import { query } from "../../db/pool.js";
import { withTransaction, type Tx } from "../../db/tx.js";
import { AppError } from "../../lib/errors.js";
import { overstayBase, percentOfBps } from "../../lib/money.js";
import type { AuthUser } from "../../middleware/auth.js";
import type { BookingRow } from "../bookings/repo.js";
import { getProvider } from "../payments/provider.js";
import { getPricingSettings, type PricingSettings } from "../settings/repo.js";

/** A session that nobody ended is closed automatically this long after the booked end (safety cap). */
const AUTO_END_CAP_MS = 12 * 3_600_000;

export interface SessionRow {
  id: string;
  booking_id: string;
  user_id: string;
  started_at: Date;
  booked_end_at: Date;
  entered_at: Date | null;
  ended_at: Date | null;
  ended_by_admin: boolean;
  duration_minutes: number | null;
  status: "active" | "completed" | "auto_ended" | "cancelled";
  auto_ended: boolean;
}

export interface FinalizeResult {
  endedAt: Date;
  durationMinutes: number;
  overstayMinutes: number;
  overstayTotalPaise: number;
  overstayStatus: "none" | "paid" | "due";
}

/**
 * Close a session: stamp end/duration, record any overstay charge, complete the booking and revoke
 * the QR pass. Shared by self-service end, gate exit and the 12 h safety cap, so all three agree.
 * Caller holds row locks on the session and booking.
 */
export async function finalizeSession(
  tx: Tx,
  sess: SessionRow,
  booking: BookingRow,
  settings: PricingSettings,
  opts: { endedAt: Date; byAdmin: boolean; auto: boolean },
): Promise<FinalizeResult> {
  const { endedAt } = opts;
  const durationMinutes = Math.max(0, Math.ceil((endedAt.getTime() - sess.started_at.getTime()) / 60_000));
  const pastEndMinutes = Math.ceil((endedAt.getTime() - sess.booked_end_at.getTime()) / 60_000);
  const overstayMinutes = Math.max(0, pastEndMinutes - settings.exit_grace_minutes);

  await query(
    `update parking_sessions set ended_at = $2, duration_minutes = $3, status = $4, auto_ended = $5, ended_by_admin = $6
      where id = $1`,
    [sess.id, endedAt, durationMinutes, opts.auto ? "auto_ended" : "completed", opts.auto, opts.byAdmin],
    tx,
  );

  let overstayTotalPaise = 0;
  let overstayStatus: FinalizeResult["overstayStatus"] = "none";
  if (overstayMinutes > 0) {
    const base = overstayBase(overstayMinutes, booking.hourly_rate_paise);
    const gst = percentOfBps(base, settings.gst_bps);
    overstayTotalPaise = base + gst;
    // Mock gateway settles instantly (original behaviour). With a real gateway the amount is
    // recorded as 'due' and collected at the gate / by an admin.
    const isMock = (await getProvider()).name === "mock";
    const rc = await query<{ r: string }>("select generate_overstay_receipt_number() as r", [], tx);
    await query(
      `insert into overstay_charges (session_id, booking_id, user_id, overstay_minutes, base_paise, gst_paise, total_paise,
                                    status, provider_ref, receipt_number, paid_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [sess.id, booking.id, sess.user_id, overstayMinutes, base, gst, overstayTotalPaise,
       isMock ? "paid" : "due", isMock ? `MOCK-AUTO-${sess.id.slice(0, 8).toUpperCase()}` : null, rc.rows[0]!.r, isMock ? endedAt : null],
      tx,
    );
    overstayStatus = isMock ? "paid" : "due";
  }

  await query("update bookings set status = 'completed', qr_revoked_at = coalesce(qr_revoked_at, now()) where id = $1", [booking.id], tx);
  return { endedAt, durationMinutes, overstayMinutes, overstayTotalPaise, overstayStatus };
}

async function lockSession(tx: Tx, idOrBookingId: string): Promise<SessionRow | null> {
  const { rows } = await query<SessionRow>(
    "select * from parking_sessions where id = $1 or booking_id = $1 for update",
    [idOrBookingId],
    tx,
  );
  return rows[0] ?? null;
}

async function lockBooking(tx: Tx, id: string): Promise<BookingRow> {
  const { rows } = await query<BookingRow>("select * from bookings where id = $1 for update", [id], tx);
  return rows[0]!;
}

/** Owner (or admin) ends their own parking. Staff exit goes through the gate instead. */
export async function endSession(user: AuthUser, idOrBookingId: string) {
  return withTransaction(async (tx) => {
    const sess = await lockSession(tx, idOrBookingId);
    if (!sess || (sess.user_id !== user.id && user.role !== "admin")) throw AppError.notFound("Session not found", "SESSION_NOT_FOUND");
    if (sess.ended_at) throw AppError.conflict("Session has already been ended", "SESSION_ENDED");
    if (sess.status !== "active") throw AppError.conflict(`Session cannot be ended (status: ${sess.status})`, "SESSION_NOT_ACTIVE");
    const now = new Date();
    if (now < sess.started_at) throw AppError.conflict("This session has not started yet. Cancel the booking instead.", "SESSION_NOT_STARTED");

    const booking = await lockBooking(tx, sess.booking_id);
    const settings = await getPricingSettings(tx);
    const r = await finalizeSession(tx, sess, booking, settings, { endedAt: now, byAdmin: sess.user_id !== user.id, auto: false });
    return {
      sessionId: sess.id,
      bookingId: sess.booking_id,
      endedAt: r.endedAt,
      durationMinutes: r.durationMinutes,
      overstayMinutes: r.overstayMinutes,
      overstayTotalPaise: r.overstayTotalPaise,
    };
  });
}

/** Close every session left open for more than 12 h past its booked end. Returns how many. */
export async function autoEndStaleSessions(): Promise<number> {
  const { rows } = await query<{ id: string }>(
    `select id from parking_sessions
      where status = 'active' and ended_at is null and booked_end_at < now() - interval '12 hours' and entered_at is not null
      limit 200`,
  );
  let n = 0;
  for (const { id } of rows) {
    await withTransaction(async (tx) => {
      const sess = await lockSession(tx, id);
      if (!sess || sess.ended_at || sess.status !== "active") return;
      const booking = await lockBooking(tx, sess.booking_id);
      const settings = await getPricingSettings(tx);
      const endedAt = new Date(sess.booked_end_at.getTime() + AUTO_END_CAP_MS);
      await finalizeSession(tx, sess, booking, settings, { endedAt, byAdmin: false, auto: true });
      n += 1;
    });
  }
  return n;
}

const SESSION_VIEW = `
  ps.id as session_id, ps.booking_id, ps.user_id, ps.started_at, ps.booked_end_at, ps.entered_at, ps.ended_at,
  ps.status, ps.auto_ended, ps.ended_by_admin, ps.duration_minutes,
  b.reference as booking_reference, sl.code as slot_code, sl.level_code, b.plate_snapshot, b.hourly_rate_paise,
  coalesce((select sum(oc.total_paise) from overstay_charges oc where oc.session_id = ps.id), 0)::int as overstay_total_paise`;
const SESSION_FROM = `from parking_sessions ps join bookings b on b.id = ps.booking_id join parking_slots sl on sl.id = b.slot_id`;

export async function getActiveSession(user: AuthUser, bookingId: string | null) {
  await autoEndStaleSessions();
  const { rows } = await query<Record<string, unknown> & { user_id: string }>(
    bookingId
      ? `select ${SESSION_VIEW} ${SESSION_FROM} where ps.booking_id = $1`
      : `select ${SESSION_VIEW} ${SESSION_FROM} where ps.user_id = $1 and ps.status = 'active' and ps.ended_at is null
          order by ps.started_at desc limit 1`,
    [bookingId ?? user.id],
  );
  const s = rows[0];
  if (!s) return { session: null };
  if (s.user_id !== user.id && user.role !== "admin") throw AppError.notFound("Session not found", "SESSION_NOT_FOUND");

  const settings = await getPricingSettings();
  const now = Date.now();
  const startedAt = (s["started_at"] as Date).getTime();
  const bookedEnd = (s["booked_end_at"] as Date).getTime();
  const endedAt = s["ended_at"] as Date | null;

  let isActive = false;
  let elapsed = 0;
  let remaining = 0;
  let overSecs = 0;
  let overPaise = 0;
  if (endedAt) {
    elapsed = Math.floor((endedAt.getTime() - startedAt) / 1000);
  } else if (now < startedAt) {
    remaining = Math.floor((bookedEnd - now) / 1000);
  } else {
    isActive = true;
    elapsed = Math.floor((now - startedAt) / 1000);
    remaining = Math.floor((bookedEnd - now) / 1000);
    const pastEnd = Math.max(0, Math.floor((now - bookedEnd) / 1000));
    overSecs = Math.max(0, pastEnd - settings.exit_grace_minutes * 60);
    overPaise = Math.ceil((overSecs * (s["hourly_rate_paise"] as number)) / 3600);
  }

  return {
    session: {
      sessionId: s["session_id"],
      bookingId: s["booking_id"],
      userId: s["user_id"],
      startedAt: s["started_at"],
      bookedEndAt: s["booked_end_at"],
      endedAt: s["ended_at"],
      enteredAt: s["entered_at"],
      status: s["status"],
      autoEnded: s["auto_ended"],
      endedByAdmin: s["ended_by_admin"],
      durationMinutes: s["duration_minutes"],
      isActive,
      elapsedSeconds: elapsed,
      secondsRemaining: remaining,
      overstaySeconds: overSecs,
      overstayPaiseSoFar: overPaise,
      elapsed,
      remaining,
    },
  };
}

export async function listMySessions(user: AuthUser, status: string | null, page: number, pageSize: number) {
  const where = "ps.user_id = $1 and ($2::text is null or ps.status = $2)";
  const [rows, count] = await Promise.all([
    query(`select ${SESSION_VIEW} ${SESSION_FROM} where ${where} order by ps.started_at desc limit $3 offset $4`, [user.id, status, pageSize, (page - 1) * pageSize]),
    query<{ n: number }>(`select count(*)::int as n from parking_sessions ps where ${where}`, [user.id, status]),
  ]);
  const totalCount = count.rows[0]?.n ?? 0;
  return {
    sessions: rows.rows.map((s) => ({
      sessionId: s["session_id"],
      bookingId: s["booking_id"],
      startedAt: s["started_at"],
      bookedEndAt: s["booked_end_at"],
      endedAt: s["ended_at"],
      status: s["status"],
      autoEnded: s["auto_ended"],
      durationMinutes: s["duration_minutes"],
      bookingReference: s["booking_reference"],
      slotCode: s["slot_code"],
      levelCode: s["level_code"],
      plateSnapshot: s["plate_snapshot"],
      overstayTotalPaise: Number(s["overstay_total_paise"] ?? 0),
    })),
    totalCount,
    totalPages: Math.ceil(totalCount / pageSize) || 1,
    page,
    pageSize,
  };
}

export async function getSession(user: AuthUser, idOrBookingId: string) {
  const { rows } = await query(
    `select ${SESSION_VIEW} ${SESSION_FROM} where (ps.id = $1 or ps.booking_id = $1) and ($2::boolean or ps.user_id = $3)`,
    [idOrBookingId, user.role === "admin", user.id],
  );
  const s = rows[0];
  if (!s) return { session: null };
  return {
    session: {
      sessionId: s["session_id"], bookingId: s["booking_id"], userId: s["user_id"], startedAt: s["started_at"],
      bookedEndAt: s["booked_end_at"], endedAt: s["ended_at"], status: s["status"], autoEnded: s["auto_ended"],
      endedByAdmin: s["ended_by_admin"], durationMinutes: s["duration_minutes"], bookingReference: s["booking_reference"],
      slotCode: s["slot_code"], levelCode: s["level_code"], plateSnapshot: s["plate_snapshot"],
      overstayTotalPaise: Number(s["overstay_total_paise"] ?? 0),
    },
  };
}
