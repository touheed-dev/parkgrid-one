# Architecture

```
Browser (TanStack Start, React 19)                Express 5 API (Node 22, TypeScript strict, ESM)            PostgreSQL 16 + pgvector
  src/lib/api/*  ──HTTP + Bearer──►  middleware: helmet · cors · rate-limit · auth · zod validate  ──pg──►  tables, constraints, triggers
  src/lib/auth/session.ts                routes → service (transactions) → SQL                              LISTEN/NOTIFY ──► Socket.IO ──► browser
  Socket.IO client  ◄── ids-only events ──  realtime listener (1 dedicated connection)
  Razorpay Checkout.js ─► /payments/verify        webhooks (raw body) ◄── Razorpay          OpenAI (optional): embeddings + chat
```

## Layers (backend)
`routes.ts` (HTTP + zod) → `service.ts` (rules, one transaction per business action) → SQL (`pg`, hand-written, parameterised). Shared pieces: `db/tx.ts` (`withTransaction`, retry on deadlock/serialization), `db/errors.ts` (pg error → API error), `lib/money.ts` (integer paise, same rounding as the original SQL), `middleware/auth.ts` (JWT + role re-read from DB, 30 s cache).

## Decisions that differ from the master prompt (and why)
| Prompt said | Built | Reason |
|---|---|---|
| Port every SQL function to TypeScript | **Money/state paths in TypeScript** (booking, cancel, pay, sessions, gate, overrides, refunds). **Reporting/admin SQL kept** (dashboard, revenue, payment totals, user list, role/settings/rate changes) behind a transaction-local `auth.uid()` shim; Express authorises first. | ~900 lines of tested reporting SQL; rewriting them invites drift. Gateway calls cannot live in SQL anyway. Parity table in `DATABASE.md`. |
| `node-pg-migrate`, plain SQL | Same | ✔ |
| Email verification flag | Not implemented | Not needed for the flows asked; removed instead of leaving a dead flag |
| Redis optional | Not used; documented in `REALTIME.md` | Single instance needs none |
| Overstay collected through Razorpay at exit | Overstay is **recorded** (`paid` by the mock gateway as in the original, `due` with Razorpay) | Keeps the exit gate fast; collecting a second online payment at a barrier is a product decision, listed under limitations |
| No-show when start passes | No-show when the **whole window** passes with no gate entry | See `AUDIT.md` #3 |
| Chat via OpenAI only | OpenAI when `OPENAI_API_KEY` is set, otherwise **grounded retrieval-only answers** with the same streaming protocol | Works offline and in CI |

## Money and time
Integer **paise**, never floats. GST `floor((base × bps + 5000) / 10000)` equals Postgres `round()` for non-negative integers. All timestamps `timestamptz` (UTC); IST (`+05:30`, no DST) only for labels, references and the 15-minute alignment rule.

## Booking lifecycle
`reserved` (hold, 10 min) → pay → `confirmed` (QR issued, session row created) → gate entry → `active` → gate exit → `completed`.
Branches: `expired` (hold lapsed), `cancelled` (refund tiers), `no_show`. Overlap is impossible by construction: `EXCLUDE USING gist (slot_id WITH =, during WITH &&) WHERE status IN ('reserved','confirmed','active')` with half-open ranges.
