import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { addVehicle, app, auth, resetDb, signup, signupWithRole, type TestUser } from "./helpers.js";

beforeEach(resetDb);
afterAll(async () => {
  await pool.end();
});

function slotTime(minutesAhead: number): Date {
  const d = new Date(Date.now() + minutesAhead * 60_000);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(Math.ceil(d.getUTCMinutes() / 15) * 15);
  return d;
}

async function paid(u: TestUser, slot: string, startInMin = 600, hours = 2) {
  const v = await addVehicle(u);
  const start = slotTime(startInMin);
  const b = await request(app).post("/bookings").set(auth(u)).send({
    slot_id: slot, vehicle_id: v.id, start_at: start.toISOString(), end_at: new Date(start.getTime() + hours * 3_600_000).toISOString(),
  });
  if (b.status !== 201) throw new Error("booking failed: " + JSON.stringify(b.body));
  const id = b.body.booking.id as string;
  const p = await request(app).post("/payments/pay").set(auth(u)).send({ booking_id: id, method: "upi", idempotency_key: `adm-${id}` });
  return { id, paymentId: p.body.payment.id as string, total: b.body.booking.total_paise as number };
}

const ADMIN_ROUTES: [string, string][] = [
  ["get", "/admin/dashboard"], ["get", "/admin/revenue?from=2026-01-01&to=2026-01-31"], ["get", "/admin/users"],
  ["get", "/admin/bookings"], ["get", "/admin/payments"], ["get", "/admin/sessions"], ["get", "/admin/sessions/active"],
  ["get", "/admin/settings"], ["get", "/admin/slot-rates"], ["get", "/admin/audit-logs"],
];

describe("access control", () => {
  it("anonymous -> 401, member -> 403, staff -> 403 on every admin route; admin -> 200", async () => {
    const member = await signup();
    const staff = await signupWithRole("staff");
    const admin = await signupWithRole("admin");
    for (const [, path] of ADMIN_ROUTES) {
      expect((await request(app).get(path)).status, `anon ${path}`).toBe(401);
      expect((await request(app).get(path).set(auth(member))).status, `member ${path}`).toBe(403);
      expect((await request(app).get(path).set(auth(staff))).status, `staff ${path}`).toBe(403);
      expect((await request(app).get(path).set(auth(admin))).status, `admin ${path}`).toBe(200);
    }
    expect((await request(app).patch("/admin/users/00000000-0000-4000-8000-000000000000/role").set(auth(member)).send({ role: "admin", reason: "let me in" })).status).toBe(403);
  });
});

describe("dashboard & revenue (ported SQL)", () => {
  it("shows today's bookings and net revenue after a payment and a refund", async () => {
    const admin = await signupWithRole("admin");
    const u = await signup();
    const a = await paid(u, "L1-03");
    await paid(u, "L1-04");
    const dash = await request(app).get("/admin/dashboard").set(auth(admin));
    expect(dash.body.dashboard.kpis.bookings_today).toBe(2);
    expect(dash.body.dashboard.kpis.revenue_today_paise).toBe(a.total * 2);

    await request(app).post(`/admin/bookings/${a.id}/override`).set(auth(admin)).send({ action: "cancel_full_refund", reason: "customer complaint" });
    const after = await request(app).get("/admin/dashboard").set(auth(admin));
    expect(after.body.dashboard.kpis.revenue_today_paise).toBe(a.total);

    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const rep = await request(app).get(`/admin/revenue?from=${today}&to=${tomorrow}&group=day`).set(auth(admin));
    expect(rep.status).toBe(200);
    expect(rep.body.report.totals.total_refund_paise).toBe(a.total);
    expect((await request(app).get("/admin/revenue?from=2026-01-31&to=2026-01-01").set(auth(admin))).status).toBe(400);
    expect((await request(app).get("/admin/revenue?from=2024-01-01&to=2026-01-01").set(auth(admin))).status).toBe(400);
  });
});

describe("users", () => {
  it("lists users with counts, changes roles (audited), protects the last admin, and applies it immediately", async () => {
    const admin = await signupWithRole("admin");
    const u = await signup({ full_name: "Rohan Mehta" });
    const list = await request(app).get("/admin/users?search=rohan").set(auth(admin));
    expect(list.body.users).toHaveLength(1);
    expect(list.body.users[0]).toMatchObject({ id: u.id, role: "member", fullName: "Rohan Mehta" });

    const promote = await request(app).patch(`/admin/users/${u.id}/role`).set(auth(admin)).send({ role: "staff", reason: "gate duty" });
    expect(promote.status).toBe(200);
    expect(promote.body.profile.role).toBe("staff");
    // new role is effective on the very next request, no token refresh needed
    expect((await request(app).get("/gate/recent").set(auth(u))).status).toBe(200);

    const demoteLast = await request(app).patch(`/admin/users/${admin.id}/role`).set(auth(admin)).send({ role: "member", reason: "oops by mistake" });
    expect(demoteLast.status).toBe(400);

    const logs = await request(app).get("/admin/audit-logs").set(auth(admin));
    expect(logs.body.logs[0]).toMatchObject({ action: "change_user_role", record_id: u.id });
    expect(logs.body.logs[0].actor.full_name).toBeDefined();

    const noReason = await request(app).patch(`/admin/users/${u.id}/role`).set(auth(admin)).send({ role: "member" });
    expect(noReason.status).toBe(400);
  });

  it("disabling a user signs them out everywhere and blocks login; cannot disable yourself", async () => {
    const admin = await signupWithRole("admin");
    const u = await signup();
    expect((await request(app).patch(`/admin/users/${admin.id}/status`).set(auth(admin)).send({ disabled: true, reason: "testing self" })).status).toBe(400);
    expect((await request(app).patch(`/admin/users/${u.id}/status`).set(auth(admin)).send({ disabled: true, reason: "abuse reports" })).status).toBe(200);
    expect((await request(app).get("/auth/me").set(auth(u))).status).toBe(401);
    expect((await request(app).post("/auth/refresh").send({ refreshToken: u.refreshToken })).status).toBe(401);
    expect((await request(app).post("/auth/login").send({ email: u.email, password: u.password })).status).toBe(401);
    await request(app).patch(`/admin/users/${u.id}/status`).set(auth(admin)).send({ disabled: false, reason: "appeal accepted" }).expect(200);
    expect((await request(app).post("/auth/login").send({ email: u.email, password: u.password })).status).toBe(200);
  });

  it("user detail hides QR tokens", async () => {
    const admin = await signupWithRole("admin");
    const u = await signup();
    await paid(u, "L1-05");
    const d = await request(app).get(`/admin/users/${u.id}`).set(auth(admin));
    expect(d.body.bookings).toHaveLength(1);
    expect(d.body.bookings[0].qr_token).toBeNull();
    expect(d.body.vehicles).toHaveLength(1);
  });
});

describe("bookings & overrides", () => {
  it("lists/filters bookings and shows full detail with payments, refunds, session", async () => {
    const admin = await signupWithRole("admin");
    const u = await signup();
    const a = await paid(u, "L1-06");
    const list = await request(app).get("/admin/bookings?status=confirmed&search=" + (await pool.query("select reference from bookings where id = $1", [a.id])).rows[0].reference).set(auth(admin));
    expect(list.body.totalCount).toBe(1);
    expect(list.body.bookings[0].profiles).toBeDefined();
    const d = await request(app).get(`/admin/bookings/${a.id}`).set(auth(admin));
    expect(d.body.booking.payments).toHaveLength(1);
    expect(d.body.booking.payments[0].provider_signature).toBeUndefined();
    expect(d.body.booking.parking_sessions).toBeTruthy();
    expect(d.body.booking.qr_token).toBeNull();
  });

  it("override: full refund, by policy, no refund, no-show; terminal bookings are rejected; every action is audited", async () => {
    const admin = await signupWithRole("admin");
    const u = await signup();
    const full = await paid(u, "L1-09");
    const r1 = await request(app).post(`/admin/bookings/${full.id}/override`).set(auth(admin)).send({ action: "cancel_full_refund", reason: "double charged" });
    expect(r1.body.booking).toMatchObject({ status: "cancelled", payment_status: "refunded", refund_paise: full.total });
    expect((await pool.query("select status from payment_refunds")).rows[0].status).toBe("processed");
    expect((await request(app).post(`/admin/bookings/${full.id}/override`).set(auth(admin)).send({ action: "cancel_no_refund", reason: "again again" })).status).toBe(409);

    const none = await paid(u, "L1-10");
    const r2 = await request(app).post(`/admin/bookings/${none.id}/override`).set(auth(admin)).send({ action: "cancel_no_refund", reason: "fraud suspected" });
    expect(r2.body.booking).toMatchObject({ status: "cancelled", payment_status: "paid", refund_paise: 0 });

    const policy = await paid(u, "L1-11", 600); // far ahead -> 100 %
    const r3 = await request(app).post(`/admin/bookings/${policy.id}/override`).set(auth(admin)).send({ action: "cancel_by_policy", reason: "customer asked nicely" });
    expect(r3.body.booking.refund_paise).toBe(policy.total);

    const ns = await paid(u, "L1-12");
    const r4 = await request(app).post(`/admin/bookings/${ns.id}/override`).set(auth(admin)).send({ action: "mark_no_show", reason: "never showed up" });
    expect(r4.body.booking.status).toBe("no_show");
    expect((await pool.query("select status from parking_sessions where booking_id = $1", [ns.id])).rows[0].status).toBe("cancelled");

    const logs = (await request(app).get("/admin/audit-logs").set(auth(admin))).body.logs.map((l: { action: string }) => l.action);
    expect(logs).toEqual(expect.arrayContaining(["override_booking_cancel_full_refund", "override_booking_cancel_no_refund", "override_booking_cancel_by_policy", "override_booking_mark_no_show"]));
    expect((await request(app).post(`/admin/bookings/${ns.id}/override`).set(auth(admin)).send({ action: "mark_no_show", reason: "x" })).status).toBe(400);
  });
});

describe("payments admin", () => {
  it("lists with totals, hides gateway secrets, supports partial then final refund with limits", async () => {
    const admin = await signupWithRole("admin");
    const u = await signup();
    const p = await paid(u, "L1-13");
    const list = await request(app).get("/admin/payments").set(auth(admin));
    expect(list.body.totalCount).toBe(1);
    expect(list.body.totals.grossPaise).toBe(p.total);
    expect(JSON.stringify(list.body)).not.toContain("provider_signature");

    const part = await request(app).post(`/admin/payments/${p.paymentId}/refund`).set(auth(admin)).send({ amount_paise: 1000, reason: "goodwill gesture" });
    expect(part.status).toBe(200);
    expect(part.body.refund).toMatchObject({ amount_paise: 1000, status: "processed" });
    expect((await pool.query("select status from payments")).rows[0].status).toBe("partially_refunded");
    expect((await pool.query("select payment_status, refund_paise from bookings where id = $1", [p.id])).rows[0]).toEqual({ payment_status: "partially_refunded", refund_paise: 1000 });

    const tooMuch = await request(app).post(`/admin/payments/${p.paymentId}/refund`).set(auth(admin)).send({ amount_paise: p.total, reason: "too much now" });
    expect(tooMuch.status).toBe(400);
    const rest = await request(app).post(`/admin/payments/${p.paymentId}/refund`).set(auth(admin)).send({ amount_paise: p.total - 1000, reason: "remaining balance" });
    expect(rest.status).toBe(200);
    expect((await pool.query("select status from payments")).rows[0].status).toBe("refunded");
    expect((await request(app).post(`/admin/payments/${p.paymentId}/refund`).set(auth(admin)).send({ amount_paise: 1, reason: "nothing left" })).status).toBe(409);

    const detail = await request(app).get(`/admin/payments/${p.paymentId}`).set(auth(admin));
    expect(detail.body.payment.payment_refunds).toHaveLength(2);
    expect(detail.body.payment.bookings.qr_token).toBeUndefined();
  });
});

describe("settings, rates, slots", () => {
  it("updates settings with validation + audit and the new policy applies to quotes", async () => {
    const admin = await signupWithRole("admin");
    const u = await signup();
    const base = (await request(app).get("/admin/settings").set(auth(admin))).body.settings;
    const body = { gst_bps: 1200, hold_minutes: base.hold_minutes, min_hours: 1, max_hours: 24, max_advance_days: 30, refund_full_hours: 2, refund_partial_minutes: 30, partial_refund_bps: 5000, exit_grace_minutes: 15, reason: "festival season" };
    expect((await request(app).put("/admin/settings").set(auth(admin)).send({ ...body, gst_bps: 5000 })).status).toBe(400);
    expect((await request(app).put("/admin/settings").set(auth(admin)).send({ ...body, max_hours: 0 })).status).toBe(400);
    const ok = await request(app).put("/admin/settings").set(auth(admin)).send(body);
    expect(ok.status).toBe(200);
    expect(ok.body.settings.gst_bps).toBe(1200);
    const start = slotTime(300);
    const q = await request(app).get(`/bookings/quote?slot_id=L1-14&start_at=${encodeURIComponent(start.toISOString())}&end_at=${encodeURIComponent(new Date(start.getTime() + 3_600_000).toISOString())}`).set(auth(u));
    expect(q.body.quote).toMatchObject({ base_paise: 5000, gst_paise: 600, total_paise: 5600 });
    expect((await request(app).get("/admin/audit-logs").set(auth(admin))).body.logs[0].action).toMatch(/settings/);
  });

  it("updates slot tariffs for all slots of a type and individual slot status/notes (audited)", async () => {
    const admin = await signupWithRole("admin");
    const rates = await request(app).put("/admin/slot-rates").set(auth(admin)).send({ standard_rate_paise: 6000, ev_rate_paise: 8000, accessible_rate_paise: 6000, reason: "annual tariff revision" });
    expect(rates.status).toBe(200);
    expect((await pool.query("select hourly_rate_paise from parking_slots where code = 'L1-01'")).rows[0].hourly_rate_paise).toBe(6000);
    expect((await pool.query("select hourly_rate_paise from parking_slots where slot_type = 'ev' limit 1")).rows[0].hourly_rate_paise).toBe(8000);

    const slot = (await pool.query("select id from parking_slots where code = 'L2-20'")).rows[0].id;
    const upd = await request(app).patch(`/parking/slots/${slot}`).set(auth(admin)).send({ admin_status: "maintenance", notes: "oil leak" });
    expect(upd.status).toBe(200);
    expect(upd.body.slot).toMatchObject({ admin_status: "maintenance", notes: "oil leak" });
    expect((await request(app).patch(`/parking/slots/${slot}`).set(auth(admin)).send({ code: "ZZ-99" })).status).toBe(400);
    expect((await request(app).patch(`/parking/slots/${slot}`).set(auth(admin)).send({})).status).toBe(400);
    const u = await signup();
    const v = await addVehicle(u);
    const start = slotTime(300);
    const blocked = await request(app).post("/bookings").set(auth(u)).send({ slot_id: "L2-20", vehicle_id: v.id, start_at: start.toISOString(), end_at: new Date(start.getTime() + 3_600_000).toISOString() });
    expect(blocked.body.error.code).toBe("SLOT_UNAVAILABLE");
  });
});

describe("parking listing & facility summary", () => {
  it("members see free/occupied only; admins also see which booking occupies a bay", async () => {
    const admin = await signupWithRole("admin");
    const u = await signup();
    const v = await addVehicle(u);
    const start = slotTime(240);
    const res = await request(app).post("/bookings").set(auth(u)).send({ slot_id: "L2-25", vehicle_id: v.id, start_at: start.toISOString(), end_at: new Date(start.getTime() + 2 * 3_600_000).toISOString() });
    expect(res.status).toBe(201);
    // move the window so it covers 'now' (test setup only: bypass the immutability trigger)
    await pool.query("alter table bookings disable trigger bookings_protect_immutability");
    await pool.query("update bookings set start_at = now() - interval '10 minutes', end_at = now() + interval '110 minutes' where id = $1", [res.body.booking.id]);
    await pool.query("alter table bookings enable trigger bookings_protect_immutability");

    const asMember = (await request(app).get("/parking/slots?level=L2&search=L2-25").set(auth(u))).body.slots[0];
    expect(asMember).toMatchObject({ code: "L2-25", is_occupied: true, current_booking: null });
    expect(asMember.parking_levels.code).toBe("L2");
    const asAdmin = (await request(app).get("/parking/slots?level=L2&search=L2-25").set(auth(admin))).body.slots[0];
    expect(asAdmin.current_booking.reference).toBe(res.body.booking.reference);

    const sum = (await request(app).get("/parking/summary").set(auth(u))).body;
    expect(sum.totalSlots).toBe(150);
    expect(sum.reservedSlots).toBeGreaterThanOrEqual(1);
    expect(sum.availableSlots).toBe(149);
    expect(sum.byType).toEqual({ standard: 128, ev: 12, accessible: 10 });
    const paged = (await request(app).get("/parking/slots?pageSize=20&page=2").set(auth(u))).body;
    expect(paged).toMatchObject({ totalCount: 150, totalPages: 8, page: 2, pageSize: 20 });
    expect(paged.slots).toHaveLength(20);
  });
});
