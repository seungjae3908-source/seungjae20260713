-- Member access hardening: associate S/AI access support, optional expiry,
-- canonical pending-state normalization, and auditable admin password recovery.
-- This migration does not grant order placement, member administration, backtests,
-- or futures capabilities to associate members.

begin;

-- Production compatibility bootstrap for legacy member schemas. Preserve the
-- existing effective access while materializing the canonical member columns
-- expected by the S/AI access hardening below.
alter table public.profiles
  add column if not exists membership_level text,
  add column if not exists is_active boolean,
  add column if not exists permissions_updated_at timestamptz;

update public.profiles
set membership_level = case
      when status::text = 'suspended' then case
        when membership_level in ('pending', 'associate', 'regular', 'admin') then membership_level
        when role in ('admin', 'master') then 'admin'
        when role = 'associate' then 'associate'
        when role in ('full', 'regular') then 'regular'
        else 'pending'
      end
      when status::text <> 'approved' then 'pending'
      when membership_level in ('pending', 'associate', 'regular', 'admin') then membership_level
      when role in ('admin', 'master') then 'admin'
      when role = 'associate' then 'associate'
      when role in ('full', 'regular') then 'regular'
      else 'regular'
    end,
    is_active = case
      when status::text <> 'approved' then false
      when is_active is false then false
      else true
    end,
    permissions_updated_at = coalesce(permissions_updated_at, updated_at, created_at, now())
where membership_level is null
   or membership_level not in ('pending', 'associate', 'regular', 'admin')
   or is_active is null
   or permissions_updated_at is null
   or (status::text = 'suspended' and is_active is true)
   or (status::text not in ('approved', 'suspended')
       and (membership_level <> 'pending' or is_active is true));

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

create table if not exists public.member_permission_audit (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete restrict,
  target_user_id uuid not null references auth.users(id) on delete cascade,
  action text not null check (action in (
    'member.approve',
    'member.membership.change',
    'member.active.change',
    'member.membership.expiry.change',
    'member.status.change',
    'member.password.reset'
  )),
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
revoke all privileges on table public.member_permission_audit from public, anon, authenticated;
grant select, insert on table public.member_permission_audit to authenticated;


alter table public.profiles
  add column if not exists membership_expires_at timestamptz;

-- A pending member cannot simultaneously be active. Normalize any legacy drift
-- without approving or elevating anyone.
update public.profiles
set is_active = false,
    status = case
      when status is null or status = 'approved' then 'pending'
      else status
    end,
    membership_expires_at = null,
    approved_at = null,
    approved_by = null,
    permissions_updated_at = now(),
    updated_at = now()
where membership_level = 'pending'
  and (
    is_active is true
    or status is null
    or status = 'approved'
    or membership_expires_at is not null
    or approved_at is not null
    or approved_by is not null
  );

create index if not exists profiles_membership_expiry_idx
  on public.profiles (membership_level, membership_expires_at)
  where membership_expires_at is not null;

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
    when p.membership_expires_at is not null and p.membership_expires_at <= now() then 'pending'
    when p.membership_level in ('pending', 'associate', 'regular', 'admin') then p.membership_level
    when p.role in ('admin', 'master') then 'admin'
    when p.role = 'associate' then 'associate'
    when p.role in ('user', 'regular', 'full') then 'regular'
    else 'pending'
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
        and (p.membership_expires_at is null or p.membership_expires_at > now())
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
grant execute on function public.current_membership_level() to authenticated;
grant execute on function public.is_approved_member() to authenticated;


create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select coalesce(public.current_membership_level() = 'admin', false)
$function$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- Trigger/internal SECURITY DEFINER helpers must not be callable through the
-- exposed Data API. Keep only the membership predicates needed by signed-in
-- RLS callers above.
do $member_legacy_definer_acl_hardening$
begin
  if to_regprocedure('public.handle_new_user()') is not null then
    execute 'revoke all on function public.handle_new_user() from public, anon, authenticated';
  end if;
  if to_regprocedure('public.log_profile_change()') is not null then
    execute 'revoke all on function public.log_profile_change() from public, anon, authenticated';
  end if;
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke all on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
  if to_regprocedure('public.is_full_member()') is not null then
    execute 'revoke all on function public.is_full_member() from public, anon';
  end if;
end
$member_legacy_definer_acl_hardening$;

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

revoke update, delete on table public.member_permission_audit from public, anon, authenticated;
grant select, insert on table public.member_permission_audit to authenticated;

-- Privileged profile changes have one auditable path through the SECURITY DEFINER
-- mutation function below. Remove the legacy direct UPDATE route.
drop policy if exists "admins update profiles" on public.profiles;
revoke insert, update, delete on table public.profiles from public, anon, authenticated;


-- Associate members may view only their own journal evidence for trading analytics
-- and AI review. Mutation policies stay unchanged (regular/admin only).
drop policy if exists "paper_journal_entries select own" on public.paper_journal_entries;
create policy "paper_journal_entries select own"
  on public.paper_journal_entries for select
  using (
    auth.uid() = user_id
    and public.current_membership_level() in ('associate', 'regular', 'admin')
  );

alter table public.member_permission_audit
  drop constraint if exists member_permission_audit_action_check;
alter table public.member_permission_audit
  add constraint member_permission_audit_action_check
  check (action in (
    'member.approve',
    'member.membership.change',
    'member.active.change',
    'member.membership.expiry.change',
    'member.status.change',
    'member.password.reset'
  ));

create or replace function public.apply_member_permission_change(
  p_target_user_id uuid,
  p_membership_level text,
  p_is_active boolean,
  p_membership_expires_at timestamptz,
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
  v_current_expiry timestamptz;
  v_next_tier text;
  v_next_active boolean;
  v_next_expiry timestamptz;
  v_next_role text;
  v_next_status public.profiles.status%type;
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

  lock table public.profiles in share row exclusive mode;

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
  v_current_expiry := case when v_current_tier in ('associate', 'regular') then v_current.membership_expires_at else null end;

  v_next_tier := coalesce(p_membership_level, v_current_tier);
  v_next_active := case
    when v_next_tier = 'pending' then false
    else coalesce(p_is_active, v_current_active)
  end;
  v_next_expiry := case
    when v_next_tier in ('pending', 'admin') then null
    else p_membership_expires_at
  end;

  v_next_role := case v_next_tier
    when 'admin' then 'admin'
    when 'associate' then 'associate'
    when 'regular' then 'full'
    else 'pending'
  end;
  v_next_status := case
    when v_next_tier = 'pending' then 'pending'
    when not v_next_active then 'suspended'
    else 'approved'
  end;

  select count(*)::integer
  into v_active_admin_count
  from public.profiles
  where status = 'approved'
    and is_active is true
    and membership_level = 'admin'
    and (membership_expires_at is null or membership_expires_at > v_now);

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
    when v_current_expiry is distinct from v_next_expiry then 'member.membership.expiry.change'
    else 'member.status.change'
  end;

  v_before := jsonb_build_object(
    'membershipLevel', v_current_tier,
    'isActive', v_current_active,
    'membershipExpiresAt', v_current_expiry,
    'role', v_current.role,
    'status', v_current.status
  );
  v_after := jsonb_build_object(
    'membershipLevel', v_next_tier,
    'isActive', v_next_active,
    'membershipExpiresAt', v_next_expiry,
    'role', v_next_role,
    'status', v_next_status
  );

  update public.profiles
  set membership_level = v_next_tier,
      is_active = v_next_active,
      membership_expires_at = v_next_expiry,
      role = v_next_role,
      status = v_next_status,
      approved_at = case
        when v_next_status <> 'approved' then null
        when v_current.status = 'approved' and v_current.approved_at is not null then v_current.approved_at
        else v_now
      end,
      approved_by = case
        when v_next_status <> 'approved' then null
        when v_current.status = 'approved' and v_current.approved_by is not null then v_current.approved_by
        else v_actor_id
      end,
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
      'membership_expires_at', v_updated.membership_expires_at,
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

revoke all on function public.apply_member_permission_change(uuid, text, boolean, timestamptz, text, timestamptz) from public;
grant execute on function public.apply_member_permission_change(uuid, text, boolean, timestamptz, text, timestamptz) to authenticated;

-- Backward-compatible bridge for the immediately preceding Production app.
-- The database hardening is applied before the new app cutover, so keeping the
-- prior five-argument RPC prevents a short-lived old-app/new-schema mismatch
-- and makes a post-QA application rollback safe. Authorization and mutation
-- remain owned by the canonical six-argument SECURITY DEFINER function above.
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
as $legacy_bridge$
declare
  v_current_expiry timestamptz;
begin
  select membership_expires_at
  into v_current_expiry
  from public.profiles
  where id = p_target_user_id;

  return public.apply_member_permission_change(
    p_target_user_id,
    p_membership_level,
    p_is_active,
    v_current_expiry,
    p_reason,
    p_expected_permissions_updated_at
  );
end
$legacy_bridge$;

revoke all on function public.apply_member_permission_change(uuid, text, boolean, text, timestamptz) from public;
grant execute on function public.apply_member_permission_change(uuid, text, boolean, text, timestamptz) to authenticated;

commit;
