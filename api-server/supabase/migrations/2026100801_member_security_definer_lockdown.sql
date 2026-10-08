-- Member SECURITY DEFINER privilege lockdown.
-- Preserve only the currently required RLS helper execution while removing
-- broad PUBLIC defaults and preventing direct application-role calls to
-- trigger-only or obsolete legacy functions. No member rows or trading data are changed.

begin;

-- Profiles are read directly by authenticated clients under RLS, but every
-- mutation is server/admin mediated. Remove legacy broad Data API table grants,
-- including TRUNCATE (which RLS does not constrain), and keep SELECT only.
revoke all privileges on table public.profiles from public, anon, authenticated;
grant select on table public.profiles to authenticated;

-- Permission audit rows are immutable application evidence. The browser may
-- read them under admin RLS, but no authenticated client may forge audit rows
-- directly through the Data API. Password-reset authorization gets one
-- narrowly-scoped, validated RPC below.
drop policy if exists "member audit admins insert" on public.member_permission_audit;
revoke insert, update, delete, truncate, references, trigger
  on table public.member_permission_audit from public, anon, authenticated;
grant select on table public.member_permission_audit to authenticated;

create or replace function public.record_member_password_reset_authorization(
  p_target_user_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_audit_id uuid;
begin
  if v_actor_id is null or public.current_membership_level() is distinct from 'admin' then
    raise exception using errcode = 'P0001', message = 'MEMBER_ADMIN_REQUIRED';
  end if;
  if p_target_user_id is null or not exists (
    select 1 from public.profiles where id = p_target_user_id
  ) then
    raise exception using errcode = 'P0001', message = 'MEMBER_NOT_FOUND';
  end if;
  if char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception using errcode = 'P0001', message = 'CHANGE_REASON_REQUIRED';
  end if;

  insert into public.member_permission_audit (
    actor_id, target_user_id, action, before_value, after_value, reason
  ) values (
    v_actor_id,
    p_target_user_id,
    'member.password.reset',
    '{"password":"REDACTED"}'::jsonb,
    '{"resetAuthorized":true,"credentialStored":false}'::jsonb,
    v_reason
  )
  returning id into v_audit_id;

  return jsonb_build_object(
    'auditId', v_audit_id,
    'action', 'member.password.reset',
    'actorId', v_actor_id,
    'targetUserId', p_target_user_id,
    'resetAuthorized', true,
    'credentialStored', false
  );
end
$function$;

revoke all on function public.record_member_password_reset_authorization(uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_member_password_reset_authorization(uuid, text)
  to authenticated;

do $member_security_definer_lockdown$
declare
  helper text;
  trigger_only text;
begin
  foreach helper in array array[
    'public.current_membership_level()',
    'public.is_approved_member()',
    'public.is_admin()'
  ]
  loop
    if to_regprocedure(helper) is not null then
      execute format('revoke all on function %s from public, anon, authenticated', helper);
      execute format('grant execute on function %s to authenticated', helper);
    end if;
  end loop;

  foreach trigger_only in array array[
    'public.handle_new_user()',
    'public.log_profile_change()',
    'public.rls_auto_enable()',
    'public.is_full_member()'
  ]
  loop
    if to_regprocedure(trigger_only) is not null then
      execute format('revoke all on function %s from public, anon, authenticated', trigger_only);
    end if;
  end loop;

  if to_regprocedure('public.apply_member_permission_change(uuid,text,boolean,timestamptz,text,timestamptz)') is not null then
    revoke all on function public.apply_member_permission_change(
      uuid, text, boolean, timestamptz, text, timestamptz
    ) from public, anon, authenticated;
    grant execute on function public.apply_member_permission_change(
      uuid, text, boolean, timestamptz, text, timestamptz
    ) to authenticated;
  end if;
end
$member_security_definer_lockdown$;

do $member_security_definer_lockdown_verify$
begin
  if exists (
    select 1 from information_schema.table_privileges
    where table_schema = 'public'
      and table_name = 'member_permission_audit'
      and grantee in ('PUBLIC','anon')
  ) or exists (
    select 1 from information_schema.table_privileges
    where table_schema = 'public'
      and table_name = 'member_permission_audit'
      and grantee = 'authenticated'
      and privilege_type <> 'SELECT'
  ) or not exists (
    select 1 from information_schema.table_privileges
    where table_schema = 'public'
      and table_name = 'member_permission_audit'
      and grantee = 'authenticated'
      and privilege_type = 'SELECT'
  ) then
    raise exception 'MEMBER_AUDIT_TABLE_PRIVILEGE_INVALID';
  end if;

  if exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'member_permission_audit'
      and cmd = 'INSERT'
  ) then
    raise exception 'MEMBER_AUDIT_DIRECT_INSERT_POLICY_PRESENT';
  end if;

  if to_regprocedure('public.record_member_password_reset_authorization(uuid,text)') is null then
    raise exception 'MEMBER_PASSWORD_RESET_AUDIT_RPC_MISSING';
  end if;

  if exists (
    select 1 from information_schema.routine_privileges
    where specific_schema = 'public'
      and routine_name = 'record_member_password_reset_authorization'
      and grantee in ('PUBLIC','anon')
      and privilege_type = 'EXECUTE'
  ) or not exists (
    select 1 from information_schema.routine_privileges
    where specific_schema = 'public'
      and routine_name = 'record_member_password_reset_authorization'
      and grantee = 'authenticated'
      and privilege_type = 'EXECUTE'
  ) then
    raise exception 'MEMBER_PASSWORD_RESET_AUDIT_RPC_PRIVILEGE_INVALID';
  end if;

  if exists (
    select 1
    from information_schema.table_privileges
    where table_schema = 'public'
      and table_name = 'profiles'
      and grantee in ('PUBLIC', 'anon')
  ) then
    raise exception 'MEMBER_PROFILE_PUBLIC_OR_ANON_PRIVILEGE_PRESENT';
  end if;

  if exists (
    select 1
    from information_schema.table_privileges
    where table_schema = 'public'
      and table_name = 'profiles'
      and grantee = 'authenticated'
      and privilege_type <> 'SELECT'
  ) or not exists (
    select 1
    from information_schema.table_privileges
    where table_schema = 'public'
      and table_name = 'profiles'
      and grantee = 'authenticated'
      and privilege_type = 'SELECT'
  ) then
    raise exception 'MEMBER_PROFILE_AUTHENTICATED_PRIVILEGE_INVALID';
  end if;

  if exists (
    select 1
    from information_schema.routine_privileges
    where specific_schema = 'public'
      and routine_name in ('handle_new_user', 'log_profile_change', 'rls_auto_enable', 'is_full_member')
      and grantee in ('PUBLIC', 'anon', 'authenticated')
      and privilege_type = 'EXECUTE'
  ) then
    raise exception 'MEMBER_TRIGGER_SECURITY_DEFINER_DIRECT_EXECUTE_PRESENT';
  end if;

  if exists (
    select 1
    from information_schema.routine_privileges
    where specific_schema = 'public'
      and routine_name in (
        'current_membership_level',
        'is_approved_member',
        'is_admin'
      )
      and grantee in ('PUBLIC', 'anon')
      and privilege_type = 'EXECUTE'
  ) then
    raise exception 'MEMBER_RLS_HELPER_PUBLIC_EXECUTE_PRESENT';
  end if;

  if exists (
    select 1
    from information_schema.routine_privileges
    where specific_schema = 'public'
      and routine_name = 'apply_member_permission_change'
      and grantee in ('PUBLIC', 'anon')
      and privilege_type = 'EXECUTE'
  ) or not exists (
    select 1
    from information_schema.routine_privileges
    where specific_schema = 'public'
      and routine_name = 'apply_member_permission_change'
      and grantee = 'authenticated'
      and privilege_type = 'EXECUTE'
  ) then
    raise exception 'MEMBER_PERMISSION_RPC_EXECUTE_PRIVILEGE_INVALID';
  end if;

  if exists (
    select required.routine_name
    from (
      values
        ('current_membership_level'),
        ('is_approved_member'),
        ('is_admin')
    ) as required(routine_name)
    where to_regprocedure('public.' || required.routine_name || '()') is not null
      and (
        not exists (
          select 1 from information_schema.routine_privileges p
          where p.specific_schema = 'public'
            and p.routine_name = required.routine_name
            and p.grantee = 'authenticated'
            and p.privilege_type = 'EXECUTE'
        )
      )
  ) then
    raise exception 'MEMBER_RLS_HELPER_AUTHENTICATED_EXECUTE_MISSING';
  end if;
end
$member_security_definer_lockdown_verify$;

commit;
