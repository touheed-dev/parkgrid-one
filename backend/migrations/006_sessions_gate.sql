-- Up Migration
-- Parking sessions, overstay charges, gate scan audit.
-- Behaviour kept from the original: one session per confirmed booking, created by a trigger
-- when the booking goes reserved -> confirmed; "active" is derived from timestamps.
-- Added: entered_at (set by the gate entry scan) and overstay status.

create table parking_sessions (
  id                uuid primary key default gen_random_uuid(),
  booking_id        uuid not null unique references bookings (id) on delete restrict,
  user_id           uuid not null references users (id) on delete restrict,
  started_at        timestamptz not null default now(),   -- equals booking.start_at
  booked_end_at     timestamptz not null default now(),   -- equals booking.end_at
  entered_at        timestamptz,                          -- gate entry scan time
  ended_at          timestamptz,                          -- null = still open
  ended_by_admin    boolean not null default false,
  duration_minutes  int,
  status            text not null default 'active'
                    check (status in ('active', 'completed', 'auto_ended', 'cancelled')),
  auto_ended        boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index idx_sessions_user_id on parking_sessions (user_id);
create index idx_sessions_status on parking_sessions (status);
create index idx_sessions_started_at on parking_sessions (started_at desc);

create trigger parking_sessions_set_updated_at
  before update on parking_sessions
  for each row execute function set_updated_at();

create table overstay_charges (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null references parking_sessions (id) on delete restrict,
  booking_id        uuid not null references bookings (id) on delete restrict,
  user_id           uuid not null references users (id) on delete restrict,
  overstay_minutes  int not null default 0 check (overstay_minutes >= 0),
  base_paise        int not null default 0 check (base_paise >= 0),
  gst_paise         int not null default 0 check (gst_paise >= 0),
  total_paise       int not null default 0 check (total_paise >= 0),
  -- 'paid' = settled by the mock provider (original behaviour); 'due' = to be collected.
  status            text not null default 'paid' check (status in ('due', 'paid', 'waived')),
  provider_ref      text,
  receipt_number    text unique,
  paid_at           timestamptz default now(),
  created_at        timestamptz not null default now()
);

create index idx_overstay_session_id on overstay_charges (session_id);
create index idx_overstay_booking_id on overstay_charges (booking_id);
create index idx_overstay_user_id on overstay_charges (user_id);

create or replace function generate_overstay_receipt_number()
returns text language plpgsql volatile as $$
declare
  v_date text := to_char(timezone('Asia/Kolkata', now()), 'YYYYMMDD');
  v_chars text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_random text;
  v_candidate text;
  v_i int;
  v_attempts int := 0;
begin
  loop
    v_attempts := v_attempts + 1;
    if v_attempts > 100 then
      raise exception 'Failed to generate unique overstay receipt' using errcode = 'P0001';
    end if;
    v_random := '';
    for v_i in 1..4 loop
      v_random := v_random || substr(v_chars, floor(random() * length(v_chars) + 1)::int, 1);
    end loop;
    v_candidate := 'OV-' || v_date || '-' || v_random;
    if not exists (select 1 from overstay_charges where receipt_number = v_candidate) then
      return v_candidate;
    end if;
  end loop;
end;
$$;

-- Session is created when a booking is confirmed; a not-yet-started session is cancelled
-- when its booking is cancelled (ported from create_session_on_confirm).
create or replace function create_session_on_confirm()
returns trigger language plpgsql as $$
begin
  if new.status = 'confirmed' and old.status = 'reserved' then
    if not exists (select 1 from parking_sessions where booking_id = new.id) then
      insert into parking_sessions (booking_id, user_id, started_at, booked_end_at, status)
      values (new.id, new.user_id, new.start_at, new.end_at, 'active');
    end if;
  end if;

  if new.status = 'cancelled' then
    update parking_sessions
    set status = 'cancelled', updated_at = now()
    where booking_id = new.id
      and status = 'active'
      and ended_at is null
      and started_at > now();
  end if;
  return new;
end;
$$;

create trigger bookings_create_session
  after update on bookings
  for each row execute function create_session_on_confirm();

-- Every gate scan outcome is stored (audit + idempotency).
create table gate_scans (
  id            uuid primary key default gen_random_uuid(),
  booking_id    uuid references bookings (id) on delete set null,
  token_prefix  text,                       -- first 6 chars of the token only, never the full token
  scanned_by    uuid references users (id) on delete set null,
  direction     text not null check (direction in ('entry', 'exit')),
  gate_id       text,
  result        text not null,              -- ok | already_entered | invalid_token | expired | cancelled | too_early | already_used | not_entered ...
  reason        text,
  created_at    timestamptz not null default now()
);

create index idx_gate_scans_booking on gate_scans (booking_id);
create index idx_gate_scans_created on gate_scans (created_at desc);

-- Down Migration
drop table if exists gate_scans;
drop trigger if exists bookings_create_session on bookings;
drop function if exists create_session_on_confirm();
drop function if exists generate_overstay_receipt_number();
drop table if exists overstay_charges;
drop table if exists parking_sessions;
