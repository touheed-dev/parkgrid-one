import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";

export interface ProviderOrder {
  orderId: string;
  amountPaise: number;
  currency: "INR";
}

export interface RefundResult {
  providerRefundId: string;
  status: "processed" | "pending";
}

/**
 * Gateway abstraction. PAYMENT_PROVIDER=mock keeps the original simulated scenarios
 * (success / decline / insufficient_funds / timeout) for dev and tests; razorpay is the real thing.
 */
export interface PaymentProvider {
  readonly name: "mock" | "razorpay";
  createOrder(input: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<ProviderOrder>;
  /** Refund (part of) a captured payment. `idempotencyKey` makes retries safe. */
  refund(input: { providerPaymentId: string; amountPaise: number; idempotencyKey: string; notes?: Record<string, string> }): Promise<RefundResult>;
  /** Public key id for Checkout.js (never the secret). */
  publicKeyId(): string | null;
}

export class MockProvider implements PaymentProvider {
  readonly name = "mock" as const;
  async createOrder(input: { amountPaise: number }): Promise<ProviderOrder> {
    return { orderId: `order_mock_${randomUUID().replaceAll("-", "").slice(0, 14)}`, amountPaise: input.amountPaise, currency: "INR" };
  }
  async refund(): Promise<RefundResult> {
    return { providerRefundId: `rfnd_mock_${randomUUID().replaceAll("-", "").slice(0, 14)}`, status: "processed" };
  }
  publicKeyId(): string | null {
    return null;
  }
}

let cached: PaymentProvider | null = null;
let override: PaymentProvider | null = null;

/** Tests inject a fake gateway here. */
export function setProviderForTests(p: PaymentProvider | null): void {
  override = p;
}

export async function getProvider(): Promise<PaymentProvider> {
  if (override) return override;
  if (cached) return cached;
  if (env.PAYMENT_PROVIDER === "razorpay") {
    const { RazorpayProvider } = await import("./razorpay.js");
    cached = new RazorpayProvider();
  } else {
    cached = new MockProvider();
  }
  return cached;
}
