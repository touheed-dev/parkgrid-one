import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { addVehicle, app, auth, resetDb, signup, type TestUser } from "./helpers.js";

beforeEach(resetDb);
afterAll(async () => {
  await pool.end();
});

/** Next IST-aligned (15-min) instant at least `minutesAhead` from now. */
function slotTime(minutesAhead: number): Date {
  const d = new Date(Date.now() + minutesAhead * 60_000);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(Math.ceil(d.getUTCMinutes() / 15) * 15);
  return d;
}
const hoursAfter = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000);

async function book(u: TestUser, vehicleId: string, slot: string, start: Date, end: Date) {
  return request(app)
    .post("/bookings")
    .set(auth(u))
    .send({ slot_id: slot, vehicle_id: vehicleId, start_at: start.toISOString(), end_at: end.toISOString() });
}

describe("create booking", () => {
  it("creates a hold with a server-computed price", async () => {
    const u = await signup();
    const v = await addVehicle(u);
    const start = slotTime(60);
    const res = await book(u, v.id, "B2-10", start, hoursAfter(start, 2));
    expect(res.status).toBe(201);
    const b = res.body.booking;
    expect(b.status).toBe("reserved");
    expect(b.payment_status).toBe("pending");
    expect(b.hours).toBe(2);
    expect(b.base_paise).toBe(10000);
    expect(b.gst_paise).toBe(1800);
    expect(b.total_paise).toBe(11800);
    expect(b.reference).toMatch(/^SP-\d{8}-[A-Z0-9]{4}$/);
    expect(b.qr_token).toBeNull();
    expect(new Date(b.hold_expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("accepts a slot code instead of a uuid, and rejects client-supplied price/status/user", async () => {
    const u = await signup();
    const v = await addVehicle(u);
    const start = slotTime(60);
    const evil = await request(app).post("/bookings").set(auth(u)).send({
      slot_id: "B2-11", vehicle_id: v.id, start_at: start.toISOString(), end_at: hoursAfter(start, 1).toISOString(),
      total_paise: 1, status: "confirmed", user_id: u.id,
    });
    expect(evil.status).toBe(400);
  });

  it("validates window rules (past, misaligned, too far, duration, EV vehicle)", async () => {
    const u = await signup();
    const v = await addVehicle(u);
    const start = slotTime(60);

    const past = await book(u, v.id, "B2-12", new Date(Date.now() - 3_600_000), start);
    expect(past.status).toBe(400);
    expect(past.body.error.code).toBe("START_IN_PAST");

    const mis = new Date(start.getTime() + 7 * 60_000);
    expect((await book(u, v.id, "B2-12", mis, hoursAfter(mis, 1))).body.error.code).toBe("NOT_ALIGNED");

    const far = slotTime(60 * 24 * 40);
    expect((await book(u, v.id, "B2-12", far, hoursAfter(far, 1))).body.error.code).toBe("TOO_FAR_AHEAD");

    expect((await book(u, v.id, "B2-12", start, hoursAfter(start, 30))).body.error.code).toBe("INVALID_DURATION");
    expect((await book(u, v.id, "B2-12", start, start)).status).toBe(400);

    // G1-01 is an EV bay; a plain car may not book it
    expect((await book(u, v.id, "G1-01", start, hoursAfter(start, 1))).body.error.code).toBe("EV_REQUIRED");
    const ev = await addVehicle(u, { plate_number: "MH12EV0099", vehicle_type: "ev", connector_type: "CCS2" });
    expect((await book(u, ev.id, "G1-01", start, hoursAfter(start, 1))).status).toBe(201);
  });

  it("refuses maintenance slots and other people's vehicles", async () => {
    const a = await signup();
    const b = await signup();
    const va = await addVehicle(a);
    const vb = await addVehicle(b);
    const start = slotTime(60);
    await pool.query("update parking_slots set admin_status = 'maintenance' where code = 'B2-13'");
    expect((await book(a, va.id, "B2-13", start, hoursAfter(start, 1))).body.error.code).toBe("SLOT_UNAVAILABLE");
    expect((await book(a, vb.id, "B2-14", start, hoursAfter(start, 1))).body.error.code).toBe("VEHICLE_NOT_FOUND");
  });
});

describe("double booking protection", () => {
  it("25 parallel bookings for the same slot and time: exactly one wins, no overlaps in the DB", async () => {
    const users: { u: TestUser; vehicleId: string }[] = [];
    for (let i = 0; i < 25; i++) {
      const u = await signup();
      const v = await addVehicle(u);
      users.push({ u, vehicleId: v.id });
    }
    const start = slotTime(90);
    const end = hoursAfter(start, 2);
    const results = await Promise.all(users.map(({ u, vehicleId }) => book(u, vehicleId, "L1-20", start, end)));

    const created = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(24);
    expect(conflicts.every((r) => r.body.error.code === "SLOT_TAKEN")).toBe(true);

    const { rows } = await pool.query(
      `select count(*)::int as n from bookings a join bookings b
         on a.slot_id = b.slot_id and a.id < b.id and a.during && b.during
        where a.status in ('reserved','confirmed','active') and b.status in ('reserved','confirmed','active')`,
    );
    expect(rows[0].n).toBe(0);
  });

  it("overlapping windows conflict, but back-to-back bookings are allowed (half-open ranges)", async () => {
    const u = await signup();
    const v = await addVehicle(u);
    const t = slotTime(120);
    expect((await book(u, v.id, "L1-21", t, hoursAfter(t, 1))).status).toBe(201);
    expect((await book(u, v.id, "L1-21", new Date(t.getTime() + 30 * 60_000 - (t.getUTCMinutes() % 15) * 0), hoursAfter(t, 2))).status).toBe(409);
    expect((await book(u, v.id, "L1-21", hoursAfter(t, 1), hoursAfter(t, 2))).status).toBe(201);
  });

  it("an expired hold frees the slot", async () => {
    const a = await signup();
    const b = await signup();
    const va = await addVehicle(a);
    const vb = await addVehicle(b);
    const start = slotTime(120);
    const first = await book(a, va.id, "L1-22", start, hoursAfter(start, 1));
    expect(first.status).toBe(201);
    expect((await book(b, vb.id, "L1-22", start, hoursAfter(start, 1))).status).toBe(409);
    await pool.query("update bookings set hold_expires_at = now() - interval '1 minute' where id = $1", [first.body.booking.id]);
    expect((await book(b, vb.id, "L1-22", start, hoursAfter(start, 1))).status).toBe(201);
    const stale = await pool.query("select status from bookings where id = $1", [first.body.booking.id]);
    expect(stale.rows[0].status).toBe("expired");
  });

  it("different users can book different slots at the same time", async () => {
    const a = await signup();
    const b = await signup();
    const va = await addVehicle(a);
    const vb = await addVehicle(b);
    const start = slotTime(120);
    const [r1, r2] = await Promise.all([
      book(a, va.id, "L2-05", start, hoursAfter(start, 1)),
      book(b, vb.id, "L2-06", start, hoursAfter(start, 1)),
    ]);
    expect([r1.status, r2.status]).toEqual([201, 201]);
  });
});

describe("availability, quote, listing", () => {
  it("availability reflects held slots; quote matches the booking price", async () => {
    const u = await signup();
    const v = await addVehicle(u);
    const start = slotTime(120);
    const end = hoursAfter(start, 3);
    await book(u, v.id, "L2-07", start, end);
    const q = new URLSearchParams({ start_at: start.toISOString(), end_at: end.toISOString(), level: "L2" });
    const av = await request(app).get(`/bookings/availability?${q}`).set(auth(u));
    expect(av.status).toBe(200);
    const slot = await pool.query("select id from parking_slots where code = 'L2-07'");
    const row = av.body.availability.find((a: { slot_id: string }) => a.slot_id === slot.rows[0].id);
    expect(row.is_available).toBe(false);

    const quote = await request(app).get(`/bookings/quote?slot_id=L2-08&start_at=${encodeURIComponent(start.toISOString())}&end_at=${encodeURIComponent(end.toISOString())}`).set(auth(u));
    expect(quote.body.quote).toEqual({ hours: 3, hourly_rate_paise: 5000, base_paise: 15000, gst_paise: 2700, total_paise: 17700 });
  });

  it("lists my bookings by tab with slot and vehicle details", async () => {
    const u = await signup();
    const v = await addVehicle(u);
    const start = slotTime(120);
    await book(u, v.id, "L2-09", start, hoursAfter(start, 1));
    const up = await request(app).get("/bookings?statusTab=Upcoming").set(auth(u));
    expect(up.body.totalCount).toBe(1);
    expect(up.body.bookings[0].parking_slots.code).toBe("L2-09");
    expect(up.body.bookings[0].vehicles.plate_number).toBe(v["plate_number"]);
    expect((await request(app).get("/bookings?statusTab=Cancelled").set(auth(u))).body.totalCount).toBe(0);
  });
});

describe("IDOR on bookings", () => {
  it("another member gets 404 for read, preview and cancel", async () => {
    const a = await signup();
    const b = await signup();
    const v = await addVehicle(a);
    const start = slotTime(120);
    const id = (await book(a, v.id, "L2-10", start, hoursAfter(start, 1))).body.booking.id;
    expect((await request(app).get(`/bookings/${id}`).set(auth(b))).status).toBe(404);
    expect((await request(app).get(`/bookings/${id}/cancellation-preview`).set(auth(b))).status).toBe(404);
    expect((await request(app).post(`/bookings/${id}/cancel`).set(auth(b)).send({})).status).toBe(404);
    expect((await request(app).get(`/bookings/${id}`).set(auth(a))).status).toBe(200);
    expect((await request(app).get("/bookings")).status).toBe(401);
  });
});

describe("cancellation", () => {
  async function paidBooking(startInMinutes: number) {
    const u = await signup();
    const v = await addVehicle(u);
    const start = slotTime(startInMinutes);
    const id = (await book(u, v.id, "L2-11", start, hoursAfter(start, 2))).body.booking.id;
    const total = 11800;
    // simulate a captured payment (the payment module has its own tests)
    const pay = await pool.query(
      `insert into payments (booking_id, user_id, provider, provider_ref, method, amount_paise, base_paise, gst_paise, status, receipt_number, idempotency_key)
       values ($1,$2,'mock','MOCK-' || $5::text,'upi',$3,10000,1800,'succeeded','RC-' || substr($5::text,1,8),$4) returning id`,
      [id, u.id, total, `k-${id}`, id],
    );
    await pool.query("update bookings set status='confirmed', payment_status='paid', hold_expires_at=null where id=$1", [id]);
    return { u, id, total, paymentId: pay.rows[0].id as string };
  }

  it("refunds 100% when cancelled well in advance, records the refund and frees the slot", async () => {
    const { u, id, total, paymentId } = await paidBooking(5 * 60);
    const preview = await request(app).get(`/bookings/${id}/cancellation-preview`).set(auth(u));
    expect(preview.body.preview).toMatchObject({ refund_paise: total, refund_percentage: 100 });

    const res = await request(app).post(`/bookings/${id}/cancel`).set(auth(u)).send({ reason: "plans changed" });
    expect(res.status).toBe(200);
    expect(res.body.booking).toMatchObject({ status: "cancelled", payment_status: "refunded", refund_paise: total });

    const refunds = await pool.query("select amount_paise, status from payment_refunds where payment_id = $1", [paymentId]);
    expect(refunds.rows).toEqual([{ amount_paise: total, status: "processed" }]);

    // cancelling twice is safe and changes nothing
    const again = await request(app).post(`/bookings/${id}/cancel`).set(auth(u)).send({});
    expect(again.status).toBe(409);
    expect((await pool.query("select count(*)::int as n from payment_refunds")).rows[0].n).toBe(1);

    // the user got a notification
    const n = await request(app).get("/notifications").set(auth(u));
    expect(n.body.notifications.some((x: { title: string }) => x.title === "Booking cancelled")).toBe(true);
  });

  it("refunds 50% between 30 min and 2 h before start, 0% within 30 min", async () => {
    const mid = await paidBooking(75);
    expect((await request(app).post(`/bookings/${mid.id}/cancel`).set(auth(mid.u)).send({})).body.booking.refund_paise).toBe(5900);
    // the slot is free again, so the same helper can book it for the next case
    const late = await paidBooking(15);
    const res = await request(app).post(`/bookings/${late.id}/cancel`).set(auth(late.u)).send({});
    expect(res.body.booking).toMatchObject({ refund_paise: 0, payment_status: "paid" });
  });

  it("cannot cancel once the booking has started", async () => {
    const u = await signup();
    const v = await addVehicle(u);
    const start = slotTime(60);
    const id = (await book(u, v.id, "L2-12", start, hoursAfter(start, 1))).body.booking.id;
    await pool.query("update bookings set status = 'confirmed' where id = $1", [id]);
    await pool.query("alter table bookings disable trigger bookings_protect_immutability");
    await pool.query("update bookings set start_at = now() - interval '10 minutes' where id = $1", [id]);
    await pool.query("alter table bookings enable trigger bookings_protect_immutability");
    const res = await request(app).post(`/bookings/${id}/cancel`).set(auth(u)).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_STARTED");
  });
});
