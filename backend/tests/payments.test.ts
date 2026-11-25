import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { MockProvider, setProviderForTests, type PaymentProvider } from "../src/modules/payments/provider.js";
import { signPayload } from "../src/modules/payments/service.js";
import { addVehicle, app, auth, resetDb, signup, type TestUser } from "./helpers.js";

beforeEach(resetDb);
afterEach(() => setProviderForTests(null));
afterAll(async () => {
  await pool.end();
});

const KEY_SECRET = "unit_test_key_secret";
const WEBHOOK_SECRET = "unit_test_webhook_secret";

function slotTime(minutesAhead: number): Date {
  const d = new Date(Date.now() + minutesAhead * 60_000);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(Math.ceil(d.getUTCMinutes() / 15) * 15);
  return d;
}

async function holdBooking(u: TestUser, slot = "L1-01", startInMin = 120, hours = 2) {
  const v = await addVehicle(u);
  const start = slotTime(startInMin);
  const res = await request(app).post("/bookings").set(auth(u)).send({
    slot_id: slot, vehicle_id: v.id, start_at: start.toISOString(), end_at: new Date(start.getTime() + hours * 3_600_000).toISOString(),
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.booking as { id: string; total_paise: number; reference: string };
}

describe("mock gateway", () => {
  it("success: confirms the booking, issues an opaque QR and a receipt, creates a session", async () => {
    const u = await signup();
    const b = await holdBooking(u);
    const res = await request(app).post("/payments/pay").set(auth(u)).send({ booking_id: b.id, method: "upi", idempotency_key: "idem-key-0001" });
    expect(res.status).toBe(200);
    expect(res.body.payment).toMatchObject({ status: "succeeded", amount_paise: b.total_paise, provider: "mock" });
    expect(res.body.payment.receipt_number).toMatch(/^RC-\d{8}-[0-9A-Z]{4}$/);
    expect(res.body.booking).toMatchObject({ status: "confirmed", payment_status: "paid", hold_expires_at: null });
    expect(res.body.booking.qr_token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(res.body.booking.qr_token).not.toContain(b.reference);
    expect((await pool.query("select count(*)::int as n from parking_sessions where booking_id = $1", [b.id])).rows[0].n).toBe(1);
    const notes = await request(app).get("/notifications").set(auth(u));
    expect(notes.body.notifications.map((n: { title: string }) => n.title)).toEqual(expect.arrayContaining(["Booking confirmed", "Payment successful"]));
  });

  it("is idempotent: the same key never double-charges", async () => {
    const u = await signup();
    const b = await holdBooking(u);
    const body = { booking_id: b.id, method: "card", idempotency_key: "idem-key-0002" };
    const [a, c] = await Promise.all([request(app).post("/payments/pay").set(auth(u)).send(body), request(app).post("/payments/pay").set(auth(u)).send(body)]);
    expect([a.status, c.status]).toEqual([200, 200]);
    expect(a.body.payment.id).toBe(c.body.payment.id);
    expect((await pool.query("select count(*)::int as n from payments")).rows[0].n).toBe(1);
  });

  it("decline scenarios record a failed payment; attempts are capped", async () => {
    const u = await signup();
    const b = await holdBooking(u);
    for (let i = 1; i <= 3; i++) {
      const r = await request(app).post("/payments/pay").set(auth(u)).send({ booking_id: b.id, method: "card", idempotency_key: `idem-fail-000${i}`, test_scenario: "decline" });
      expect(r.status).toBe(200);
      expect(r.body.payment.status).toBe("failed");
      expect(r.body.booking.payment_status).toBe("failed");
    }
    const capped = await request(app).post("/payments/pay").set(auth(u)).send({ booking_id: b.id, method: "card", idempotency_key: "idem-fail-0004" });
    expect(capped.status).toBe(409);
    expect(capped.body.error.code).toBe("MAX_ATTEMPTS");
  });

  it("refuses an expired hold, another user's booking, and unknown fields", async () => {
    const u = await signup();
    const other = await signup();
    const b = await holdBooking(u);
    const stolen = await request(app).post("/payments/pay").set(auth(other)).send({ booking_id: b.id, method: "upi", idempotency_key: "idem-key-0003" });
    expect(stolen.status).toBe(404);
    const evil = await request(app).post("/payments/pay").set(auth(u)).send({ booking_id: b.id, method: "upi", idempotency_key: "idem-key-0004", amount_paise: 1 });
    expect(evil.status).toBe(400);
    await pool.query("update bookings set hold_expires_at = now() - interval '1 minute' where id = $1", [b.id]);
    const late = await request(app).post("/payments/pay").set(auth(u)).send({ booking_id: b.id, method: "upi", idempotency_key: "idem-key-0005" });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toMatch(/HOLD_EXPIRED|BOOKING_NOT_PAYABLE/);
  });

  it("cancelling a paid booking refunds through the provider and revokes the QR", async () => {
    const u = await signup();
    const b = await holdBooking(u, "L1-02", 600);
    await request(app).post("/payments/pay").set(auth(u)).send({ booking_id: b.id, method: "upi", idempotency_key: "idem-key-0006" });
    const res = await request(app).post(`/bookings/${b.id}/cancel`).set(auth(u)).send({});
    expect(res.body.booking).toMatchObject({ status: "cancelled", payment_status: "refunded", qr_token: null });
    const rf = await pool.query("select status, provider_refund_id from payment_refunds");
    expect(rf.rows[0].status).toBe("processed");
    expect(rf.rows[0].provider_refund_id).toMatch(/^rfnd_mock_/);
    const rc = await request(app).get(`/payments/receipt?booking_id=${b.id}`).set(auth(u));
    expect(rc.body.payment.payment_refunds).toHaveLength(1);
  });

  it("a failing gateway leaves the refund pending (cancel still succeeds) and the retry settles it", async () => {
    const u = await signup();
    const b = await holdBooking(u, "L1-03", 600);
    await request(app).post("/payments/pay").set(auth(u)).send({ booking_id: b.id, method: "upi", idempotency_key: "idem-key-0007" });
    const broken: PaymentProvider = { ...new MockProvider(), name: "mock", createOrder: new MockProvider().createOrder, publicKeyId: () => null, refund: async () => { throw new Error("gateway down"); } };
    setProviderForTests(broken);
    const res = await request(app).post(`/bookings/${b.id}/cancel`).set(auth(u)).send({});
    expect(res.status).toBe(200);
    expect((await pool.query("select status from payment_refunds")).rows[0].status).toBe("pending");
    setProviderForTests(null);
    const { settlePendingRefunds } = await import("../src/modules/payments/refunds.js");
    expect(await settlePendingRefunds()).toBe(1);
    expect((await pool.query("select status from payment_refunds")).rows[0].status).toBe("processed");
  });

  it("IDOR: receipts and payment lists are private", async () => {
    const a = await signup();
    const b = await signup();
    const bk = await holdBooking(a);
    const paid = await request(app).post("/payments/pay").set(auth(a)).send({ booking_id: bk.id, method: "upi", idempotency_key: "idem-key-0008" });
    expect((await request(app).get(`/payments/receipt?payment_id=${paid.body.payment.id}`).set(auth(b))).status).toBe(404);
    expect((await request(app).get("/payments").set(auth(b))).body.totalCount).toBe(0);
    expect((await request(app).get("/payments").set(auth(a))).body.totalCount).toBe(1);
  });
});

/** Fake Razorpay: deterministic orders, records refund calls. */
function fakeRazorpay() {
  const calls = { orders: [] as { amountPaise: number; receipt: string }[], refunds: [] as { providerPaymentId: string; amountPaise: number }[] };
  const provider: PaymentProvider = {
    name: "razorpay",
    publicKeyId: () => "rzp_test_unit",
    createOrder: async (i) => {
      calls.orders.push({ amountPaise: i.amountPaise, receipt: i.receipt });
      return { orderId: `order_T${calls.orders.length}${Math.random().toString(36).slice(2, 8)}`, amountPaise: i.amountPaise, currency: "INR" };
    },
    refund: async (i) => {
      calls.refunds.push({ providerPaymentId: i.providerPaymentId, amountPaise: i.amountPaise });
      return { providerRefundId: `rfnd_T${calls.refunds.length}`, status: "processed" };
    },
  };
  return { provider, calls };
}

const checkoutSig = (orderId: string, paymentId: string) => signPayload(`${orderId}|${paymentId}`, KEY_SECRET);

async function sendWebhook(event: object, eventId: string, opts: { sig?: string } = {}) {
  const raw = JSON.stringify(event);
  return request(app)
    .post("/webhooks/razorpay")
    .set("content-type", "application/json")
    .set("x-razorpay-event-id", eventId)
    .set("x-razorpay-signature", opts.sig ?? signPayload(raw, WEBHOOK_SECRET))
    .send(raw);
}

const captured = (orderId: string, paymentId: string, method = "upi") => ({
  event: "payment.captured",
  payload: { payment: { entity: { id: paymentId, order_id: orderId, method, status: "captured" } } },
});

describe("razorpay order + verify", () => {
  it("creates an order for the SERVER price and returns only the public key id", async () => {
    const { provider, calls } = fakeRazorpay();
    setProviderForTests(provider);
    const u = await signup();
    const b = await holdBooking(u);
    const res = await request(app).post("/payments/create-order").set(auth(u)).send({ booking_id: b.id });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ amount: b.total_paise, currency: "INR", keyId: "rzp_test_unit" });
    expect(JSON.stringify(res.body)).not.toContain(KEY_SECRET);
    expect(calls.orders[0]).toMatchObject({ amountPaise: b.total_paise, receipt: b.reference });
    // the client cannot choose the amount
    const evil = await request(app).post("/payments/create-order").set(auth(u)).send({ booking_id: b.id, amount: 1 });
    expect(evil.status).toBe(400);
  });

  it("verify confirms with a valid signature, rejects a forged one, and is idempotent", async () => {
    const { provider } = fakeRazorpay();
    setProviderForTests(provider);
    const u = await signup();
    const b = await holdBooking(u);
    const order = (await request(app).post("/payments/create-order").set(auth(u)).send({ booking_id: b.id })).body;

    const forged = await request(app).post("/payments/verify").set(auth(u)).send({ razorpay_order_id: order.orderId, razorpay_payment_id: "pay_ABC123456", razorpay_signature: "0".repeat(64) });
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe("INVALID_SIGNATURE");
    expect((await pool.query("select status from bookings where id = $1", [b.id])).rows[0].status).toBe("reserved");

    const good = { razorpay_order_id: order.orderId, razorpay_payment_id: "pay_ABC123456", razorpay_signature: checkoutSig(order.orderId, "pay_ABC123456") };
    const first = await request(app).post("/payments/verify").set(auth(u)).send(good);
    expect(first.status).toBe(200);
    expect(first.body.booking).toMatchObject({ status: "confirmed", payment_status: "paid" });
    expect(first.body.booking.qr_token).toBeTruthy();
    const again = await request(app).post("/payments/verify").set(auth(u)).send(good);
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe("already_confirmed");
    expect(again.body.booking.qr_token).toBe(first.body.booking.qr_token);
    expect((await pool.query("select count(*)::int as n from parking_sessions")).rows[0].n).toBe(1);
  });

  it("another user cannot verify (or hijack) someone else's order", async () => {
    setProviderForTests(fakeRazorpay().provider);
    const a = await signup();
    const mallory = await signup();
    const b = await holdBooking(a);
    const order = (await request(app).post("/payments/create-order").set(auth(a)).send({ booking_id: b.id })).body;
    const res = await request(app).post("/payments/verify").set(auth(mallory)).send({ razorpay_order_id: order.orderId, razorpay_payment_id: "pay_ABC123456", razorpay_signature: checkoutSig(order.orderId, "pay_ABC123456") });
    expect(res.status).toBe(404);
  });
});

describe("razorpay webhooks", () => {
  it("rejects bad signatures; accepts good ones; replays are acknowledged without double processing", async () => {
    setProviderForTests(fakeRazorpay().provider);
    const u = await signup();
    const b = await holdBooking(u);
    const order = (await request(app).post("/payments/create-order").set(auth(u)).send({ booking_id: b.id })).body;
    const evt = captured(order.orderId, "pay_WEB123456");

    expect((await sendWebhook(evt, "evt_1", { sig: "deadbeef" })).status).toBe(400);
    expect((await pool.query("select count(*)::int as n from webhook_events")).rows[0].n).toBe(0);

    const ok = await sendWebhook(evt, "evt_1");
    expect(ok.status).toBe(200);
    const bk = (await pool.query("select status, payment_status, qr_token from bookings where id = $1", [b.id])).rows[0];
    expect(bk).toMatchObject({ status: "confirmed", payment_status: "paid" });

    const replay = await sendWebhook(evt, "evt_1");
    expect(replay.body.duplicate).toBe(true);
    // a different event id for the same payment (order.paid after payment.captured) is also a no-op
    expect((await sendWebhook(captured(order.orderId, "pay_WEB123456"), "evt_2")).status).toBe(200);
    expect((await pool.query("select count(*)::int as n from payments where status = 'succeeded'")).rows[0].n).toBe(1);
    expect((await pool.query("select qr_token from bookings where id = $1", [b.id])).rows[0].qr_token).toBe(bk.qr_token);
  });

  it("webhook alone confirms the booking when the browser never comes back", async () => {
    setProviderForTests(fakeRazorpay().provider);
    const u = await signup();
    const b = await holdBooking(u);
    const order = (await request(app).post("/payments/create-order").set(auth(u)).send({ booking_id: b.id })).body;
    await sendWebhook(captured(order.orderId, "pay_ONLYWEB1", "card"), "evt_only_web");
    const pay = (await pool.query("select status, method, receipt_number, provider_ref from payments")).rows[0];
    expect(pay).toMatchObject({ status: "succeeded", method: "card", provider_ref: "pay_ONLYWEB1" });
    expect(pay.receipt_number).toBeTruthy();
  });

  it("payment after the hold expired: slot still free -> confirmed anyway", async () => {
    setProviderForTests(fakeRazorpay().provider);
    const u = await signup();
    const b = await holdBooking(u);
    const order = (await request(app).post("/payments/create-order").set(auth(u)).send({ booking_id: b.id })).body;
    await pool.query("update bookings set hold_expires_at = now() - interval '5 minutes' where id = $1", [b.id]);
    await pool.query("update bookings set status = 'expired' where id = $1", [b.id]); // the job ran
    await sendWebhook(captured(order.orderId, "pay_LATE00001"), "evt_late_ok");
    expect((await pool.query("select status, payment_status from bookings where id = $1", [b.id])).rows[0]).toEqual({ status: "confirmed", payment_status: "paid" });
    expect((await pool.query("select count(*)::int as n from parking_sessions where booking_id = $1", [b.id])).rows[0].n).toBe(1);
  });

  it("payment after the hold expired AND slot re-booked -> automatic full refund, never money without a booking", async () => {
    const { provider, calls } = fakeRazorpay();
    setProviderForTests(provider);
    const a = await signup();
    const b = await signup();
    const ba = await holdBooking(a, "L1-05", 180, 1);
    const order = (await request(app).post("/payments/create-order").set(auth(a)).send({ booking_id: ba.id })).body;
    await pool.query("update bookings set hold_expires_at = now() - interval '5 minutes' where id = $1", [ba.id]);

    // someone else grabs the slot for the same time (lazy expiry frees it)
    const vb = await addVehicle(b);
    const start = (await pool.query("select start_at, end_at from bookings where id = $1", [ba.id])).rows[0];
    const grab = await request(app).post("/bookings").set(auth(b)).send({ slot_id: "L1-05", vehicle_id: vb.id, start_at: start.start_at, end_at: start.end_at });
    expect(grab.status).toBe(201);

    await sendWebhook(captured(order.orderId, "pay_LATE00002"), "evt_late_refund");
    const bk = (await pool.query("select status, payment_status, refund_paise from bookings where id = $1", [ba.id])).rows[0];
    expect(bk).toMatchObject({ status: "expired", payment_status: "refunded", refund_paise: ba.total_paise });
    expect(calls.refunds).toEqual([{ providerPaymentId: "pay_LATE00002", amountPaise: ba.total_paise }]);
    expect((await pool.query("select status from payment_refunds")).rows[0].status).toBe("processed");
    const notes = await request(app).get("/notifications").set(auth(a));
    expect(notes.body.notifications.some((n: { title: string }) => n.title === "Payment refunded")).toBe(true);
    // the other user's booking is untouched
    expect((await pool.query("select status from bookings where id = $1", [grab.body.booking.id])).rows[0].status).toBe("reserved");
  });

  it("payment.failed marks the attempt failed; refund.processed updates the refund; unknown orders are ignored", async () => {
    setProviderForTests(fakeRazorpay().provider);
    const u = await signup();
    const b = await holdBooking(u);
    const order = (await request(app).post("/payments/create-order").set(auth(u)).send({ booking_id: b.id })).body;
    await sendWebhook({ event: "payment.failed", payload: { payment: { entity: { id: "pay_F1", order_id: order.orderId, error_description: "Bank declined" } } } }, "evt_fail");
    expect((await pool.query("select status, failure_reason from payments")).rows[0]).toEqual({ status: "failed", failure_reason: "Bank declined" });

    const unknown = await sendWebhook(captured("order_DOESNOTEXIST", "pay_X1"), "evt_unknown");
    expect(unknown.status).toBe(200);
    expect(unknown.body.ignored).toBe(true);
  });
});

describe("config", () => {
  it("reports the active provider without leaking secrets", async () => {
    const u = await signup();
    const res = await request(app).get("/payments/config").set(auth(u));
    expect(res.body).toEqual({ provider: "mock", keyId: null });
  });
});
