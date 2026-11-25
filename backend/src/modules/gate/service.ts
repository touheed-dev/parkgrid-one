import { query } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { parseQrPayload } from "../../lib/tokens.js";
import type { AuthUser } from "../../middleware/auth.js";
import type { BookingRow } from "../bookings/repo.js";
import { finalizeSession, type SessionRow } from "../sessions/service.js";
import { getPricingSettings } from "../settings/repo.js";

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
  booking?: { reference: string; plate: string; slot: string; level: string; start_at: Date; end_at: Date };
  session?: { entered_at: Date | null; ended_at: Date | null };
  overstay?: { minutes: number; total_paise: number; status: "none" | "paid" | "due" };
}

const MESSAGES: Record<ScanResult, string> = {
  ok: "Welcome",
  already_entered: "Vehicle is already inside. Nothing changed.",
  already_exited: "Vehicle has already exited.",
  invalid_token: "This QR code is not valid.",
  cancelled: "This booking was cancelled.",
  expired: "This pass has expired.",
  too_early: "Too early. Entry opens shortly before the booked start time.",
  already_used: "This pass was already used.",
  not_entered: "No entry was recorded for this pass, so it cannot exit.",
  no_session: "No parking session was found for this booking.",
};

interface BookingWithSlot extends BookingRow {
  slot_code: string;
  level_code: string;
}

async function audit(
  direction: "entry" | "exit",
  result: ScanResult,
  actor: AuthUser,
  gateId: string | undefined,
  bookingId: string | null,
  tokenPrefix: string | null,
  reason?: string,
): Promise<void> {
  await query(
    `insert into gate_scans (booking_id, token_prefix, scanned_by, direction, gate_id, result, reason)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [bookingId, tokenPrefix, actor.id, direction, gateId ?? null, result, reason ?? null],
  );
}

function bookingView(b: BookingWithSlot) {
  return { reference: b.reference, plate: b.plate_snapshot, slot: b.slot_code, level: b.level_code, start_at: b.start_at, end_at: b.end_at };
}

/**
 * Scan a QR pass at the gate. Every outcome (ok, invalid, expired, cancelled, too early, replays)
 * is stored in gate_scans and returned to the staff screen with a clear reason. Entry and exit are
 * idempotent: scanning twice never creates a second session or a second charge.
 */
export async function scan(actor: AuthUser, input: { token: string; direction: "entry" | "exit"; gateId?: string | undefined }): Promise<ScanOutcome> {
  const { direction } = input;
  const finish = async (result: ScanResult, b: BookingWithSlot | null, extra: Partial<ScanOutcome> = {}, tokenPrefix: string | null = null): Promise<ScanOutcome> => {
    await audit(direction, result, actor, input.gateId, b?.id ?? null, tokenPrefix);
    const ok = result === "ok" || result === "already_entered" || result === "already_exited";
    return { ok, result, message: MESSAGES[result], direction, ...(b ? { booking: bookingView(b) } : {}), ...extra };
  };

  const token = parseQrPayload(input.token);
  if (!token) return finish("invalid_token", null);
  const prefix = token.slice(0, 6);

  const found = await query<BookingWithSlot>(
    `select b.*, s.code as slot_code, s.level_code from bookings b join parking_slots s on s.id = b.slot_id where b.qr_token = $1`,
    [token],
  );
  const b = found.rows[0];
  if (!b) return finish("invalid_token", null, {}, prefix);

  const sessRes = await query<SessionRow>("select * from parking_sessions where booking_id = $1", [b.id]);
  const sess = sessRes.rows[0] ?? null;
  const now = Date.now();
  const settings = await getPricingSettings();

  if (direction === "entry") {
    if (b.status === "completed") return finish("already_used", b, {}, prefix);
    if (b.qr_revoked_at || ["cancelled", "no_show"].includes(b.status)) return finish("cancelled", b, {}, prefix);
    if (b.status === "expired") return finish("expired", b, {}, prefix);
    if (sess?.entered_at && !sess.ended_at) {
      return finish("already_entered", b, { session: { entered_at: sess.entered_at, ended_at: null } }, prefix);
    }
    if (now < b.start_at.getTime() - settings.early_entry_minutes * 60_000) return finish("too_early", b, {}, prefix);
    if (now > b.end_at.getTime()) return finish("expired", b, {}, prefix);
    if (!sess) return finish("no_session", b, {}, prefix);

    const entered = await withTransaction(async (tx) => {
      const locked = await query<SessionRow>("select * from parking_sessions where booking_id = $1 for update", [b.id], tx);
      const s = locked.rows[0]!;
      if (s.entered_at) return { raced: true as const, at: s.entered_at }; // lost a race with a concurrent scan
      const at = new Date();
      await query("update parking_sessions set entered_at = $2, status = 'active' where id = $1", [s.id, at], tx);
      await query("update bookings set status = 'active' where id = $1 and status = 'confirmed'", [b.id], tx);
      return { raced: false as const, at };
    });
    return finish(entered.raced ? "already_entered" : "ok", b, { session: { entered_at: entered.at, ended_at: null } }, prefix);
  }

  // ---- exit ----
  if (!sess) return finish("no_session", b, {}, prefix);
  if (sess.ended_at) {
    return finish("already_exited", b, { session: { entered_at: sess.entered_at, ended_at: sess.ended_at } }, prefix);
  }
  if (!sess.entered_at) return finish("not_entered", b, {}, prefix);

  const done = await withTransaction(async (tx) => {
    const locked = await query<SessionRow>("select * from parking_sessions where booking_id = $1 for update", [b.id], tx);
    const s = locked.rows[0]!;
    if (s.ended_at) return { raced: true as const, endedAt: s.ended_at };
    const bk = await query<BookingRow>("select * from bookings where id = $1 for update", [b.id], tx);
    const result = await finalizeSession(tx, s, bk.rows[0]!, await getPricingSettings(tx), { endedAt: new Date(), byAdmin: false, auto: false });
    return { raced: false as const, endedAt: result.endedAt, result };
  });
  if (done.raced) return finish("already_exited", b, { session: { entered_at: sess.entered_at, ended_at: done.endedAt } }, prefix);
  return finish(
    "ok",
    b,
    {
      session: { entered_at: sess.entered_at, ended_at: done.endedAt },
      overstay: { minutes: done.result.overstayMinutes, total_paise: done.result.overstayTotalPaise, status: done.result.overstayStatus },
    },
    prefix,
  );
}

export async function recentScans(actor: AuthUser, limit = 10) {
  const { rows } = await query(
    `select g.id, g.direction, g.result, g.gate_id, g.created_at, b.reference, b.plate_snapshot as plate
       from gate_scans g left join bookings b on b.id = g.booking_id
      where g.scanned_by = $1 order by g.created_at desc limit $2`,
    [actor.id, limit],
  );
  return { scans: rows };
}
