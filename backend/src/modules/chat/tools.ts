import { query } from "../../db/pool.js";
import { FACILITY } from "../../config/facility.js";
import { slotAvailability } from "../parking/service.js";
import { getPricingSettings } from "../settings/repo.js";

/** Live availability per level for the next hour. Counts only; no personal data. */
export async function getLiveAvailability(level?: string) {
  const now = new Date();
  const avail = await slotAvailability(now, new Date(now.getTime() + 3_600_000), { level });
  const { rows: slots } = await query<{ id: string; level_code: string; slot_type: string }>(
    "select id, level_code, slot_type from parking_slots where admin_status = 'active'",
  );
  const byId = new Map(slots.map((s) => [s.id, s]));
  const levels: Record<string, { free: number; total: number; ev_free: number }> = {};
  let free = 0;
  let total = 0;
  for (const a of avail) {
    const s = byId.get(a.slot_id);
    if (!s) continue;
    const l = (levels[s.level_code] ??= { free: 0, total: 0, ev_free: 0 });
    l.total += 1;
    total += 1;
    if (a.is_available) {
      l.free += 1;
      free += 1;
      if (s.slot_type === "ev") l.ev_free += 1;
    }
  }
  return { as_of: now.toISOString(), window: "next 60 minutes", free_slots: free, total_active_slots: total, by_level: levels };
}

/** Current tariff (per hour, before GST), GST and cancellation policy, straight from settings. */
export async function getPricing() {
  const s = await getPricingSettings();
  const { rows } = await query<{ slot_type: string; rate: number }>(
    "select slot_type, min(hourly_rate_paise)::int as rate from parking_slots where admin_status = 'active' group by slot_type",
  );
  const rate = (t: string) => rows.find((r) => r.slot_type === t)?.rate ?? null;
  return {
    currency: "INR",
    hourly_rate_rupees_before_gst: {
      standard: rate("standard") === null ? null : rate("standard")! / 100,
      ev: rate("ev") === null ? null : rate("ev")! / 100,
      accessible: rate("accessible") === null ? null : rate("accessible")! / 100,
    },
    gst_percent: s.gst_bps / 100,
    booking_hold_minutes: s.hold_minutes,
    min_hours: s.min_hours,
    max_hours: s.max_hours,
    exit_grace_minutes: s.exit_grace_minutes,
    cancellation: {
      full_refund_if_cancelled_at_least_hours_before_start: s.refund_full_hours,
      partial_refund_percent_if_at_least_minutes_before_start: { percent: s.partial_refund_bps / 100, minutes: s.refund_partial_minutes },
      otherwise: "no refund",
    },
  };
}

export function getOperatingInfo() {
  return { ...FACILITY };
}

/** Strictly scoped to the authenticated user: WHERE user_id = $1. Never another user's data. */
export async function getMyActiveBooking(userId: string) {
  const { rows } = await query(
    `select b.reference, b.status, b.start_at, b.end_at, s.code as slot, s.level_code as level
       from bookings b join parking_slots s on s.id = b.slot_id
      where b.user_id = $1 and b.status in ('reserved','confirmed','active') and b.end_at >= now()
      order by b.start_at asc limit 3`,
    [userId],
  );
  return { bookings: rows };
}
