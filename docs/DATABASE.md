# Database

PostgreSQL 16 with `pgcrypto`, `btree_gist`, `citext`, `vector`. Migrations in `backend/migrations/` (plain SQL, `-- Up` / `-- Down`). `npm run migrate`; the test suite also runs **up → down (all) → up** on an empty database.

| Migration | Contents |
|---|---|
| 001 | `users`, `profiles` (role), `refresh_tokens` (hashed, family id), `password_reset_tokens` |
| 002 | `parking_levels`, `parking_slots` (delete forbidden by trigger) |
| 003 | `vehicles` (plate normalisation, max 5, single default, owner immutable) |
| 004 | `pricing_settings` (singleton), `bookings` + exclusion constraint + immutability trigger |
| 005 | `payments` (+ gateway ids), `payment_refunds`, `webhook_events`, receipt numbers, immutability triggers |
| 006 | `parking_sessions`, `overstay_charges`, `gate_scans`, session-on-confirm trigger |
| 007 | `notifications` + notification triggers (bug fixed, see AUDIT #2) |
| 008 | `admin_audit_log`, `pg_notify` realtime triggers (ids only, fired after commit) |
| 009 | `kb_documents`, `kb_chunks` (HNSW cosine index + generated `tsvector`) |
| 010 | ported reporting/admin SQL + `auth.uid()` shim |

Integrity that does not depend on application code: exclusion constraint, `end_at > start_at`, booking price/owner/slot immutable, payment amounts immutable and statuses one-way, refunds append-only, one succeeded payment per booking (partial unique index), unique idempotency key, unique webhook event id, unique QR token.

## Parity table: original SQL function → new home → test that proves it
| Original | Now | Test |
|---|---|---|
| `create_booking` | `bookings/service.createBooking` (slot row `FOR UPDATE` + exclusion constraint) | `bookings.test` (validation matrix, **25 parallel requests → exactly one 201**) |
| `quote_booking`, GST maths | `bookings/service.quote`, `lib/money.ts` | `foundation.test`, `bookings.test`, `admin.test` (rate change) |
| `slot_availability` | `parking/service.slotAvailability` | `bookings.test`, `rag.test` (live tool) |
| `cancellation_preview`, `cancel_booking` | `bookings/service` (refund recorded as pending, gateway called after commit) | `bookings.test` (100% / 50% / 0%), `payments.test` |
| `expire_stale_holds` | `bookings/repo` + job | `bookings.test` (expired hold frees slot) |
| `expire_unused_bookings` | `bookings/repo` + job (rule changed) | `gate.test` (jobs) |
| `pay_for_booking` | `payments/service.payWithMock` | `payments.test` (success, idempotency, declines, attempt cap) |
| `generate_booking_reference` / `generate_receipt_number` | `newReference` / SQL function kept | `bookings.test`, `payments.test` (regex) |
| `create_session_on_confirm` | trigger kept (+ explicit idempotent insert) | `payments.test`, `gate.test` |
| `get_active_session`, `end_session`, `list_my_sessions`, `get_session` | `sessions/service` (`finalizeSession` shared with the gate) | `gate.test` |
| `admin_override_booking`, `admin_refund_payment` | `admin/service` | `admin.test` |
| `admin_dashboard_stats`, `admin_revenue_report`, `admin_payment_totals`, `admin_list_users`, `admin_set_user_role`, `admin_update_settings`, `admin_get/update_slot_rates`, `admin_active_sessions` | **kept as SQL** (010), called after `requireAdmin` | `admin.test` |
| `set_default_vehicle` | `vehicles/routes` transaction + trigger | `vehicles.test` |
| `mark_notifications_read` etc., notification triggers | route SQL + triggers kept | `bookings.test`, `payments.test`, `gate.test` |
| `availability_ping` + Supabase realtime | `pg_notify` triggers + Socket.IO | `realtime.test` |
| `handle_new_user`, `prevent_role_change_via_api` | signup always `member`, strict zod schemas, role only via admin endpoint | `auth.test` |
| RLS / `is_admin()` | `requireAuth` / `requireRole` + `WHERE user_id = $me` in every query | IDOR tests in every suite |

The `auth.uid()` shim: `set_config('app.user_id', <id>, true)` inside the same transaction, so the SQL-side admin check is a second, independent line of defence.

## Not measured yet
`EXPLAIN` plans and a load test were not run (see `RUNBOOK.md` → limitations). Indexes exist on every foreign key and hot filter (user, slot, status, start time, hold expiry, created_at).
