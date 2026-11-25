import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { runJob } from "../src/jobs/index.js";
import { toQrPayload } from "../src/lib/tokens.js";
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

/** A confirmed, paid booking with a QR pass. start/end are rewritten to the wanted window (immutability trigger bypassed for test setup only). */
async function passFor(u: TestUser, slot: string, startOffsetMin: number, durationHours = 2) {
  const v = await addVehicle(u);
  const start = slotTime(240);
  const res = await request(app).post("/bookings").set(auth(u)).send({
    slot_id: slot, vehicle_id: v.id, start_at: start.toISOString(), end_at: new Date(start.getTime() + durationHours * 3_600_000).toISOString(),
  });
  const id = res.body.booking.id as string;
  const pay = await request(app).post("/payments/pay").set(auth(u)).send({ booking_id: id, method: "upi", idempotency_key: `gate-${id}` });
  const token = pay.body.booking.qr_token as string;
  await shiftWindow(id, startOffsetMin, durationHours);
  return { id, token, payload: toQrPayload(token) };
}

async function shiftWindow(id: string, startOffsetMin: number, durationHours: number) {
  const startAt = new Date(Date.now() + startOffsetMin * 60_000);
  const endAt = new Date(startAt.getTime() + durationHours * 3_600_000);
  await pool.query("alter table bookings disable trigger bookings_protect_immutability");
  await pool.query("update bookings set start_at = $2, end_at = $3 where id = $1", [id, startAt, endAt]);
  await pool.query("alter table bookings enable trigger bookings_protect_immutability");
  await pool.query("update parking_sessions set started_at = $2, booked_end_at = $3 where booking_id = $1", [id, startAt, endAt]);
}

const scan = (staff: TestUser, token: string, direction: "entry" | "exit") =>
  request(app).post("/gate/scan").set(auth(staff)).send({ token, direction });

describe("gate access control", () => {
  it("members cannot scan; staff and admins can; anonymous cannot", async () => {
    const member = await signup();
    const staff = await signupWithRole("staff");
    const admin = await signupWithRole("admin");
    expect((await scan(member, "PG1:whatever-token-value-0001", "entry")).status).toBe(403);
    expect((await request(app).post("/gate/scan").send({ token: "x", direction: "entry" })).status).toBe(401);
    expect((await scan(staff, "PG1:whatever-token-value-0001", "entry")).status).toBe(200);
    expect((await scan(admin, "PG1:whatever-token-value-0001", "entry")).status).toBe(200);
  });

  it("staff cannot reach admin-only routes", async () => {
    const staff = await signupWithRole("staff");
    const res = await request(app).patch("/parking/slots/00000000-0000-4000-8000-000000000000").set(auth(staff)).send({ notes: "x" });
    expect(res.status).toBe(403);
  });
});

describe("entry / exit flow", () => {
  it("valid pass: entry opens the session, a replay is idempotent, exit completes it and kills the pass", async () => {
    const u = await signup();
    const staff = await signupWithRole("staff");
    const p = await passFor(u, "L1-10", -10);

    const entry = await scan(staff, p.payload, "entry");
    expect(entry.body).toMatchObject({ ok: true, result: "ok", direction: "entry" });
    expect(entry.body.booking.slot).toBe("L1-10");
    expect(JSON.stringify(entry.body)).not.toContain(u.email);
    expect((await pool.query("select status from bookings where id = $1", [p.id])).rows[0].status).toBe("active");

    const replay = await scan(staff, p.payload, "entry");
    expect(replay.body).toMatchObject({ ok: true, result: "already_entered" });
    expect((await pool.query("select count(*)::int as n from parking_sessions where booking_id = $1", [p.id])).rows[0].n).toBe(1);

    const exit = await scan(staff, p.payload, "exit");
    expect(exit.body).toMatchObject({ ok: true, result: "ok", direction: "exit", overstay: { minutes: 0, total_paise: 0, status: "none" } });
    expect((await pool.query("select status, qr_revoked_at is not null as revoked from bookings where id = $1", [p.id])).rows[0]).toEqual({ status: "completed", revoked: true });

    expect((await scan(staff, p.payload, "exit")).body.result).toBe("already_exited");
    expect((await scan(staff, p.payload, "entry")).body.result).toBe("already_used");

    const scans = await pool.query("select direction, result from gate_scans order by created_at");
    expect(scans.rows.map((r) => `${r.direction}:${r.result}`)).toEqual([
      "entry:ok", "entry:already_entered", "exit:ok", "exit:already_exited", "entry:already_used",
    ]);
    const notes = await request(app).get("/notifications").set(auth(u));
    expect(notes.body.notifications.some((n: { title: string }) => n.title === "Parking ended")).toBe(true);
  });

  it("rejects: garbage, unknown token, too early, expired window, exit without entry, cancelled booking", async () => {
    const u = await signup();
    const staff = await signupWithRole("staff");

    expect((await scan(staff, "SP-20260101-ABCD", "entry")).body.result).toBe("invalid_token");
    expect((await scan(staff, toQrPayload("A".repeat(32)), "entry")).body.result).toBe("invalid_token");

    const early = await passFor(u, "L1-11", 120);
    const e = await scan(staff, early.payload, "entry");
    expect(e.body).toMatchObject({ ok: false, result: "too_early" });

    await shiftWindow(early.id, -240, 2); // window ended 2h ago
    expect((await scan(staff, early.payload, "entry")).body.result).toBe("expired");

    const noEntry = await passFor(u, "L1-12", -10);
    expect((await scan(staff, noEntry.payload, "exit")).body.result).toBe("not_entered");

    const cancelled = await passFor(u, "L1-13", 600);
    await request(app).post(`/bookings/${cancelled.id}/cancel`).set(auth(u)).send({});
    expect((await scan(staff, cancelled.payload, "entry")).body.result).toBe("cancelled");
  });

  it("allows entry shortly before start (grace) and late arrival inside the paid window", async () => {
    const u = await signup();
    const staff = await signupWithRole("staff");
    const soon = await passFor(u, "L1-14", 10); // starts in 10 min, early grace is 15
    expect((await scan(staff, soon.payload, "entry")).body.result).toBe("ok");
    const late = await passFor(u, "L1-15", -90); // arrives 90 min late, window is 2h
    expect((await scan(staff, late.payload, "entry")).body.result).toBe("ok");
  });

  it("two simultaneous entry scans create exactly one session entry", async () => {
    const u = await signup();
    const staff = await signupWithRole("staff");
    const p = await passFor(u, "L1-16", -5);
    const [a, b] = await Promise.all([scan(staff, p.payload, "entry"), scan(staff, p.payload, "entry")]);
    expect([a.body.result, b.body.result].sort()).toEqual(["already_entered", "ok"]);
    expect((await pool.query("select count(*)::int as n from parking_sessions")).rows[0].n).toBe(1);
  });

  it("exit after the booked end plus grace charges overstay (GST included) once", async () => {
    const u = await signup();
    const staff = await signupWithRole("staff");
    const p = await passFor(u, "L1-17", -90, 2); // arrives inside the window
    await scan(staff, p.payload, "entry");
    await shiftWindow(p.id, -180, 2); // ...and overstays: the booked window ended 60 min ago
    const exit = await scan(staff, p.payload, "exit");
    // 60 min past end - 15 min grace = 45 overstay min (+ a few seconds -> ceil'd minute can add 1)
    const o = exit.body.overstay;
    expect(o.minutes).toBeGreaterThanOrEqual(45);
    expect(o.minutes).toBeLessThanOrEqual(46);
    const base = Math.ceil((o.minutes * 5000) / 60);
    expect(o.total_paise).toBe(base + Math.floor((base * 1800 + 5000) / 10000));
    expect(o.status).toBe("paid"); // mock gateway settles instantly (original behaviour)
    await scan(staff, p.payload, "exit");
    expect((await pool.query("select count(*)::int as n from overstay_charges")).rows[0].n).toBe(1);
    const notes = await request(app).get("/notifications").set(auth(u));
    expect(notes.body.notifications.some((n: { title: string }) => n.title === "Overstay charge applied")).toBe(true);
  });
});

describe("QR pass privacy", () => {
  it("only the owner (and admin) can see the token, only while the pass is valid; reissue rotates it", async () => {
    const u = await signup();
    const other = await signup();
    const admin = await signupWithRole("admin");
    const staff = await signupWithRole("staff");
    const p = await passFor(u, "L1-18", 120);

    expect((await request(app).get(`/bookings/${p.id}`).set(auth(u))).body.booking.qr_token).toBe(p.token);
    expect((await request(app).get(`/bookings/${p.id}`).set(auth(admin))).body.booking.qr_token).toBe(p.token);
    expect((await request(app).get(`/bookings/${p.id}`).set(auth(other))).status).toBe(404);
    expect((await request(app).get(`/bookings/${p.id}`).set(auth(staff))).status).toBe(404);

    const re = await request(app).post(`/bookings/${p.id}/qr/reissue`).set(auth(u));
    expect(re.body.booking.qr_token).not.toBe(p.token);
    expect((await scan(staff, p.payload, "entry")).body.result).toBe("invalid_token");
    expect((await request(app).post(`/bookings/${p.id}/qr/reissue`).set(auth(other))).status).toBe(404);

    await request(app).post(`/bookings/${p.id}/cancel`).set(auth(u)).send({});
    expect((await request(app).get(`/bookings/${p.id}`).set(auth(u))).body.booking.qr_token).toBeNull();
  });
});

describe("sessions (self-service)", () => {
  it("shows the active session with live timers and lets the owner end it; others get 404", async () => {
    const u = await signup();
    const other = await signup();
    const staff = await signupWithRole("staff");
    const p = await passFor(u, "L1-19", -30);
    await scan(staff, p.payload, "entry");

    const active = await request(app).get("/sessions/active").set(auth(u));
    expect(active.body.session).toMatchObject({ bookingId: p.id, isActive: true, status: "active" });
    expect(active.body.session.secondsRemaining).toBeGreaterThan(0);
    expect((await request(app).get("/sessions/active").set(auth(other))).body.session).toBeNull();
    expect((await request(app).get(`/sessions/active?booking_id=${p.id}`).set(auth(other))).status).toBe(404);

    const sid = active.body.session.sessionId;
    expect((await request(app).post(`/sessions/${sid}/end`).set(auth(other))).status).toBe(404);
    const ended = await request(app).post(`/sessions/${sid}/end`).set(auth(u));
    expect(ended.body).toMatchObject({ sessionId: sid, overstayMinutes: 0, overstayTotalPaise: 0 });
    expect((await request(app).post(`/sessions/${sid}/end`).set(auth(u))).status).toBe(409);
    const list = await request(app).get("/sessions").set(auth(u));
    expect(list.body.sessions[0]).toMatchObject({ slotCode: "L1-19", status: "completed" });
  });
});

describe("background jobs", () => {
  it("expireStaleHolds, no-show, auto-end and the advisory lock", async () => {
    const u = await signup();
    const staff = await signupWithRole("staff");
    const v = await addVehicle(u);
    const start = slotTime(240);
    const hold = await request(app).post("/bookings").set(auth(u)).send({ slot_id: "L2-01", vehicle_id: v.id, start_at: start.toISOString(), end_at: new Date(start.getTime() + 3_600_000).toISOString() });
    await pool.query("update bookings set hold_expires_at = now() - interval '1 minute' where id = $1", [hold.body.booking.id]);
    expect(await runJob("expireStaleHolds")).toEqual({ ran: true, count: 1 });
    expect((await pool.query("select status from bookings where id = $1", [hold.body.booking.id])).rows[0].status).toBe("expired");

    const noShow = await passFor(u, "L2-02", -300, 2); // whole window passed, never scanned
    expect(await runJob("expireUnusedBookings")).toEqual({ ran: true, count: 1 });
    expect((await pool.query("select status from bookings where id = $1", [noShow.id])).rows[0].status).toBe("no_show");
    expect((await pool.query("select status from parking_sessions where booking_id = $1", [noShow.id])).rows[0].status).toBe("cancelled");

    const stuck = await passFor(u, "L2-03", -2000, 2);
    await shiftWindow(stuck.id, -1, 2);
    await scan(staff, stuck.payload, "entry");
    await pool.query("update parking_sessions set booked_end_at = now() - interval '13 hours', started_at = now() - interval '15 hours' where booking_id = $1", [stuck.id]);
    expect(await runJob("autoEndStaleSessions")).toEqual({ ran: true, count: 1 });
    expect((await pool.query("select status, auto_ended from parking_sessions where booking_id = $1", [stuck.id])).rows[0]).toEqual({ status: "auto_ended", auto_ended: true });
    const charge = (await pool.query("select overstay_minutes from overstay_charges")).rows[0];
    expect(charge.overstay_minutes).toBe(12 * 60 - 15);

    // a second instance holding the lock makes the run skip instead of double-running
    const holder = await pool.connect();
    const key = (() => { let h = 0; for (const ch of "expireStaleHolds") h = (h * 31 + ch.charCodeAt(0)) | 0; return h; })();
    await holder.query("select pg_advisory_lock($1)", [key]);
    expect(await runJob("expireStaleHolds")).toEqual({ ran: false, reason: "locked" });
    await holder.query("select pg_advisory_unlock($1)", [key]);
    holder.release();
  });

  it("the internal job endpoint needs the cron secret", async () => {
    expect((await request(app).post("/internal/jobs/expireStaleHolds")).status).toBe(401);
    expect((await request(app).post("/internal/jobs/expireStaleHolds").set("x-cron-secret", "nope")).status).toBe(401);
    const ok = await request(app).post("/internal/jobs/expireStaleHolds").set("x-cron-secret", "test-cron-secret-0000");
    expect(ok.status).toBe(200);
    expect((await request(app).post("/internal/jobs/nope").set("x-cron-secret", "test-cron-secret-0000")).status).toBe(404);
  });
});
