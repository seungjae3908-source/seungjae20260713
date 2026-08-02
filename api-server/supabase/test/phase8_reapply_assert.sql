\set ON_ERROR_STOP on

do $reapply_assertions$
declare
  table_name text;
  rls_enabled boolean;
begin
  foreach table_name in array array[
    'paper_accounts', 'paper_orders', 'paper_positions',
    'paper_fills', 'paper_journal_entries', 'paper_sync_state',
    'member_permission_audit'
  ]
  loop
    if to_regclass('public.' || table_name) is null then
      raise exception 'reapply missing table %', table_name;
    end if;
    select c.relrowsecurity into rls_enabled
      from pg_class c where c.oid = to_regclass('public.' || table_name);
    if rls_enabled is not true then
      raise exception 'reapply missing RLS on %', table_name;
    end if;
  end loop;

  if (
    select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name in ('membership_level', 'is_active', 'permissions_updated_at')
  ) <> 3 then
    raise exception 'reapply missing Phase 8 profile columns';
  end if;

  if to_regprocedure('public.current_membership_level()') is null then
    raise exception 'reapply missing membership helper function';
  end if;
end
$reapply_assertions$;
