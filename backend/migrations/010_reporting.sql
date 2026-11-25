-- Up Migration
-- Admin/reporting SQL functions, ported verbatim from the Supabase migrations.
--
-- Pragmatic port decision (see docs/DATABASE.md): these functions are pure SQL reporting /
-- small admin writes. Instead of rewriting ~900 lines of tested SQL in TypeScript (and risking
-- drift), we keep them and provide a tiny `auth.uid()` shim that reads a transaction-local
-- setting. The Express layer ALWAYS authorises first (requireRole('admin')), then runs
--   BEGIN; SELECT set_config('app.user_id', <id>, true); SELECT admin_xxx(...); COMMIT;
-- so the SQL-side admin check is a second, independent line of defence.

create schema if not exists auth;

create or replace function auth.uid()
returns uuid language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create or replace function public.is_admin()
returns boolean language sql stable as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;

-- ported from 20261020200000_fix_admin_dashboard_and_revenue.sql
create or replace function public.admin_dashboard_stats()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_id          uuid := auth.uid();
  v_now                timestamptz := pg_catalog.now();
  v_today_ist          date := (pg_catalog.timezone('Asia/Kolkata', v_now))::date;
  v_start_today_tz     timestamptz := (v_today_ist::text || ' 00:00:00 Asia/Kolkata')::timestamptz;
  v_end_today_tz       timestamptz := (v_today_ist::text || ' 23:59:59.999999 Asia/Kolkata')::timestamptz;
  
  v_bookings_today     int := 0;
  v_gross_today_paise  bigint := 0;
  v_refund_today_paise bigint := 0;
  v_revenue_today_paise bigint := 0;
  v_active_sessions    int := 0;
  v_total_active_slots int := 0;
  v_occupied_slots     int := 0;
  v_occupancy_percent  numeric := 0.0;
  
  v_recent_bookings    jsonb := '[]'::jsonb;
  v_revenue_7d         jsonb := '[]'::jsonb;
  v_alerts             jsonb := '[]'::jsonb;
  
  v_failed_payments_24h int := 0;
  v_overstay_sessions   int := 0;
  v_down_slots          int := 0;
begin
  -- 1. Security Check
  if v_caller_id is null or not public.is_admin() then
    raise exception 'Access denied: administrator privileges required' using errcode = '42501';
  end if;

  -- 2. Bookings created today (IST)
  select count(*)::int into v_bookings_today
  from public.bookings b
  where b.created_at between v_start_today_tz and v_end_today_tz;

  -- 3. Net Revenue today (IST): succeeded payments minus refunds recorded in the window
  select coalesce(sum(p.amount_paise), 0)::bigint into v_gross_today_paise
  from public.payments p
  where p.created_at between v_start_today_tz and v_end_today_tz
    and p.status in ('succeeded', 'refunded', 'partially_refunded');

  select coalesce(sum(pr.amount_paise), 0)::bigint into v_refund_today_paise
  from public.payment_refunds pr
  where pr.created_at between v_start_today_tz and v_end_today_tz;

  v_revenue_today_paise := v_gross_today_paise - v_refund_today_paise;

  -- 4. Active Sessions count
  select count(*)::int into v_active_sessions
  from public.parking_sessions ps
  where ps.status = 'active'
    and ps.ended_at is null;

  -- 5. Occupancy % (occupied or reserved right now / total active slots)
  select count(*)::int into v_total_active_slots
  from public.parking_slots sl
  where sl.admin_status = 'active';

  select count(distinct b.slot_id)::int into v_occupied_slots
  from public.bookings b
  where (
    (b.status in ('confirmed', 'active') and v_now between b.start_at and b.end_at)
    or exists (
      select 1 from public.parking_sessions ps
      where ps.booking_id = b.id
        and ps.status = 'active'
        and ps.ended_at is null
    )
  );

  if v_total_active_slots > 0 then
    v_occupancy_percent := round((v_occupied_slots::numeric / v_total_active_slots::numeric) * 100.0, 1);
  else
    v_occupancy_percent := 0.0;
  end if;

  -- 6. Recent 10 Bookings
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', rb.id,
        'reference', rb.reference,
        'slot_code', rb.slot_code,
        'plate_snapshot', rb.plate_snapshot,
        'start_at', rb.start_at,
        'end_at', rb.end_at,
        'status', rb.status,
        'total_paise', rb.total_paise,
        'created_at', rb.created_at
      ) order by rb.created_at desc
    ),
    '[]'::jsonb
  ) into v_recent_bookings
  from (
    select
      b.id,
      b.reference,
      coalesce(sl.code, 'N/A') as slot_code,
      b.plate_snapshot,
      b.start_at,
      b.end_at,
      b.status,
      b.total_paise,
      b.created_at
    from public.bookings b
    left join public.parking_slots sl on sl.id = b.slot_id
    order by b.created_at desc
    limit 10
  ) rb;

  -- 7. Revenue last 7 days (including today)
  with days as (
    select (v_today_ist - i)::date as day_dt
    from pg_catalog.generate_series(6, 0, -1) as i
  ),
  day_bounds as (
    select
      d.day_dt,
      (d.day_dt::text || ' 00:00:00 Asia/Kolkata')::timestamptz as start_tz,
      (d.day_dt::text || ' 23:59:59.999999 Asia/Kolkata')::timestamptz as end_tz,
      pg_catalog.to_char(d.day_dt, 'YYYY-MM-DD') as date_str,
      pg_catalog.to_char(d.day_dt, 'Dy DD') as short_label
    from days d
  ),
  day_rev as (
    select
      db.date_str,
      db.short_label,
      coalesce(
        (
          select sum(p.amount_paise)
          from public.payments p
          where p.created_at between db.start_tz and db.end_tz
            and p.status in ('succeeded', 'refunded', 'partially_refunded')
        ),
        0
      ) - coalesce(
        (
          select sum(pr.amount_paise)
          from public.payment_refunds pr
          where pr.created_at between db.start_tz and db.end_tz
        ),
        0
      ) as net_paise
    from day_bounds db
    order by db.day_dt asc
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'date', dr.date_str,
        'label', dr.short_label,
        'net_paise', dr.net_paise
      )
    ),
    '[]'::jsonb
  ) into v_revenue_7d
  from day_rev dr;

  -- 8. Active Operational Alerts
  -- (a) Failed payments in last 24h
  select count(*)::int into v_failed_payments_24h
  from public.payments p
  where p.status = 'failed'
    and p.created_at >= (v_now - '24 hours'::interval);

  -- (b) Overstaying active sessions
  select count(*)::int into v_overstay_sessions
  from public.parking_sessions ps
  where ps.status = 'active'
    and ps.ended_at is null
    and (ps.booked_end_at is not null and v_now > ps.booked_end_at);

  -- (c) Slots in maintenance or blocked
  select count(*)::int into v_down_slots
  from public.parking_slots sl
  where sl.admin_status in ('maintenance', 'blocked');

  -- Build alerts array
  select coalesce(
    jsonb_agg(alt),
    '[]'::jsonb
  ) into v_alerts
  from (
    select
      'failed_payments' as id,
      'warning' as severity,
      'Failed Payments Detected' as title,
      v_failed_payments_24h || ' payment attempts failed in the last 24 hours.' as description,
      'payments' as link_tab
    where v_failed_payments_24h > 0

    union all

    select
      'overstay_vehicles' as id,
      'error' as severity,
      'Active Overstay Vehicles' as title,
      v_overstay_sessions || ' parked vehicles have exceeded their booked end time.' as description,
      'sessions' as link_tab
    where v_overstay_sessions > 0

    union all

    select
      'slots_offline' as id,
      'info' as severity,
      'Slots Out of Service' as title,
      v_down_slots || ' slots are currently set to maintenance or blocked status.' as description,
      'slots' as link_tab
    where v_down_slots > 0
  ) alt;

  -- 9. Final Aggregate Payload
  return jsonb_build_object(
    'kpis', jsonb_build_object(
      'bookings_today', v_bookings_today,
      'revenue_today_paise', v_revenue_today_paise,
      'active_sessions_count', v_active_sessions,
      'occupancy_percent', v_occupancy_percent,
      'total_active_slots', v_total_active_slots,
      'occupied_slots', v_occupied_slots
    ),
    'revenue_last_7_days', v_revenue_7d,
    'recent_bookings', v_recent_bookings,
    'alerts', v_alerts,
    'generated_at', v_now
  );
end;
$$;

-- ported from 20261020160001_fix_revenue_report.sql  (NOTE: the later 20261020200000 version returns {periods,summary,by_slot_type}, which the admin revenue page cannot read; this earlier version matches the page contract {periods[period_label],totals,breakdown_by_*})
create or replace function public.admin_revenue_report(
  p_from  date default null,
  p_to    date default null,
  p_group text default 'day'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid := auth.uid();
  v_diff_days int;
  v_from_tz   timestamptz;
  v_to_tz     timestamptz;
  v_result    jsonb;
  v_today_ist date := (pg_catalog.timezone('Asia/Kolkata', pg_catalog.now()))::date;
  v_from_date date;
  v_to_date   date;
begin
  -- 1. Security Check
  if v_caller_id is null or not public.is_admin() then
    raise exception 'Access denied: administrator privileges required' using errcode = '42501';
  end if;

  -- 2. Input Defaults and Validation
  v_from_date := coalesce(p_from, v_today_ist);
  v_to_date   := coalesce(p_to, v_today_ist);

  if v_from_date > v_to_date then
    raise exception 'Invalid date range: start date must be before or equal to end date' using errcode = 'P0001';
  end if;

  v_diff_days := (v_to_date - v_from_date);
  if v_diff_days > 366 then
    raise exception 'Date range exceeds maximum limit of 366 days' using errcode = 'P0001';
  end if;

  if p_group not in ('day', 'week', 'month') then
    raise exception 'Invalid grouping: must be day, week, or month' using errcode = 'P0001';
  end if;

  -- Interpret inputs in Asia/Kolkata timezone
  v_from_tz := (v_from_date::text || ' 00:00:00 Asia/Kolkata')::timestamptz;
  v_to_tz   := (v_to_date::text   || ' 23:59:59.999999 Asia/Kolkata')::timestamptz;

  with period_series as (
    select
      case p_group
        when 'day'   then pg_catalog.to_char(pg_catalog.timezone('Asia/Kolkata', d), 'YYYY-MM-DD')
        when 'week'  then pg_catalog.to_char(pg_catalog.timezone('Asia/Kolkata', pg_catalog.date_trunc('week', d)), 'YYYY-"W"IW')
        when 'month' then pg_catalog.to_char(pg_catalog.timezone('Asia/Kolkata', pg_catalog.date_trunc('month', d)), 'YYYY-MM')
      end as period_label,
      min(d) as p_start,
      max(d) as p_end
    from pg_catalog.generate_series(v_from_tz, v_to_tz, '1 day'::interval) as d
    group by 1
  ),
  period_payments as (
    select
      case p_group
        when 'day'   then pg_catalog.to_char(pg_catalog.timezone('Asia/Kolkata', p.created_at), 'YYYY-MM-DD')
        when 'week'  then pg_catalog.to_char(pg_catalog.timezone('Asia/Kolkata', pg_catalog.date_trunc('week', p.created_at)), 'YYYY-"W"IW')
        when 'month' then pg_catalog.to_char(pg_catalog.timezone('Asia/Kolkata', pg_catalog.date_trunc('month', p.created_at)), 'YYYY-MM')
      end as period_label,
      coalesce(sum(case when p.status in ('succeeded', 'refunded', 'partially_refunded') then p.amount_paise else 0 end), 0)::bigint as gross_paise,
      coalesce(sum(case when p.status in ('succeeded', 'refunded', 'partially_refunded') then p.gst_paise else 0 end), 0)::bigint as gst_paise
    from public.payments p
    where p.created_at between v_from_tz and v_to_tz
    group by 1
  ),
  period_refunds as (
    select
      case p_group
        when 'day'   then pg_catalog.to_char(pg_catalog.timezone('Asia/Kolkata', pr.created_at), 'YYYY-MM-DD')
        when 'week'  then pg_catalog.to_char(pg_catalog.timezone('Asia/Kolkata', pg_catalog.date_trunc('week', pr.created_at)), 'YYYY-"W"IW')
        when 'month' then pg_catalog.to_char(pg_catalog.timezone('Asia/Kolkata', pg_catalog.date_trunc('month', pr.created_at)), 'YYYY-MM')
      end as period_label,
      coalesce(sum(pr.amount_paise), 0)::bigint as refund_paise
    from public.payment_refunds pr
    where pr.created_at between v_from_tz and v_to_tz
      and pr.status = 'processed'
    group by 1
  ),
  period_bookings as (
    select
      case p_group
        when 'day'   then pg_catalog.to_char(pg_catalog.timezone('Asia/Kolkata', b.created_at), 'YYYY-MM-DD')
        when 'week'  then pg_catalog.to_char(pg_catalog.timezone('Asia/Kolkata', pg_catalog.date_trunc('week', b.created_at)), 'YYYY-"W"IW')
        when 'month' then pg_catalog.to_char(pg_catalog.timezone('Asia/Kolkata', pg_catalog.date_trunc('month', b.created_at)), 'YYYY-MM')
      end as period_label,
      count(*)::bigint as bookings_count,
      count(*) filter (where b.status = 'cancelled')::bigint as cancelled_count
    from public.bookings b
    where b.created_at between v_from_tz and v_to_tz
    group by 1
  ),
  period_overstay as (
    select
      case p_group
        when 'day'   then pg_catalog.to_char(pg_catalog.timezone('Asia/Kolkata', oc.created_at), 'YYYY-MM-DD')
        when 'week'  then pg_catalog.to_char(pg_catalog.timezone('Asia/Kolkata', pg_catalog.date_trunc('week', oc.created_at)), 'YYYY-"W"IW')
        when 'month' then pg_catalog.to_char(pg_catalog.timezone('Asia/Kolkata', pg_catalog.date_trunc('month', oc.created_at)), 'YYYY-MM')
      end as period_label,
      coalesce(sum(oc.total_paise), 0)::bigint as overstay_paise
    from public.overstay_charges oc
    where oc.created_at between v_from_tz and v_to_tz
    group by 1
  ),
  merged_periods as (
    select
      ps.period_label,
      coalesce(pp.gross_paise, 0) as gross_paise,
      coalesce(pr.refund_paise, 0) as refund_paise,
      (coalesce(pp.gross_paise, 0) - coalesce(pr.refund_paise, 0)) as net_paise,
      coalesce(pp.gst_paise, 0) as gst_paise,
      coalesce(pb.bookings_count, 0) as bookings_count,
      coalesce(pb.cancelled_count, 0) as cancelled_count,
      coalesce(po.overstay_paise, 0) as overstay_paise
    from period_series ps
    left join period_payments pp on pp.period_label = ps.period_label
    left join period_refunds  pr on pr.period_label = ps.period_label
    left join period_bookings pb on pb.period_label = ps.period_label
    left join period_overstay po on po.period_label = ps.period_label
    order by ps.period_label asc
  ),
  slot_type_breakdown as (
    select
      psl.slot_type as slot_type,
      count(b.id)::bigint as bookings_count,
      coalesce(sum(case when p.status in ('succeeded', 'refunded', 'partially_refunded') then p.amount_paise else 0 end), 0)::bigint as gross_paise
    from public.bookings b
    join public.parking_slots psl on psl.id = b.slot_id
    left join public.payments p on p.booking_id = b.id
    where b.created_at between v_from_tz and v_to_tz
    group by psl.slot_type
    order by gross_paise desc
  ),
  level_breakdown as (
    select
      psl.level_code,
      count(b.id)::bigint as bookings_count,
      coalesce(sum(case when p.status in ('succeeded', 'refunded', 'partially_refunded') then p.amount_paise else 0 end), 0)::bigint as gross_paise
    from public.bookings b
    join public.parking_slots psl on psl.id = b.slot_id
    left join public.payments p on p.booking_id = b.id
    where b.created_at between v_from_tz and v_to_tz
    group by psl.level_code
    order by psl.level_code asc
  ),
  method_breakdown as (
    select
      p.method,
      count(*)::bigint as count,
      coalesce(sum(p.amount_paise), 0)::bigint as gross_paise
    from public.payments p
    where p.created_at between v_from_tz and v_to_tz
      and p.status in ('succeeded', 'refunded', 'partially_refunded')
    group by p.method
    order by gross_paise desc
  )
  select jsonb_build_object(
    'periods', coalesce((select jsonb_agg(to_jsonb(mp)) from merged_periods mp), '[]'::jsonb),
    'totals', jsonb_build_object(
      'total_gross_paise', coalesce((select sum(gross_paise) from merged_periods), 0),
      'total_refund_paise', coalesce((select sum(refund_paise) from merged_periods), 0),
      'total_net_paise', coalesce((select sum(net_paise) from merged_periods), 0),
      'total_gst_paise', coalesce((select sum(gst_paise) from merged_periods), 0),
      'total_bookings', coalesce((select sum(bookings_count) from merged_periods), 0),
      'total_cancelled', coalesce((select sum(cancelled_count) from merged_periods), 0),
      'total_overstay_paise', coalesce((select sum(overstay_paise) from merged_periods), 0),
      'average_booking_value_paise', case
        when coalesce((select sum(bookings_count) from merged_periods), 0) > 0 then
          (coalesce((select sum(gross_paise) from merged_periods), 0) / (select sum(bookings_count) from merged_periods))
        else 0
      end,
      'cancellation_rate_bps', case
        when coalesce((select sum(bookings_count) from merged_periods), 0) > 0 then
          ((coalesce((select sum(cancelled_count) from merged_periods), 0)::numeric * 10000.0) / (select sum(bookings_count) from merged_periods))::int
        else 0
      end
    ),
    'breakdown_by_slot_type', coalesce((select jsonb_agg(to_jsonb(stb)) from slot_type_breakdown stb), '[]'::jsonb),
    'breakdown_by_level', coalesce((select jsonb_agg(to_jsonb(lb)) from level_breakdown lb), '[]'::jsonb),
    'breakdown_by_payment_method', coalesce((select jsonb_agg(to_jsonb(mb)) from method_breakdown mb), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- ported from 20261020160001_fix_revenue_report.sql  (NOTE: the later 20261020200000 version returns {periods,summary,by_slot_type}, which the admin revenue page cannot read; this earlier version matches the page contract {periods[period_label],totals,breakdown_by_*})
create or replace function public.admin_payment_totals(
  p_date_from timestamptz default null,
  p_date_to   timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_id          uuid := auth.uid();
  v_gross_paise        bigint := 0;
  v_refund_paise       bigint := 0;
  v_succeeded_count    int := 0;
  v_failed_count       int := 0;
  v_total_transactions int := 0;
begin
  if v_caller_id is null or not public.is_admin() then
    raise exception 'Access denied: administrator privileges required' using errcode = '42501';
  end if;

  select
    coalesce(sum(case when status in ('succeeded', 'refunded', 'partially_refunded') then amount_paise else 0 end), 0)::bigint,
    count(case when status in ('succeeded', 'refunded', 'partially_refunded') then 1 end)::int,
    count(case when status = 'failed' then 1 end)::int,
    count(*)::int
  into
    v_gross_paise,
    v_succeeded_count,
    v_failed_count,
    v_total_transactions
  from public.payments
  where (p_date_from is null or created_at >= p_date_from)
    and (p_date_to is null or created_at <= p_date_to);

  select coalesce(sum(pr.amount_paise), 0)::bigint
  into v_refund_paise
  from public.payment_refunds pr
  where pr.status = 'processed'
    and (p_date_from is null or pr.created_at >= p_date_from)
    and (p_date_to is null or pr.created_at <= p_date_to);

  return jsonb_build_object(
    'grossPaise', v_gross_paise,
    'refundPaise', v_refund_paise,
    'netPaise', (v_gross_paise - v_refund_paise),
    'succeededCount', v_succeeded_count,
    'failedCount', v_failed_count,
    'totalTransactions', v_total_transactions
  );
end;
$$;

-- ported from 20261020143000_admin_apis.sql
create or replace function public.admin_active_sessions()
returns table (
  session_id            uuid,
  booking_id            uuid,
  booking_reference     text,
  slot_code             text,
  level_code            text,
  plate_snapshot        text,
  user_full_name        text,
  started_at            timestamptz,
  booked_end_at         timestamptz,
  overstay_minutes      int,
  overstay_charge_paise int,
  is_overstay           boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid := auth.uid();
  v_now       timestamptz := pg_catalog.now();
  v_grace_min int;
begin
  if v_caller_id is null or not public.is_admin() then
    raise exception 'Access denied: administrator privileges required' using errcode = '42501';
  end if;

  select exit_grace_minutes into v_grace_min from public.pricing_settings where id = true;
  v_grace_min := coalesce(v_grace_min, 15);

  return query
  select
    ps.id as session_id,
    ps.booking_id,
    b.reference as booking_reference,
    sl.code as slot_code,
    sl.level_code,
    b.plate_snapshot,
    pr.full_name as user_full_name,
    ps.started_at,
    ps.booked_end_at,
    greatest(0, pg_catalog.ceil(extract(epoch from (v_now - ps.booked_end_at)) / 60.0)::int - v_grace_min) as overstay_minutes,
    case
      when v_now > (ps.booked_end_at + (v_grace_min || ' minutes')::interval) then
        pg_catalog.ceil(
          greatest(0, pg_catalog.ceil(extract(epoch from (v_now - ps.booked_end_at)) / 60.0)::int - v_grace_min)::numeric *
          b.hourly_rate_paise / 60.0
        )::int
      else 0
    end as overstay_charge_paise,
    (v_now > ps.booked_end_at) as is_overstay
  from public.parking_sessions ps
  join public.bookings b on b.id = ps.booking_id
  join public.parking_slots sl on sl.id = b.slot_id
  left join public.profiles pr on pr.id = ps.user_id
  where ps.status = 'active'
    and ps.ended_at is null
  order by (v_now - ps.booked_end_at) desc;
end;
$$;

-- ported from 20261020143000_admin_apis.sql
create or replace function public.admin_list_users(
  p_search text default null,
  p_role   text default null,
  p_limit  int  default 20,
  p_offset int  default 0
)
returns table (
  id              uuid,
  email           text,
  full_name       text,
  phone           text,
  role            text,
  created_at      timestamptz,
  last_sign_in_at timestamptz,
  booking_count   bigint,
  total_paid_paise bigint,
  total_count     bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid := auth.uid();
  v_limit     int  := least(greatest(1, coalesce(p_limit, 20)), 50);
  v_offset    int  := greatest(0, coalesce(p_offset, 0));
  v_trimmed   text := trim(coalesce(p_search, ''));
begin
  if v_caller_id is null or not public.is_admin() then
    raise exception 'Access denied: administrator privileges required' using errcode = '42501';
  end if;

  return query
  with filtered_users as (
    select
      p.id,
      u.email::text as email,
      p.full_name,
      p.phone,
      p.role,
      p.created_at,
      u.last_sign_in_at,
      coalesce(b_stats.b_count, 0) as booking_count,
      coalesce(p_stats.paid_paise, 0) as total_paid_paise
    from public.profiles p
    join public.users u on u.id = p.id
    left join (
      select user_id, count(*)::bigint as b_count
      from public.bookings
      group by user_id
    ) b_stats on b_stats.user_id = p.id
    left join (
      select user_id, sum(amount_paise)::bigint as paid_paise
      from public.payments
      where status in ('succeeded', 'refunded', 'partially_refunded')
      group by user_id
    ) p_stats on p_stats.user_id = p.id
    where (p_role is null or p_role = 'All' or p.role = p_role)
      and (
        v_trimmed = ''
        or p.full_name ilike '%' || v_trimmed || '%'
        or p.phone     ilike '%' || v_trimmed || '%'
        or u.email     ilike '%' || v_trimmed || '%'
      )
  ),
  counted as (
    select count(*) as total_rows from filtered_users
  )
  select
    fu.id,
    fu.email,
    fu.full_name,
    fu.phone,
    fu.role,
    fu.created_at,
    fu.last_sign_in_at,
    fu.booking_count,
    fu.total_paid_paise,
    c.total_rows as total_count
  from filtered_users fu
  cross join counted c
  order by fu.created_at desc
  limit v_limit offset v_offset;
end;
$$;

-- ported from 20261020143000_admin_apis.sql
create or replace function public.admin_set_user_role(
  p_user_id uuid,
  p_role    text,
  p_reason  text
)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_id   uuid := auth.uid();
  v_target_user public.profiles;
  v_old_role    text;
  v_admin_count int;
  v_trimmed_reason text;
begin
  -- 1. Authentication & admin check
  if v_caller_id is null or not public.is_admin() then
    raise exception 'Access denied: administrator privileges required' using errcode = '42501';
  end if;

  -- 2. Validate reason length (5-300 chars)
  v_trimmed_reason := trim(coalesce(p_reason, ''));
  if length(v_trimmed_reason) < 5 or length(v_trimmed_reason) > 300 then
    raise exception 'A valid reason between 5 and 300 characters is required' using errcode = 'P0001';
  end if;

  -- 3. Validate target role
  if p_role not in ('member', 'staff', 'admin') then
    raise exception 'Invalid role: must be member, staff, or admin' using errcode = 'P0001';
  end if;

  -- 4. An admin cannot change their own role
  if p_user_id = v_caller_id then
    raise exception 'Administrators cannot alter their own access role' using errcode = 'P0001';
  end if;

  -- 5. Lock and retrieve target profile
  select * into v_target_user
  from public.profiles
  where id = p_user_id
  for update;

  if not found then
    raise exception 'User profile not found' using errcode = 'P0002';
  end if;

  v_old_role := v_target_user.role;
  if v_old_role = p_role then
    return v_target_user;
  end if;

  -- 6. Last admin demotion guard: prevent demoting the last remaining admin
  if v_old_role = 'admin' and p_role <> 'admin' then
    select count(*) into v_admin_count
    from public.profiles
    where role = 'admin';

    if v_admin_count <= 1 then
      raise exception 'Operation rejected: cannot demote the last remaining administrator' using errcode = 'P0001';
    end if;
  end if;

  -- 7. Set transaction-local flag so profiles_prevent_role_change allows this update
  perform pg_catalog.set_config('app.allow_role_change', 'true', true);

  update public.profiles
  set role = p_role,
      updated_at = pg_catalog.now()
  where id = p_user_id
  returning * into v_target_user;

  -- 8. Write audit log
  insert into public.admin_audit_log (
    actor_id, action, record_type, record_id, reason, old_data, new_data
  ) values (
    v_caller_id,
    'change_user_role',
    'user',
    p_user_id::text,
    v_trimmed_reason,
    jsonb_build_object('role', v_old_role),
    jsonb_build_object('role', p_role)
  );

  return v_target_user;
end;
$$;

-- ported from 20261020143000_admin_apis.sql
create or replace function public.admin_update_settings(
  p_gst_bps                 int,
  p_hold_minutes            int,
  p_min_hours               int,
  p_max_hours               int,
  p_max_advance_days        int,
  p_refund_full_hours       int,
  p_refund_partial_minutes  int,
  p_partial_refund_bps      int,
  p_exit_grace_minutes      int,
  p_reason                  text
)
returns public.pricing_settings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_id      uuid := auth.uid();
  v_old_settings   public.pricing_settings;
  v_new_settings   public.pricing_settings;
  v_trimmed_reason text;
  v_now            timestamptz := pg_catalog.now();
begin
  -- 1. Security check
  if v_caller_id is null or not public.is_admin() then
    raise exception 'Access denied: administrator privileges required' using errcode = '42501';
  end if;

  -- 2. Validate reason
  v_trimmed_reason := trim(coalesce(p_reason, ''));
  if length(v_trimmed_reason) < 5 or length(v_trimmed_reason) > 300 then
    raise exception 'A valid reason between 5 and 300 characters is required' using errcode = 'P0001';
  end if;

  -- 3. Strict range validation
  if p_gst_bps < 0 or p_gst_bps > 2800 then
    raise exception 'GST basis points must be between 0 and 2800 (0%% to 28%%)' using errcode = 'P0001';
  end if;

  if p_hold_minutes < 5 or p_hold_minutes > 30 then
    raise exception 'Hold duration must be between 5 and 30 minutes' using errcode = 'P0001';
  end if;

  if p_min_hours < 1 or p_min_hours > 4 then
    raise exception 'Minimum booking hours must be between 1 and 4' using errcode = 'P0001';
  end if;

  if p_max_hours < 1 or p_max_hours > 72 or p_max_hours < p_min_hours then
    raise exception 'Maximum booking hours must be between min_hours and 72' using errcode = 'P0001';
  end if;

  if p_max_advance_days < 1 or p_max_advance_days > 90 then
    raise exception 'Maximum advance booking days must be between 1 and 90' using errcode = 'P0001';
  end if;

  if p_refund_full_hours < 0 or p_refund_full_hours > 48 then
    raise exception 'Full refund threshold must be between 0 and 48 hours' using errcode = 'P0001';
  end if;

  if p_refund_partial_minutes < 0 or p_refund_partial_minutes > 1440 then
    raise exception 'Partial refund threshold must be between 0 and 1440 minutes' using errcode = 'P0001';
  end if;

  if p_partial_refund_bps < 0 or p_partial_refund_bps > 10000 then
    raise exception 'Partial refund percentage must be between 0 and 10000 bps (0%% to 100%%)' using errcode = 'P0001';
  end if;

  if p_exit_grace_minutes < 0 or p_exit_grace_minutes > 120 then
    raise exception 'Exit grace duration must be between 0 and 120 minutes' using errcode = 'P0001';
  end if;

  -- 4. Lock settings singleton
  select * into v_old_settings
  from public.pricing_settings
  where id = true
  for update;

  -- 5. Apply updates
  update public.pricing_settings
  set gst_bps                = p_gst_bps,
      hold_minutes           = p_hold_minutes,
      min_hours              = p_min_hours,
      max_hours              = p_max_hours,
      max_advance_days       = p_max_advance_days,
      refund_full_hours      = p_refund_full_hours,
      refund_partial_minutes = p_refund_partial_minutes,
      partial_refund_bps     = p_partial_refund_bps,
      exit_grace_minutes     = p_exit_grace_minutes,
      updated_at             = v_now
  where id = true
  returning * into v_new_settings;

  -- 6. Write audit log
  insert into public.admin_audit_log (
    actor_id, action, record_type, record_id, reason, old_data, new_data
  ) values (
    v_caller_id,
    'update_pricing_settings',
    'settings',
    'singleton',
    v_trimmed_reason,
    to_jsonb(v_old_settings),
    to_jsonb(v_new_settings)
  );

  return v_new_settings;
end;
$$;

-- ported from 20261020160002_admin_slot_rates.sql
create or replace function public.admin_get_slot_rates()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid := auth.uid();
  v_rates     jsonb;
begin
  if v_caller_id is null or not public.is_admin() then
    raise exception 'Access denied: administrator privileges required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'standard_rate_paise', coalesce(
      (select hourly_rate_paise from public.parking_slots where slot_type = 'standard' limit 1),
      5000
    ),
    'ev_rate_paise', coalesce(
      (select hourly_rate_paise from public.parking_slots where slot_type = 'ev' limit 1),
      7000
    ),
    'accessible_rate_paise', coalesce(
      (select hourly_rate_paise from public.parking_slots where slot_type = 'accessible' limit 1),
      5000
    )
  ) into v_rates;

  return v_rates;
end;
$$;

-- ported from 20261020160002_admin_slot_rates.sql
create or replace function public.admin_update_slot_rates(
  p_standard_rate_paise   int,
  p_ev_rate_paise         int,
  p_accessible_rate_paise int,
  p_reason                text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_id      uuid := auth.uid();
  v_old_rates      jsonb;
  v_new_rates      jsonb;
  v_trimmed_reason text;
  v_now            timestamptz := pg_catalog.now();
begin
  -- 1. Security Check
  if v_caller_id is null or not public.is_admin() then
    raise exception 'Access denied: administrator privileges required' using errcode = '42501';
  end if;

  -- 2. Validate Reason
  v_trimmed_reason := trim(coalesce(p_reason, ''));
  if length(v_trimmed_reason) < 5 or length(v_trimmed_reason) > 300 then
    raise exception 'A valid reason between 5 and 300 characters is required' using errcode = 'P0001';
  end if;

  -- 3. Validate Rate Boundaries (₹10/hr to ₹1,000/hr)
  if p_standard_rate_paise < 1000 or p_standard_rate_paise > 100000 then
    raise exception 'Standard rate must be between 1000 and 100000 paise (₹10 to ₹1,000/hr)' using errcode = 'P0001';
  end if;

  if p_ev_rate_paise < 1000 or p_ev_rate_paise > 100000 then
    raise exception 'EV rate must be between 1000 and 100000 paise (₹10 to ₹1,000/hr)' using errcode = 'P0001';
  end if;

  if p_accessible_rate_paise < 1000 or p_accessible_rate_paise > 100000 then
    raise exception 'Accessible rate must be between 1000 and 100000 paise (₹10 to ₹1,000/hr)' using errcode = 'P0001';
  end if;

  -- 4. Capture current rates
  v_old_rates := public.admin_get_slot_rates();

  -- 5. Update parking_slots table by slot_type
  update public.parking_slots
  set hourly_rate_paise = p_standard_rate_paise,
      updated_at = v_now
  where slot_type = 'standard';

  update public.parking_slots
  set hourly_rate_paise = p_ev_rate_paise,
      updated_at = v_now
  where slot_type = 'ev';

  update public.parking_slots
  set hourly_rate_paise = p_accessible_rate_paise,
      updated_at = v_now
  where slot_type = 'accessible';

  v_new_rates := jsonb_build_object(
    'standard_rate_paise', p_standard_rate_paise,
    'ev_rate_paise', p_ev_rate_paise,
    'accessible_rate_paise', p_accessible_rate_paise
  );

  -- 6. Write to admin audit log
  insert into public.admin_audit_log (
    actor_id,
    action,
    record_type,
    record_id,
    reason,
    old_data,
    new_data
  ) values (
    v_caller_id,
    'update_slot_rates',
    'parking_slots',
    'slot_types',
    v_trimmed_reason,
    v_old_rates,
    v_new_rates
  );

  return v_new_rates;
end;
$$;

-- Down Migration
drop function if exists public.admin_update_slot_rates;
drop function if exists public.admin_get_slot_rates;
drop function if exists public.admin_update_settings;
drop function if exists public.admin_set_user_role;
drop function if exists public.admin_list_users;
drop function if exists public.admin_active_sessions;
drop function if exists public.admin_payment_totals;
drop function if exists public.admin_revenue_report;
drop function if exists public.admin_dashboard_stats;
drop function if exists public.is_admin();
drop function if exists auth.uid();
drop schema if exists auth;
