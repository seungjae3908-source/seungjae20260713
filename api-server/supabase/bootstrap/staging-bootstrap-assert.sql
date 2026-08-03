-- Verify the complete staging bootstrap contract without inserting any user data.

do $staging_bootstrap_assert$
declare
  required_table text;
  missing_columns integer;
  auth_user_count bigint;
  profile_count bigint;
  global_control_count bigint;
begin
  foreach required_table in array array[
    'profiles',
    'audit_logs',
    'watchlist_items',
    'market_cache',
    'portfolio_holdings',
    'alert_preferences',
    'paper_accounts',
    'paper_orders',
    'paper_positions',
    'paper_fills',
    'paper_journal_entries',
    'paper_sync_state',
    'member_permission_audit',
    'trade_system_controls',
    'trade_automation_profiles',
    'trade_exchange_connections',
    'trade_order_plans',
    'trade_orders',
    'trade_order_events'
  ]
  loop
    if to_regclass(format('public.%I', required_table)) is null then
      raise exception 'staging bootstrap missing required table public.%', required_table;
    end if;
  end loop;

  select count(*) into missing_columns
  from unnest(array[
    'id', 'login_name', 'display_name', 'role', 'status',
    'membership_level', 'is_active', 'permissions_updated_at', 'updated_at'
  ]) as required(column_name)
  where not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'profiles'
      and c.column_name = required.column_name
  );
  if missing_columns <> 0 then
    raise exception 'staging bootstrap profiles contract is missing % required column(s)', missing_columns;
  end if;

  if to_regprocedure('public.handle_new_user()') is null then
    raise exception 'staging bootstrap missing public.handle_new_user()';
  end if;
  if to_regprocedure('public.current_membership_level()') is null then
    raise exception 'staging bootstrap missing public.current_membership_level()';
  end if;
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'on_auth_user_created'
      and tgrelid = 'auth.users'::regclass
      and not tgisinternal
  ) then
    raise exception 'staging bootstrap missing auth.users profile trigger';
  end if;
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_membership_level_check'
  ) then
    raise exception 'staging bootstrap missing profiles membership constraint';
  end if;

  if not exists (
    select 1 from pg_class
    where oid = 'public.profiles'::regclass and relrowsecurity
  ) then
    raise exception 'staging bootstrap profiles RLS is not enabled';
  end if;
  if not exists (
    select 1 from pg_class
    where oid = 'public.paper_journal_entries'::regclass and relrowsecurity
  ) then
    raise exception 'staging bootstrap paper journal RLS is not enabled';
  end if;
  if not exists (
    select 1 from pg_class
    where oid = 'public.trade_order_plans'::regclass and relrowsecurity
  ) then
    raise exception 'staging bootstrap trade plan RLS is not enabled';
  end if;

  select count(*) into auth_user_count from auth.users;
  select count(*) into profile_count from public.profiles;
  if auth_user_count <> 0 or profile_count <> 0 then
    raise exception 'staging bootstrap must not create users or profiles (auth %, profiles %)', auth_user_count, profile_count;
  end if;

  select count(*) into global_control_count
  from public.trade_system_controls
  where control_key = 'global' and emergency_stopped is false;
  if global_control_count <> 1 then
    raise exception 'staging bootstrap requires one safe global trade control row';
  end if;
end
$staging_bootstrap_assert$;
