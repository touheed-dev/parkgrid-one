import type { AdminAuditLogRow, PricingSettingsRow } from "@/types/api";
import { http } from "./http";

export type { AdminAuditLogRow, PricingSettingsRow };

export const adminGetSettings = () => http.get<{ settings: PricingSettingsRow }>("/admin/settings");

export const adminUpdateSettings = ({
  data,
}: {
  data: {
    gst_bps: number;
    hold_minutes: number;
    min_hours: number;
    max_hours: number;
    max_advance_days: number;
    refund_full_hours: number;
    refund_partial_minutes: number;
    partial_refund_bps: number;
    exit_grace_minutes: number;
    reason: string;
  };
}) => {
  if (data.max_hours < data.min_hours) {
    return Promise.reject(
      new Error("Maximum booking hours cannot be less than minimum booking hours."),
    );
  }
  return http.put<{ settings: PricingSettingsRow }>("/admin/settings", data);
};

export const adminListAuditLogs = ({ data }: { data?: { limit?: number } } = {}) =>
  http.get<{ logs: AdminAuditLogRow[] }>("/admin/audit-logs", { limit: data?.limit ?? 50 });

export type SlotRates = {
  standard_rate_paise: number;
  ev_rate_paise: number;
  accessible_rate_paise: number;
};

export const adminGetSlotRates = () => http.get<{ rates: SlotRates }>("/admin/slot-rates");

export const adminUpdateSlotRates = ({ data }: { data: SlotRates & { reason: string } }) =>
  http.put<{ rates: SlotRates }>("/admin/slot-rates", data);

export interface AdminDashboardData {
  kpis: {
    bookings_today: number;
    revenue_today_paise: number;
    active_sessions_count: number;
    occupancy_percent: number;
    total_active_slots: number;
    occupied_slots: number;
  };
  revenue_last_7_days: Array<{ date: string; label: string; net_paise: number }>;
  recent_bookings: Array<{
    id: string;
    reference: string;
    slot_code: string;
    plate_snapshot: string;
    start_at: string;
    end_at: string;
    status: string;
    total_paise: number;
    created_at: string;
  }>;
  alerts: Array<{
    id: string;
    severity: "warning" | "error" | "info";
    title: string;
    description: string;
    link_tab: string;
  }>;
  generated_at: string;
}

export const adminGetDashboardStats = () =>
  http.get<{ dashboard: AdminDashboardData }>("/admin/dashboard");
