import Razorpay from "razorpay";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import type { PaymentProvider, ProviderOrder, RefundResult } from "./provider.js";

/**
 * Razorpay gateway (Orders API + refunds). Verified against razorpay-node 2.9.x:
 *   orders.create({ amount, currency, receipt, notes }), payments.refund(paymentId, { amount, speed, notes, receipt })
 * Amounts are integer paise. The key SECRET is read only here, never sent to the browser.
 */
export class RazorpayProvider implements PaymentProvider {
  readonly name = "razorpay" as const;
  private readonly client = new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });

  async createOrder(input: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<ProviderOrder> {
    try {
      const order = await this.client.orders.create({
        amount: input.amountPaise,
        currency: "INR",
        receipt: input.receipt.slice(0, 40),
        notes: input.notes,
      });
      return { orderId: order.id, amountPaise: Number(order.amount), currency: "INR" };
    } catch (err) {
      logger.error({ err: describe(err) }, "razorpay order creation failed");
      throw new AppError("PAYMENT_GATEWAY_ERROR", 502, "Could not start the payment. Please try again.");
    }
  }

  async refund(input: { providerPaymentId: string; amountPaise: number; idempotencyKey: string; notes?: Record<string, string> }): Promise<RefundResult> {
    const refund = await this.client.payments.refund(input.providerPaymentId, {
      amount: input.amountPaise,
      speed: "normal",
      receipt: input.idempotencyKey.slice(0, 40),
      notes: input.notes ?? {},
    });
    return { providerRefundId: refund.id, status: refund.status === "processed" ? "processed" : "pending" };
  }

  publicKeyId(): string {
    return env.RAZORPAY_KEY_ID;
  }
}

function describe(err: unknown): string {
  const e = err as { error?: { description?: string }; message?: string };
  return e?.error?.description ?? e?.message ?? "unknown";
}
