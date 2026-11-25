import type { Queryable } from "../../db/pool.js";
import { query } from "../../db/pool.js";

export const ACTIVE_STATUSES = ["reserved", "confirmed", "active"] as const;

export interface BookingRow {
  id: string;
  reference: string;
  user_id: string;
  slot_id: string;
  vehicle_id: string;
  plate_snapshot: string;
  vehicle_type_snapshot: string;
  start_at: Date;
  end_at: Date;
  hours: number;
  hourly_rate_paise: number;
  base_paise: number;
  gst_paise: number;
  total_paise: number;
  status: string;
  payment_status: string;
  hold_expires_at: Date | null;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  refund_paise: number;
  qr_token: string | null;
  qr_issued_at: Date | null;
  qr_revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
  [key: string]: unknown;
}

/** Release holds whose time is up. Cheap and idempotent; called lazily on reads and by the job. */
export async function expireStaleHolds(db?: Queryable): Promise<number> {
  const res = await query(
    `update bookings set status = 'expired'
      where status = 'reserved' and hold_expires_at is not null and hold_expires_at < now()`,
    [],
    db,
  );
  return res.rowCount ?? 0;
}

/**
 * No-show: a CONFIRMED booking whose whole window has passed without a gate entry.
 * (Deviation from the Supabase original, which flagged a paid booking as no-show the moment its
 * start time passed. With a gate, arriving late inside the paid window must still be allowed.
 * Documented in docs/DATABASE.md.)
 */
export async function expireUnusedBookings(db?: Queryable): Promise<number> {
  const updated = await query<{ id: string }>(
    `update bookings b set status = 'no_show'
      where b.status = 'confirmed'
        and b.end_at < now()
        and not exists (
          select 1 from parking_sessions ps
           where ps.booking_id = b.id and (ps.entered_at is not null or ps.ended_at is not null)
        )
      returning b.id`,
    [],
    db,
  );
  const ids = updated.rows.map((r) => r.id);
  if (ids.length > 0) {
    await query(
      "update parking_sessions set status = 'cancelled' where booking_id = any($1::uuid[]) and status = 'active' and ended_at is null",
      [ids],
      db,
    );
  }
  return ids.length;
}

const BOOKING_JOINS = `
  to_jsonb((select x from (select s.id, s.code, s.level_code, s.zone, s.slot_type) x)) as parking_slots,
  to_jsonb((select v from (select ve.id, ve.plate_number, ve.vehicle_type, ve.make, ve.model) v)) as vehicles`;

export async function findBookingDetail(
  by: { id?: string; reference?: string },
  db?: Queryable,
): Promise<(BookingRow & { parking_slots: unknown; vehicles: unknown }) | null> {
  const { rows } = await query<BookingRow & { parking_slots: unknown; vehicles: unknown }>(
    `select b.*, ${BOOKING_JOINS}
       from bookings b
       join parking_slots s on s.id = b.slot_id
       join vehicles ve on ve.id = b.vehicle_id
      where ${by.id ? "b.id = $1" : "b.reference = $1"}`,
    [by.id ?? by.reference],
    db,
  );
  return rows[0] ?? null;
}

export async function listBookingsForUser(
  userId: string,
  tab: "Upcoming" | "Active" | "Completed" | "Cancelled",
  page: number,
  pageSize: number,
): Promise<{ rows: unknown[]; total: number }> {
  const filters: Record<typeof tab, { where: string; order: string }> = {
    Upcoming: { where: "b.status in ('reserved','confirmed') and b.start_at >= now()", order: "b.start_at asc" },
    Active: { where: "b.status in ('confirmed','active') and b.start_at <= now() and b.end_at >= now()", order: "b.end_at asc" },
    Completed: { where: "b.status in ('completed','no_show')", order: "b.end_at desc" },
    Cancelled: { where: "b.status in ('cancelled','expired')", order: "b.created_at desc" },
  };
  const f = filters[tab];
  const base = `from bookings b
       join parking_slots s on s.id = b.slot_id
       join vehicles ve on ve.id = b.vehicle_id
      where b.user_id = $1 and ${f.where}`;
  const [list, count] = await Promise.all([
    query(`select b.*, ${BOOKING_JOINS} ${base} order by ${f.order} limit $2 offset $3`, [userId, pageSize, (page - 1) * pageSize]),
    query<{ n: number }>(`select count(*)::int as n ${base}`, [userId]),
  ]);
  return { rows: list.rows, total: count.rows[0]?.n ?? 0 };
}
