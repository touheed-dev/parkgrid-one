import { readFileSync } from "node:fs";
import request from "supertest";
import { createApp } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { clearIdentityCache } from "../src/middleware/auth.js";

export const app = createApp();

/** Wipe all per-test data but keep migrations + parking seed. */
export async function resetDb(): Promise<void> {
  await pool.query(`
    truncate table kb_chunks, kb_documents, gate_scans, webhook_events, admin_audit_log, notifications,
      overstay_charges, parking_sessions, payment_refunds, payments, bookings, vehicles,
      password_reset_tokens, refresh_tokens, profiles, users restart identity cascade`);
  await pool.query("delete from pricing_settings");
  await pool.query("insert into pricing_settings (id) values (true)");
  await pool.query(readFileSync("seeds/parking.sql", "utf8"));
  await pool.query("update parking_slots set admin_status = 'active', hourly_rate_paise = case when slot_type = 'ev' then 7000 else 5000 end");
  clearIdentityCache();
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  token: string;
  refreshToken: string;
}

let counter = 0;
export async function signup(overrides: { email?: string; password?: string; full_name?: string } = {}): Promise<TestUser> {
  counter += 1;
  const email = overrides.email ?? `user${counter}-${Date.now()}@example.com`;
  const password = overrides.password ?? "Sup3r-Secret-Pass";
  const res = await request(app)
    .post("/auth/signup")
    .send({ email, password, full_name: overrides.full_name ?? "Test User" });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.user.id, email, password, token: res.body.accessToken, refreshToken: res.body.refreshToken };
}

export async function setRole(userId: string, role: "member" | "staff" | "admin"): Promise<void> {
  await pool.query("update profiles set role = $2 where id = $1", [userId, role]);
  clearIdentityCache();
}

export async function signupWithRole(role: "member" | "staff" | "admin"): Promise<TestUser> {
  const u = await signup();
  if (role !== "member") await setRole(u.id, role);
  return u;
}

export const auth = (u: TestUser): { Authorization: string } => ({ Authorization: `Bearer ${u.token}` });

export async function addVehicle(u: TestUser, over: Record<string, unknown> = {}): Promise<{ id: string; [k: string]: unknown }> {
  counter += 1;
  const res = await request(app)
    .post("/vehicles")
    .set(auth(u))
    .send({ plate_number: `MH12AB${String(1000 + counter).slice(-4)}`, vehicle_type: "car", ...over });
  if (res.status !== 201) throw new Error(`addVehicle failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.vehicle;
}
