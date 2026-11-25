# Security

RLS is gone, so **every route declares auth, role and ownership**, and every suite has IDOR tests.

| Area | Auth | Role | Ownership rule |
|---|---|---|---|
| `/auth/*` signup, login, refresh, logout, forgot/reset | none | – | refresh token hash lookup |
| `/auth/me`, `/auth/logout-all`, `/auth/change-password` | Bearer | any | own user |
| `/profile`, `/vehicles`, `/notifications` | Bearer | any | `WHERE user_id = $me`; others' rows → 404 |
| `/parking/*` read | Bearer | any (admins/staff also see bay → booking) | – |
| `PATCH /parking/slots/:id` | Bearer | admin | – (audited) |
| `/bookings/*` | Bearer | any | owner (admin may read); 404 otherwise |
| `/payments/*` | Bearer | any | booking/payment owner |
| `/webhooks/razorpay` | HMAC signature | – | order lookup |
| `/sessions/*` | Bearer | any | owner (admin may read) |
| `/gate/*` | Bearer | staff, admin | – |
| `/admin/*`, `/admin/kb/*` | Bearer | **admin only** (staff = 403) | – (audited) |
| `/api/chat` | Bearer | any | tools scoped to the token's user |
| `/internal/jobs/:name` | `x-cron-secret` | – | constant-time compare |

Verified by tests: member → admin/gate routes 403, staff → admin routes 403, anonymous 401, user B cannot read/cancel/pay/scan/see the QR of user A's booking, vehicle, payment, session or notification (404), client-supplied `status/price/role/user_id/paid` rejected by `z.strictObject`.

## Controls
- **Passwords**: argon2id (`@node-rs/argon2`), 8–128 chars, small deny-list, unknown-email logins burn the same CPU; 5 failures lock the account (15 min doubling, cap 4 h) with the same generic message; per-IP rate limits on auth routes.
- **Tokens**: HS256 JWT (15 min; one issuer/verifier, so no key distribution needed), role **re-read from the database** (30 s cache, invalidated on role change/disable). Refresh token: 256-bit random, **stored hashed**, rotated on every use, **reuse detection revokes the family**. Reset tokens: hashed, 30 min, single-use, reset revokes all sessions.
- **Browser storage trade-off**: tokens sit in `localStorage` ("remember") or `sessionStorage`, as the app already did. That is readable by injected script (XSS); httpOnly cookies would need CSRF defence and a cookie-aware API. Mitigations: short access lifetime, rotating refresh, CSP via helmet on the API, no `dangerouslySetInnerHTML` added.
- **Input**: zod on every body/query/param; parameterised SQL only; dynamic `ORDER BY` is never taken from input; LIKE patterns escaped.
- **Headers/limits**: helmet, CORS allow-list (`CORS_ORIGINS`), 100 KB JSON limit, `trust proxy` configurable, stricter limits on auth, payments, gate and chat.
- **Secrets**: only via env, validated at boot (JWT secret ≥32 chars, Razorpay keys required when selected); `.env` ignored; logs redact authorization, passwords, tokens, signatures; CI fails if a secret name appears in the browser bundle.
- **Errors**: one handler, pg codes mapped (23505→409, 23P01→`SLOT_TAKEN`, 23503→409, 23514→400, deadlock/serialization retried 3×), no stack traces to clients in production.
- **Money**: integer paise, server-side prices, immutable payment rows, idempotency keys, webhook dedupe, constant-time signature checks.
- **AI**: context and user text treated as data, retrieval threshold, prompt never contains secrets (checked by the eval script), per-user rate limit and token cap.
- `npm audit --omit=dev`: no high/critical. 3 *moderate* advisories remain in `node-pg-migrate`'s `glob`/`minimatch` (ReDoS on crafted glob patterns). The tool only runs at deploy time against our own migration directory, never on request data.

## Not done / out of scope
Email verification, 2FA, per-device session list UI, WAF, secrets rotation tooling, penetration test.
