import type {
  BookingRow,
  ParkingSessionRow,
  PaymentRefundRow,
  PaymentRow,
  VehicleRow,
} from "@/types/api";
import { http } from "./http";

export type { BookingRow };

type Args<T> = { data: T };

export const getAvailability = ({
  data,
}: Args<{
  start_at: string;
  end_at: string;
  level?: string | null;
  zone?: string | null;
  slot_type?: string | null;
}>) =>
  http.get<{ availability: { slot_id: string; is_available: boolean }[] }>(
    "/bookings/availability",
    {
      start_at: data.start_at,
      end_at: data.end_at,
      level: data.level ?? undefined,
      zone: data.zone ?? undefined,
      slot_type: data.slot_type ?? undefined,
    },
  );

export const quoteBooking = ({
  data,
}: Args<{ slot_id: string; start_at: string; end_at: string }>) =>
  http.get<{
    quote: {
      hours: number;
      hourly_rate_paise: number;
      base_paise: number;
      gst_paise: number;
      total_paise: number;
    };
  }>("/bookings/quote", data);

export const createBooking = ({
  data,
}: Args<{ slot_id: string; vehicle_id: string; start_at: string; end_at: string }>) =>
  http.post<{ booking: BookingRow }>("/bookings", data);

export const listMyBookings = ({
  data,
}: Args<{
  statusTab?: "Upcoming" | "Active" | "Completed" | "Cancelled";
  page?: number;
  pageSize?: number;
}>) =>
  http.get<{ bookings: BookingRow[]; totalCount: number; page: number; pageSize: number }>(
    "/bookings",
    data,
  );

export const getBooking = ({
  data,
}: Args<{ id?: string | undefined; reference?: string | undefined }>) => {
  if (data.id) return http.get<{ booking: BookingRow }>(`/bookings/${data.id}`);
  if (data.reference)
    return http.get<{ booking: BookingRow }>("/bookings/lookup", { reference: data.reference });
  return Promise.reject(new Error("Booking identifier required."));
};

export const getCancellationPreview = ({ data }: Args<{ booking_id: string }>) =>
  http.get<{
    preview: {
      booking_id: string;
      total_paise: number;
      refund_paise: number;
      refund_percentage: number;
      payment_status: string;
    };
  }>(`/bookings/${data.booking_id}/cancellation-preview`);

export const cancelBooking = ({
  data,
}: Args<{ booking_id: string; reason?: string | null | undefined }>) =>
  http.post<{ booking: BookingRow }>(`/bookings/${data.booking_id}/cancel`, {
    reason: data.reason ?? null,
  });

/** Owner re-issues the QR pass (the old one stops working immediately). */
export const reissueQr = ({ data }: Args<{ booking_id: string }>) =>
  http.post<{ booking: BookingRow }>(`/bookings/${data.booking_id}/qr/reissue`);

export const adminListBookings = ({
  data,
}: Args<{
  status?: string;
  payment_status?: string;
  search?: string;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  page?: number;
  pageSize?: number;
}>) =>
  http.get<{
    bookings: BookingRow[];
    totalCount: number;
    totalPages: number;
    page: number;
    pageSize: number;
  }>("/admin/bookings", data);

export type AdminBookingDetail = BookingRow & {
  parking_slots: {
    id: string;
    code: string;
    level_code: string;
    zone: string;
    slot_type: string;
    [k: string]: unknown;
  } | null;
  vehicles: (VehicleRow & { [k: string]: unknown }) | null;
  profiles: { id: string; full_name: string | null; phone: string | null; role: string } | null;
  payments: PaymentRow[];
  payment_refunds: PaymentRefundRow[];
  parking_sessions: ParkingSessionRow | null;
};

export const adminGetBooking = ({ data }: Args<{ booking_id: string }>) =>
  http.get<{ booking: AdminBookingDetail }>(`/admin/bookings/${data.booking_id}`);

export const adminOverrideBooking = ({
  data,
}: Args<{
  booking_id: string;
  action: "cancel_full_refund" | "cancel_by_policy" | "cancel_no_refund" | "mark_no_show";
  reason: string;
}>) =>
  http.post<{ booking: BookingRow }>(`/admin/bookings/${data.booking_id}/override`, {
    action: data.action,
    reason: data.reason,
  });
