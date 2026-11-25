-- Up Migration
-- Parking levels and slots (ported 1:1 from supabase parking_slots migration, minus RLS).

create table parking_levels (
  code          text primary key check (code in ('B2', 'B1', 'G1', 'L1', 'L2')),
  name          text not null,
  sort_order    int not null,
  allows_heavy  boolean not null default false
);

create table parking_slots (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique check (code ~ '^[A-Z0-9]{1,3}-[0-9]{2,3}$'),
  level_code        text not null references parking_levels (code),
  zone              text not null check (zone in ('A', 'B', 'EV')),
  bay_number        int not null,
  slot_type         text not null check (slot_type in ('standard', 'ev', 'accessible')),
  has_ev_charger    boolean not null default false check (
                      (slot_type = 'ev' and has_ev_charger = true) or
                      (slot_type <> 'ev' and has_ev_charger = false)
                    ),
  hourly_rate_paise int not null check (hourly_rate_paise >= 0),
  admin_status      text not null default 'active' check (admin_status in ('active', 'maintenance', 'blocked')),
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint parking_slots_level_bay_key unique (level_code, bay_number)
);

create index idx_parking_slots_level_zone on parking_slots (level_code, zone);
create index idx_parking_slots_admin_status on parking_slots (admin_status);

create trigger parking_slots_set_updated_at
  before update on parking_slots
  for each row execute function set_updated_at();

-- Hard deletes are forbidden so bookings/audit rows never lose their slot reference.
create or replace function prevent_slot_deletion()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Hard-deleting parking slots is forbidden. Set admin_status to maintenance or blocked instead.'
    using errcode = 'restrict_violation';
end;
$$;

create trigger parking_slots_prevent_delete
  before delete on parking_slots
  for each row execute function prevent_slot_deletion();

-- Down Migration
drop table if exists parking_slots;
drop function if exists prevent_slot_deletion();
drop table if exists parking_levels;
