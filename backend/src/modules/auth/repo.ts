import type { Queryable } from "../../db/pool.js";
import { query } from "../../db/pool.js";
import type { Role } from "../../middleware/auth.js";

export interface UserRecord {
  id: string;
  email: string;
  password_hash: string;
  disabled_at: Date | null;
  failed_login_count: number;
  locked_until: Date | null;
  role: Role;
  full_name: string | null;
}

export interface RefreshRecord {
  id: string;
  user_id: string;
  family_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
}

export async function createUserWithProfile(
  db: Queryable,
  emailAddr: string,
  passwordHash: string,
  fullName: string | null,
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    "insert into users (email, password_hash) values ($1, $2) returning id",
    [emailAddr, passwordHash],
    db,
  );
  const id = rows[0]!.id;
  // Role is ALWAYS 'member' here; only the admin endpoint can change it.
  await query("insert into profiles (id, full_name, role) values ($1, $2, 'member')", [id, fullName], db);
  return id;
}

export async function findUserByEmail(emailAddr: string): Promise<UserRecord | null> {
  const { rows } = await query<UserRecord>(
    `select u.id, u.email::text as email, u.password_hash, u.disabled_at, u.failed_login_count,
            u.locked_until, p.role, p.full_name
       from users u join profiles p on p.id = u.id
      where u.email = $1`,
    [emailAddr],
  );
  return rows[0] ?? null;
}

export async function findUserById(id: string, db?: Queryable): Promise<UserRecord | null> {
  const { rows } = await query<UserRecord>(
    `select u.id, u.email::text as email, u.password_hash, u.disabled_at, u.failed_login_count,
            u.locked_until, p.role, p.full_name
       from users u join profiles p on p.id = u.id
      where u.id = $1`,
    [id],
    db,
  );
  return rows[0] ?? null;
}

export async function recordFailedLogin(userId: string, lockUntil: Date | null): Promise<void> {
  await query(
    "update users set failed_login_count = failed_login_count + 1, locked_until = coalesce($2, locked_until) where id = $1",
    [userId, lockUntil],
  );
}

export async function recordSuccessfulLogin(userId: string): Promise<void> {
  await query(
    "update users set failed_login_count = 0, locked_until = null, last_sign_in_at = now() where id = $1",
    [userId],
  );
}

export async function insertRefreshToken(
  db: Queryable,
  p: { userId: string; familyId: string; tokenHash: string; expiresAt: Date; userAgent: string | null; ip: string | null },
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `insert into refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [p.userId, p.familyId, p.tokenHash, p.expiresAt, p.userAgent, p.ip],
    db,
  );
  return rows[0]!.id;
}

export async function lockRefreshToken(db: Queryable, tokenHash: string): Promise<RefreshRecord | null> {
  const { rows } = await query<RefreshRecord>(
    `select id, user_id, family_id, expires_at, revoked_at, replaced_by
       from refresh_tokens where token_hash = $1 for update`,
    [tokenHash],
    db,
  );
  return rows[0] ?? null;
}

export async function markRotated(db: Queryable, oldId: string, newId: string): Promise<void> {
  await query("update refresh_tokens set revoked_at = now(), replaced_by = $2 where id = $1", [oldId, newId], db);
}

export async function revokeFamily(familyId: string, db?: Queryable): Promise<void> {
  await query("update refresh_tokens set revoked_at = now() where family_id = $1 and revoked_at is null", [familyId], db);
}

export async function revokeAllForUser(userId: string, exceptFamily: string | null, db?: Queryable): Promise<void> {
  await query(
    `update refresh_tokens set revoked_at = now()
      where user_id = $1 and revoked_at is null and ($2::uuid is null or family_id <> $2::uuid)`,
    [userId, exceptFamily],
    db,
  );
}

export async function familyOfToken(tokenHash: string): Promise<string | null> {
  const { rows } = await query<{ family_id: string }>("select family_id from refresh_tokens where token_hash = $1", [tokenHash]);
  return rows[0]?.family_id ?? null;
}

export async function insertResetToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
  // Invalidate earlier unused links so only the newest works.
  await query("update password_reset_tokens set used_at = now() where user_id = $1 and used_at is null", [userId]);
  await query("insert into password_reset_tokens (user_id, token_hash, expires_at) values ($1, $2, $3)", [userId, tokenHash, expiresAt]);
}

export async function consumeResetToken(db: Queryable, tokenHash: string): Promise<{ user_id: string } | null> {
  const { rows } = await query<{ user_id: string }>(
    `update password_reset_tokens set used_at = now()
      where token_hash = $1 and used_at is null and expires_at > now()
      returning user_id`,
    [tokenHash],
    db,
  );
  return rows[0] ?? null;
}

export async function setPassword(db: Queryable, userId: string, passwordHash: string): Promise<void> {
  await query(
    "update users set password_hash = $2, failed_login_count = 0, locked_until = null where id = $1",
    [userId, passwordHash],
    db,
  );
}
