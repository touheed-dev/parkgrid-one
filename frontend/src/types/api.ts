// Shared API row types. Same names the former *.server.ts files exported, so hooks and pages keep compiling.
import type { Database } from "@/types/db";

type Tables = Database["public"]["Tables"];

/** Columns added by the Express backend (opaque QR pass, gateway fields). */
export type BookingRow = Tables["bookings"]["Row"] & {
  qr_token: string | null;
  qr_issued_at: string | null;
  qr_revoked_at: string | null;
};
export type PricingSettingsRow = Tables["pricing_settings"]["Row"] & {
  early_entry_minutes?: number;
};
export type ParkingLevelRow = Tables["parking_levels"]["Row"];
export type ParkingSlotRow = Tables["parking_slots"]["Row"];
export type PaymentRow = Tables["payments"]["Row"] & {
  provider_order_id?: string | null;
  method: Tables["payments"]["Row"]["method"] | null;
};
export type PaymentRefundRow = Tables["payment_refunds"]["Row"] & {
  provider_refund_id?: string | null;
  status?: "pending" | "processed" | "failed";
};
export type ParkingSessionRow = Tables["parking_sessions"]["Row"];
export type OverstayChargeRow = Tables["overstay_charges"]["Row"];
export type NotificationRow = Tables["notifications"]["Row"];
export type VehicleRow = Tables["vehicles"]["Row"];
export type AdminAuditLogRow = Tables["admin_audit_log"]["Row"] & {
  actor?: { full_name: string | null } | null;
};

export type ParkingSlotWithOccupancy = ParkingSlotRow & {
  is_occupied: boolean;
  current_booking?: {
    id: string;
    reference: string;
    status: string;
    start_at: string;
    end_at: string;
    plate_snapshot?: string | null;
  } | null;
};

export type VehicleType = "car" | "suv" | "bike" | "ev";
export type ConnectorType = "CCS2" | "Type2" | "CHAdeMO" | "Bharat_AC001" | "Bharat_DC001";
export type NotificationType = "booking" | "payment" | "session" | "system" | "info";
