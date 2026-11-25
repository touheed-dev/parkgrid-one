import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** URL-safe random token with `bytes` bytes of entropy (default 256 bit). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time string comparison (never compare secrets/signatures with ===). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const QR_PREFIX = "PG1:";

/** QR pass token: 192-bit opaque random value. No personal data, no booking id inside. */
export function newQrToken(): string {
  return randomToken(24);
}

/** The string encoded in the QR image: `PG1:` (format/version) + token. */
export function toQrPayload(token: string): string {
  return QR_PREFIX + token;
}

export function parseQrPayload(payload: string): string | null {
  const p = payload.trim();
  if (!p.startsWith(QR_PREFIX)) return null;
  const token = p.slice(QR_PREFIX.length);
  return /^[A-Za-z0-9_-]{20,64}$/.test(token) ? token : null;
}
