\set ON_ERROR_STOP on

do $reapply_assertions$
declare
  candidate_table text;
  rls_enabled boolean;
begin
  foreach candidate_table in array array[
    'paper_accounts', 'paper_orders', 'paper_positions',
    'paper_fills', 'paper_journal_entries', 'paper_sync_state',
    'member_permission_audit'
  ]
  loop
    if to_regclass('public.' || candidate_table) is null then
      raise exception 'reapply missing table %', candidate_table;
    end if;
    select c.relrowsecurity into rls_enabled
      from pg_class c where c.oid = to_regclass('public.' || candidate_table);
    if rls_enabled is not true then
      raise exception 'reapply missing RLS on %', candidate_table;
    end if;
  end loop;

  if (
    select count(*) from information_schema.columns as columns_info
    where columns_info.table_schema = 'public'
      and columns_info.table_name = 'profiles'
      and columns_info.column_name in ('membership_level', 'is_active', 'permissions_updated_at')
  ) <> 3 then
    raise exception 'reapply missing Phase 8 profile columns';
  end if;

  if to_regprocedure('public.current_membership_level()') is null then
    raise exception 'reapply missing membership helper function';
  end if;
end
$reapply_assertions$;
