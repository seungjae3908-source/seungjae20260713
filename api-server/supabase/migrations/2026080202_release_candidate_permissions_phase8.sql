-- Phase 8 release-candidate member permissions and audit storage.
-- Review/CI only in this phase. Do not apply to the production database.

begin;

create extension if not exists pgcrypto;

do $phase8_profiles_required$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'Phase 8 migration requires public.profiles';
  end if;
end
$phase8_profiles_required$;

alter table public.profiles
  add column if not exists membership_level text,
  add column if not exists is_active boolean not null default true,
  add column if not exists permissions_updated_at timestamptz not null default now();

-- Preserve compatibility with the current user/admin + status model.
-- Existing approved users become regular members; existing admins stay admins.
update public.profiles
set membership_level = case
  when role = 'admin' and coalesce(status, 'approved') = 'approved' then 'admin'
  when coalesce(status, 'pending') = 'approved' then 'regular'
  else 'pending'
end
where membership_level is null
   or membership_level not in ('pending', 'associate', 'regular', 'admin');

alter table public.profiles
  alter column membership_level set default 'pending',
  alter column membership_level set not null;

do $phase8_membership_constraint$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_membership_level_check'
  ) then
    alter table public.profiles
      add constraint profiles_membership_level_check
      check (membership_level in ('pending', 'associate', 'regular', 'admin'));
  end if;
end
$phase8_membership_constraint$;

create index if not exists profiles_membership_active_idx
  on public.profiles (membership_level, is_active, permissions_updated_at desc);

-- Security-definer helper avoids recursive profiles RLS checks while using
-- only the authenticated user's database profile as the authority.
create or replace function public.current_membership_level()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select case
    when p.is_active is not true then 'pending'
    when p.membership_level in ('pending', 'associate', 'regular', 'admin') then p.membership_level
    when p.role = 'admin' and p.status = 'approved' then 'admin'
    when p.status = 'approved' then 'regular'
    else 'pending'
  end
  from public.profiles p
  where p.id = auth.uid()
  limit 1
$function$;

revoke all on function public.current_membership_level() from public;
grant execute on function public.current_membership_level() to anon, authenticated;

alter table public.profiles enable row level security;

drop policy if exists "profiles phase8 select own" on public.profiles;
create policy "profiles phase8 select own"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "profiles phase8 admins select" on public.profiles;
create policy "profiles phase8 admins select"
  on public.profiles for select
  using (public.current_membership_level() = 'admin');

drop policy if exists "profiles phase8 admins update" on public.profiles;
create policy "profiles phase8 admins update"
  on public.profiles for update
  using (public.current_membership_level() = 'admin')
  with check (public.current_membership_level() = 'admin');

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
  with check (
    public.current_membership_level() = 'admin'
    and auth.uid() = actor_id
  );

-- No policy grants admins access to paper_* rows or original journal notes.

commit;
