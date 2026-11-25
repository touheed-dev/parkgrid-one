import { query } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { AppError } from "../../lib/errors.js";
import { percentOfBps } from "../../lib/money.js";
import { invalidateIdentity, type AuthUser } from "../../middleware/auth.js";
import { settleRefund } from "../payments/refunds.js";
import { getPricingSettings } from "../settings/repo.js";
import { writeAudit } from "./audit.js";

export type OverrideAction = "cancel_full_refund" | "cancel_by_policy" | "cancel_no_refund" | "mark_no_show";

/**
 * Admin override of a booking (port of admin_override_booking). Money movement is recorded as a
 * pending refund inside the transaction and sent to the gateway after commit.
 */
export async function overrideBooking(admin: AuthUser, bookingId: string, action: OverrideAction, reason: string) {
  const { booking, refundId } = await withTransaction(async (tx) => {
    const bk = await query<Record<string, unknown> & { id: string; status: string; payment_status: string; start_at: Date; total_paise: number; refund_paise: number }>(
      "select * from bookings where id = $1 for update",
      [bookingId],
      tx,
    );
    const b = bk.rows[0];
    if (!b) throw AppError.notFound("Booking not found", "BOOKING_NOT_FOUND");
    if (["completed", "cancelled", "no_show", "expired"].includes(b.status)) {
      throw AppError.conflict(`Cannot override a booking that is already ${b.status}`, "NOT_OVERRIDABLE");
    }

    const payRes = await query<{ id: string; amount_paise: number }>(
      "select id, amount_paise from payments where booking_id = $1 and status in ('succeeded','partially_refunded') for update",
      [bookingId],
      tx,
    );
    const pay = payRes.rows[0];
    let existingRefunds = 0;
    let remainingPaid = 0;
    if (pay) {
      const sum = await query<{ s: number }>("select coalesce(sum(amount_paise),0)::int as s from payment_refunds where payment_id = $1", [pay.id], tx);
      existingRefunds = sum.rows[0]!.s;
      remainingPaid = Math.max(0, pay.amount_paise - existingRefunds);
    }

    const oldStatus = { status: b.status, payment_status: b.payment_status };
    let refund = 0;
    let pendingRefundId: string | null = null;
    let updated;

    if (action === "mark_no_show") {
      updated = await query("update bookings set status = 'no_show', qr_revoked_at = coalesce(qr_revoked_at, now()) where id = $1 returning *", [bookingId], tx);
    } else {
      let refundReason: string;
      if (action === "cancel_full_refund") {
        refund = remainingPaid;
        refundReason = `Admin override: full refund (${reason})`;
      } else if (action === "cancel_no_refund") {
        refundReason = `Admin override: no refund (${reason})`;
      } else {
        const s = await getPricingSettings(tx);
        const msUntilStart = b.start_at.getTime() - Date.now();
        if (msUntilStart > 0 && remainingPaid > 0) {
          if (msUntilStart / 3_600_000 >= s.refund_full_hours) refund = remainingPaid;
          else if (msUntilStart / 60_000 >= s.refund_partial_minutes) {
            refund = Math.min(percentOfBps(b.total_paise, s.partial_refund_bps), remainingPaid);
          }
        }
        refundReason = `Admin override: cancellation policy (${reason})`;
      }

      let newPaymentStatus = b.payment_status;
      if (pay) {
        const totalRefunded = existingRefunds + refund;
        if (refund > 0) {
          const ins = await query<{ id: string }>(
            "insert into payment_refunds (payment_id, booking_id, amount_paise, reason, status) values ($1,$2,$3,$4,'pending') returning id",
            [pay.id, bookingId, refund, refundReason],
            tx,
          );
          pendingRefundId = ins.rows[0]!.id;
          await query("update payments set status = $2 where id = $1", [pay.id, totalRefunded >= pay.amount_paise ? "refunded" : "partially_refunded"], tx);
        }
        newPaymentStatus = totalRefunded >= pay.amount_paise ? "refunded" : totalRefunded > 0 ? "partially_refunded" : b.payment_status;
      }
      updated = await query(
        `update bookings set status = 'cancelled', cancelled_at = now(), cancellation_reason = $2,
                refund_paise = refund_paise + $3, payment_status = $4, qr_revoked_at = coalesce(qr_revoked_at, now())
          where id = $1 returning *`,
        [bookingId, `Admin override: ${reason}`, refund, newPaymentStatus],
        tx,
      );
    }

    await query(
      `update parking_sessions set status = 'cancelled', ended_at = coalesce(ended_at, now()), ended_by_admin = true
        where booking_id = $1 and status = 'active' and ended_at is null`,
      [bookingId],
      tx,
    );
    await writeAudit(tx, {
      actorId: admin.id, action: `override_booking_${action}`, recordType: "booking", recordId: bookingId, reason,
      oldData: oldStatus, newData: { status: updated.rows[0]!["status"], payment_status: updated.rows[0]!["payment_status"], refund_paise: refund },
    });
    return { booking: updated.rows[0]!, refundId: pendingRefundId };
  });

  if (refundId) await settleRefund(refundId);
  return { booking };
}

/** Manual refund of (part of) a payment (port of admin_refund_payment). */
export async function refundPayment(admin: AuthUser, paymentId: string, amountPaise: number, reason: string) {
  const refund = await withTransaction(async (tx) => {
    const p = await query<{ id: string; booking_id: string; amount_paise: number; status: string }>(
      "select id, booking_id, amount_paise, status from payments where id = $1 for update",
      [paymentId],
      tx,
    );
    const pay = p.rows[0];
    if (!pay) throw AppError.notFound("Payment transaction not found", "PAYMENT_NOT_FOUND");
    if (!["succeeded", "partially_refunded"].includes(pay.status)) {
      throw AppError.conflict(`Payment cannot be refunded in current status: ${pay.status}`, "NOT_REFUNDABLE");
    }
    const sum = await query<{ s: number }>("select coalesce(sum(amount_paise),0)::int as s from payment_refunds where payment_id = $1", [paymentId], tx);
    const existing = sum.rows[0]!.s;
    const remaining = pay.amount_paise - existing;
    if (remaining <= 0) throw AppError.conflict("Payment has already been fully refunded", "ALREADY_REFUNDED");
    if (amountPaise < 1 || amountPaise > remaining) {
      throw AppError.badRequest(`Refund amount must be between 1 and ${remaining} paise`, "INVALID_REFUND_AMOUNT");
    }
    const ins = await query(
      "insert into payment_refunds (payment_id, booking_id, amount_paise, reason, status) values ($1,$2,$3,$4,'pending') returning *",
      [paymentId, pay.booking_id, amountPaise, reason],
      tx,
    );
    const total = existing + amountPaise;
    const status = total >= pay.amount_paise ? "refunded" : "partially_refunded";
    await query("update payments set status = $2 where id = $1", [paymentId, status], tx);
    await query("update bookings set refund_paise = refund_paise + $2, payment_status = $3 where id = $1", [pay.booking_id, amountPaise, status], tx);
    await writeAudit(tx, {
      actorId: admin.id, action: "refund_payment", recordType: "payment", recordId: paymentId, reason,
      oldData: { status: pay.status, amount_paise: pay.amount_paise, refunded_previously: existing },
      newData: { refund_id: ins.rows[0]!["id"], amount_paise: amountPaise, total_refunded: total },
    });
    return ins.rows[0]!;
  });

  await settleRefund(refund["id"] as string);
  const fresh = await query("select * from payment_refunds where id = $1", [refund["id"]]);
  return { refund: fresh.rows[0] };
}

/** Enable/disable a login. Disabling also signs the user out everywhere. Never the caller, never the last admin. */
export async function setUserDisabled(admin: AuthUser, userId: string, disabled: boolean, reason: string) {
  if (userId === admin.id) throw AppError.badRequest("You cannot disable your own account", "SELF_DISABLE");
  const result = await withTransaction(async (tx) => {
    const u = await query<{ disabled_at: Date | null; role: string }>(
      "select u.disabled_at, p.role from users u join profiles p on p.id = u.id where u.id = $1 for update of u",
      [userId],
      tx,
    );
    const target = u.rows[0];
    if (!target) throw AppError.notFound("User not found", "USER_NOT_FOUND");
    if (disabled && target.role === "admin") {
      const admins = await query<{ n: number }>(
        "select count(*)::int as n from profiles p join users u on u.id = p.id where p.role = 'admin' and u.disabled_at is null",
        [],
        tx,
      );
      if (admins.rows[0]!.n <= 1) throw AppError.conflict("Cannot disable the last remaining administrator", "LAST_ADMIN");
    }
    await query("update users set disabled_at = $2 where id = $1", [userId, disabled ? new Date() : null], tx);
    if (disabled) await query("update refresh_tokens set revoked_at = now() where user_id = $1 and revoked_at is null", [userId], tx);
    await writeAudit(tx, {
      actorId: admin.id, action: disabled ? "disable_user" : "enable_user", recordType: "user", recordId: userId, reason,
      oldData: { disabled: target.disabled_at !== null }, newData: { disabled },
    });
    return { id: userId, disabled };
  });
  invalidateIdentity(userId);
  return result;
}
