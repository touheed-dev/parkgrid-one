# Phase 0 audit: what the Supabase project did, and what changed

This is the result of reading the original project (`docs/legacy-supabase/` keeps its SQL) before writing the backend.

## What existed
- 16 SQL migrations, 13 tables, about 60 Postgres functions/triggers holding most business logic; auth by Supabase; 10 `*.server.ts` files calling them; AI chat through the Lovable gateway with a hard-coded prompt.
- Business rules that were ported exactly (see `DATABASE.md` parity table): GST 18% (`gst_bps`) with `round half up`, hold 10 min, 1–24 h bookings, 30 days advance, 15-minute alignment on the IST clock, refund tiers (100% ≥ 2 h, 50% ≥ 30 min, else 0), grace 15 min then overstay = `ceil(min × rate / 60)` + GST, max 5 vehicles per user, one default vehicle, plate normalisation, EV bays need an EV.

## Suspected issues found (decisions in bold)
| # | Issue in the original | Decision |
|---|---|---|
| 1 | `admin_revenue_report` (latest migration) returns `{periods, summary, by_slot_type}` but the admin revenue page reads `{periods[period_label, refund_paise], totals, breakdown_by_*}`: the page could not render real data. | **Ported the earlier version that matches the page.** |
| 2 | Overstay notification triggers read `overstay_charges.amount_paise`, a column that does not exist; the error was swallowed, so overstay notifications were never created. | **Fixed (`total_paise`).** |
| 3 | `expire_unused_bookings` marked a paid booking `no_show` the moment its start time passed, even if the customer was parked, because `confirmed → active` only happened lazily when someone opened the session screen. | **No-show now means: confirmed, window fully elapsed, never entered through the gate.** Late arrival inside the paid window is allowed. |
| 4 | Admin slot occupancy treated every confirmed booking's session (`status='active'`) as occupying the bay, even for future bookings. | **Occupancy now = booking window covers now, or entered session.** |
| 5 | `end_session` allowed ending a session that had not started yet (completes the booking with no refund). | **Rejected with "cancel instead".** |
| 6 | The "heavy vehicle" rule described in the master prompt does not exist in the original SQL (vehicle types are car/suv/bike/ev; only `parking_levels.allows_heavy` exists). | **Not invented.** The flag stays and is admin-editable. |
| 7 | The original design had *no QR/gate* ("automatic timer-based sessions"); the QR encoded the booking reference. | **Gate flow added as you requested; sessions still created on confirmation and derived from time for the existing UI.** |
| 8 | FAQ answers hard-coded live numbers ("73 available"). | **Removed from the seed; live data comes from tools.** |
| 9 | `payment_mode` setting in the DB duplicated what is really a deployment choice. | **Provider comes from `PAYMENT_PROVIDER`; the column remains for compatibility.** |

## Frontend coupling (27 files) and what replaced it
`*.server.ts` and Supabase client → `src/lib/api/*` (same function names, `{ data }` call shape, same exported types), `src/lib/auth/session.ts`, `src/lib/api/http.ts`, Socket.IO realtime, Razorpay checkout, opaque QR, gate page, assistant and knowledge page wired to the API. See `README.md`.
