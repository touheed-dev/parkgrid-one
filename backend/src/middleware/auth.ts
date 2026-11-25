import type { NextFunction, Request, Response } from "express";
import { query } from "../db/pool.js";
import { AppError } from "../lib/errors.js";
import { verifyAccessToken } from "../lib/jwt.js";

export type Role = "member" | "staff" | "admin";

export interface AuthUser {
  id: string;
  role: Role;
  sessionId: string;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
    rawBody?: Buffer;
  }
}

interface CachedIdentity {
  role: Role;
  disabled: boolean;
  expiresAt: number;
}

// The role in the JWT is NOT trusted for authorisation: we re-read it from the DB, cached for a
// short time, so demoting/disabling a user takes effect within seconds.
const IDENTITY_TTL_MS = 30_000;
const identityCache = new Map<string, CachedIdentity>();

export function invalidateIdentity(userId: string): void {
  identityCache.delete(userId);
}

export function clearIdentityCache(): void {
  identityCache.clear();
}

async function loadIdentity(userId: string): Promise<CachedIdentity | null> {
  const hit = identityCache.get(userId);
  if (hit && hit.expiresAt > Date.now()) return hit;
  const { rows } = await query<{ role: Role; disabled_at: Date | null }>(
    `select p.role, u.disabled_at
       from users u join profiles p on p.id = u.id
      where u.id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) {
    identityCache.delete(userId);
    return null;
  }
  const identity: CachedIdentity = {
    role: row.role,
    disabled: row.disabled_at !== null,
    expiresAt: Date.now() + IDENTITY_TTL_MS,
  };
  identityCache.set(userId, identity);
  return identity;
}

/** Current role/disabled state of a user (30 s cache). Used by long-lived connections to re-check access. */
export async function currentIdentity(userId: string): Promise<{ role: Role; disabled: boolean } | null> {
  const i = await loadIdentity(userId);
  return i ? { role: i.role, disabled: i.disabled } : null;
}

export async function authenticateToken(token: string): Promise<AuthUser> {
  let claims;
  try {
    claims = await verifyAccessToken(token);
  } catch {
    throw AppError.unauthorized("Invalid or expired token", "INVALID_TOKEN");
  }
  const identity = await loadIdentity(claims.sub);
  if (!identity || identity.disabled) {
    throw AppError.unauthorized("Account not available", "ACCOUNT_DISABLED");
  }
  return { id: claims.sub, role: identity.role, sessionId: claims.sid };
}

/** Requires `Authorization: Bearer <access token>`. Attaches `req.user`. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) {
    throw AppError.unauthorized();
  }
  const token = header.slice(7).trim();
  if (!token) throw AppError.unauthorized();
  req.user = await authenticateToken(token);
  next();
}

/** Role gate. `admin` always passes. Must run after requireAuth. */
export function requireRole(...allowed: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) throw AppError.unauthorized();
    if (user.role === "admin" || allowed.includes(user.role)) {
      next();
      return;
    }
    throw AppError.forbidden();
  };
}

/** Strictly admin-only (staff is NOT enough). */
export const requireAdmin = requireRole();

/** Helper for handlers: the authenticated user (guaranteed after requireAuth). */
export function me(req: Request): AuthUser {
  if (!req.user) throw AppError.unauthorized();
  return req.user;
}
