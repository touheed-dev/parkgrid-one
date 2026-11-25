import { query } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { getProvider } from "./provider.js";

/**
 * Send one pending refund to the gateway. Called AFTER the cancel transaction has committed, so we
 * never hold row locks while waiting on the network. Idempotent: the refund id is the gateway
 * idempotency key, and only 'pending' rows are touched. Failures keep the row 'pending' so the
 * reconcile job retries; the booking is already cancelled either way.
 */
export async function settleRefund(refundId: string): Promise<"processed" | "pending" | "failed" | "skipped"> {
  const { rows } = await query<{ id: string; amount_paise: number; status: string; provider_ref: string | null; booking_id: string }>(
    `select r.id, r.amount_paise, r.status, p.provider_ref, r.booking_id
       from payment_refunds r join payments p on p.id = r.payment_id
      where r.id = $1`,
    [refundId],
  );
  const refund = rows[0];
  if (!refund || refund.status !== "pending") return "skipped";

  try {
    const provider = await getProvider();
    const result = await provider.refund({
      providerPaymentId: refund.provider_ref ?? "",
      amountPaise: refund.amount_paise,
      idempotencyKey: refund.id,
      notes: { booking_id: refund.booking_id },
    });
    await query(
      "update payment_refunds set status = $2, provider_refund_id = $3 where id = $1 and status = 'pending'",
      [refund.id, result.status, result.providerRefundId],
    );
    return result.status;
  } catch (err) {
    logger.error({ err: (err as Error).message, refundId }, "refund attempt failed; will retry");
    return "pending";
  }
}

/** Retry every refund still pending (job + admin tool). */
export async function settlePendingRefunds(limit = 50): Promise<number> {
  const { rows } = await query<{ id: string }>(
    "select id from payment_refunds where status = 'pending' order by created_at asc limit $1",
    [limit],
  );
  let done = 0;
  for (const r of rows) {
    const outcome = await settleRefund(r.id);
    if (outcome === "processed") done += 1;
  }
  return done;
}
