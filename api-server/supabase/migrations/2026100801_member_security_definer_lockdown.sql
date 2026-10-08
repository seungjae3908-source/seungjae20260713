-- Member SECURITY DEFINER privilege lockdown.
-- Preserve RLS helper execution for anon/authenticated while removing broad
-- PUBLIC defaults and preventing direct application-role calls to trigger-only
-- functions. No member rows or trading data are changed.

begin;

do $member_security_definer_lockdown$
declare
  helper text;
  trigger_only text;
begin
  foreach helper in array array[
    'public.current_membership_level()',
    'public.is_approved_member()',
    'public.is_admin()',
    'public.is_full_member()'
  ]
  loop
    if to_regprocedure(helper) is not null then
      execute format('revoke all on function %s from public', helper);
      execute format('grant execute on function %s to anon, authenticated', helper);
    end if;
  end loop;

  foreach trigger_only in array array[
    'public.handle_new_user()',
    'public.log_profile_change()',
    'public.rls_auto_enable()'
  ]
  loop
    if to_regprocedure(trigger_only) is not null then
      execute format('revoke all on function %s from public, anon, authenticated', trigger_only);
    end if;
  end loop;

  if to_regprocedure('public.apply_member_permission_change(uuid,text,boolean,timestamptz,text,timestamptz)') is not null then
    revoke all on function public.apply_member_permission_change(
      uuid, text, boolean, timestamptz, text, timestamptz
    ) from public;
    grant execute on function public.apply_member_permission_change(
      uuid, text, boolean, timestamptz, text, timestamptz
    ) to authenticated;
  end if;
end
$member_security_definer_lockdown$;

do $member_security_definer_lockdown_verify$
begin
  if exists (
    select 1
    from information_schema.routine_privileges
    where specific_schema = 'public'
      and routine_name in ('handle_new_user', 'log_profile_change', 'rls_auto_enable')
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
        'is_admin',
        'is_full_member'
      )
      and grantee = 'PUBLIC'
      and privilege_type = 'EXECUTE'
  ) then
    raise exception 'MEMBER_RLS_HELPER_PUBLIC_EXECUTE_PRESENT';
  end if;

  if exists (
    select required.routine_name
    from (
      values
        ('current_membership_level'),
        ('is_approved_member'),
        ('is_admin'),
        ('is_full_member')
    ) as required(routine_name)
    where to_regprocedure('public.' || required.routine_name || '()') is not null
      and (
        not exists (
          select 1 from information_schema.routine_privileges p
          where p.specific_schema = 'public'
            and p.routine_name = required.routine_name
            and p.grantee = 'anon'
            and p.privilege_type = 'EXECUTE'
        )
        or not exists (
          select 1 from information_schema.routine_privileges p
          where p.specific_schema = 'public'
            and p.routine_name = required.routine_name
            and p.grantee = 'authenticated'
            and p.privilege_type = 'EXECUTE'
        )
      )
  ) then
    raise exception 'MEMBER_RLS_HELPER_REQUIRED_EXECUTE_MISSING';
  end if;
end
$member_security_definer_lockdown_verify$;

commit;
