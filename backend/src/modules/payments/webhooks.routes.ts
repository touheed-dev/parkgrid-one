import express, { Router } from "express";
import { env } from "../../config/env.js";
import { query } from "../../db/pool.js";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { safeEqual } from "../../lib/tokens.js";
import { confirmCapturedPayment, markOrderFailed, signPayload, type PaymentMethod } from "./service.js";

/**
 * Mounted BEFORE express.json(): the signature is computed over the exact raw bytes,
 * so the body must stay a Buffer. Never compare signatures with ===.
 */
export const webhooksRouter: Router = Router();

interface RazorpayEvent {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string; method?: string; error_description?: string } };
    order?: { entity?: { id?: string } };
    refund?: { entity?: { id?: string; status?: string } };
  };
}

const METHODS = new Set(["upi", "card", "netbanking", "wallet"]);
const asMethod = (m?: string): PaymentMethod | null => (m && METHODS.has(m) ? (m as PaymentMethod) : null);

async function processEvent(evt: RazorpayEvent): Promise<void> {
  const payment = evt.payload?.payment?.entity;
  switch (evt.event) {
    case "payment.captured":
    case "order.paid": {
      const orderId = payment?.order_id ?? evt.payload?.order?.entity?.id;
      if (!orderId || !payment?.id) throw new Error("event is missing order/payment id");
      await confirmCapturedPayment({ orderId, providerPaymentId: payment.id, method: asMethod(payment.method) });
      return;
    }
    case "payment.failed": {
      if (payment?.order_id) await markOrderFailed(payment.order_id, payment.error_description ?? "Payment failed");
      return;
    }
    case "refund.processed":
    case "refund.failed": {
      const refund = evt.payload?.refund?.entity;
      if (refund?.id) {
        await query("update payment_refunds set status = $2 where provider_refund_id = $1", [refund.id, evt.event === "refund.processed" ? "processed" : "failed"]);
      }
      return;
    }
    default:
      return; // event types we do not care about are acknowledged and ignored
  }
}

webhooksRouter.post("/razorpay", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  const raw = req.body;
  const signature = req.get("x-razorpay-signature") ?? "";
  if (!Buffer.isBuffer(raw) || !env.RAZORPAY_WEBHOOK_SECRET || !safeEqual(signPayload(raw, env.RAZORPAY_WEBHOOK_SECRET), signature)) {
    res.status(400).json({ error: { code: "INVALID_SIGNATURE", message: "Invalid webhook signature" } });
    return;
  }

  let evt: RazorpayEvent;
  try {
    evt = JSON.parse(raw.toString("utf8")) as RazorpayEvent;
  } catch {
    res.status(400).json({ error: { code: "INVALID_JSON", message: "Malformed body" } });
    return;
  }

  // Razorpay retries with the same event id, so it is our idempotency key.
  const eventId = req.get("x-razorpay-event-id") ?? "";
  if (!eventId) {
    res.status(400).json({ error: { code: "MISSING_EVENT_ID", message: "Missing event id" } });
    return;
  }

  const ins = await query<{ id: string; processed_at: Date | null }>(
    `insert into webhook_events (provider, event_id, event_type, payload)
     values ('razorpay', $1, $2, $3)
     on conflict (provider, event_id) do update set event_type = excluded.event_type
     returning id, processed_at`,
    [eventId, evt.event ?? "unknown", JSON.stringify(evt)],
  );
  const row = ins.rows[0]!;
  if (row.processed_at) {
    res.json({ received: true, duplicate: true }); // already handled: acknowledge fast
    return;
  }

  try {
    await processEvent(evt);
    await query("update webhook_events set processed_at = now(), error = null where id = $1", [row.id]);
    res.json({ received: true });
  } catch (err) {
    const message = (err as Error).message;
    if (err instanceof AppError && err.httpStatus === 404) {
      // An event for an order we never created (e.g. another app on the same Razorpay account): retrying is pointless.
      await query("update webhook_events set processed_at = now(), error = $2 where id = $1", [row.id, message.slice(0, 500)]);
      res.json({ received: true, ignored: true });
      return;
    }
    logger.error({ err: message, eventId }, "webhook processing failed");
    await query("update webhook_events set error = $2 where id = $1", [row.id, message.slice(0, 500)]);
    // 5xx makes Razorpay retry later; the row stays unprocessed so the retry runs again.
    res.status(500).json({ error: { code: "WEBHOOK_FAILED", message: "Processing failed" } });
  }
});
