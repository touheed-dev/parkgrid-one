import type { Queryable } from "../../db/pool.js";
import { query } from "../../db/pool.js";
import { expireStaleHolds } from "../bookings/repo.js";

export interface AvailabilityFilter {
  level?: string | null | undefined;
  zone?: string | null | undefined;
  slot_type?: string | null | undefined;
}

const isAll = (v: string | null | undefined): boolean => !v || v === "All";

/**
 * Per active slot: is it free for the whole [start, end) window? (port of slot_availability).
 * Returns zero personal data.
 */
export async function slotAvailability(
  start: Date,
  end: Date,
  f: AvailabilityFilter = {},
  db?: Queryable,
): Promise<{ slot_id: string; is_available: boolean }[]> {
  await expireStaleHolds(db);
  const { rows } = await query<{ slot_id: string; is_available: boolean }>(
    `select s.id as slot_id,
            not exists (
              select 1 from bookings b
               where b.slot_id = s.id
                 and b.status in ('reserved','confirmed','active')
                 and b.during && tstzrange($1::timestamptz, $2::timestamptz, '[)')
            ) as is_available
       from parking_slots s
      where s.admin_status = 'active'
        and ($3::text is null or s.level_code = $3)
        and ($4::text is null or s.zone = $4)
        and ($5::text is null or s.slot_type = $5)`,
    [start, end, isAll(f.level) ? null : f.level, isAll(f.zone) ? null : f.zone, isAll(f.slot_type) ? null : f.slot_type],
    db,
  );
  return rows;
}

export interface ListSlotsInput {
  level: string;
  zone: string;
  slot_type: string;
  admin_status: string;
  search: string;
  page: number;
  pageSize: number;
}

interface CurrentBooking {
  id: string;
  reference: string;
  status: string;
  start_at: Date;
  end_at: Date;
  plate_snapshot: string | null;
}

export async function listSlots(input: ListSlotsInput, seesBookingDetails: boolean) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (!isAll(input.level)) add("s.level_code = ?", input.level);
  if (!isAll(input.zone)) add("s.zone = ?", input.zone);
  if (!isAll(input.slot_type)) add("s.slot_type = ?", input.slot_type);
  if (!isAll(input.admin_status)) add("s.admin_status = ?", input.admin_status);
  if (input.search.trim()) add("s.code ilike ?", `%${input.search.trim().replace(/[%_\\]/g, "\\$&")}%`);
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";

  const total = await query<{ n: number }>(`select count(*)::int as n from parking_slots s ${whereSql}`, params);
  const totalCount = total.rows[0]?.n ?? 0;

  const paging = input.pageSize > 0 ? `limit ${input.pageSize} offset ${(input.page - 1) * input.pageSize}` : "";
  const { rows: slots } = await query<{ id: string } & Record<string, unknown>>(
    `select s.*, to_jsonb((select l from (select pl.code, pl.name, pl.sort_order, pl.allows_heavy) l)) as parking_levels
       from parking_slots s join parking_levels pl on pl.code = s.level_code
       ${whereSql}
      order by s.level_code asc, s.bay_number asc ${paging}`,
    params,
  );
  const totalPages = input.pageSize > 0 ? Math.ceil(totalCount / input.pageSize) || 1 : 1;
  if (slots.length === 0) return { slots: [], totalCount: 0, page: input.page, pageSize: input.pageSize, totalPages: 1 };

  const slotIds = slots.map((s) => s.id);
  const occupied = new Set<string>();
  const current = new Map<string, CurrentBooking>();

  if (seesBookingDetails) {
    const { rows } = await query<CurrentBooking & { slot_id: string }>(
      `select b.id, b.slot_id, b.reference, b.status, b.start_at, b.end_at, b.plate_snapshot
         from bookings b
        where b.slot_id = any($1::uuid[])
          and (
            (b.status in ('reserved','confirmed','active') and b.start_at <= now() and b.end_at >= now())
            or exists (select 1 from parking_sessions ps where ps.booking_id = b.id and ps.status = 'active' and ps.ended_at is null and ps.entered_at is not null)
          )`,
      [slotIds],
    );
    for (const b of rows) {
      occupied.add(b.slot_id);
      if (!current.has(b.slot_id)) {
        current.set(b.slot_id, {
          id: b.id, reference: b.reference, status: b.status, start_at: b.start_at, end_at: b.end_at, plate_snapshot: b.plate_snapshot,
        });
      }
    }
  } else {
    const now = new Date();
    const avail = await slotAvailability(now, new Date(now.getTime() + 3_600_000), {
      level: input.level, zone: input.zone, slot_type: input.slot_type,
    });
    for (const a of avail) if (!a.is_available) occupied.add(a.slot_id);
  }

  return {
    slots: slots.map((s) => ({ ...s, is_occupied: occupied.has(s.id), current_booking: current.get(s.id) ?? null })),
    totalCount,
    page: input.page,
    pageSize: input.pageSize,
    totalPages,
  };
}

/** Port of getFacilitySummary, including its occupancy arithmetic, so the dashboard numbers match. */
export async function getFacilitySummary() {
  const now = new Date();
  const plusOneHour = new Date(now.getTime() + 3_600_000);

  const [levelsRes, slotsRes, avail, bookingsRes] = await Promise.all([
    query<{ code: string }>("select * from parking_levels order by sort_order asc"),
    query<{ id: string; level_code: string; slot_type: string; admin_status: string }>(
      "select id, code, level_code, zone, slot_type, admin_status from parking_slots",
    ),
    slotAvailability(now, plusOneHour),
    query<{ slot_id: string; status: string }>(
      `select slot_id, status from bookings
        where status in ('confirmed','reserved','active') and start_at <= $2 and end_at >= $1`,
      [now, plusOneHour],
    ),
  ]);

  const levels = levelsRes.rows;
  const slots = slotsRes.rows;
  const unavailable = new Set(avail.filter((r) => !r.is_available).map((r) => r.slot_id));
  const activeSet = new Set(bookingsRes.rows.filter((b) => b.status === "active").map((b) => b.slot_id));
  const reservedSet = new Set(bookingsRes.rows.filter((b) => b.status === "confirmed" || b.status === "reserved").map((b) => b.slot_id));

  const byLevel: Record<string, { total: number; active: number; occupied: number; maintenance: number; blocked: number }> = {};
  for (const l of levels) byLevel[l.code] = { total: 0, active: 0, occupied: 0, maintenance: 0, blocked: 0 };
  const byType = { standard: 0, ev: 0, accessible: 0 };
  const byStatus = { active: 0, occupied: 0, maintenance: 0, blocked: 0 };
  let evReadySlots = 0;

  for (const slot of slots) {
    const isUnavailable = unavailable.has(slot.id);
    const isOccupied = activeSet.has(slot.id) || (isUnavailable && !reservedSet.has(slot.id));
    const isReserved = reservedSet.has(slot.id);
    const isAvailable = slot.admin_status === "active" && !isUnavailable;

    const ls = byLevel[slot.level_code];
    if (ls) {
      ls.total += 1;
      if (slot.admin_status === "active") {
        if (isOccupied || isReserved) ls.occupied += 1;
        else ls.active += 1;
      } else if (slot.admin_status === "maintenance") ls.maintenance += 1;
      else if (slot.admin_status === "blocked") ls.blocked += 1;
    }
    if (slot.slot_type in byType) byType[slot.slot_type as keyof typeof byType] += 1;
    if (slot.admin_status === "active") {
      if (isOccupied) byStatus.occupied += 1;
      else byStatus.active += 1;
      if (slot.slot_type === "ev" && isAvailable) evReadySlots += 1;
    } else if (slot.admin_status in byStatus) {
      byStatus[slot.admin_status as keyof typeof byStatus] += 1;
    }
  }

  const totalSlots = slots.length;
  const occupiedSlots =
    activeSet.size > 0
      ? activeSet.size
      : unavailable.size - reservedSet.size > 0
        ? unavailable.size - reservedSet.size
        : unavailable.size;
  const availableSlots = slots.filter((s) => s.admin_status === "active" && !unavailable.has(s.id)).length;

  return {
    totalSlots,
    occupiedSlots,
    reservedSlots: reservedSet.size,
    availableSlots,
    evReadySlots,
    percentage: totalSlots > 0 ? Math.round((availableSlots / totalSlots) * 100) : 0,
    levels,
    byLevel,
    byType,
    byStatus,
    updatedAt: now.toISOString(),
  };
}
