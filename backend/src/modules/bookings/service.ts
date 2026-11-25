import { randomInt } from "node:crypto";
import { query } from "../../db/pool.js";
import { withTransaction, type Tx } from "../../db/tx.js";
import { AppError } from "../../lib/errors.js";
import { quoteFor, refundFor, type Quote } from "../../lib/money.js";
import { ceilHours, isAlignedTo15Min, istDateStamp } from "../../lib/time.js";
import type { AuthUser } from "../../middleware/auth.js";
import { settleRefund } from "../payments/refunds.js";
import { getPricingSettings } from "../settings/repo.js";
import * as repo from "./repo.js";

const SLOT_CODE_RE = /^[A-Z0-9]{1,3}-[0-9]{2,3}$/;
const REF_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
/** Small clock-skew tolerance, same as the original (5 minutes). */
const PAST_TOLERANCE_MS = 5 * 60_000;

/** The client may send the slot UUID or its code (e.g. "B2-01"). */
export async function resolveSlotId(slotIdOrCode: string, db?: Tx): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slotIdOrCode)) return slotIdOrCode;
  const code = slotIdOrCode.trim().toUpperCase();
  if (!SLOT_CODE_RE.test(code)) throw AppError.notFound("Slot not found", "SLOT_NOT_FOUND");
  const { rows } = await query<{ id: string }>("select id from parking_slots where code = $1", [code], db);
  if (!rows[0]) throw AppError.notFound("Slot not found", "SLOT_NOT_FOUND");
  return rows[0].id;
}

function newReference(): string {
  let rand = "";
  for (let i = 0; i < 4; i++) rand += REF_CHARS[randomInt(REF_CHARS.length)];
  return `SP-${istDateStamp()}-${rand}`;
}

function parseWindow(startIso: string, endIso: string): { start: Date; end: Date } {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (!(end > start)) throw AppError.badRequest("End time must be after start time", "INVALID_WINDOW");
  return { start, end };
}

export async function quote(slotIdOrCode: string, startIso: string, endIso: string): Promise<Quote> {
  const { start, end } = parseWindow(startIso, endIso);
  const slotId = await resolveSlotId(slotIdOrCode);
  const { rows } = await query<{ hourly_rate_paise: number }>("select hourly_rate_paise from parking_slots where id = $1", [slotId]);
  if (!rows[0]) throw AppError.notFound("Slot not found", "SLOT_NOT_FOUND");
  const s = await getPricingSettings();
  const hours = ceilHours(start, end);
  if (hours < s.min_hours || hours > s.max_hours) {
    throw AppError.badRequest(`Booking duration must be between ${s.min_hours} and ${s.max_hours} hours`, "INVALID_DURATION");
  }
  return quoteFor(hours, rows[0].hourly_rate_paise, s.gst_bps);
}

export interface CreateBookingInput {
  slot_id: string;
  vehicle_id: string;
  start_at: string;
  end_at: string;
}

/**
 * Create a HOLD (status 'reserved', unpaid) on a slot. Double-booking protection, three layers:
 *  1. validation (window, alignment, slot active, vehicle ownership/EV rule, server-side price)
 *  2. the slot row is locked FOR UPDATE, so concurrent requests for the same slot queue up
 *  3. the exclusion constraint on (slot_id, time range) is the final guard -> SQLSTATE 23P01 -> 409
 */
export async function createBooking(user: AuthUser, input: CreateBookingInput): Promise<repo.BookingRow> {
  const { start, end } = parseWindow(input.start_at, input.end_at);
  const slotId = await resolveSlotId(input.slot_id);

  for (let attempt = 1; ; attempt++) {
    try {
      return await withTransaction(async (tx) => {
        await repo.expireStaleHolds(tx);
        const s = await getPricingSettings(tx);
        const now = Date.now();

        if (start.getTime() < now - PAST_TOLERANCE_MS) {
          throw AppError.badRequest("Booking start time cannot be in the past. Please select an upcoming arrival time.", "START_IN_PAST");
        }
        if (start.getTime() > now + s.max_advance_days * 86_400_000) {
          throw AppError.badRequest("Booking cannot be made so far in advance.", "TOO_FAR_AHEAD");
        }
        if (!isAlignedTo15Min(start)) {
          throw AppError.badRequest("Booking start time must be aligned to a 15-minute mark.", "NOT_ALIGNED");
        }

        const slotRes = await query<{ id: string; admin_status: string; slot_type: string; hourly_rate_paise: number }>(
          "select id, admin_status, slot_type, hourly_rate_paise from parking_slots where id = $1 for update",
          [slotId],
          tx,
        );
        const slot = slotRes.rows[0];
        if (!slot || slot.admin_status !== "active") {
          throw AppError.badRequest("Parking slot is not available for reservations", "SLOT_UNAVAILABLE");
        }

        const vehRes = await query<{ id: string; plate_number: string; vehicle_type: string; is_ev: boolean }>(
          "select id, plate_number, vehicle_type, is_ev from vehicles where id = $1 and user_id = $2 and archived_at is null",
          [input.vehicle_id, user.id],
          tx,
        );
        const vehicle = vehRes.rows[0];
        if (!vehicle) throw AppError.badRequest("Selected vehicle not found or not active", "VEHICLE_NOT_FOUND");
        if (slot.slot_type === "ev" && !(vehicle.is_ev || vehicle.vehicle_type === "ev")) {
          throw AppError.badRequest("An electric vehicle is required for EV charging bays", "EV_REQUIRED");
        }

        const hours = ceilHours(start, end);
        if (hours < s.min_hours || hours > s.max_hours) {
          throw AppError.badRequest("Selected booking duration is not permitted.", "INVALID_DURATION");
        }
        const price = quoteFor(hours, slot.hourly_rate_paise, s.gst_bps);
        const holdUntil = new Date(now + s.hold_minutes * 60_000);

        try {
          const ins = await query<repo.BookingRow>(
            `insert into bookings (reference, user_id, slot_id, vehicle_id, plate_snapshot, vehicle_type_snapshot,
                                   start_at, end_at, hours, hourly_rate_paise, base_paise, gst_paise, total_paise,
                                   status, payment_status, hold_expires_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'reserved','pending',$14)
             returning *`,
            [newReference(), user.id, slotId, vehicle.id, vehicle.plate_number, vehicle.vehicle_type, start, end,
             hours, price.hourly_rate_paise, price.base_paise, price.gst_paise, price.total_paise, holdUntil],
            tx,
          );
          return ins.rows[0]!;
        } catch (err) {
          if ((err as { code?: string }).code === "23P01") {
            throw new AppError("SLOT_TAKEN", 409, "This slot was just taken for that time. Please pick another space.");
          }
          throw err;
        }
      });
    } catch (err) {
      // 4-char reference collision (1 in ~1M per day): just try again with a fresh reference.
      const e = err as { code?: string; constraint?: string };
      if (e.code === "23505" && e.constraint === "bookings_reference_key" && attempt < 3) continue;
      throw err;
    }
  }
}

/** Owner or admin sees QR token while the pass is valid; nobody else, never otherwise. */
export function presentBooking<T extends { [k: string]: unknown }>(row: T, viewer: AuthUser): T {
  const out: Record<string, unknown> = { ...row };
  const isOwner = row["user_id"] === viewer.id;
  const canSee = isOwner || viewer.role === "admin";
  const valid = ["confirmed", "active"].includes(String(row["status"])) && !row["qr_revoked_at"];
  if (!(canSee && valid)) out["qr_token"] = null;
  return out as T;
}

export async function listMine(user: AuthUser, tab: "Upcoming" | "Active" | "Completed" | "Cancelled", page: number, pageSize: number) {
  await repo.expireStaleHolds();
  await repo.expireUnusedBookings();
  const { rows, total } = await repo.listBookingsForUser(user.id, tab, page, pageSize);
  return {
    bookings: rows.map((r) => presentBooking(r as Record<string, unknown>, user)),
    totalCount: total,
    page,
    pageSize,
  };
}

export async function getOne(user: AuthUser, by: { id?: string; reference?: string }) {
  const booking = await repo.findBookingDetail(by);
  // Another user's booking looks exactly like a missing one.
  if (!booking || (booking.user_id !== user.id && user.role !== "admin")) {
    throw AppError.notFound("Booking not found.", "BOOKING_NOT_FOUND");
  }
  return { booking: presentBooking(booking, user) };
}

export interface RefundPreview {
  booking_id: string;
  total_paise: number;
  refund_paise: number;
  refund_percentage: number;
  payment_status: string;
}

async function loadOwnedBooking(tx: Tx | undefined, user: AuthUser, bookingId: string, lock: boolean): Promise<repo.BookingRow> {
  const { rows } = await query<repo.BookingRow>(`select * from bookings where id = $1 ${lock ? "for update" : ""}`, [bookingId], tx);
  const b = rows[0];
  if (!b || (b.user_id !== user.id && user.role !== "admin")) throw AppError.notFound("Booking not found.", "BOOKING_NOT_FOUND");
  return b;
}

export async function cancellationPreview(user: AuthUser, bookingId: string): Promise<RefundPreview> {
  const b = await loadOwnedBooking(undefined, user, bookingId, false);
  if (!["reserved", "confirmed"].includes(b.status)) {
    throw AppError.badRequest("Only reserved or confirmed bookings can be cancelled", "NOT_CANCELLABLE");
  }
  const s = await getPricingSettings();
  const tier = refundFor(b.total_paise, b.payment_status === "paid", b.start_at.getTime() - Date.now(), s);
  return { booking_id: b.id, total_paise: b.total_paise, ...tier, payment_status: b.payment_status };
}

/**
 * Cancel a booking. One transaction: lock row -> validate -> compute refund tier -> mark cancelled
 * (frees the slot immediately) -> record the refund as 'pending'. The gateway call happens AFTER
 * commit (settleRefund), so no row lock is held while waiting on the network.
 * Idempotent: cancelling twice answers "no longer active" and changes nothing.
 */
export async function cancelBooking(user: AuthUser, bookingId: string, reason: string | null, opts: { actorIsAdminOverride?: boolean } = {}) {
  await repo.expireUnusedBookings();
  await repo.expireStaleHolds();

  const { booking, refundId } = await withTransaction(async (tx) => {
    const b = await loadOwnedBooking(tx, user, bookingId, true);

    if (["cancelled", "completed", "expired", "no_show"].includes(b.status)) {
      throw AppError.conflict("This booking cannot be cancelled because it is no longer active.", "NOT_CANCELLABLE");
    }
    if (!["reserved", "confirmed"].includes(b.status)) {
      throw AppError.conflict("This booking cannot be cancelled.", "NOT_CANCELLABLE");
    }
    if (!opts.actorIsAdminOverride) {
      if (b.start_at.getTime() <= Date.now()) {
        throw AppError.conflict("This booking has already started and cannot be cancelled.", "ALREADY_STARTED");
      }
      const sess = await query(
        `select 1 from parking_sessions where booking_id = $1
            and (started_at <= now() or ended_at is not null or entered_at is not null or status in ('completed','auto_ended'))`,
        [bookingId],
        tx,
      );
      if (sess.rows[0]) {
        throw AppError.conflict("This booking has an active parking session and cannot be cancelled.", "SESSION_STARTED");
      }
    }

    await query("update parking_sessions set status = 'cancelled' where booking_id = $1 and status = 'active'", [bookingId], tx);

    const s = await getPricingSettings(tx);
    const isPaid = b.payment_status === "paid";
    const tier = refundFor(b.total_paise, isPaid, b.start_at.getTime() - Date.now(), s);
    let newPaymentStatus = b.payment_status;
    let pendingRefundId: string | null = null;

    if (isPaid) {
      newPaymentStatus = tier.refund_paise === b.total_paise ? "refunded" : tier.refund_paise > 0 ? "partially_refunded" : "paid";
      if (tier.refund_paise > 0) {
        const pay = await query<{ id: string }>(
          "select id from payments where booking_id = $1 and status in ('succeeded','partially_refunded') for update",
          [bookingId],
          tx,
        );
        if (pay.rows[0]) {
          const ins = await query<{ id: string }>(
            `insert into payment_refunds (payment_id, booking_id, amount_paise, reason, status)
             values ($1,$2,$3,$4,'pending') returning id`,
            [pay.rows[0].id, bookingId, tier.refund_paise, reason ?? `User cancellation: ${tier.refund_percentage}% refund tier`],
            tx,
          );
          pendingRefundId = ins.rows[0]!.id;
          await query("update payments set status = $2 where id = $1", [pay.rows[0].id, newPaymentStatus], tx);
        }
      }
    }

    const upd = await query<repo.BookingRow>(
      `update bookings set status = 'cancelled', cancelled_at = now(), cancellation_reason = $2,
              refund_paise = $3, payment_status = $4, qr_revoked_at = coalesce(qr_revoked_at, now())
        where id = $1 returning *`,
      [bookingId, reason, tier.refund_paise, newPaymentStatus],
      tx,
    );
    return { booking: upd.rows[0]!, refundId: pendingRefundId };
  });

  if (refundId) await settleRefund(refundId); // after commit; failure leaves it 'pending' for the retry job
  return { booking: presentBooking(booking, user) };
}
