// Razorpay Checkout.js flow (browser only).
//   1. server creates an order for the SERVER-computed price and returns only the public key id
//   2. we open Checkout.js with that order
//   3. on success we send the three signed values to the server, which verifies the HMAC and
//      confirms the booking (the webhook is the backup if this tab never returns)
// The key SECRET never reaches the browser.
import {
  createRazorpayOrder,
  reportRazorpayFailure,
  verifyRazorpayPayment,
  type PaymentMethod,
  type PaymentResult,
} from "@/lib/api/payments";

const CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

interface RazorpaySuccess {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayInstance {
  open(): void;
  on(
    event: "payment.failed",
    handler: (response: { error?: { description?: string } }) => void,
  ): void;
}

interface RazorpayOptions {
  key: string;
  amount: number;
  currency: string;
  order_id: string;
  name: string;
  description: string;
  prefill?: { name?: string; email?: string };
  theme?: { color: string };
  handler: (response: RazorpaySuccess) => void;
  modal?: { ondismiss?: () => void; escape?: boolean };
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

let scriptPromise: Promise<void> | null = null;

/** Load Checkout.js on demand (never during SSR, never on pages that do not pay). */
export function loadCheckoutScript(): Promise<void> {
  if (typeof window === "undefined")
    return Promise.reject(new Error("Checkout is only available in the browser."));
  if (window.Razorpay) return Promise.resolve();
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = CHECKOUT_SRC;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      scriptPromise = null; // allow a retry
      reject(
        new Error("Could not load the payment window. Please check your connection and try again."),
      );
    };
    document.head.appendChild(el);
  });
  return scriptPromise;
}

export type RazorpayOutcome =
  | { kind: "paid"; result: PaymentResult }
  | { kind: "failed"; reason: string }
  | { kind: "dismissed" };

export async function payWithRazorpay(input: {
  bookingId: string;
  method: PaymentMethod;
  prefill?: { name?: string; email?: string };
}): Promise<RazorpayOutcome> {
  await loadCheckoutScript();
  const order = await createRazorpayOrder({
    data: { booking_id: input.bookingId, method: input.method },
  });
  const Razorpay = window.Razorpay;
  if (!Razorpay) throw new Error("The payment window is unavailable. Please try again.");

  return new Promise<RazorpayOutcome>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: RazorpayOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    const rzp = new Razorpay({
      key: order.keyId,
      amount: order.amount,
      currency: order.currency,
      order_id: order.orderId,
      name: "ParkGrid One",
      description: `Booking ${order.bookingReference}`,
      ...(input.prefill ? { prefill: input.prefill } : {}),
      theme: { color: "#00B8D4" },
      handler: (response) => {
        verifyRazorpayPayment({ data: response })
          .then((verified) =>
            finish({
              kind: "paid",
              result: { payment: verified.payment, booking: verified.booking },
            }),
          )
          .catch((err: unknown) => {
            if (!settled) {
              settled = true;
              reject(err instanceof Error ? err : new Error("Payment verification failed."));
            }
          });
      },
      modal: { ondismiss: () => finish({ kind: "dismissed" }), escape: true },
    });

    rzp.on("payment.failed", (response) => {
      const reason = response.error?.description ?? "Payment failed. Please try again.";
      void reportRazorpayFailure({ data: { razorpay_order_id: order.orderId, reason } }).catch(
        () => undefined,
      );
      finish({ kind: "failed", reason });
    });

    rzp.open();
  });
}
