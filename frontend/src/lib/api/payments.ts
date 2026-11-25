import type { BookingRow, PaymentRefundRow, PaymentRow } from "@/types/api";
import { http } from "./http";

export type { PaymentRefundRow, PaymentRow };

export type PaymentMethod = "upi" | "card" | "netbanking" | "wallet";
export type TestScenario = "success" | "decline" | "insufficient_funds" | "timeout";

export interface PaymentResult {
  payment: PaymentRow;
  booking: BookingRow;
}

// ---- gateway selection (the backend decides: mock for dev, razorpay in production) ----
export const getPaymentConfig = () =>
  http.get<{ provider: "mock" | "razorpay"; keyId: string | null }>("/payments/config");

// ---- mock gateway: keeps the original success/decline/insufficient_funds/timeout scenarios ----
export const payBooking = ({
  data,
}: {
  data: {
    booking_id: string;
    method: PaymentMethod;
    idempotency_key: string;
    test_scenario?: TestScenario | undefined;
  };
}) =>
  http.post<PaymentResult>("/payments/pay", {
    ...data,
    test_scenario: data.test_scenario ?? "success",
  });

// ---- Razorpay: server creates the order, Checkout.js pays, server verifies the signature ----
export interface RazorpayOrder {
  orderId: string;
  amount: number;
  currency: "INR";
  keyId: string;
  paymentId: string;
  bookingReference: string;
}

export const createRazorpayOrder = ({
  data,
}: {
  data: { booking_id: string; method?: PaymentMethod | undefined };
}) => http.post<RazorpayOrder>("/payments/create-order", data);

export const verifyRazorpayPayment = ({
  data,
}: {
  data: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string };
}) => http.post<PaymentResult & { outcome: string }>("/payments/verify", data);

export const reportRazorpayFailure = ({
  data,
}: {
  data: { razorpay_order_id: string; reason?: string };
}) => http.post<{ success: boolean }>("/payments/report-failure", data);

export const getReceipt = ({
  data,
}: {
  data: { booking_id?: string; payment_id?: string; receipt_number?: string };
}) => http.get<{ payment: PaymentRow & Record<string, unknown> }>("/payments/receipt", data);

export const listMyPayments = ({ data }: { data?: { page?: number; pageSize?: number } } = {}) =>
  http.get<{
    payments: (PaymentRow & Record<string, unknown>)[];
    totalCount: number;
    page: number;
    pageSize: number;
  }>("/payments", data ?? {});

export const adminListPayments = ({
  data,
}: {
  data?: {
    page?: number;
    pageSize?: number;
    status?: "all" | "succeeded" | "failed" | "refunded" | "partially_refunded";
    method?: "all" | PaymentMethod;
    search?: string;
    dateFrom?: string | undefined;
    dateTo?: string | undefined;
  };
} = {}) =>
  http.get<{
    payments: (PaymentRow & Record<string, unknown>)[];
    totalCount: number;
    page: number;
    pageSize: number;
    totals: {
      grossPaise: number;
      refundPaise: number;
      netPaise: number;
      succeededCount: number;
      failedCount: number;
      totalTransactions: number;
    };
  }>("/admin/payments", data ?? {});

export const adminGetPayment = ({ data }: { data: { payment_id: string } }) =>
  http.get<{ payment: PaymentRow & Record<string, unknown> }>(`/admin/payments/${data.payment_id}`);

export const adminRefundPayment = ({
  data,
}: {
  data: { payment_id: string; amount_paise: number; reason: string };
}) =>
  http.post<{ refund: PaymentRefundRow }>(`/admin/payments/${data.payment_id}/refund`, {
    amount_paise: data.amount_paise,
    reason: data.reason,
  });

export type RevenueReportPeriod = {
  period_label: string;
  gross_paise: number;
  refund_paise: number;
  net_paise: number;
  gst_paise: number;
  bookings_count: number;
  cancelled_count: number;
  overstay_paise: number;
};

export type RevenueReportTotals = {
  total_gross_paise: number;
  total_refund_paise: number;
  total_net_paise: number;
  total_gst_paise: number;
  total_bookings: number;
  total_cancelled: number;
  total_overstay_paise: number;
  average_booking_value_paise: number;
  cancellation_rate_bps: number;
};

export type RevenueReportBreakdown = {
  slot_type?: string;
  level_code?: string;
  method?: string;
  bookings_count?: number;
  count?: number;
  gross_paise: number;
};

export type RevenueReportData = {
  periods: RevenueReportPeriod[];
  totals: RevenueReportTotals;
  breakdown_by_slot_type: RevenueReportBreakdown[];
  breakdown_by_level: RevenueReportBreakdown[];
  breakdown_by_payment_method: RevenueReportBreakdown[];
};

export const adminRevenueReport = ({
  data,
}: {
  data: { from: string; to: string; group?: "day" | "week" | "month" };
}) =>
  http.get<{ report: RevenueReportData }>("/admin/revenue", {
    from: data.from,
    to: data.to,
    group: data.group ?? "day",
  });
