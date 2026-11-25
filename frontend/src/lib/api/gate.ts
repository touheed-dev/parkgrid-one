import { http } from "./http";

export type ScanResult =
  | "ok"
  | "already_entered"
  | "already_exited"
  | "invalid_token"
  | "cancelled"
  | "expired"
  | "too_early"
  | "already_used"
  | "not_entered"
  | "no_session";

export interface ScanOutcome {
  ok: boolean;
  result: ScanResult;
  message: string;
  direction: "entry" | "exit";
  booking?: {
    reference: string;
    plate: string;
    slot: string;
    level: string;
    start_at: string;
    end_at: string;
  };
  session?: { entered_at: string | null; ended_at: string | null };
  overstay?: { minutes: number; total_paise: number; status: "none" | "paid" | "due" };
}

export interface RecentScan {
  id: string;
  direction: "entry" | "exit";
  result: ScanResult;
  gate_id: string | null;
  created_at: string;
  reference: string | null;
  plate: string | null;
}

export const scanPass = ({
  data,
}: {
  data: { token: string; direction: "entry" | "exit"; gateId?: string | undefined };
}) => http.post<ScanOutcome>("/gate/scan", data);

export const listRecentScans = () => http.get<{ scans: RecentScan[] }>("/gate/recent");
