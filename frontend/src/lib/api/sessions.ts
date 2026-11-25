import type { OverstayChargeRow, ParkingSessionRow } from "@/types/api";
import { http } from "./http";

export type { OverstayChargeRow, ParkingSessionRow };

export type AdminActiveSessionRow = {
  sessionId: string;
  bookingId: string;
  bookingReference: string;
  slotCode: string;
  levelCode: string;
  plateSnapshot: string;
  userFullName: string | null;
  startedAt: string;
  bookedEndAt: string;
  overstayMinutes: number;
  overstayChargePaise: number;
  isOverstay: boolean;
};

export interface ActiveSession {
  sessionId: string;
  bookingId: string;
  userId: string;
  startedAt: string;
  bookedEndAt: string;
  endedAt: string | null;
  enteredAt: string | null;
  status: string;
  autoEnded: boolean;
  endedByAdmin: boolean;
  durationMinutes: number | null;
  isActive: boolean;
  elapsedSeconds: number;
  secondsRemaining: number;
  overstaySeconds: number;
  overstayPaiseSoFar: number;
  elapsed: number;
  remaining: number;
}

interface SessionListItem {
  sessionId: string;
  bookingId: string;
  startedAt: string;
  bookedEndAt: string;
  endedAt: string | null;
  status: string;
  autoEnded: boolean;
  durationMinutes: number | null;
  bookingReference: string;
  slotCode: string;
  levelCode: string;
  plateSnapshot: string;
  overstayTotalPaise: number;
}

interface SessionDetail extends SessionListItem {
  userId: string;
  endedByAdmin: boolean;
}

export const getActiveSession = ({
  data,
}: { data?: { booking_id?: string | null | undefined } } = {}) =>
  http.get<{ session: ActiveSession | null }>("/sessions/active", {
    booking_id: data?.booking_id ?? undefined,
  });

export const endSession = ({ data }: { data: { session_id: string } }) =>
  http.post<{
    sessionId: string;
    bookingId: string;
    endedAt: string;
    durationMinutes: number;
    overstayMinutes: number;
    overstayTotalPaise: number;
  }>(`/sessions/${data.session_id}/end`);

export const listMySessions = ({
  data,
}: { data?: { status?: string | null | undefined; page?: number; pageSize?: number } } = {}) =>
  http.get<{
    sessions: SessionListItem[];
    totalCount: number;
    totalPages: number;
    page: number;
    pageSize: number;
  }>("/sessions", {
    status: data?.status ?? undefined,
    page: data?.page,
    pageSize: data?.pageSize,
  });

export const getSession = ({ data }: { data: { session_id: string } }) =>
  http.get<{ session: SessionDetail | null }>(`/sessions/${data.session_id}`);

export const adminListSessions = ({
  data,
}: { data?: { status?: string; search?: string; page?: number; pageSize?: number } } = {}) =>
  http.get<{
    sessions: (SessionDetail & { userFullName: string | null })[];
    totalCount: number;
    totalPages: number;
    page: number;
    pageSize: number;
  }>("/admin/sessions", data ?? {});

export const adminActiveSessions = () =>
  http.get<{ sessions: AdminActiveSessionRow[] }>("/admin/sessions/active");
