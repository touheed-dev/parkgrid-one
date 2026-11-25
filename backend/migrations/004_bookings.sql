-- Up Migration
-- Pricing settings (singleton) + bookings with DB-level double-booking protection.
-- Orchestration (create/cancel/expire/confirm) lives in TypeScript services; the invariants
-- (exclusion constraint, immutability trigger) stay in the database as the last line of defence.

create table pricing_settings (
  id                      boolean primary key default true check (id),
  gst_bps                 int not null default 1800 check (gst_bps >= 0),
  hold_minutes            int not null default 10 check (hold_minutes between 1 and 60),
  min_hours               int not null default 1 check (min_hours >= 1),
  max_hours               int not null default 24 check (max_hours >= min_hours),
  max_advance_days        int not null default 30 check (max_advance_days >= 1),
  refund_full_hours       int not null default 2 check (refund_full_hours >= 0),
  refund_partial_minutes  int not null default 30 check (refund_partial_minutes >= 0),
  partial_refund_bps      int not null default 5000 check (partial_refund_bps between 0 and 10000),
  payment_mode            text not null default 'mock' check (payment_mode in ('mock', 'razorpay')),
  max_payment_attempts    int not null default 3 check (max_payment_attempts >= 1),
  exit_grace_minutes      int not null default 15 check (exit_grace_minutes >= 0),
  early_entry_minutes     int not null default 15 check (early_entry_minutes >= 0),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

insert into pricing_settings (id) values (true) on conflict (id) do nothing;

create trigger pricing_settings_set_updated_at
  before update on pricing_settings
  for each row execute function set_updated_at();

create table bookings (
  id                    uuid primary key default gen_random_uuid(),
  reference             text not null unique check (reference ~ '^SP-[0-9]{8}-[A-Z0-9]{4}$'),
  user_id               uuid not null references profiles (id) on delete restrict,
  slot_id               uuid not null references parking_slots (id) on delete restrict,
  vehicle_id            uuid not null references vehicles (id) on delete restrict,
  plate_snapshot        text not null,
  vehicle_type_snapshot text not null,
  start_at              timestamptz not null,
  end_at                timestamptz not null check (end_at > start_at),
  during                tstzrange generated always as (tstzrange(start_at, end_at, '[)')) stored,
  hours                 int not null check (hours >= 1),
  hourly_rate_paise     int not null check (hourly_rate_paise >= 0),
  base_paise            int not null check (base_paise >= 0),
  gst_paise             int not null check (gst_paise >= 0),
  total_paise           int not null check (total_paise >= 0),
  status                text not null default 'reserved' check (
                          status in ('reserved', 'confirmed', 'active', 'completed', 'cancelled', 'no_show', 'expired')
                        ),
  payment_status        text not null default 'pending' check (
                          payment_status in ('pending', 'paid', 'failed', 'refunded', 'partially_refunded')
                        ),
  hold_expires_at       timestamptz,
  cancelled_at          timestamptz,
  cancellation_reason   text,
  refund_paise          int not null default 0 check (refund_paise >= 0),
  -- Opaque QR pass token (see docs/PAYMENTS.md). Never the booking reference.
  qr_token              text unique,
  qr_issued_at          timestamptz,
  qr_revoked_at         timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- Half-open ranges: 10:00-11:00 and 11:00-12:00 do not overlap.
  constraint bookings_slot_during_overlap_excl
    exclude using gist (slot_id with =, during with &&)
    where (status in ('reserved', 'confirmed', 'active'))
);

create index idx_bookings_user_start on bookings (user_id, start_at desc);
create index idx_bookings_status on bookings (status);
create index idx_bookings_start_at on bookings (start_at);
create index idx_bookings_slot on bookings (slot_id);
create index idx_bookings_vehicle on bookings (vehicle_id);
create index idx_bookings_hold on bookings (hold_expires_at) where status = 'reserved';

create or replace function protect_booking_immutability()
returns trigger language plpgsql as $$
begin
  if old.user_id <> new.user_id
     or old.slot_id <> new.slot_id
     or old.vehicle_id <> new.vehicle_id
     or old.start_at <> new.start_at
     or old.end_at <> new.end_at
     or old.reference <> new.reference
     or old.base_paise <> new.base_paise
     or old.gst_paise <> new.gst_paise
     or old.total_paise <> new.total_paise
  then
    raise exception 'Booking parameters and pricing are immutable after creation' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger bookings_protect_immutability
  before update on bookings
  for each row execute function protect_booking_immutability();

create trigger bookings_set_updated_at
  before update on bookings
  for each row execute function set_updated_at();

-- Down Migration
drop table if exists bookings;
drop function if exists protect_booking_immutability();
drop table if exists pricing_settings;
