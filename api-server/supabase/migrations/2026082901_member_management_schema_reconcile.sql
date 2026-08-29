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
-- * pending/rejected/revoked/withdrawn/disabled/inactive rows stay pending/inactive;
-- * suspended rows stay inactive but preserve their last stored tier so an explicit
--   administration reactivation can restore the pre-suspension tier;
-- * approved associate stays associate;
-- * approved full/regular stays regular;
-- * only an already-approved legacy admin/master remains admin.
-- If canonical fields already exist, preserve a valid tier and an explicit
-- is_active=false instead of widening access during an idempotent re-run.
update public.profiles
set membership_level = case
      when coalesce(status, 'pending') = 'suspended' then case
        when membership_level in ('pending', 'associate', 'regular', 'admin') then membership_level
        when role in ('admin', 'master') then 'admin'
        when role = 'associate' then 'associate'
        when role in ('full', 'regular') then 'regular'
        else 'pending'
      end
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
     coalesce(status, 'pending') = 'suspended'
     and is_active is true
   )
   or (
     coalesce(status, 'pending') not in ('approved', 'suspended')
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
  check (status in ('pending', 'approved', 'rejected', 'suspended', 'revoked', 'withdrawn', 'disabled', 'inactive'));

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

-- Audit rows are authoritative records produced only by the atomic privileged
-- mutation below. Authenticated clients cannot inject standalone audit rows.
drop policy if exists "member audit admins insert" on public.member_permission_audit;
revoke insert on table public.member_permission_audit from authenticated;
grant select on table public.member_permission_audit to authenticated;

create or replace function public.apply_member_permission_change(
  p_target_user_id uuid,
  p_membership_level text,
  p_is_active boolean,
  p_reason text,
  p_expected_permissions_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id uuid := auth.uid();
  v_current public.profiles%rowtype;
  v_updated public.profiles%rowtype;
  v_current_tier text;
  v_current_active boolean;
  v_next_tier text;
  v_next_active boolean;
  v_next_role text;
  v_next_status text;
  v_action text;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_active_admin_count integer;
  v_now timestamptz := clock_timestamp();
  v_before jsonb;
  v_after jsonb;
begin
  if v_actor_id is null then
    raise exception using errcode = 'P0001', message = 'MEMBER_ADMIN_REQUIRED';
  end if;
  if p_target_user_id is null then
    raise exception using errcode = 'P0001', message = 'MEMBER_NOT_FOUND';
  end if;
  if p_membership_level is not null
     and p_membership_level not in ('pending', 'associate', 'regular', 'admin') then
    raise exception using errcode = 'P0001', message = 'INVALID_MEMBER_CHANGE';
  end if;
  if char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception using errcode = 'P0001', message = 'CHANGE_REASON_REQUIRED';
  end if;

  -- Privileged member mutations are rare. Serializing them prevents two concurrent
  -- admin demotions from each observing a safe pre-change admin count.
  lock table public.profiles in share row exclusive mode;

  -- Recheck authority after taking the serialization lock. The route-level admin
  -- check is defense-in-depth only; the database remains authoritative.
  if public.current_membership_level() is distinct from 'admin' then
    raise exception using errcode = 'P0001', message = 'MEMBER_ADMIN_REQUIRED';
  end if;

  select *
  into v_current
  from public.profiles
  where id = p_target_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'MEMBER_NOT_FOUND';
  end if;

  if v_current.permissions_updated_at is distinct from p_expected_permissions_updated_at then
    raise exception using errcode = 'P0001', message = 'MEMBER_STATE_CONFLICT';
  end if;

  -- Match the application fail-closed contract exactly. Only approved/suspended
  -- rows may preserve a stored tier; every other state starts from pending.
  v_current_tier := case
    when v_current.status not in ('approved', 'suspended') or v_current.status is null then 'pending'
    when v_current.membership_level in ('pending', 'associate', 'regular', 'admin') then v_current.membership_level
    when v_current.status = 'suspended' and v_current.role in ('admin', 'master') then 'admin'
    when v_current.status = 'suspended' and v_current.role = 'associate' then 'associate'
    when v_current.status = 'suspended' and v_current.role in ('full', 'regular') then 'regular'
    when v_current.status = 'suspended' then 'pending'
    when v_current.role in ('admin', 'master') then 'admin'
    when v_current.role = 'associate' then 'associate'
    when v_current.role in ('full', 'regular') then 'regular'
    else 'regular'
  end;
  v_current_active := v_current.is_active is true;
  v_next_tier := coalesce(p_membership_level, v_current_tier);
  v_next_active := coalesce(p_is_active, v_current_active);

  v_next_role := case v_next_tier
    when 'admin' then 'admin'
    when 'associate' then 'associate'
    when 'regular' then 'full'
    else 'pending'
  end;
  v_next_status := case
    when not v_next_active then 'suspended'
    when v_next_tier = 'pending' then 'pending'
    else 'approved'
  end;

  select count(*)::integer
  into v_active_admin_count
  from public.profiles
  where status = 'approved'
    and is_active is true
    and membership_level = 'admin';

  if v_current.status = 'approved'
     and v_current_active
     and v_current_tier = 'admin'
     and (v_next_tier <> 'admin' or not v_next_active)
     and v_active_admin_count <= 1 then
    raise exception using errcode = 'P0001', message = 'LAST_ACTIVE_ADMIN_PROTECTED';
  end if;

  v_action := case
    when v_current_tier = 'pending' and v_next_tier = 'associate' and v_next_active then 'member.approve'
    when v_current_tier <> v_next_tier then 'member.membership.change'
    when v_current_active is distinct from v_next_active then 'member.active.change'
    else 'member.status.change'
  end;

  v_before := jsonb_build_object(
    'membershipLevel', v_current_tier,
    'isActive', v_current_active,
    'role', v_current.role,
    'status', v_current.status
  );
  v_after := jsonb_build_object(
    'membershipLevel', v_next_tier,
    'isActive', v_next_active,
    'role', v_next_role,
    'status', v_next_status
  );

  update public.profiles
  set membership_level = v_next_tier,
      is_active = v_next_active,
      role = v_next_role,
      status = v_next_status,
      approved_at = case when v_next_status = 'approved' then v_now else null end,
      approved_by = case when v_next_status = 'approved' then v_actor_id else null end,
      permissions_updated_at = v_now,
      updated_at = v_now
  where id = p_target_user_id
  returning * into v_updated;

  insert into public.member_permission_audit (
    actor_id,
    target_user_id,
    action,
    before_value,
    after_value,
    reason,
    created_at
  ) values (
    v_actor_id,
    p_target_user_id,
    v_action,
    v_before,
    v_after,
    v_reason,
    v_now
  );

  return jsonb_build_object(
    'member', jsonb_build_object(
      'id', v_updated.id,
      'login_name', v_updated.login_name,
      'display_name', v_updated.display_name,
      'membership_level', v_updated.membership_level,
      'is_active', v_updated.is_active,
      'status', v_updated.status,
      'role', v_updated.role,
      'approved_at', v_updated.approved_at,
      'approved_by', v_updated.approved_by,
      'created_at', v_updated.created_at,
      'updated_at', v_updated.updated_at,
      'permissions_updated_at', v_updated.permissions_updated_at
    ),
    'audit', jsonb_build_object(
      'action', v_action,
      'targetUserId', p_target_user_id,
      'actorId', v_actor_id,
      'beforeValue', v_before,
      'afterValue', v_after,
      'reason', v_reason
    )
  );
end
$function$;

revoke all on function public.apply_member_permission_change(uuid, text, boolean, text, timestamptz) from public;
grant execute on function public.apply_member_permission_change(uuid, text, boolean, text, timestamptz) to authenticated;

-- Privileged profile changes must not have a second PostgREST path. The legacy
-- policy allowed an approved admin JWT to UPDATE profiles directly, bypassing the
-- serialized last-admin invariant and the mandatory member_permission_audit row.
-- New-user profile creation remains the SECURITY DEFINER auth trigger path and the
-- atomic function above continues to update as its owner.
drop policy if exists "admins update profiles" on public.profiles;
revoke insert, update, delete on table public.profiles from public, anon, authenticated;

commit;
