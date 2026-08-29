-- Reconcile the legacy Production profiles schema with the canonical member-management API.
-- This migration preserves existing effective access and never auto-approves or elevates a member.

begin;

create extension if not exists pgcrypto;

do $profiles_required$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'member-management reconcile requires public.profiles';
  end if;
end
$profiles_required$;

alter table public.profiles
  add column if not exists login_name text,
  add column if not exists membership_level text,
  add column if not exists is_active boolean,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid,
  add column if not exists permissions_updated_at timestamptz;

-- Preserve the legacy effective tier exactly:
-- * unapproved rows remain pending/inactive, including legacy admin-role rows;
-- * approved associate stays associate;
-- * approved full/regular stays regular;
-- * only an already-approved legacy admin/master remains admin.
-- If canonical fields already exist, preserve a valid tier and an explicit
-- is_active=false instead of widening access during an idempotent re-run.
update public.profiles
set membership_level = case
      when coalesce(status, 'pending') <> 'approved' then 'pending'
      when membership_level in ('pending', 'associate', 'regular', 'admin') then membership_level
      when role in ('admin', 'master') then 'admin'
      when role = 'associate' then 'associate'
      when role in ('full', 'regular') then 'regular'
      else 'regular'
    end,
    is_active = case
      when coalesce(status, 'pending') <> 'approved' then false
      when is_active is false then false
      else true
    end,
    approved_at = case
      when coalesce(status, 'pending') = 'approved' then coalesce(approved_at, updated_at, created_at)
      else null
    end,
    permissions_updated_at = coalesce(permissions_updated_at, updated_at, created_at, now())
where membership_level is null
   or membership_level not in ('pending', 'associate', 'regular', 'admin')
   or is_active is null
   or permissions_updated_at is null
   or (
     coalesce(status, 'pending') <> 'approved'
     and (membership_level <> 'pending' or is_active is true)
   );

alter table public.profiles
  alter column membership_level set default 'pending',
  alter column membership_level set not null,
  alter column is_active set default false,
  alter column is_active set not null,
  alter column permissions_updated_at set default now(),
  alter column permissions_updated_at set not null;

alter table public.profiles drop constraint if exists profiles_membership_level_check;
alter table public.profiles
  add constraint profiles_membership_level_check
  check (membership_level in ('pending', 'associate', 'regular', 'admin'));

-- Canonical member administration uses suspended for an explicitly disabled member.
-- Keep every known non-approved legacy state so reconciliation cannot narrow access-state history.
alter table public.profiles drop constraint if exists profiles_status_check;
alter table public.profiles
  add constraint profiles_status_check
  check (status in ('pending', 'approved', 'rejected', 'suspended', 'revoked', 'disabled'));

create index if not exists profiles_membership_active_idx
  on public.profiles (membership_level, is_active, permissions_updated_at desc);

create or replace function public.current_membership_level()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select case
    when coalesce(p.status, 'pending') <> 'approved' then 'pending'
    when p.is_active is not true then 'pending'
    when p.membership_level in ('pending', 'associate', 'regular', 'admin') then p.membership_level
    when p.role in ('admin', 'master') then 'admin'
    when p.role = 'associate' then 'associate'
    else 'regular'
  end
  from public.profiles p
  where p.id = auth.uid()
  limit 1
$function$;

create or replace function public.is_approved_member()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select coalesce(
    (
      select p.status = 'approved'
        and p.is_active is true
        and p.membership_level in ('associate', 'regular', 'admin')
      from public.profiles p
      where p.id = auth.uid()
      limit 1
    ),
    false
  )
$function$;

revoke all on function public.current_membership_level() from public;
revoke all on function public.is_approved_member() from public;
grant execute on function public.current_membership_level() to anon, authenticated;
grant execute on function public.is_approved_member() to anon, authenticated;

create table if not exists public.member_permission_audit (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete restrict,
  target_user_id uuid not null references auth.users(id) on delete cascade,
  action text not null check (action in ('member.approve', 'member.membership.change', 'member.active.change', 'member.status.change')),
  before_value jsonb not null default '{}'::jsonb,
  after_value jsonb not null default '{}'::jsonb,
  reason text not null check (char_length(reason) between 3 and 500),
  created_at timestamptz not null default now()
);

create index if not exists member_permission_audit_target_idx
  on public.member_permission_audit (target_user_id, created_at desc);
create index if not exists member_permission_audit_actor_idx
  on public.member_permission_audit (actor_id, created_at desc);

alter table public.member_permission_audit enable row level security;

drop policy if exists "member audit admins select" on public.member_permission_audit;
create policy "member audit admins select"
  on public.member_permission_audit for select
  using (public.current_membership_level() = 'admin');

drop policy if exists "member audit admins insert" on public.member_permission_audit;
create policy "member audit admins insert"
  on public.member_permission_audit for insert
  with check (public.current_membership_level() = 'admin' and auth.uid() = actor_id);

grant select, insert on table public.member_permission_audit to authenticated;

commit;
