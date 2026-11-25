-- Up Migration
-- Payments ledger (Razorpay + mock), refunds, webhook inbox.
-- Changes vs. the Supabase original:
--   * status gains 'created' (a Razorpay order exists but is not paid yet)
--   * method is nullable until the gateway tells us what the customer used
--   * provider_order_id / provider_signature added; provider_ref holds the gateway payment id

create table payments (
  id                 uuid primary key default gen_random_uuid(),
  booking_id         uuid not null references bookings (id) on delete restrict,
  user_id            uuid not null references users (id) on delete restrict,
  provider           text not null default 'mock',
  provider_ref       text,
  provider_order_id  text,
  provider_signature text,
  method             text check (method is null or method in ('upi', 'card', 'netbanking', 'wallet')),
  amount_paise       int not null check (amount_paise > 0),
  base_paise         int not null check (base_paise >= 0),
  gst_paise          int not null check (gst_paise >= 0),
  currency           text not null default 'INR',
  status             text not null check (status in ('created', 'succeeded', 'failed', 'refunded', 'partially_refunded')),
  failure_reason     text,
  receipt_number     text unique,
  idempotency_key    text not null unique,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- A booking may have at most one successful/active payment.
create unique index idx_payments_booking_succeeded
  on payments (booking_id)
  where (status in ('succeeded', 'refunded', 'partially_refunded'));

create unique index idx_payments_provider_order on payments (provider_order_id) where provider_order_id is not null;
create unique index idx_payments_provider_ref on payments (provider_ref) where provider_ref is not null;
create index idx_payments_user_created on payments (user_id, created_at desc);
create index idx_payments_booking_id on payments (booking_id);
create index idx_payments_status on payments (status);
create index idx_payments_created_at on payments (created_at desc);

create table payment_refunds (
  id                   uuid primary key default gen_random_uuid(),
  payment_id           uuid not null references payments (id) on delete restrict,
  booking_id           uuid not null references bookings (id) on delete restrict,
  amount_paise         int not null check (amount_paise > 0),
  reason               text,
  provider_refund_id   text unique,
  status               text not null default 'processed' check (status in ('pending', 'processed', 'failed')),
  created_at           timestamptz not null default now()
);

create index idx_payment_refunds_payment_id on payment_refunds (payment_id);
create index idx_payment_refunds_booking_id on payment_refunds (booking_id);

create or replace function protect_payment_immutability()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.id <> old.id or
       new.booking_id <> old.booking_id or
       new.user_id <> old.user_id or
       new.amount_paise <> old.amount_paise or
       new.base_paise <> old.base_paise or
       new.gst_paise <> old.gst_paise or
       new.currency <> old.currency or
       new.idempotency_key <> old.idempotency_key or
       new.created_at <> old.created_at then
      raise exception 'Payment financial values and identities are immutable' using errcode = '42501';
    end if;

    if old.status = 'succeeded' and new.status not in ('succeeded', 'refunded', 'partially_refunded') then
      raise exception 'Illegal payment status transition from % to %', old.status, new.status using errcode = 'P0001';
    end if;

    if old.status in ('refunded', 'failed') and new.status <> old.status then
      raise exception 'Final payment status % cannot be modified', old.status using errcode = 'P0001';
    end if;

    new.updated_at := now();
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'Payment records cannot be deleted' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger payments_protect_immutability
  before update or delete on payments
  for each row execute function protect_payment_immutability();

-- Refunds are append-only except for the gateway status fields.
create or replace function protect_refund_immutability()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Payment refund records cannot be deleted' using errcode = '42501';
  end if;
  if new.id <> old.id or new.payment_id <> old.payment_id or new.booking_id <> old.booking_id
     or new.amount_paise <> old.amount_paise or new.created_at <> old.created_at then
    raise exception 'Payment refund amounts and identities are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger payment_refunds_protect_immutability
  before update or delete on payment_refunds
  for each row execute function protect_refund_immutability();

-- Receipt numbers: RC-YYYYMMDD-XXXX (IST date + 4 Crockford base32 chars).
create or replace function generate_receipt_number()
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
      raise exception 'Failed to generate a unique receipt number after 100 attempts' using errcode = 'P0001';
    end if;
    v_random := '';
    for v_i in 1..4 loop
      v_random := v_random || substr(v_chars, floor(random() * length(v_chars) + 1)::int, 1);
    end loop;
    v_candidate := 'RC-' || v_date || '-' || v_random;
    if not exists (select 1 from payments where receipt_number = v_candidate) then
      return v_candidate;
    end if;
  end loop;
end;
$$;

-- Inbox for gateway webhooks. event_id is unique -> replays are detected and ignored.
create table webhook_events (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null,
  event_id      text not null,
  event_type    text not null,
  payload       jsonb not null,
  processed_at  timestamptz,
  error         text,
  created_at    timestamptz not null default now(),
  constraint webhook_events_provider_event_key unique (provider, event_id)
);

-- Down Migration
drop table if exists webhook_events;
drop function if exists generate_receipt_number();
drop table if exists payment_refunds;
drop function if exists protect_refund_immutability();
drop table if exists payments;
drop function if exists protect_payment_immutability();
