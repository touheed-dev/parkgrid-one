import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { sentMails } from "../src/lib/mailer.js";
import { app, auth, resetDb, setRole, signup } from "./helpers.js";

beforeEach(resetDb);
afterAll(async () => {
  await pool.end();
});

describe("signup / login / me", () => {
  it("signs up, then /auth/me returns the member", async () => {
    const u = await signup({ full_name: "Asha Rao" });
    const me = await request(app).get("/auth/me").set(auth(u));
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ email: u.email, role: "member", full_name: "Asha Rao" });
    expect(JSON.stringify(me.body)).not.toContain("password");
  });

  it("rejects duplicate email, weak passwords and unknown fields", async () => {
    const u = await signup();
    const dup = await request(app).post("/auth/signup").send({ email: u.email.toUpperCase(), password: "Another-Pass-123" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("EMAIL_TAKEN");

    const weak = await request(app).post("/auth/signup").send({ email: "weak@example.com", password: "password123" });
    expect(weak.status).toBe(400);
    const short = await request(app).post("/auth/signup").send({ email: "short@example.com", password: "abc" });
    expect(short.status).toBe(400);

    // mass-assignment: a client can never choose its own role
    const evil = await request(app).post("/auth/signup").send({ email: "evil@example.com", password: "Valid-Pass-12345", role: "admin" });
    expect(evil.status).toBe(400);
  });

  it("gives the same generic error for unknown email and wrong password", async () => {
    const u = await signup();
    const a = await request(app).post("/auth/login").send({ email: u.email, password: "Wrong-Password-1" });
    const b = await request(app).post("/auth/login").send({ email: "nobody@example.com", password: "Wrong-Password-1" });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
    expect(a.body.error.message).toBe("Invalid email or password");
  });

  it("locks the account after repeated failures (even for the right password) without revealing it", async () => {
    const u = await signup();
    for (let i = 0; i < 5; i++) {
      await request(app).post("/auth/login").send({ email: u.email, password: "Wrong-Password-1" });
    }
    const res = await request(app).post("/auth/login").send({ email: u.email, password: u.password });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("Invalid email or password");
  });

  it("rejects missing, garbage and tampered bearer tokens", async () => {
    const u = await signup();
    expect((await request(app).get("/auth/me")).status).toBe(401);
    expect((await request(app).get("/auth/me").set({ Authorization: "Bearer nope" })).status).toBe(401);
    const tampered = u.token.slice(0, -3) + (u.token.endsWith("aaa") ? "bbb" : "aaa");
    expect((await request(app).get("/auth/me").set({ Authorization: `Bearer ${tampered}` })).status).toBe(401);
  });
});

describe("refresh token rotation", () => {
  it("rotates on every refresh and detects reuse of an old token (family revoked)", async () => {
    const u = await signup();
    const r1 = await request(app).post("/auth/refresh").send({ refreshToken: u.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(u.refreshToken);

    // replaying the OLD token => reuse detected
    const replay = await request(app).post("/auth/refresh").send({ refreshToken: u.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("REFRESH_REUSED");

    // ...and the NEW token from the same family is now dead too
    const afterReuse = await request(app).post("/auth/refresh").send({ refreshToken: r1.body.refreshToken });
    expect(afterReuse.status).toBe(401);
  });

  it("logout revokes the session's refresh token", async () => {
    const u = await signup();
    await request(app).post("/auth/logout").send({ refreshToken: u.refreshToken }).expect(200);
    const res = await request(app).post("/auth/refresh").send({ refreshToken: u.refreshToken });
    expect(res.status).toBe(401);
  });

  it("logout-all revokes every session", async () => {
    const u = await signup();
    const second = await request(app).post("/auth/login").send({ email: u.email, password: u.password });
    await request(app).post("/auth/logout-all").set(auth(u)).expect(200);
    expect((await request(app).post("/auth/refresh").send({ refreshToken: u.refreshToken })).status).toBe(401);
    expect((await request(app).post("/auth/refresh").send({ refreshToken: second.body.refreshToken })).status).toBe(401);
  });
});

describe("password reset", () => {
  it("answers identically for known and unknown emails, and a link works once", async () => {
    const u = await signup();
    sentMails.length = 0;
    const known = await request(app).post("/auth/forgot-password").send({ email: u.email });
    const unknown = await request(app).post("/auth/forgot-password").send({ email: "ghost@example.com" });
    expect(known.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    expect(sentMails).toHaveLength(1);

    const token = /token=([^\s&]+)/.exec(sentMails[0]!.text)![1]!;
    const reset = await request(app).post("/auth/reset-password").send({ token: decodeURIComponent(token), password: "Brand-New-Pass-99" });
    expect(reset.status).toBe(200);
    const reuse = await request(app).post("/auth/reset-password").send({ token: decodeURIComponent(token), password: "Another-New-Pass-99" });
    expect(reuse.status).toBe(400);

    // old sessions are gone, new password works
    expect((await request(app).post("/auth/refresh").send({ refreshToken: u.refreshToken })).status).toBe(401);
    expect((await request(app).post("/auth/login").send({ email: u.email, password: "Brand-New-Pass-99" })).status).toBe(200);
  });
});

describe("authorisation", () => {
  it("a member cannot promote themselves through the profile API", async () => {
    const u = await signup();
    const res = await request(app).patch("/profile").set(auth(u)).send({ full_name: "Mallory", role: "admin" });
    expect(res.status).toBe(400);
    const ok = await request(app).patch("/profile").set(auth(u)).send({ full_name: "Mallory", phone: "98765 43210" });
    expect(ok.status).toBe(200);
    expect(ok.body.profile.role).toBe("member");
    expect(ok.body.profile.phone).toBe("+919876543210");
  });

  it("demoting or disabling a user takes effect without waiting for token expiry", async () => {
    const u = await signup();
    await setRole(u.id, "admin");
    expect((await request(app).get("/auth/me").set(auth(u))).body.user.role).toBe("admin");
    await setRole(u.id, "member");
    expect((await request(app).get("/auth/me").set(auth(u))).body.user.role).toBe("member");
    await pool.query("update users set disabled_at = now() where id = $1", [u.id]);
    const { clearIdentityCache } = await import("../src/middleware/auth.js");
    clearIdentityCache();
    expect((await request(app).get("/auth/me").set(auth(u))).status).toBe(401);
  });

  it("change-password requires the current password", async () => {
    const u = await signup();
    const bad = await request(app).post("/auth/change-password").set(auth(u)).send({ currentPassword: "nope-nope-1", newPassword: "Brand-New-Pass-99" });
    expect(bad.status).toBe(400);
    const ok = await request(app).post("/auth/change-password").set(auth(u)).send({ currentPassword: u.password, newPassword: "Brand-New-Pass-99" });
    expect(ok.status).toBe(200);
  });
});
