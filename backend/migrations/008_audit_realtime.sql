-- Up Migration
-- Admin audit log and realtime change feed (LISTEN/NOTIFY).
-- NOTIFY payloads carry ids and an event type ONLY (no personal data, far below the 8000-byte
-- limit). Postgres delivers NOTIFY after the transaction commits, so listeners never see
-- uncommitted work.

create table admin_audit_log (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid not null references users (id) on delete restrict,
  action       text not null check (length(action) between 1 and 100),
  record_type  text not null check (length(record_type) between 1 and 50),
  record_id    text not null default '',
  reason       text not null default '',
  old_data     jsonb,
  new_data     jsonb,
  created_at   timestamptz not null default now()
);

create index idx_audit_created on admin_audit_log (created_at desc);
create index idx_audit_actor on admin_audit_log (actor_id);

create or replace function notify_event(p_type text, p_payload jsonb)
returns void language plpgsql as $$
begin
  perform pg_notify('parkgrid', (jsonb_build_object('type', p_type) || p_payload)::text);
exception when others then
  null; -- realtime must never break a business transaction
end;
$$;

create or replace function trg_bookings_realtime()
returns trigger language plpgsql as $$
begin
  perform notify_event('availability_changed', jsonb_build_object('slot_id', new.slot_id));
  perform notify_event('booking_changed', jsonb_build_object('user_id', new.user_id, 'booking_id', new.id));
  return new;
end;
$$;

create trigger trg_bookings_realtime
  after insert or update of status, payment_status, start_at, end_at, slot_id on bookings
  for each row execute function trg_bookings_realtime();

create or replace function trg_sessions_realtime()
returns trigger language plpgsql as $$
declare v_slot uuid;
begin
  select slot_id into v_slot from bookings where id = new.booking_id;
  perform notify_event('availability_changed', jsonb_build_object('slot_id', v_slot));
  perform notify_event('session_changed', jsonb_build_object('user_id', new.user_id, 'session_id', new.id));
  return new;
end;
$$;

create trigger trg_sessions_realtime
  after insert or update of status, ended_at, entered_at on parking_sessions
  for each row execute function trg_sessions_realtime();

create or replace function trg_notifications_realtime()
returns trigger language plpgsql as $$
begin
  perform notify_event('notification_created', jsonb_build_object('user_id', new.user_id));
  return new;
end;
$$;

create trigger trg_notifications_realtime
  after insert on notifications
  for each row execute function trg_notifications_realtime();

create or replace function trg_payments_realtime()
returns trigger language plpgsql as $$
begin
  perform notify_event('payment_changed', jsonb_build_object('user_id', new.user_id));
  return new;
end;
$$;

create trigger trg_payments_realtime
  after insert or update of status on payments
  for each row execute function trg_payments_realtime();

create or replace function trg_slots_realtime()
returns trigger language plpgsql as $$
begin
  perform notify_event('availability_changed', jsonb_build_object('slot_id', new.id));
  return new;
end;
$$;

create trigger trg_slots_realtime
  after update of admin_status on parking_slots
  for each row execute function trg_slots_realtime();

-- Down Migration
drop trigger if exists trg_slots_realtime on parking_slots;
drop trigger if exists trg_payments_realtime on payments;
drop trigger if exists trg_notifications_realtime on notifications;
drop trigger if exists trg_sessions_realtime on parking_sessions;
drop trigger if exists trg_bookings_realtime on bookings;
drop function if exists trg_slots_realtime();
drop function if exists trg_payments_realtime();
drop function if exists trg_notifications_realtime();
drop function if exists trg_sessions_realtime();
drop function if exists trg_bookings_realtime();
drop function if exists notify_event(text, jsonb);
drop table if exists admin_audit_log;
