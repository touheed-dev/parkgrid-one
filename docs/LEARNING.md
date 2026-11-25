# What I learned (viva notes)

## 1. Request lifecycle (Sprint 1)
Request → `pino-http` (request id) → helmet → CORS → rate limit → JSON parse → route → `requireAuth` → `validate(zod)` → service → SQL → response, any throw → one error handler.
- **Q: Why one error format?** The UI shows `error.message`; clients branch on stable `code`s.
- **Q: Why integer paise?** Binary floats cannot represent 0.1; money must be exact.
- **Try**: add a `/healthz`-style endpoint that returns the migration count.

## 2. JWT + refresh rotation (Sprint 2)
```
login → access JWT (15 min) + refresh token (random, hashed in DB)
refresh → old token marked replaced, new token issued (same family)
old token replayed → whole family revoked (someone stole it)
```
- **Q: Why not trust the role inside the JWT?** A demoted admin would stay admin until expiry; we re-read the role (30 s cache).
- **Q: Why hash refresh tokens?** A DB leak must not hand out sessions.
- **Try**: add `GET /auth/sessions` listing families.

## 3. Booking without double-booking (Sprint 3)
```
BEGIN → expire stale holds → validate → SELECT slot FOR UPDATE → INSERT booking → COMMIT
                                                  └─ exclusion constraint = final guard (23P01 → 409)
```
- **Q: Why an exclusion constraint and not just an `if`?** Two requests can both pass the `if` before either inserts (race). The constraint is checked by the database atomically.
- **Q: Why half-open ranges `[start, end)`?** 10:00–11:00 and 11:00–12:00 must both be allowed.
- **Q: Why FOR UPDATE as well?** It queues concurrent requests per slot, so losers get a clean 409 instead of racing.
- **Try**: change the constraint to closed ranges and watch the adjacent-booking test fail.

## 4. Razorpay sequence (Sprint 4)
See `PAYMENTS.md`.
- **Q: Why a webhook if the browser calls verify?** The tab can close right after paying; the webhook is the source of truth.
- **Q: Why compare signatures with `timingSafeEqual`?** `===` leaks, byte by byte, how much of a guess was right.
- **Q: Why create the Razorpay order before taking row locks?** Never hold database locks while waiting on the network.
- **Try**: replay the same signed webhook twice with `curl` and check `webhook_events`.

## 5. QR + gate (Sprint 4)
The QR is a random 192-bit token, not the booking id; the server looks it up. **Q: Why opaque?** It can be revoked/rotated and leaks nothing if photographed. **Q: Why make scans idempotent?** Cameras and humans scan twice.

## 6. LISTEN/NOTIFY → Socket.IO (Sprint 5)
See `REALTIME.md`. **Q: Why not Redis?** One instance does not need it; Postgres already tells us after commit. **Q: Why a dedicated connection for LISTEN?** Pool clients get recycled and silently lose the subscription.

## 7. RAG (Sprint 5)
`question → embedding → nearest chunks → threshold → prompt(+context) → answer`. **Q: What stops hallucination?** Only retrieved text and tool results are allowed as facts, there is a similarity threshold, and "I don't know" is an accepted answer. **Q: Why tools for live numbers?** Prices and availability change; prompts go stale.

## Why Express + Postgres here (interview table)
| Choice | Why | Alternatives and why not |
|---|---|---|
| Express 5 + TypeScript | smallest surface to learn HTTP, middleware, transactions explicitly | NestJS: more structure/DI than a first project needs; Fastify: faster but less familiar; Django/Spring: different language/runtime from the frontend |
| PostgreSQL | exclusion constraints, `tstzrange`, triggers, LISTEN/NOTIFY, pgvector in one place | MySQL: no exclusion constraints/pgvector; MongoDB: weak for relational money/booking integrity |
| `pg` + SQL | you see transactions and locks; reuse of the original SQL | ORM hides the locking that matters here |
| Socket.IO over LISTEN | reconnects, rooms, fallbacks | raw WebSocket: reimplement them; polling only: slower updates |
