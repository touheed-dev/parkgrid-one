import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { io as connect, type Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { attachRealtime } from "../src/modules/realtime/socket.js";
import { addVehicle, app, auth, resetDb, signup, signupWithRole, type TestUser } from "./helpers.js";

let server: Server;
let url: string;
let rt: ReturnType<typeof attachRealtime>;
const sockets: Socket[] = [];

beforeAll(async () => {
  server = createServer(app);
  rt = attachRealtime(server);
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
  await new Promise((r) => setTimeout(r, 400)); // let the LISTEN connection come up
});
afterAll(async () => {
  await rt.close();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});
beforeEach(resetDb);
afterEach(() => {
  while (sockets.length) sockets.pop()?.close();
});

function open(user: TestUser | null): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(url, { auth: user ? { token: user.token } : {}, transports: ["websocket"], reconnection: false });
    sockets.push(s);
    s.on("connect", () => resolve(s));
    s.on("connect_error", (e) => reject(e));
  });
}

function collect(s: Socket, events: string[]): Record<string, unknown[]> {
  const got: Record<string, unknown[]> = {};
  for (const e of events) {
    got[e] = [];
    s.on(e, (payload) => got[e]!.push(payload));
  }
  return got;
}
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

function slotTime(minutesAhead: number): Date {
  const d = new Date(Date.now() + minutesAhead * 60_000);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(Math.ceil(d.getUTCMinutes() / 15) * 15);
  return d;
}

describe("socket authentication", () => {
  it("refuses anonymous and invalid-token connections", async () => {
    await expect(open(null)).rejects.toThrow("UNAUTHORIZED");
    await expect(open({ token: "garbage" } as TestUser)).rejects.toThrow("UNAUTHORIZED");
  });
  it("accepts a valid access token", async () => {
    const u = await signup();
    const s = await open(u);
    expect(s.connected).toBe(true);
  });
  it("refuses disabled users", async () => {
    const u = await signup();
    await pool.query("update users set disabled_at = now() where id = $1", [u.id]);
    const { clearIdentityCache } = await import("../src/middleware/auth.js");
    clearIdentityCache();
    await expect(open(u)).rejects.toThrow("UNAUTHORIZED");
  });
});

describe("event routing", () => {
  it("a booking pushes availability to everyone, but the booking event ONLY to its owner (and admins)", async () => {
    const owner = await signup();
    const stranger = await signup();
    const admin = await signupWithRole("admin");
    const [so, ss, sa] = await Promise.all([open(owner), open(stranger), open(admin)]);
    const evts = ["availability_changed", "booking_changed", "admin_booking_changed", "notification_created", "payment_changed"];
    const go = collect(so, evts);
    const gs = collect(ss, evts);
    const ga = collect(sa, evts);

    const v = await addVehicle(owner);
    const start = slotTime(240);
    const res = await request(app).post("/bookings").set(auth(owner)).send({
      slot_id: "L1-20", vehicle_id: v.id, start_at: start.toISOString(), end_at: new Date(start.getTime() + 3_600_000).toISOString(),
    });
    expect(res.status).toBe(201);
    await settle();

    // everyone authenticated learns that availability changed...
    expect(go["availability_changed"]!.length).toBeGreaterThan(0);
    expect(gs["availability_changed"]!.length).toBeGreaterThan(0);
    // ...but only the owner gets the booking event, the stranger gets NOTHING private
    expect(go["booking_changed"]!.length).toBeGreaterThan(0);
    expect(gs["booking_changed"]).toHaveLength(0);
    expect(gs["admin_booking_changed"]).toHaveLength(0);
    expect(gs["notification_created"]).toHaveLength(0);
    // admins get the admin-flavoured event
    expect(ga["admin_booking_changed"]!.length).toBeGreaterThan(0);
    expect(JSON.stringify(gs)).not.toContain(owner.id);
  });

  it("payment confirmation pushes notification + payment events to the payer only", async () => {
    const payer = await signup();
    const other = await signup();
    const [sp, so] = await Promise.all([open(payer), open(other)]);
    const evts = ["notification_created", "payment_changed", "booking_changed"];
    const gp = collect(sp, evts);
    const go = collect(so, evts);
    const v = await addVehicle(payer);
    const start = slotTime(300);
    const b = await request(app).post("/bookings").set(auth(payer)).send({
      slot_id: "L1-21", vehicle_id: v.id, start_at: start.toISOString(), end_at: new Date(start.getTime() + 3_600_000).toISOString(),
    });
    await request(app).post("/payments/pay").set(auth(payer)).send({ booking_id: b.body.booking.id, method: "upi", idempotency_key: "rt-key-0001" });
    await settle();
    expect(gp["notification_created"]!.length).toBeGreaterThan(0);
    expect(gp["payment_changed"]!.length).toBeGreaterThan(0);
    expect(go["notification_created"]).toHaveLength(0);
    expect(go["payment_changed"]).toHaveLength(0);
    expect(go["booking_changed"]).toHaveLength(0);
  });

  it("a member cannot hijack the admin room by sending an auth event with someone else's token", async () => {
    const member = await signup();
    const admin = await signupWithRole("admin");
    const sm = await open(member);
    const ack = await new Promise<boolean>((resolve) => {
      sm.emit("auth", { token: admin.token }, (ok: boolean) => resolve(ok));
    });
    expect(ack).toBe(false); // identity change refused, socket dropped
    await settle(200);
    expect(sm.connected).toBe(false);
  });

  it("re-auth with a fresh token for the SAME user is accepted", async () => {
    const u = await signup();
    const s = await open(u);
    const refreshed = await request(app).post("/auth/refresh").send({ refreshToken: u.refreshToken });
    const ack = await new Promise<boolean>((resolve) => s.emit("auth", { token: refreshed.body.accessToken }, (ok: boolean) => resolve(ok)));
    expect(ack).toBe(true);
    expect(s.connected).toBe(true);
  });
});
