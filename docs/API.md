# API reference

Base URL: `API_URL` (default `http://localhost:4000`). JSON in, JSON out. Success responses are the bare object the frontend function used to return (for example `{ bookings, totalCount }`). Errors always look like:

```json
{ "error": { "code": "SLOT_TAKEN", "message": "This slot was just taken for that time. Please pick another space.", "details": null } }
```

**Auth**: `Authorization: Bearer <access token>` (15 min JWT). Roles: `member` < `staff` < `admin` (admin passes every role gate). A resource owned by someone else answers **404**, never 403.

| Legend | |
|---|---|
| 🔓 | public |
| 🔑 | any signed-in user |
| 🅢 | staff or admin |
| 🅐 | admin only |

## Health and operations
| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/healthz` | 🔓 | `{status, db}`; 503 when the DB is unreachable |
| POST | `/internal/jobs/:name` | `x-cron-secret` | run `expireStaleHolds`, `expireUnusedBookings`, `autoEndStaleSessions`, `settlePendingRefunds` |

## Auth (`/auth`)
| Method | Path | Access | Body → response |
|---|---|---|---|
| POST | `/auth/signup` | 🔓 | `{email, password, full_name?}` → 201 `{accessToken, refreshToken, expiresIn, user}`. Always role `member`; unknown fields → 400 |
| POST | `/auth/login` | 🔓 | `{email, password}` → tokens. Same generic error for unknown email / wrong password / locked / disabled |
| POST | `/auth/refresh` | 🔓 | `{refreshToken}` → new tokens (rotation). Replaying an old token revokes the whole family (`REFRESH_REUSED`) |
| POST | `/auth/logout` | 🔓 | `{refreshToken?}` → revokes that session |
| POST | `/auth/logout-all` | 🔑 | revokes every session |
| POST | `/auth/forgot-password` | 🔓 | `{email}` → always 200 (no account enumeration) |
| POST | `/auth/reset-password` | 🔓 | `{token, password}`; single-use, 30 min, revokes all sessions |
| POST | `/auth/change-password` | 🔑 | `{currentPassword, newPassword}`; other sessions are revoked |
| GET | `/auth/me` | 🔑 | `{user:{id,email,role,full_name}}` (role re-read from the DB) |

Error codes: `INVALID_CREDENTIALS`, `EMAIL_TAKEN`, `WEAK_PASSWORD`, `REFRESH_REUSED`, `INVALID_REFRESH`, `INVALID_RESET_TOKEN`, `INVALID_TOKEN`, `ACCOUNT_DISABLED`, `RATE_LIMITED`.

## Profile, vehicles, notifications
| Method | Path | Access | Notes |
|---|---|---|---|
| GET / PATCH | `/profile` | 🔑 | PATCH `{full_name, phone?}` only; `role` etc. rejected |
| GET | `/profile/recent-bookings` | 🔑 | last 5 |
| GET | `/vehicles?includeArchived=` | 🔑 | own vehicles |
| POST | `/vehicles` | 🔑 | max 5 active; `PLATE_TAKEN`, `VEHICLE_LIMIT` |
| PATCH | `/vehicles/:id` | 🔑 | own only |
| POST | `/vehicles/:id/default` | 🔑 | atomic single default |
| DELETE | `/vehicles/:id` | 🔑 | archives (history keeps a plate snapshot) |
| GET | `/notifications?filter=&page=&pageSize=` | 🔑 | own only |
| GET | `/notifications/unread-count` | 🔑 | `{count}` |
| POST | `/notifications/mark-read` · `/mark-all-read` | 🔑 | `{ids[]}` |
| DELETE | `/notifications/:id` | 🔑 | own only |

## Parking and bookings
| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/parking/slots` | 🔑 | filters `level,zone,slot_type,admin_status,search,page,pageSize`; admins/staff also get `current_booking` |
| GET | `/parking/summary` | 🔑 | facility counts (same arithmetic as the original dashboard) |
| PATCH | `/parking/slots/:id` | 🅐 | `admin_status`, `notes`, `hourly_rate_paise` only; audited |
| GET | `/bookings/availability?start_at&end_at&level&zone&slot_type` | 🔑 | free/occupied per slot, no personal data |
| GET | `/bookings/quote?slot_id&start_at&end_at` | 🔑 | `slot_id` may be a UUID or a code like `B2-01` |
| POST | `/bookings` | 🔑 | `{slot_id, vehicle_id, start_at, end_at}` → 201 booking in status `reserved` (hold). **Price, status and owner are decided by the server.** `SLOT_TAKEN` 409, `START_IN_PAST`, `TOO_FAR_AHEAD`, `NOT_ALIGNED`, `INVALID_DURATION`, `EV_REQUIRED`, `VEHICLE_NOT_FOUND`, `SLOT_UNAVAILABLE` |
| GET | `/bookings?statusTab=Upcoming\|Active\|Completed\|Cancelled` | 🔑 | own; includes `parking_slots`, `vehicles` |
| GET | `/bookings/lookup?reference=` · `/bookings/:id` | 🔑 | owner or admin; `qr_token` only while the pass is valid |
| GET | `/bookings/:id/cancellation-preview` | 🔑 | `{preview:{refund_paise, refund_percentage,…}}` |
| POST | `/bookings/:id/cancel` | 🔑 | `{reason?}`; idempotent (second call → 409 `NOT_CANCELLABLE`) |
| POST | `/bookings/:id/qr/reissue` | 🔑 owner | rotates the pass; the old QR dies immediately |

## Payments
| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/payments/config` | 🔑 | `{provider:'mock'\|'razorpay', keyId}`; never the secret |
| POST | `/payments/pay` | 🔑 | mock gateway: `{booking_id, method, idempotency_key, test_scenario?}` → `{payment, booking}` |
| POST | `/payments/create-order` | 🔑 | Razorpay: `{booking_id, method?}` → `{orderId, amount, currency, keyId}` (amount computed server-side) |
| POST | `/payments/verify` | 🔑 | `{razorpay_order_id, razorpay_payment_id, razorpay_signature}`; HMAC-SHA256 checked with `timingSafeEqual`; idempotent |
| POST | `/payments/report-failure` | 🔑 | marks the caller's own pending order failed |
| GET | `/payments/receipt?booking_id\|payment_id\|receipt_number` | 🔑 | owner (or admin) |
| GET | `/payments` | 🔑 | own history |
| POST | `/webhooks/razorpay` | signature | raw body; `payment.captured`, `order.paid`, `payment.failed`, `refund.processed`, `refund.failed`; deduped by event id |

## Sessions and gate
| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/sessions/active?booking_id=` | 🔑 | live timers; others' sessions → 404 |
| GET | `/sessions`, `/sessions/:id` | 🔑 | own |
| POST | `/sessions/:id/end` | 🔑 owner | overstay computed and recorded |
| POST | `/gate/scan` | 🅢 | `{token:'PG1:…', direction:'entry'\|'exit', gateId?}` → HTTP 200 `{ok, result, message, booking?, overstay?}`; results: `ok, already_entered, already_exited, invalid_token, cancelled, expired, too_early, already_used, not_entered, no_session` |
| GET | `/gate/recent` | 🅢 | caller's last 10 scans |

## Admin (all 🅐, all mutations audited)
`GET /admin/dashboard` · `GET /admin/revenue?from&to&group` · `GET /admin/users` · `GET /admin/users/:id` · `PATCH /admin/users/:id/role` `{role, reason}` · `PATCH /admin/users/:id/status` `{disabled, reason}` · `GET /admin/bookings` · `GET /admin/bookings/:id` · `POST /admin/bookings/:id/override` `{action, reason}` · `GET /admin/payments` · `GET /admin/payments/:id` · `POST /admin/payments/:id/refund` `{amount_paise, reason}` · `GET /admin/sessions` · `GET /admin/sessions/active` · `GET|PUT /admin/settings` · `GET|PUT /admin/slot-rates` · `GET /admin/audit-logs`

Knowledge base: `GET /admin/kb/status` · `GET|POST /admin/kb/documents` · `PATCH|DELETE /admin/kb/documents/:id` · `POST /admin/kb/documents/:id/reembed` · `GET /admin/kb/documents/:id/chunks` · `POST /admin/kb/search` `{query, topK?}` (shows scores and whether each hit passes the threshold).

## Assistant
`POST /api/chat` 🔑 · body `{messages: UIMessage[]}` (≤30 messages, ≤2000 chars per user message) · streams the Vercel AI SDK UI message stream (what `@ai-sdk/react` expects) · 20 requests per 10 min per user.
