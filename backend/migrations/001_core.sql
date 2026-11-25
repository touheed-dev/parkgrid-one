-- Up Migration
-- Core: extensions, shared helpers, users/profiles, auth token tables.
-- Ported from supabase profiles migration. Supabase-only parts (auth.users, auth.uid(),
-- RLS, grants, realtime publication) are removed: authorisation now lives in Express.

create extension if not exists pgcrypto;
create extension if not exists btree_gist;
create extension if not exists citext;
create extension if not exists vector;

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create table users (
  id                  uuid primary key default gen_random_uuid(),
  email               citext not null unique,
  password_hash       text not null,
  email_verified_at   timestamptz,
  last_sign_in_at     timestamptz,
  disabled_at         timestamptz,
  failed_login_count  int not null default 0,
  locked_until        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create trigger users_set_updated_at
  before update on users
  for each row execute function set_updated_at();

create table profiles (
  id          uuid primary key references users (id) on delete cascade,
  full_name   text,
  phone       text,
  avatar_url  text,
  role        text not null default 'member' check (role in ('member', 'admin', 'staff')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_profiles_role on profiles (role);

create trigger profiles_set_updated_at
  before update on profiles
  for each row execute function set_updated_at();

-- Refresh tokens are stored hashed (sha-256). family_id groups a rotation chain so that
-- replay of an already-rotated token can revoke the whole family (reuse detection).
create table refresh_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users (id) on delete cascade,
  family_id    uuid not null,
  token_hash   text not null unique,
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  replaced_by  uuid references refresh_tokens (id) on delete set null,
  user_agent   text,
  ip           text,
  created_at   timestamptz not null default now()
);

create index idx_refresh_tokens_user on refresh_tokens (user_id);
create index idx_refresh_tokens_family on refresh_tokens (family_id);

create table password_reset_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index idx_password_reset_user on password_reset_tokens (user_id);

-- Down Migration
drop table if exists password_reset_tokens;
drop table if exists refresh_tokens;
drop table if exists profiles;
drop table if exists users;
drop function if exists set_updated_at();
