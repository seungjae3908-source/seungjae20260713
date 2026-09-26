\set ON_ERROR_STOP on

do $rollback_assertions$
declare
  candidate_table text;
begin
  foreach candidate_table in array array[
    'paper_accounts', 'paper_orders', 'paper_positions',
    'paper_fills', 'paper_journal_entries', 'paper_sync_state',
    'member_permission_audit'
  ]
  loop
    if to_regclass('public.' || candidate_table) is not null then
      raise exception 'rollback left table %', candidate_table;
    end if;
  end loop;

  if exists (
    select 1 from information_schema.columns as columns_info
    where columns_info.table_schema = 'public'
      and columns_info.table_name = 'profiles'
      and columns_info.column_name in ('membership_level', 'is_active', 'permissions_updated_at')
  ) then
    raise exception 'rollback left Phase 8 profile columns';
  end if;

  if to_regprocedure('public.current_membership_level()') is not null then
    raise exception 'rollback left membership helper function';
  end if;
end
$rollback_assertions$;
