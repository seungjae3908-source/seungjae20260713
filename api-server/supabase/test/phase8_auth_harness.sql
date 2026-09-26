-- Disposable PostgreSQL harness for Phase 8 CI only.
-- It does not connect to or copy data from a Supabase project.

create extension if not exists pgcrypto;

create schema if not exists auth;

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
end
$roles$;

create table if not exists auth.users (
  id uuid primary key,
  email text,
  created_at timestamptz not null default now()
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $function$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$function$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  login_name text not null unique,
  display_name text not null,
  role text not null default 'user' check (role in ('user', 'admin')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'suspended', 'withdrawn')),
  approved_at timestamptz,
  approved_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

grant usage on schema public, auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;

grant select, insert, update, delete on public.profiles to authenticated;
grant select on public.profiles to anon;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'user-a@test.invalid'),
  ('22222222-2222-2222-2222-222222222222', 'user-b@test.invalid'),
  ('33333333-3333-3333-3333-333333333333', 'associate@test.invalid'),
  ('44444444-4444-4444-4444-444444444444', 'pending@test.invalid'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'admin@test.invalid')
on conflict (id) do nothing;

-- The staging bootstrap installs the auth.users profile trigger before these
-- fixtures run. Update trigger-created rows so every CI tier remains exact and
-- deterministic rather than silently keeping the default pending tier.
insert into public.profiles (
  id, login_name, display_name, role, status, membership_level, is_active,
  approved_at, permissions_updated_at
) values
  ('11111111-1111-1111-1111-111111111111', 'user-a', 'User A', 'user', 'approved', 'regular', true, now(), now()),
  ('22222222-2222-2222-2222-222222222222', 'user-b', 'User B', 'user', 'approved', 'regular', true, now(), now()),
  ('33333333-3333-3333-3333-333333333333', 'associate', 'Associate', 'user', 'approved', 'associate', true, now(), now()),
  ('44444444-4444-4444-4444-444444444444', 'pending', 'Pending', 'user', 'pending', 'pending', true, null, now()),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'admin', 'Admin', 'admin', 'approved', 'admin', true, now(), now())
on conflict (id) do update set
  login_name = excluded.login_name,
  display_name = excluded.display_name,
  role = excluded.role,
  status = excluded.status,
  membership_level = excluded.membership_level,
  is_active = excluded.is_active,
  approved_at = excluded.approved_at,
  permissions_updated_at = excluded.permissions_updated_at,
  updated_at = now();
