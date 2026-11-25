import type { BookingRow, VehicleRow } from "@/types/api";
import { http } from "./http";

export type AdminUserRow = {
  id: string;
  email: string;
  fullName: string | null;
  phone: string | null;
  role: "member" | "admin" | "staff";
  createdAt: string;
  lastSignInAt: string | null;
  bookingCount: number;
  totalPaidPaise: number;
};

export const adminListUsers = ({
  data,
}: { data?: { search?: string; role?: string; page?: number; pageSize?: number } } = {}) =>
  http.get<{
    users: AdminUserRow[];
    totalCount: number;
    totalPages: number;
    page: number;
    pageSize: number;
  }>("/admin/users", data ?? {});

export const adminSetUserRole = ({
  data,
}: {
  data: { user_id: string; role: "member" | "staff" | "admin"; reason: string };
}) =>
  http.patch<{ profile: Record<string, unknown> }>(`/admin/users/${data.user_id}/role`, {
    role: data.role,
    reason: data.reason,
  });

export const adminSetUserDisabled = ({
  data,
}: {
  data: { user_id: string; disabled: boolean; reason: string };
}) =>
  http.patch<{ id: string; disabled: boolean }>(`/admin/users/${data.user_id}/status`, {
    disabled: data.disabled,
    reason: data.reason,
  });

export interface AdminUserDetail {
  profile: {
    id: string;
    email?: string;
    full_name: string | null;
    phone: string | null;
    role: "member" | "admin" | "staff";
    created_at: string;
    disabled?: boolean;
  };
  bookings: (BookingRow & { parking_slots: { code: string; level_code: string } | null })[];
  vehicles: VehicleRow[];
}

export const adminGetUserDetail = ({ data }: { data: { user_id: string } }) =>
  http.get<AdminUserDetail>(`/admin/users/${data.user_id}`);
