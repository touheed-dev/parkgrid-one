import { http } from "./http";

export type ProfileData = {
  id: string;
  email: string;
  full_name: string | null;
  phone: string | null;
  role: "member" | "admin" | "staff";
  created_at: string;
};

export type UpdateProfileInput = { full_name: string; phone?: string | null | undefined };

/** Same rule the API enforces (kept here so forms can validate before submitting). */
export function normalizeIndianPhone(input: string): string {
  const cleaned = input.trim().replace(/[\s-]/g, "");
  const match = cleaned.match(/^(?:\+91|91|0)?([6-9]\d{9})$/);
  if (!match || !match[1]) {
    throw new Error("Phone must be a valid 10-digit Indian mobile number starting with 6-9.");
  }
  return `+91${match[1]}`;
}

export const getProfile = () => http.get<{ profile: ProfileData }>("/profile");

export const updateProfile = ({ data }: { data: UpdateProfileInput }) =>
  http.patch<{ profile: ProfileData }>("/profile", data);

export const listRecentBookings = () =>
  http.get<{
    bookings: {
      id: string;
      reference: string;
      status: string;
      start_at: string;
      end_at: string;
      total_paise: number;
      parking_slots: { code: string; zone: string; level_code: string } | null;
    }[];
  }>("/profile/recent-bookings");
