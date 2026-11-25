import type { ParkingSlotRow, ParkingSlotWithOccupancy } from "@/types/api";
import { http } from "./http";

export type { ParkingLevelRow, ParkingSlotRow, ParkingSlotWithOccupancy } from "@/types/api";

export interface ListSlotsInput {
  level: "All" | "B2" | "B1" | "G1" | "L1" | "L2";
  zone: "All" | "A" | "B" | "EV";
  slot_type: "All" | "standard" | "ev" | "accessible";
  admin_status: "All" | "active" | "maintenance" | "blocked";
  search: string;
  page: number;
  pageSize: number;
}

export const listSlots = ({ data }: { data?: Partial<ListSlotsInput> } = {}) =>
  http.get<{
    slots: ParkingSlotWithOccupancy[];
    totalCount: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>("/parking/slots", data ?? {});

export interface FacilitySummary {
  totalSlots: number;
  occupiedSlots: number;
  reservedSlots: number;
  availableSlots: number;
  evReadySlots: number;
  percentage: number;
  levels: { code: string; name: string; sort_order: number; allows_heavy: boolean }[];
  byLevel: Record<
    string,
    { total: number; active: number; occupied: number; maintenance: number; blocked: number }
  >;
  byType: { standard: number; ev: number; accessible: number };
  byStatus: { active: number; occupied: number; maintenance: number; blocked: number };
  updatedAt: string;
}

export const getFacilitySummary = () => http.get<FacilitySummary>("/parking/summary");

export type AdminUpdateSlotInput = {
  id: string;
  admin_status?: "active" | "maintenance" | "blocked";
  notes?: string | null;
  hourly_rate_paise?: number;
};

export const adminUpdateSlot = ({ data }: { data: AdminUpdateSlotInput }) => {
  const { id, ...body } = data;
  return http.patch<{ success: boolean; slot: ParkingSlotRow }>(`/parking/slots/${id}`, body);
};
