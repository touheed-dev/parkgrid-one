import { Router } from "express";
import { z } from "zod";
import { query } from "../../db/pool.js";
import { withAuthUser } from "../../db/tx.js";
import { AppError } from "../../lib/errors.js";
import { invalidateIdentity, me, requireAdmin, requireAuth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { expireStaleHolds, expireUnusedBookings } from "../bookings/repo.js";
import { getPricingSettings } from "../settings/repo.js";
import * as service from "./service.js";

/** Everything here is admin-only (staff are NOT enough). Every mutation is audit-logged. */
export const adminRouter: Router = Router();
adminRouter.use(requireAuth, requireAdmin);

const reason = z.string().trim().min(5, "Reason must be at least 5 characters").max(300, "Reason cannot exceed 300 characters");
const uuid = z.uuid();
const page = z.coerce.number().int().min(1).default(1);
const pageSize = (def: number) => z.coerce.number().int().min(1).max(50).default(def);
const idParams = z.object({ id: uuid });
const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
const q = <T>(req: { query: unknown }) => req.query as T;
const like = (s: string) => `%${s.replace(/[%_\\]/g, "\\$&")}%`;

// ---------- dashboard & reports (ported SQL, authorised here first) ----------
adminRouter.get("/dashboard", async (req, res) => {
  const dashboard = await withAuthUser(me(req).id, async (tx) => (await query("select admin_dashboard_stats() as d", [], tx)).rows[0]!["d"]);
  res.json({ dashboard });
});

const revenueQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid start date format (YYYY-MM-DD)"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid end date format (YYYY-MM-DD)"),
  group: z.enum(["day", "week", "month"]).default("day"),
});
adminRouter.get("/revenue", validate({ query: revenueQuery }), async (req, res) => {
  const p = q<z.infer<typeof revenueQuery>>(req);
  const days = Math.ceil((new Date(p.to).getTime() - new Date(p.from).getTime()) / 86_400_000);
  if (days < 0) throw AppError.badRequest("Start date must be before or equal to end date.", "INVALID_RANGE");
  if (days > 366) throw AppError.badRequest("Date range cannot exceed 366 days.", "RANGE_TOO_LARGE");
  const report = await withAuthUser(me(req).id, async (tx) =>
    (await query("select admin_revenue_report($1::date, $2::date, $3) as r", [p.from, p.to, p.group], tx)).rows[0]!["r"],
  );
  res.json({ report });
});

// ---------- users ----------
const usersQuery = z.object({ search: z.string().max(100).default(""), role: z.string().max(10).default("All"), page, pageSize: pageSize(10) });
adminRouter.get("/users", validate({ query: usersQuery }), async (req, res) => {
  const p = q<z.infer<typeof usersQuery>>(req);
  const rows = await withAuthUser(me(req).id, async (tx) =>
    (await query<Record<string, unknown>>(
      "select * from admin_list_users($1, $2, $3, $4)",
      [p.search.trim() || null, p.role !== "All" ? p.role : null, p.pageSize, (p.page - 1) * p.pageSize],
      tx,
    )).rows,
  );
  const totalCount = rows.length ? Number(rows[0]!["total_count"]) : 0;
  res.json({
    users: rows.map((r) => ({
      id: r["id"], email: r["email"], fullName: r["full_name"], phone: r["phone"], role: r["role"] ?? "member",
      createdAt: r["created_at"], lastSignInAt: r["last_sign_in_at"],
      bookingCount: Number(r["booking_count"] ?? 0), totalPaidPaise: Number(r["total_paid_paise"] ?? 0),
    })),
    totalCount,
    totalPages: Math.ceil(totalCount / p.pageSize) || 1,
    page: p.page,
    pageSize: p.pageSize,
  });
});

adminRouter.get("/users/:id", validate({ params: idParams }), async (req, res) => {
  const id = idOf(req);
  const profile = await query(
    "select p.*, u.email::text as email, (u.disabled_at is not null) as disabled from profiles p join users u on u.id = p.id where p.id = $1",
    [id],
  );
  if (!profile.rows[0]) throw AppError.notFound("User profile not found.", "USER_NOT_FOUND");
  const [bookings, vehicles] = await Promise.all([
    query(
      `select b.*, (select to_jsonb(s) from (select code, level_code from parking_slots where id = b.slot_id) s) as parking_slots
         from bookings b where b.user_id = $1 order by b.created_at desc limit 20`,
      [id],
    ),
    query("select * from vehicles where user_id = $1 order by created_at desc", [id]),
  ]);
  const safe = bookings.rows.map((b) => ({ ...b, qr_token: null }));
  res.json({ profile: profile.rows[0], bookings: safe, vehicles: vehicles.rows });
});

const roleBody = z.strictObject({ role: z.enum(["member", "staff", "admin"]), reason });
adminRouter.patch("/users/:id/role", validate({ params: idParams, body: roleBody }), async (req, res) => {
  const id = idOf(req);
  const profile = await withAuthUser(me(req).id, async (tx) =>
    (await query("select to_jsonb(admin_set_user_role($1::uuid, $2, $3)) as p", [id, req.body.role, req.body.reason], tx)).rows[0]!["p"],
  );
  invalidateIdentity(id);
  res.json({ profile });
});

const statusBody = z.strictObject({ disabled: z.boolean(), reason });
adminRouter.patch("/users/:id/status", validate({ params: idParams, body: statusBody }), async (req, res) => {
  res.json(await service.setUserDisabled(me(req), idOf(req), req.body.disabled, req.body.reason));
});

// ---------- bookings ----------
const bookingsQuery = z.object({
  status: z.string().max(20).default("All"),
  payment_status: z.string().max(20).default("All"),
  search: z.string().max(60).default(""),
  dateFrom: z.string().max(40).optional(),
  dateTo: z.string().max(40).optional(),
  page,
  pageSize: pageSize(10),
});
adminRouter.get("/bookings", validate({ query: bookingsQuery }), async (req, res) => {
  await expireStaleHolds();
  await expireUnusedBookings();
  const p = q<z.infer<typeof bookingsQuery>>(req);
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (p.status !== "All") add("b.status = ?", p.status);
  if (p.payment_status !== "All") add("b.payment_status = ?", p.payment_status);
  if (p.dateFrom) add("b.created_at >= ?::timestamptz", p.dateFrom);
  if (p.dateTo) add("b.created_at <= ?::timestamptz", p.dateTo);
  if (p.search.trim()) {
    params.push(like(p.search.trim()));
    where.push(`(b.reference ilike $${params.length} or b.plate_snapshot ilike $${params.length})`);
  }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  const [rows, count] = await Promise.all([
    query(
      `select b.*,
         to_jsonb((select x from (select s.id, s.code, s.level_code, s.zone, s.slot_type) x)) as parking_slots,
         to_jsonb((select v from (select ve.id, ve.plate_number, ve.vehicle_type, ve.make, ve.model) v)) as vehicles,
         to_jsonb((select pr from (select pf.full_name, pf.phone) pr)) as profiles
       from bookings b join parking_slots s on s.id = b.slot_id join vehicles ve on ve.id = b.vehicle_id join profiles pf on pf.id = b.user_id
       ${whereSql} order by b.created_at desc limit ${p.pageSize} offset ${(p.page - 1) * p.pageSize}`,
      params,
    ),
    query<{ n: number }>(`select count(*)::int as n from bookings b ${whereSql}`, params),
  ]);
  const totalCount = count.rows[0]?.n ?? 0;
  res.json({
    bookings: rows.rows.map((b) => ({ ...b, qr_token: null })),
    totalCount,
    totalPages: Math.ceil(totalCount / p.pageSize) || 1,
    page: p.page,
    pageSize: p.pageSize,
  });
});

adminRouter.get("/bookings/:id", validate({ params: idParams }), async (req, res) => {
  const { rows } = await query(
    `select b.*,
        to_jsonb(s) as parking_slots, to_jsonb(ve) as vehicles,
        (select to_jsonb(x) from (select pf.id, pf.full_name, pf.phone, pf.role) x) as profiles,
        coalesce((select jsonb_agg(to_jsonb(p) - 'provider_signature' order by p.created_at) from payments p where p.booking_id = b.id and p.status <> 'created'), '[]'::jsonb) as payments,
        coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at) from payment_refunds r where r.booking_id = b.id), '[]'::jsonb) as payment_refunds,
        (select to_jsonb(ps) from parking_sessions ps where ps.booking_id = b.id) as parking_sessions
       from bookings b join parking_slots s on s.id = b.slot_id join vehicles ve on ve.id = b.vehicle_id join profiles pf on pf.id = b.user_id
      where b.id = $1`,
    [idOf(req)],
  );
  if (!rows[0]) throw AppError.notFound("Booking not found.", "BOOKING_NOT_FOUND");
  res.json({ booking: { ...rows[0], qr_token: null } });
});

const overrideBody = z.strictObject({ action: z.enum(["cancel_full_refund", "cancel_by_policy", "cancel_no_refund", "mark_no_show"]), reason });
adminRouter.post("/bookings/:id/override", validate({ params: idParams, body: overrideBody }), async (req, res) => {
  const r = await service.overrideBooking(me(req), idOf(req), req.body.action, req.body.reason);
  res.json({ booking: { ...r.booking, qr_token: null } });
});

// ---------- payments ----------
const paymentsQuery = z.object({
  page,
  pageSize: pageSize(15),
  status: z.enum(["all", "succeeded", "failed", "refunded", "partially_refunded"]).default("all"),
  method: z.enum(["all", "upi", "card", "netbanking", "wallet"]).default("all"),
  search: z.string().max(60).default(""),
  dateFrom: z.string().max(40).optional(),
  dateTo: z.string().max(40).optional(),
});
adminRouter.get("/payments", validate({ query: paymentsQuery }), async (req, res) => {
  const p = q<z.infer<typeof paymentsQuery>>(req);
  const where: string[] = ["p.status <> 'created'"];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (p.status !== "all") add("p.status = ?", p.status);
  if (p.method !== "all") add("p.method = ?", p.method);
  if (p.dateFrom) add("p.created_at >= ?::timestamptz", p.dateFrom);
  if (p.dateTo) add("p.created_at <= ?::timestamptz", p.dateTo);
  if (p.search.trim()) {
    params.push(like(p.search.trim()));
    where.push(`(p.receipt_number ilike $${params.length} or p.provider_ref ilike $${params.length})`);
  }
  const whereSql = `where ${where.join(" and ")}`;
  const [rows, count, totals] = await Promise.all([
    query(
      `select p.id, p.booking_id, p.user_id, p.provider, p.provider_ref, p.provider_order_id, p.method, p.amount_paise, p.base_paise, p.gst_paise,
              p.currency, p.status, p.failure_reason, p.receipt_number, p.idempotency_key, p.created_at, p.updated_at,
              (select to_jsonb(x) from (select b.reference, b.plate_snapshot, b.user_id,
                 (select to_jsonb(s) from (select ps.code, ps.level_code from parking_slots ps where ps.id = b.slot_id) s) as parking_slots
                 from bookings b where b.id = p.booking_id) x) as bookings,
              coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at) from payment_refunds r where r.payment_id = p.id), '[]'::jsonb) as payment_refunds
         from payments p ${whereSql} order by p.created_at desc limit ${p.pageSize} offset ${(p.page - 1) * p.pageSize}`,
      params,
    ),
    query<{ n: number }>(`select count(*)::int as n from payments p ${whereSql}`, params),
    withAuthUser(me(req).id, async (tx) => (await query("select admin_payment_totals($1::timestamptz, $2::timestamptz) as t", [p.dateFrom ?? null, p.dateTo ?? null], tx)).rows[0]!["t"]),
  ]);
  const totalCount = count.rows[0]?.n ?? 0;
  res.json({ payments: rows.rows, totalCount, page: p.page, pageSize: p.pageSize, totals: { ...totals, totalTransactions: totalCount } });
});

adminRouter.get("/payments/:id", validate({ params: idParams }), async (req, res) => {
  const { rows } = await query(
    `select p.id, p.booking_id, p.user_id, p.provider, p.provider_ref, p.provider_order_id, p.method, p.amount_paise, p.base_paise, p.gst_paise,
            p.currency, p.status, p.failure_reason, p.receipt_number, p.created_at, p.updated_at,
            (select to_jsonb(b) from bookings b where b.id = p.booking_id) - 'qr_token' as bookings,
            coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at) from payment_refunds r where r.payment_id = p.id), '[]'::jsonb) as payment_refunds
       from payments p where p.id = $1`,
    [idOf(req)],
  );
  if (!rows[0]) throw AppError.notFound("Payment not found.", "PAYMENT_NOT_FOUND");
  res.json({ payment: rows[0] });
});

const refundBody = z.strictObject({ amount_paise: z.number().int().min(1, "Refund amount must be at least 1 paise"), reason });
adminRouter.post("/payments/:id/refund", validate({ params: idParams, body: refundBody }), async (req, res) => {
  res.json(await service.refundPayment(me(req), idOf(req), req.body.amount_paise, req.body.reason));
});

// ---------- sessions ----------
const sessionsQuery = z.object({ status: z.string().max(20).default("All"), search: z.string().max(60).default(""), page, pageSize: pageSize(10) });
adminRouter.get("/sessions", validate({ query: sessionsQuery }), async (req, res) => {
  const p = q<z.infer<typeof sessionsQuery>>(req);
  const params: unknown[] = [p.status !== "All" ? p.status : null, p.search.trim() ? like(p.search.trim()) : null];
  const base = `from parking_sessions ps join bookings b on b.id = ps.booking_id join parking_slots sl on sl.id = b.slot_id
                left join profiles pr on pr.id = ps.user_id
                where ($1::text is null or ps.status = $1) and ($2::text is null or b.plate_snapshot ilike $2 or sl.code ilike $2)`;
  const [rows, count] = await Promise.all([
    query(
      `select ps.id as session_id, ps.booking_id, ps.user_id, ps.started_at, ps.booked_end_at, ps.entered_at, ps.ended_at, ps.status,
              ps.auto_ended, ps.ended_by_admin, ps.duration_minutes, b.reference as booking_reference, sl.code as slot_code,
              sl.level_code, b.plate_snapshot, pr.full_name as user_full_name,
              coalesce((select sum(oc.total_paise) from overstay_charges oc where oc.session_id = ps.id), 0)::int as overstay_total_paise
         ${base} order by ps.started_at desc limit ${p.pageSize} offset ${(p.page - 1) * p.pageSize}`,
      params,
    ),
    query<{ n: number }>(`select count(*)::int as n ${base}`, params),
  ]);
  const totalCount = count.rows[0]?.n ?? 0;
  res.json({
    sessions: rows.rows.map((s) => ({
      sessionId: s["session_id"], bookingId: s["booking_id"], userId: s["user_id"], startedAt: s["started_at"],
      bookedEndAt: s["booked_end_at"], enteredAt: s["entered_at"], endedAt: s["ended_at"], status: s["status"],
      autoEnded: s["auto_ended"], endedByAdmin: s["ended_by_admin"], durationMinutes: s["duration_minutes"],
      bookingReference: s["booking_reference"], slotCode: s["slot_code"], levelCode: s["level_code"],
      plateSnapshot: s["plate_snapshot"], userFullName: s["user_full_name"], overstayTotalPaise: Number(s["overstay_total_paise"] ?? 0),
    })),
    totalCount,
    totalPages: Math.ceil(totalCount / p.pageSize) || 1,
    page: p.page,
    pageSize: p.pageSize,
  });
});

adminRouter.get("/sessions/active", async (req, res) => {
  const rows = await withAuthUser(me(req).id, async (tx) => (await query<Record<string, unknown>>("select * from admin_active_sessions()", [], tx)).rows);
  res.json({
    sessions: rows.map((r) => ({
      sessionId: r["session_id"], bookingId: r["booking_id"], bookingReference: r["booking_reference"], slotCode: r["slot_code"],
      levelCode: r["level_code"], plateSnapshot: r["plate_snapshot"], userFullName: r["user_full_name"], startedAt: r["started_at"],
      bookedEndAt: r["booked_end_at"], overstayMinutes: Number(r["overstay_minutes"] ?? 0),
      overstayChargePaise: Number(r["overstay_charge_paise"] ?? 0), isOverstay: Boolean(r["is_overstay"]),
    })),
  });
});

// ---------- settings, rates, audit ----------
adminRouter.get("/settings", async (_req, res) => {
  res.json({ settings: await getPricingSettings() });
});

const settingsBody = z.strictObject({
  gst_bps: z.number().int().min(0).max(2800, "GST must be between 0% and 28% (0-2800 bps)"),
  hold_minutes: z.number().int().min(5).max(30, "Hold duration must be 5-30 minutes"),
  min_hours: z.number().int().min(1).max(4, "Minimum booking hours must be 1-4"),
  max_hours: z.number().int().min(1).max(72, "Maximum booking hours must be 1-72"),
  max_advance_days: z.number().int().min(1).max(90, "Advance window must be 1-90 days"),
  refund_full_hours: z.number().int().min(0).max(48, "Full refund cutoff must be 0-48 hours"),
  refund_partial_minutes: z.number().int().min(0).max(1440, "Partial refund cutoff must be 0-1440 mins"),
  partial_refund_bps: z.number().int().min(0).max(10000, "Partial refund must be 0-100%"),
  exit_grace_minutes: z.number().int().min(0).max(120, "Grace period must be 0-120 mins"),
  reason,
});
adminRouter.put("/settings", validate({ body: settingsBody }), async (req, res) => {
  const d = req.body as z.infer<typeof settingsBody>;
  if (d.max_hours < d.min_hours) throw AppError.badRequest("Maximum booking hours cannot be less than minimum booking hours.", "INVALID_SETTINGS");
  const settings = await withAuthUser(me(req).id, async (tx) =>
    (await query(
      "select to_jsonb(admin_update_settings($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)) as s",
      [d.gst_bps, d.hold_minutes, d.min_hours, d.max_hours, d.max_advance_days, d.refund_full_hours, d.refund_partial_minutes, d.partial_refund_bps, d.exit_grace_minutes, d.reason],
      tx,
    )).rows[0]!["s"],
  );
  res.json({ settings });
});

adminRouter.get("/slot-rates", async (req, res) => {
  const rates = await withAuthUser(me(req).id, async (tx) => (await query("select admin_get_slot_rates() as r", [], tx)).rows[0]!["r"]);
  res.json({ rates });
});

const ratesBody = z.strictObject({
  standard_rate_paise: z.number().int().min(1000).max(100000),
  ev_rate_paise: z.number().int().min(1000).max(100000),
  accessible_rate_paise: z.number().int().min(1000).max(100000),
  reason,
});
adminRouter.put("/slot-rates", validate({ body: ratesBody }), async (req, res) => {
  const d = req.body as z.infer<typeof ratesBody>;
  const rates = await withAuthUser(me(req).id, async (tx) =>
    (await query("select admin_update_slot_rates($1,$2,$3,$4) as r", [d.standard_rate_paise, d.ev_rate_paise, d.accessible_rate_paise, d.reason], tx)).rows[0]!["r"],
  );
  res.json({ rates });
});

const auditQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(50) });
adminRouter.get("/audit-logs", validate({ query: auditQuery }), async (req, res) => {
  const { rows } = await query(
    `select l.*, case when p.id is null then null else jsonb_build_object('full_name', p.full_name) end as actor
       from admin_audit_log l left join profiles p on p.id = l.actor_id order by l.created_at desc limit $1`,
    [q<z.infer<typeof auditQuery>>(req).limit],
  );
  res.json({ logs: rows });
});
