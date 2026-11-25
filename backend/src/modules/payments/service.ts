import { createHmac } from "node:crypto";
import { env } from "../../config/env.js";
import { query } from "../../db/pool.js";
import { withTransaction, type Tx } from "../../db/tx.js";
import { AppError } from "../../lib/errors.js";
import { newQrToken, safeEqual } from "../../lib/tokens.js";
import type { AuthUser } from "../../middleware/auth.js";
import * as bookingsRepo from "../bookings/repo.js";
import { presentBooking } from "../bookings/service.js";
import { getPricingSettings } from "../settings/repo.js";
import { getProvider } from "./provider.js";
import { settleRefund } from "./refunds.js";

export type PaymentMethod = "upi" | "card" | "netbanking" | "wallet";
export type TestScenario = "success" | "decline" | "insufficient_funds" | "timeout";

const DECLINE_REASONS: Record<Exclude<TestScenario, "success">, string> = {
  decline: "Card or transaction was declined by issuing bank.",
  insufficient_funds: "Insufficient account balance or credit limit.",
  timeout: "Payment gateway session timed out waiting for authorization.",
};

interface PaymentRow {
  id: string;
  booking_id: string;
  user_id: string;
  provider: string;
  provider_ref: string | null;
  provider_order_id: string | null;
  method: PaymentMethod | null;
  amount_paise: number;
  status: string;
  [key: string]: unknown;
}

export async function getConfig(): Promise<{ provider: "mock" | "razorpay"; keyId: string | null }> {
  const p = await getProvider();
  return { provider: p.name, keyId: p.publicKeyId() };
}

/** Booking must be a valid, unpaid, unexpired hold owned by the caller. Locks the row when `tx` is given. */
async function loadPayableBooking(tx: Tx | undefined, user: AuthUser, bookingId: string): Promise<bookingsRepo.BookingRow> {
  const { rows } = await query<bookingsRepo.BookingRow>(`select * from bookings where id = $1 ${tx ? "for update" : ""}`, [bookingId], tx);
  const b = rows[0];
  if (!b || b.user_id !== user.id) throw AppError.notFound("Booking not found. Please select a space again.", "BOOKING_NOT_FOUND");
  if (b.status !== "reserved") {
    throw AppError.conflict(`Booking is not in reserved status (current status: ${b.status})`, "BOOKING_NOT_PAYABLE");
  }
  if (b.hold_expires_at && b.hold_expires_at.getTime() <= Date.now()) {
    throw AppError.conflict("Reservation hold has expired. Please select a space again.", "HOLD_EXPIRED");
  }
  if (b.end_at.getTime() <= Date.now()) {
    throw AppError.conflict("Booking period has already ended. Please select a new time.", "BOOKING_ENDED");
  }
  if (!["pending", "failed"].includes(b.payment_status)) {
    throw AppError.conflict(`Booking payment status must be pending or failed (current: ${b.payment_status})`, "BOOKING_NOT_PAYABLE");
  }
  return b;
}

async function assertAttemptsLeft(tx: Tx | undefined, bookingId: string): Promise<void> {
  const s = await getPricingSettings(tx);
  const { rows } = await query<{ n: number }>(
    `select count(*)::int as n from payments
      where booking_id = $1 and status = 'failed' and failure_reason = any($2::text[])`,
    [bookingId, Object.values(DECLINE_REASONS)],
    tx,
  );
  if ((rows[0]?.n ?? 0) >= s.max_payment_attempts) {
    throw AppError.conflict("Maximum payment attempts reached for this reservation. Please choose another space.", "MAX_ATTEMPTS");
  }
}

/** booking -> confirmed, QR issued, session created. Caller holds the booking row lock. */
async function confirmBookingRow(tx: Tx, bookingId: string): Promise<bookingsRepo.BookingRow> {
  const { rows } = await query<bookingsRepo.BookingRow>(
    `update bookings set status = 'confirmed', payment_status = 'paid', hold_expires_at = null,
            qr_token = $2, qr_issued_at = now(), qr_revoked_at = null
      where id = $1 returning *`,
    [bookingId, newQrToken()],
    tx,
  );
  const b = rows[0]!;
  // The reserved->confirmed trigger creates the session; this covers the expired->confirmed path too.
  await query(
    `insert into parking_sessions (booking_id, user_id, started_at, booked_end_at, status)
     values ($1,$2,$3,$4,'active') on conflict (booking_id) do nothing`,
    [b.id, b.user_id, b.start_at, b.end_at],
    tx,
  );
  return b;
}

/** Mock gateway: reproduces the original pay_for_booking scenarios. */
export async function payWithMock(
  user: AuthUser,
  input: { booking_id: string; method: PaymentMethod; idempotency_key: string; test_scenario: TestScenario },
): Promise<{ payment: PaymentRow; booking: bookingsRepo.BookingRow }> {
  if ((await getProvider()).name !== "mock") {
    throw AppError.badRequest("Use the online payment flow for this facility", "USE_ORDER_FLOW");
  }

  const replay = async () => {
    const ex = await query<PaymentRow>("select * from payments where idempotency_key = $1 and user_id = $2", [input.idempotency_key, user.id]);
    if (!ex.rows[0]) return null;
    const bk = await query<bookingsRepo.BookingRow>("select * from bookings where id = $1", [ex.rows[0].booking_id]);
    return { payment: ex.rows[0], booking: presentBooking(bk.rows[0]!, user) };
  };
  const existing = await replay();
  if (existing) return existing;

  try {
    return await withTransaction(async (tx) => {
      await bookingsRepo.expireStaleHolds(tx);
      const b = await loadPayableBooking(tx, user, input.booking_id);
      await assertAttemptsLeft(tx, b.id);

      if (input.test_scenario === "success") {
        const rc = await query<{ r: string }>("select generate_receipt_number() as r", [], tx);
        const pay = await query<PaymentRow>(
          `insert into payments (booking_id, user_id, provider, provider_ref, method, amount_paise, base_paise, gst_paise,
                                 currency, status, receipt_number, idempotency_key)
           values ($1,$2,'mock',$3,$4,$5,$6,$7,'INR','succeeded',$8,$9) returning *`,
          [b.id, user.id, `MOCK-${newQrToken().slice(0, 12).toUpperCase()}`, input.method, b.total_paise, b.base_paise, b.gst_paise, rc.rows[0]!.r, input.idempotency_key],
          tx,
        );
        const booking = await confirmBookingRow(tx, b.id);
        return { payment: pay.rows[0]!, booking: presentBooking(booking, user) };
      }

      const pay = await query<PaymentRow>(
        `insert into payments (booking_id, user_id, provider, method, amount_paise, base_paise, gst_paise,
                               currency, status, failure_reason, idempotency_key)
         values ($1,$2,'mock',$3,$4,$5,$6,'INR','failed',$7,$8) returning *`,
        [b.id, user.id, input.method, b.total_paise, b.base_paise, b.gst_paise, DECLINE_REASONS[input.test_scenario], input.idempotency_key],
        tx,
      );
      const upd = await query<bookingsRepo.BookingRow>("update bookings set payment_status = 'failed' where id = $1 returning *", [b.id], tx);
      return { payment: pay.rows[0]!, booking: presentBooking(upd.rows[0]!, user) };
    });
  } catch (err) {
    // Two concurrent requests with the same idempotency key: the loser re-reads the winner's result
    // (it may fail on the unique key, or on the booking no longer being payable: same answer).
    const again = await replay();
    if (again) return again;
    throw err;
  }
}

/** Razorpay step 1: create an order for the server-side price. The browser then opens Checkout.js. */
export async function createOrder(user: AuthUser, input: { booking_id: string; method?: PaymentMethod | undefined }) {
  const provider = await getProvider();
  if (provider.name !== "razorpay") {
    throw AppError.badRequest("Online payments are not enabled; use the test payment flow", "ORDERS_DISABLED");
  }
  await bookingsRepo.expireStaleHolds();
  const pre = await loadPayableBooking(undefined, user, input.booking_id);
  await assertAttemptsLeft(undefined, pre.id);

  // Network call first, WITHOUT holding any DB lock; reconciled by webhook if the browser never returns.
  const order = await provider.createOrder({
    amountPaise: pre.total_paise,
    receipt: pre.reference,
    notes: { booking_id: pre.id, user_id: user.id },
  });

  return withTransaction(async (tx) => {
    const b = await loadPayableBooking(tx, user, input.booking_id); // re-validate under lock
    const pay = await query<PaymentRow>(
      `insert into payments (booking_id, user_id, provider, provider_order_id, method, amount_paise, base_paise, gst_paise,
                             currency, status, idempotency_key)
       values ($1,$2,'razorpay',$3,$4,$5,$6,$7,'INR','created',$8) returning id`,
      [b.id, user.id, order.orderId, input.method ?? null, b.total_paise, b.base_paise, b.gst_paise, `order:${order.orderId}`],
      tx,
    );
    return {
      orderId: order.orderId,
      amount: order.amountPaise,
      currency: order.currency,
      keyId: provider.publicKeyId(),
      paymentId: pay.rows[0]!.id,
      bookingReference: b.reference,
    };
  });
}

export function signPayload(payload: string | Buffer, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
  return safeEqual(signPayload(`${orderId}|${paymentId}`, env.RAZORPAY_KEY_SECRET), signature);
}

export interface ConfirmOutcome {
  kind: "confirmed" | "already_confirmed" | "refunded_unavailable" | "ignored";
  paymentId: string;
  bookingId: string;
  refundId?: string | undefined;
}

/**
 * Money has been captured for `orderId`. Turn that into a confirmed booking exactly once.
 * Used by BOTH the browser verify call and the webhook, so whichever arrives first wins and the
 * other is a harmless no-op (idempotent).
 *
 * Race: payment arrives after the hold expired / booking cancelled.
 *   - slot still free  -> confirm anyway (the customer did pay in good faith)
 *   - slot taken       -> mark the payment succeeded, then refund it in full and tell the user.
 *     Money is never left captured without a booking.
 */
export async function confirmCapturedPayment(input: {
  orderId: string;
  providerPaymentId: string;
  signature?: string | null;
  method?: PaymentMethod | null;
  expectUserId?: string;
}): Promise<ConfirmOutcome> {
  const outcome = await withTransaction(async (tx): Promise<ConfirmOutcome> => {
    const payRes = await query<PaymentRow>("select * from payments where provider_order_id = $1 for update", [input.orderId], tx);
    const pay = payRes.rows[0];
    if (!pay || (input.expectUserId && pay.user_id !== input.expectUserId)) {
      throw AppError.notFound("Payment not found", "PAYMENT_NOT_FOUND");
    }
    if (["succeeded", "refunded", "partially_refunded"].includes(pay.status)) {
      return { kind: "already_confirmed", paymentId: pay.id, bookingId: pay.booking_id };
    }

    const bk = await query<bookingsRepo.BookingRow>("select * from bookings where id = $1 for update", [pay.booking_id], tx);
    const booking = bk.rows[0]!;
    const rc = await query<{ r: string }>("select generate_receipt_number() as r", [], tx);
    const method = input.method ?? pay.method;

    await query(
      `update payments set status = 'succeeded', provider_ref = $2, provider_signature = $3, method = $4,
              receipt_number = $5, failure_reason = null where id = $1`,
      [pay.id, input.providerPaymentId, input.signature ?? null, method, rc.rows[0]!.r],
      tx,
    );

    // Can this booking still be honoured?
    let honoured = false;
    if (booking.status === "reserved") {
      honoured = true;
    } else if (booking.status === "expired") {
      await query("savepoint reactivate", [], tx);
      try {
        await query("update bookings set status = 'reserved' where id = $1", [booking.id], tx); // exclusion constraint re-checks the slot
        honoured = true;
      } catch (err) {
        if ((err as { code?: string }).code !== "23P01") throw err;
        await query("rollback to savepoint reactivate", [], tx);
      }
    }

    if (honoured) {
      await confirmBookingRow(tx, booking.id);
      return { kind: "confirmed", paymentId: pay.id, bookingId: booking.id };
    }

    // Booking cannot be honoured: refund everything automatically.
    const refund = await query<{ id: string }>(
      `insert into payment_refunds (payment_id, booking_id, amount_paise, reason, status)
       values ($1,$2,$3,'Auto-refund: payment received after the slot was released','pending') returning id`,
      [pay.id, booking.id, pay.amount_paise],
      tx,
    );
    await query("update payments set status = 'refunded' where id = $1", [pay.id], tx);
    await query("update bookings set payment_status = 'refunded', refund_paise = $2 where id = $1", [booking.id, pay.amount_paise], tx);
    await query(
      "select create_notification($1, 'payment', 'Payment refunded', $2, '/bookings')",
      [booking.user_id, `Your payment for booking ${booking.reference} arrived after the space was released, so it is being refunded in full.`],
      tx,
    );
    return { kind: "refunded_unavailable", paymentId: pay.id, bookingId: booking.id, refundId: refund.rows[0]!.id };
  });

  if (outcome.refundId) await settleRefund(outcome.refundId);
  return outcome;
}

/** Razorpay step 2 (browser): verify the signature, then confirm. Replays return the same result. */
export async function verifyPayment(
  user: AuthUser,
  input: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string },
) {
  if (!verifyCheckoutSignature(input.razorpay_order_id, input.razorpay_payment_id, input.razorpay_signature)) {
    throw AppError.badRequest("Payment verification failed", "INVALID_SIGNATURE");
  }
  const outcome = await confirmCapturedPayment({
    orderId: input.razorpay_order_id,
    providerPaymentId: input.razorpay_payment_id,
    signature: input.razorpay_signature,
    expectUserId: user.id,
  });
  const pay = await query<PaymentRow>("select * from payments where id = $1", [outcome.paymentId]);
  const bk = await query<bookingsRepo.BookingRow>("select * from bookings where id = $1", [outcome.bookingId]);
  return { outcome: outcome.kind, payment: pay.rows[0]!, booking: presentBooking(bk.rows[0]!, user) };
}

/** Browser reported a failed/dismissed attempt for one of the caller's own orders. */
export async function markOrderFailedForUser(user: AuthUser, orderId: string, reason: string): Promise<void> {
  await query(
    "update payments set status = 'failed', failure_reason = $3 where provider_order_id = $1 and user_id = $2 and status = 'created'",
    [orderId, user.id, reason.slice(0, 200)],
  );
}

/** Gateway told us (webhook) the attempt failed. */
export async function markOrderFailed(orderId: string, reason: string): Promise<void> {
  await query(
    "update payments set status = 'failed', failure_reason = $2 where provider_order_id = $1 and status = 'created'",
    [orderId, reason.slice(0, 200)],
  );
}

const PAYMENT_WITH_BOOKING = `
  p.*,
  (select to_jsonb(x) from (
     select b.id, b.reference, b.plate_snapshot, b.vehicle_type_snapshot, b.start_at, b.end_at, b.hours,
            b.hourly_rate_paise, b.base_paise, b.gst_paise, b.total_paise, b.status, b.payment_status, b.refund_paise,
            (select to_jsonb(s) from (select ps.code, ps.level_code, ps.zone, ps.slot_type from parking_slots ps where ps.id = b.slot_id) s) as parking_slots
       from bookings b where b.id = p.booking_id
  ) x) as bookings,
  coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at) from payment_refunds r where r.payment_id = p.id), '[]'::jsonb) as payment_refunds`;

export async function getReceipt(user: AuthUser, by: { booking_id?: string; payment_id?: string; receipt_number?: string }) {
  const col = by.payment_id ? "p.id" : by.receipt_number ? "p.receipt_number" : "p.booking_id";
  const val = by.payment_id ?? by.receipt_number ?? by.booking_id;
  const { rows } = await query(
    `select ${PAYMENT_WITH_BOOKING} from payments p
      where ${col} = $1 and p.status <> 'created' and ($2::boolean or p.user_id = $3)
      order by p.created_at desc limit 1`,
    [val, user.role === "admin", user.id],
  );
  if (!rows[0]) throw AppError.notFound("Receipt not found.", "RECEIPT_NOT_FOUND");
  return { payment: rows[0] };
}

export async function listMine(user: AuthUser, page: number, pageSize: number) {
  const [rows, count] = await Promise.all([
    query(
      `select ${PAYMENT_WITH_BOOKING} from payments p where p.user_id = $1 and p.status <> 'created'
        order by p.created_at desc limit $2 offset $3`,
      [user.id, pageSize, (page - 1) * pageSize],
    ),
    query<{ n: number }>("select count(*)::int as n from payments where user_id = $1 and status <> 'created'", [user.id]),
  ]);
  return { payments: rows.rows, totalCount: count.rows[0]?.n ?? 0, page, pageSize };
}

/** Owner re-issues the QR (e.g. screenshot leaked). Old token stops working immediately. */
export async function reissueQr(user: AuthUser, bookingId: string) {
  const { rows } = await query<bookingsRepo.BookingRow>(
    `update bookings set qr_token = $3, qr_issued_at = now(), qr_revoked_at = null
      where id = $1 and user_id = $2 and status in ('confirmed','active') returning *`,
    [bookingId, user.id, newQrToken()],
  );
  if (!rows[0]) throw AppError.notFound("Booking not found or has no active pass.", "BOOKING_NOT_FOUND");
  return { booking: presentBooking(rows[0], user) };
}
