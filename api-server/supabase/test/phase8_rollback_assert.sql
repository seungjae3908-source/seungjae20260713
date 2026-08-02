\set ON_ERROR_STOP on

do $rollback_assertions$
declare
  table_name text;
begin
  foreach table_name in array array[
    'paper_accounts', 'paper_orders', 'paper_positions',
    'paper_fills', 'paper_journal_entries', 'paper_sync_state',
    'member_permission_audit'
  ]
  loop
    if to_regclass('public.' || table_name) is not null then
      raise exception 'rollback left table %', table_name;
    end if;
  end loop;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name in ('membership_level', 'is_active', 'permissions_updated_at')
  ) then
    raise exception 'rollback left Phase 8 profile columns';
  end if;

  if to_regprocedure('public.current_membership_level()') is not null then
    raise exception 'rollback left membership helper function';
  end if;
end
$rollback_assertions$;
