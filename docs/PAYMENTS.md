# Payments (Razorpay) and the QR pass

`PAYMENT_PROVIDER=mock` (default, keeps the original success / decline / insufficient_funds / timeout scenarios) or `razorpay` (needs `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`; the server refuses to boot without them). The frontend asks `GET /payments/config`; the mock scenario picker is visible **only** when the backend reports `mock`.

```mermaid
sequenceDiagram
  participant B as Browser
  participant A as API
  participant R as Razorpay
  B->>A: POST /payments/create-order {booking_id}
  A->>A: validate hold, price = booking.total_paise (server side)
  A->>R: orders.create(amount, receipt = booking reference)
  A-->>B: {orderId, amount, keyId}  (never the secret)
  B->>R: Checkout.js pays
  R-->>B: {order_id, payment_id, signature}
  B->>A: POST /payments/verify
  A->>A: HMAC_SHA256(order_id|payment_id, KEY_SECRET) == signature (timingSafeEqual)
  A->>A: ONE transaction: payment succeeded, booking confirmed, QR issued, session, notification
  R-)A: POST /webhooks/razorpay payment.captured (raw body, X-Razorpay-Signature)
  A->>A: dedupe by event id; same confirm function, already confirmed = no-op
```

Rules enforced (and tested in `payments.test.ts`):
- Amount comes from the booking row; the client cannot send one (`amount` in the body → 400).
- Order creation (network) happens **before** any row lock; confirmation is one transaction.
- Verify and webhook share `confirmCapturedPayment`, so whichever arrives first wins and the other is a no-op. Webhook alone confirms the booking when the browser never returns.
- Webhook: raw bytes verified with the webhook secret, `webhook_events(provider, event_id)` unique, duplicates acknowledged immediately, processing failures answer 500 so Razorpay retries, events for unknown orders are ignored with 200.
- **Payment after the hold expired**: if the slot is still free the booking is confirmed; if someone else took it, the payment is marked succeeded, then **refunded in full automatically** and the user is notified. Money is never left captured without a booking.
- Refunds: cancellation inserts a `pending` refund inside the transaction and calls the gateway **after commit** (`settleRefund`, idempotency key = refund id). A gateway outage leaves it `pending`; the `settlePendingRefunds` job retries. `refund.processed` / `refund.failed` webhooks update it.
- Never logged or stored: card/UPI details (we never see them), key secrets.

## QR pass
`qr_token = base64url(randomBytes(24))` (192 bit) stored in `bookings.qr_token` (unique), payload string `PG1:<token>`, **no personal data and not the booking reference**. Issued only after confirmed payment; revoked on cancel, completion or `reissue`. `GET /bookings/:id` returns it only to the owner or an admin and only while confirmed/active.

## Gate
Staff/admin `POST /gate/scan`. Entry window: from `early_entry_minutes` (15) before start until booking end; late arrival inside the paid window is allowed. Entry/exit are idempotent (replays answer `already_entered` / `already_exited`; two simultaneous scans produce one entry). Exit completes the session, records overstay (`ceil(minutes × rate / 60)` + GST after the grace period) and kills the pass. Every outcome is stored in `gate_scans` (only a 6-character token prefix).

## Testing with real Razorpay (test mode)
1. Dashboard → API keys (test mode) → put `RAZORPAY_KEY_ID/SECRET` in `backend/.env`, set `PAYMENT_PROVIDER=razorpay`.
2. Webhooks → add `https://<your-api>/webhooks/razorpay`, events `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed`, copy the secret to `RAZORPAY_WEBHOOK_SECRET`. Locally expose the API with a tunnel.
3. Use Razorpay's published test cards/UPI. **Real payment through Razorpay was not exercised here (no keys); the flow is covered by signed fake webhooks and a fake gateway.**
