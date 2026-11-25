# Realtime

```
transaction commits ─► pg_notify('parkgrid', {type, ids}) ─► ONE dedicated pg connection (LISTEN) ─► Socket.IO rooms ─► browser
```
- Triggers (migration 008) emit **ids and an event type only**, far below the 8000-byte NOTIFY limit; Postgres delivers NOTIFY only after commit, so listeners never see uncommitted work.
- The LISTEN connection is **not** from the pool; it reconnects with exponential backoff (0.5 s → 15 s) and re-issues `LISTEN`.
- Handshake requires `auth.token` (access token). Anonymous sockets are refused (`UNAUTHORIZED`): nothing to subscribe to. After a token refresh the client emits `auth` with the new token; a different identity is refused and the socket dropped.
- Rooms: `user:<id>` (own events), `public` (availability, any signed-in user), `admin` (staff/admin). Roles are re-checked every minute, so a demotion or disabled account loses access without reconnecting.

| Event | Rooms |
|---|---|
| `availability_changed {slot_id}` | `public` |
| `booking_changed`, `session_changed`, `payment_changed`, `notification_created` | that user only |
| `admin_booking_changed`, `admin_session_changed`, `admin_payment_changed` | `admin` |

Tested in `realtime.test.ts`: members never receive other users' events; the stranger's received payload does not contain the owner's id.

Frontend (`src/lib/realtime.ts`) keeps the original contract: one app-wide connection, 500 ms debounce, paused while the tab is hidden and flushed on return, status `disconnected | connecting | connected | error`, and the 60 s polling fallback when not live. A reconnect triggers one catch-up refetch.

## Scaling beyond one instance
Each API instance LISTENs independently, so every instance receives every NOTIFY, but a socket is only connected to one instance, which is exactly what is needed. Redis is **not** required for this design. It is only needed if you emit events from application code (not from Postgres) or want cross-instance `io.to(room)` calls: then add `@socket.io/redis-adapter` with `REDIS_URL` and `docker compose --profile redis up -d`. Jobs already run under `pg_try_advisory_lock`, so only one instance executes each.
