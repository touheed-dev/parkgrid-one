import { hash, verify } from "@node-rs/argon2";
import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import { pool } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { AppError } from "../../lib/errors.js";
import { signAccessToken } from "../../lib/jwt.js";
import { sendMail } from "../../lib/mailer.js";
import { randomToken, sha256Hex } from "../../lib/tokens.js";
import { invalidateIdentity, type Role } from "../../middleware/auth.js";
import * as repo from "./repo.js";
import { isTrivialPassword } from "./schema.js";

const GENERIC_LOGIN_ERROR = "Invalid email or password";
const MAX_FAILURES_BEFORE_LOCK = 5;
// Used to burn the same CPU time when the email is unknown (no account enumeration by timing).
const DUMMY_HASH_PROMISE = hash("parkgrid-dummy-password");

export interface AuthContext {
  userAgent: string | null;
  ip: string | null;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; email: string; role: Role; full_name: string | null };
}

function ttlSeconds(ttl: string): number {
  const m = /^(\d+)([smhd])$/.exec(ttl);
  if (!m) return 900;
  const n = Number(m[1]);
  return n * ({ s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"]);
}

async function issueSession(
  user: { id: string; email: string; role: Role; full_name: string | null },
  familyId: string,
  ctx: AuthContext,
  db?: Parameters<typeof repo.insertRefreshToken>[0],
): Promise<SessionTokens> {
  const refreshToken = randomToken(32);
  await repo.insertRefreshToken(db ?? pool, {
    userId: user.id,
    familyId,
    tokenHash: sha256Hex(refreshToken),
    expiresAt: new Date(Date.now() + env.REFRESH_TTL_DAYS * 86_400_000),
    userAgent: ctx.userAgent?.slice(0, 300) ?? null,
    ip: ctx.ip,
  });
  const accessToken = await signAccessToken({ sub: user.id, role: user.role, sid: familyId });
  return { accessToken, refreshToken, expiresIn: ttlSeconds(env.JWT_ACCESS_TTL), user };
}

export async function signup(
  input: { email: string; password: string; full_name?: string | undefined },
  ctx: AuthContext,
): Promise<SessionTokens> {
  if (isTrivialPassword(input.password, input.email)) {
    throw AppError.badRequest("Please choose a stronger password", "WEAK_PASSWORD");
  }
  const passwordHash = await hash(input.password);
  return withTransaction(async (tx) => {
    let userId: string;
    try {
      userId = await repo.createUserWithProfile(tx, input.email, passwordHash, input.full_name ?? null);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw AppError.conflict("An account with this email already exists", "EMAIL_TAKEN");
      }
      throw err;
    }
    return issueSession(
      { id: userId, email: input.email, role: "member", full_name: input.full_name ?? null },
      randomUUID(),
      ctx,
      tx,
    );
  });
}

export async function login(input: { email: string; password: string }, ctx: AuthContext): Promise<SessionTokens> {
  const user = await repo.findUserByEmail(input.email);
  if (!user) {
    await verify(await DUMMY_HASH_PROMISE, input.password).catch(() => false);
    throw AppError.unauthorized(GENERIC_LOGIN_ERROR, "INVALID_CREDENTIALS");
  }
  const locked = user.locked_until !== null && user.locked_until.getTime() > Date.now();
  const ok = await verify(user.password_hash, input.password).catch(() => false);
  if (locked || !ok || user.disabled_at) {
    if (!ok && !locked) {
      const failures = user.failed_login_count + 1;
      // 5 failures -> 15 min lock, doubling per extra failure, capped at 4 h.
      const lockMin =
        failures >= MAX_FAILURES_BEFORE_LOCK ? Math.min(15 * 2 ** (failures - MAX_FAILURES_BEFORE_LOCK), 240) : 0;
      await repo.recordFailedLogin(user.id, lockMin ? new Date(Date.now() + lockMin * 60_000) : null);
    }
    // Same message for wrong password, locked and disabled accounts.
    throw AppError.unauthorized(GENERIC_LOGIN_ERROR, "INVALID_CREDENTIALS");
  }
  await repo.recordSuccessfulLogin(user.id);
  return issueSession({ id: user.id, email: user.email, role: user.role, full_name: user.full_name }, randomUUID(), ctx);
}

/** Rotate a refresh token. Replaying an already-rotated token revokes the whole family. */
export async function refresh(refreshToken: string, ctx: AuthContext): Promise<SessionTokens> {
  const tokenHash = sha256Hex(refreshToken);
  const outcome = await withTransaction(async (tx) => {
    const rec = await repo.lockRefreshToken(tx, tokenHash);
    if (!rec) return { kind: "invalid" as const };
    if (rec.revoked_at || rec.replaced_by) {
      await repo.revokeFamily(rec.family_id, tx); // reuse detected
      return { kind: "reused" as const };
    }
    if (rec.expires_at.getTime() <= Date.now()) return { kind: "invalid" as const };
    const user = await repo.findUserById(rec.user_id, tx);
    if (!user || user.disabled_at) {
      await repo.revokeFamily(rec.family_id, tx);
      return { kind: "invalid" as const };
    }
    const session = await issueSession(
      { id: user.id, email: user.email, role: user.role, full_name: user.full_name },
      rec.family_id,
      ctx,
      tx,
    );
    const newRow = await tx.query<{ id: string }>("select id from refresh_tokens where token_hash = $1", [
      sha256Hex(session.refreshToken),
    ]);
    await repo.markRotated(tx, rec.id, newRow.rows[0]!.id);
    return { kind: "ok" as const, session };
  });
  if (outcome.kind === "reused") {
    throw AppError.unauthorized("Session expired. Please sign in again.", "REFRESH_REUSED");
  }
  if (outcome.kind === "invalid") {
    throw AppError.unauthorized("Session expired. Please sign in again.", "INVALID_REFRESH");
  }
  return outcome.session;
}

export async function logout(refreshToken: string | undefined, sessionFamilyId: string | null): Promise<void> {
  const family = refreshToken ? await repo.familyOfToken(sha256Hex(refreshToken)) : sessionFamilyId;
  if (family) await repo.revokeFamily(family);
}

export async function logoutAll(userId: string): Promise<void> {
  await repo.revokeAllForUser(userId, null);
}

export async function forgotPassword(emailAddr: string): Promise<void> {
  const user = await repo.findUserByEmail(emailAddr);
  if (!user || user.disabled_at) return; // identical response either way
  const token = randomToken(32);
  await repo.insertResetToken(user.id, sha256Hex(token), new Date(Date.now() + env.PASSWORD_RESET_TTL_MIN * 60_000));
  const link = `${env.APP_URL}/auth/reset-password?token=${encodeURIComponent(token)}`;
  await sendMail({
    to: user.email,
    subject: "Reset your ParkGrid password",
    text: `Use this link to choose a new password (valid for ${env.PASSWORD_RESET_TTL_MIN} minutes):\n\n${link}\n\nIf you did not request this, you can ignore this email.`,
  });
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const passwordHash = await hash(newPassword);
  const userId = await withTransaction(async (tx) => {
    const used = await repo.consumeResetToken(tx, sha256Hex(token));
    if (!used) throw AppError.badRequest("This reset link is invalid or has expired", "INVALID_RESET_TOKEN");
    const user = await repo.findUserById(used.user_id, tx);
    if (user && isTrivialPassword(newPassword, user.email)) {
      throw AppError.badRequest("Please choose a stronger password", "WEAK_PASSWORD");
    }
    await repo.setPassword(tx, used.user_id, passwordHash);
    await repo.revokeAllForUser(used.user_id, null, tx);
    return used.user_id;
  });
  invalidateIdentity(userId);
}

export async function changePassword(
  userId: string,
  sessionFamilyId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await repo.findUserById(userId);
  if (!user || !(await verify(user.password_hash, currentPassword).catch(() => false))) {
    throw AppError.badRequest("Current password is incorrect", "INVALID_CURRENT_PASSWORD");
  }
  if (isTrivialPassword(newPassword, user.email)) {
    throw AppError.badRequest("Please choose a stronger password", "WEAK_PASSWORD");
  }
  const passwordHash = await hash(newPassword);
  await withTransaction(async (tx) => {
    await repo.setPassword(tx, userId, passwordHash);
    await repo.revokeAllForUser(userId, sessionFamilyId, tx); // keep this device signed in
  });
}
