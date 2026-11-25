-- Up Migration
-- Member vehicles. Integrity triggers are kept (they protect data even if app code has a bug).
-- set_default_vehicle() RPC is replaced by a TS transaction; the BEFORE trigger below also
-- guarantees a single default per user.

create table vehicles (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users (id) on delete cascade,
  plate_number    text not null check (plate_number ~ '^[A-Z0-9]{6,12}$'),
  vehicle_type    text not null check (vehicle_type in ('car', 'suv', 'bike', 'ev')),
  make            text check (make is null or length(trim(make)) between 1 and 50),
  model           text check (model is null or length(trim(model)) between 1 and 50),
  color           text check (color is null or length(trim(color)) between 1 and 30),
  is_ev           boolean not null default false,
  connector_type  text check (
                    (is_ev = false and connector_type is null) or
                    (is_ev = true and connector_type in ('CCS2', 'Type2', 'CHAdeMO', 'Bharat_AC001', 'Bharat_DC001'))
                  ),
  is_default      boolean not null default false,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint vehicles_ev_type_check check (
    (vehicle_type = 'ev' and is_ev = true) or
    (vehicle_type in ('car', 'suv', 'bike'))
  )
);

create index idx_vehicles_user_id on vehicles (user_id);

create unique index idx_vehicles_user_plate_active
  on vehicles (user_id, plate_number)
  where archived_at is null;

create unique index idx_vehicles_user_single_default
  on vehicles (user_id)
  where is_default = true and archived_at is null;

create or replace function normalize_vehicle_plate()
returns trigger language plpgsql as $$
begin
  if new.plate_number is not null then
    new.plate_number := upper(regexp_replace(new.plate_number, '[^a-zA-Z0-9]', '', 'g'));
  end if;
  return new;
end;
$$;

create trigger vehicles_normalize_plate
  before insert or update on vehicles
  for each row execute function normalize_vehicle_plate();

create or replace function check_vehicle_limit()
returns trigger language plpgsql as $$
begin
  if new.archived_at is null and (tg_op = 'INSERT' or old.archived_at is not null) then
    if (
      select count(*) from vehicles
      where user_id = new.user_id
        and archived_at is null
        and id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid)
    ) >= 5 then
      raise exception 'Active vehicle limit reached (maximum 5 vehicles)' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger vehicles_check_limit
  before insert or update on vehicles
  for each row execute function check_vehicle_limit();

create or replace function prevent_vehicle_user_id_change()
returns trigger language plpgsql as $$
begin
  if old.user_id <> new.user_id then
    raise exception 'Changing vehicle owner (user_id) is forbidden' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger vehicles_prevent_user_id_change
  before update on vehicles
  for each row execute function prevent_vehicle_user_id_change();

create trigger vehicles_set_updated_at
  before update on vehicles
  for each row execute function set_updated_at();

create or replace function ensure_single_default_vehicle()
returns trigger language plpgsql as $$
begin
  if new.is_default = true and new.archived_at is null then
    update vehicles
    set is_default = false
    where user_id = new.user_id
      and id <> new.id
      and is_default = true
      and archived_at is null;
  end if;
  return new;
end;
$$;

create trigger trg_vehicles_ensure_single_default
  before insert or update of is_default, archived_at on vehicles
  for each row execute function ensure_single_default_vehicle();

-- Down Migration
drop table if exists vehicles;
drop function if exists normalize_vehicle_plate();
drop function if exists check_vehicle_limit();
drop function if exists prevent_vehicle_user_id_change();
drop function if exists ensure_single_default_vehicle();
