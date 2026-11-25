-- Idempotent seed: 5 levels + 150 slots (ported from supabase/scripts/seed_parking_slots.sql)
-- ── 1. SEED LEVELS ───────────────────────────────────────────
insert into parking_levels (code, name, sort_order, allows_heavy)
values
  ('B2', 'Basement Level 2', 1, true),
  ('B1', 'Basement Level 1', 2, true),
  ('G1', 'Ground Floor',      3, true),
  ('L1', 'Upper Deck Level 1', 4, false),
  ('L2', 'Upper Deck Level 2', 5, false)
on conflict (code) do nothing;

-- ── 2. SEED 150 SLOTS (30 PER LEVEL) ─────────────────────────
insert into parking_slots (
  code,
  level_code,
  zone,
  bay_number,
  slot_type,
  has_ev_charger,
  hourly_rate_paise,
  admin_status
)
select
  l.code || '-' || lpad(b.bay_number::text, 2, '0') as code,
  l.code as level_code,
  case
    when (l.code in ('G1', 'B1') and b.bay_number <= 6) then 'EV'
    when (l.code in ('G1', 'B1') and b.bay_number <= 18) then 'A'
    when (l.code not in ('G1', 'B1') and b.bay_number <= 15) then 'A'
    else 'B'
  end as zone,
  b.bay_number,
  case
    when (l.code in ('G1', 'B1') and b.bay_number <= 6) then 'ev'
    when (b.bay_number in (7, 8)) then 'accessible'
    else 'standard'
  end as slot_type,
  case
    when (l.code in ('G1', 'B1') and b.bay_number <= 6) then true
    else false
  end as has_ev_charger,
  case
    when (l.code in ('G1', 'B1') and b.bay_number <= 6) then 7000 -- ₹70/hr for EV
    else 5000 -- ₹50/hr for Standard & Accessible
  end as hourly_rate_paise,
  'active' as admin_status
from (
  select unnest(array['B2', 'B1', 'G1', 'L1', 'L2']) as code
) l
cross join generate_series(1, 30) as b(bay_number)
order by l.code, b.bay_number
on conflict (code) do nothing;

