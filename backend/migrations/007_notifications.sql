-- Up Migration
-- Notifications + the triggers that create them. Pure SQL, so they port unchanged except:
--   * auth.uid()/is_admin() checks removed (ownership is enforced in Express: WHERE user_id = $me)
--   * BUGFIX: overstay triggers referenced overstay_charges.amount_paise (column does not exist,
--     the error was swallowed by `exception when others`, so overstay notifications were never
--     created). They now use total_paise.

create table notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  title       text not null default 'Notification',
  body        text,
  message     text,
  type        text not null default 'info',
  is_read     boolean not null default false,
  read        boolean not null default false,
  metadata    jsonb not null default '{}'::jsonb,
  link        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_notifications_user_created on notifications (user_id, created_at desc);
create index idx_notifications_user_unread on notifications (user_id) where is_read = false;

create or replace function sync_notification_fields()
returns trigger language plpgsql as $$
begin
  if new.title is null or new.title = '' then new.title := 'Notification'; end if;
  if (new.body is null or new.body = '') and new.message is not null then
    new.body := new.message;
  elsif (new.message is null or new.message = '') and new.body is not null then
    new.message := new.body;
  end if;
  if new.is_read is null and new.read is not null then
    new.is_read := new.read;
  elsif new.read is null and new.is_read is not null then
    new.read := new.is_read;
  end if;
  return new;
end;
$$;

create trigger notifications_sync_fields
  before insert or update on notifications
  for each row execute function sync_notification_fields();

create trigger notifications_set_updated_at
  before update on notifications
  for each row execute function set_updated_at();

create or replace function create_notification(
  p_user uuid, p_type text, p_title text, p_body text, p_link text default null
) returns uuid language plpgsql as $$
declare
  v_id uuid;
  v_type text := lower(trim(coalesce(p_type, 'system')));
  v_title text;
  v_body text;
begin
  if p_user is null then return null; end if;
  if v_type not in ('booking', 'payment', 'session', 'system') then v_type := 'system'; end if;
  v_title := substring(trim(coalesce(p_title, 'Notification')) from 1 for 120);
  v_body := substring(trim(coalesce(p_body, '')) from 1 for 500);
  insert into notifications (user_id, type, title, body, message, link, is_read, read)
  values (p_user, v_type, v_title, v_body, v_body, p_link, false, false)
  returning id into v_id;
  return v_id;
exception when others then
  return null;
end;
$$;

create or replace function trg_bookings_notify_state_change()
returns trigger language plpgsql as $$
declare
  v_slot_code text;
  v_ist_time text;
  v_title text;
  v_body text;
  v_refund_text text := '';
begin
  if old.status is not distinct from new.status then return new; end if;
  begin
    if new.status = 'confirmed' then
      select code into v_slot_code from parking_slots where id = new.slot_id;
      v_ist_time := to_char(timezone('Asia/Kolkata', new.start_at), 'DD Mon YYYY, HH12:MI AM');
      perform create_notification(new.user_id, 'booking', 'Booking confirmed',
        'Booking confirmed: slot ' || coalesce(v_slot_code, 'assigned') || ' on ' || v_ist_time || ' IST.', '/bookings');
    elsif new.status = 'cancelled' then
      if new.refund_paise is not null and new.refund_paise > 0 then
        v_refund_text := ' Refund of ₹' || trim(to_char(new.refund_paise / 100.0, '999990.00')) || ' processed.';
      end if;
      if coalesce(new.cancellation_reason, '') ilike '%admin%' then
        v_title := 'Booking cancelled by admin';
        v_body := 'Your booking ' || coalesce(new.reference, '') || ' was cancelled by administrator.' || v_refund_text;
      else
        v_title := 'Booking cancelled';
        v_body := 'Your booking ' || coalesce(new.reference, '') || ' has been cancelled.' || v_refund_text;
      end if;
      perform create_notification(new.user_id, 'booking', v_title, v_body, '/bookings');
    elsif new.status = 'no_show' then
      perform create_notification(new.user_id, 'booking', 'Booking marked as no-show',
        'Your booking ' || coalesce(new.reference, '') || ' was marked as no-show.', '/bookings');
    end if;
  exception when others then
    null;
  end;
  return new;
end;
$$;

create trigger trg_bookings_notify
  after update of status on bookings
  for each row execute function trg_bookings_notify_state_change();

create or replace function trg_payments_notify_state_change()
returns trigger language plpgsql as $$
declare
  v_amount_text text;
begin
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then return new; end if;
  begin
    v_amount_text := trim(to_char(new.amount_paise / 100.0, '999990.00'));
    if new.status = 'succeeded' then
      perform create_notification(new.user_id, 'payment', 'Payment successful',
        'Payment of ₹' || v_amount_text || ' received (Receipt: ' || coalesce(new.receipt_number, new.id::text) || ').', '/bookings');
    elsif new.status = 'failed' then
      perform create_notification(new.user_id, 'payment', 'Payment failed',
        'Payment of ₹' || v_amount_text || ' failed: ' || coalesce(new.failure_reason, 'Transaction declined'), '/bookings');
    end if;
  exception when others then
    null;
  end;
  return new;
end;
$$;

create trigger trg_payments_notify
  after insert or update of status on payments
  for each row execute function trg_payments_notify_state_change();

create or replace function trg_parking_sessions_notify_state_change()
returns trigger language plpgsql as $$
declare
  v_overstay_paise bigint := 0;
  v_overstay_text text := '';
begin
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then return new; end if;
  begin
    if (tg_op = 'INSERT' and new.status = 'active') or
       (tg_op = 'UPDATE' and old.status <> 'active' and new.status = 'active') then
      perform create_notification(new.user_id, 'session', 'Parking started', 'Your parking session has started.', '/bookings');
    elsif tg_op = 'UPDATE' and old.status = 'active' and new.status in ('completed', 'auto_ended') then
      select coalesce(sum(total_paise), 0) into v_overstay_paise from overstay_charges where session_id = new.id;
      if v_overstay_paise > 0 then
        v_overstay_text := ' Overstay charge: ₹' || trim(to_char(v_overstay_paise / 100.0, '999990.00')) || '.';
      end if;
      perform create_notification(new.user_id, 'session', 'Parking ended',
        'Your parking session has ended. Duration: ' || coalesce(new.duration_minutes::text, '0') || ' mins.' || v_overstay_text, '/bookings');
    end if;
  exception when others then
    null;
  end;
  return new;
end;
$$;

create trigger trg_parking_sessions_notify
  after insert or update of status on parking_sessions
  for each row execute function trg_parking_sessions_notify_state_change();

create or replace function trg_overstay_charges_notify()
returns trigger language plpgsql as $$
declare
  v_user_id uuid;
begin
  begin
    select user_id into v_user_id from parking_sessions where id = new.session_id;
    if v_user_id is not null then
      perform create_notification(v_user_id, 'session', 'Overstay charge applied',
        'An overstay charge of ₹' || trim(to_char(new.total_paise / 100.0, '999990.00')) ||
        ' was applied for ' || coalesce(new.overstay_minutes::text, '0') || ' minutes.', '/bookings');
    end if;
  exception when others then
    null;
  end;
  return new;
end;
$$;

create trigger trg_overstay_charges_notify
  after insert on overstay_charges
  for each row execute function trg_overstay_charges_notify();

-- Down Migration
drop trigger if exists trg_overstay_charges_notify on overstay_charges;
drop trigger if exists trg_parking_sessions_notify on parking_sessions;
drop trigger if exists trg_payments_notify on payments;
drop trigger if exists trg_bookings_notify on bookings;
drop function if exists trg_overstay_charges_notify();
drop function if exists trg_parking_sessions_notify_state_change();
drop function if exists trg_payments_notify_state_change();
drop function if exists trg_bookings_notify_state_change();
drop function if exists create_notification(uuid, text, text, text, text);
drop table if exists notifications;
drop function if exists sync_notification_fields();
