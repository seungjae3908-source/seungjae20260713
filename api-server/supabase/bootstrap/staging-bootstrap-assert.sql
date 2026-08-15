-- Verify the complete allowlisted staging bootstrap contract without inserting user data.

do $staging_bootstrap_assert$
declare
  required_table text;
  required_rls_table text;
  required_index text;
  paper_table text;
  paper_operation text;
  missing_columns integer;
  auth_user_count bigint;
  profile_count bigint;
  auth_before bigint := current_setting('app.staging_auth_users_before')::bigint;
  profiles_before bigint := current_setting('app.staging_profiles_before')::bigint;
  global_control_count bigint;
  configured_ref text := current_setting('app.staging_project_ref');
begin
  foreach required_table in array array[
    'staging_bootstrap_state',
    'profiles',
    'watchlist_items',
    'market_cache',
    'portfolio_holdings',
    'app_backups',
    'notification_preferences',
    'push_subscriptions',
    'notification_history',
    'price_alerts',
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
    'trade_order_events',
    'telegram_connections',
    'telegram_link_tokens',
    'user_execution_events',
    'notification_deliveries'
  ]
  loop
    if to_regclass(format('public.%I', required_table)) is null then
      raise exception 'staging bootstrap missing required table public.%', required_table;
    end if;
  end loop;

  select count(*) into missing_columns
  from unnest(array[
    'id', 'login_name', 'display_name', 'role', 'status', 'approved_at',
    'approved_by', 'membership_level', 'is_active',
    'permissions_updated_at', 'created_at', 'updated_at'
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
  if to_regprocedure('public.is_approved_member()') is null then
    raise exception 'staging bootstrap missing public.is_approved_member()';
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

  foreach required_index in array array[
    'profiles_login_name_unique_idx',
    'profiles_membership_active_idx',
    'watchlist_items_device_idx',
    'market_cache_expires_idx',
    'portfolio_holdings_user_idx',
    'push_subscriptions_member_idx',
    'notification_history_member_created_idx',
    'price_alerts_member_idx',
    'paper_journal_entries_user_updated_idx',
    'member_permission_audit_target_idx',
    'trade_plans_user_updated_idx',
    'trade_orders_user_updated_idx',
    'telegram_link_tokens_user_expiry_idx',
    'user_execution_events_user_occurred_idx',
    'notification_deliveries_due_idx'
  ]
  loop
    if to_regclass(format('public.%I', required_index)) is null then
      raise exception 'staging bootstrap missing required index public.%', required_index;
    end if;
  end loop;

  foreach required_rls_table in array array[
    'profiles', 'portfolio_holdings', 'app_backups',
    'notification_preferences', 'push_subscriptions',
    'notification_history', 'price_alerts',
    'paper_accounts', 'paper_orders', 'paper_positions', 'paper_fills',
    'paper_journal_entries', 'paper_sync_state', 'member_permission_audit',
    'trade_automation_profiles', 'trade_exchange_connections',
    'trade_order_plans', 'trade_orders', 'trade_order_events',
    'telegram_connections', 'telegram_link_tokens',
    'user_execution_events', 'notification_deliveries'
  ]
  loop
    if not exists (
      select 1 from pg_class
      where oid = format('public.%I', required_rls_table)::regclass
        and relrowsecurity
    ) then
      raise exception 'staging bootstrap RLS is not enabled for public.%', required_rls_table;
    end if;
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = required_rls_table
    ) then
      raise exception 'staging bootstrap has no RLS policy for public.%', required_rls_table;
    end if;
  end loop;

  foreach paper_table in array array[
    'paper_accounts',
    'paper_orders',
    'paper_positions',
    'paper_fills',
    'paper_journal_entries',
    'paper_sync_state'
  ]
  loop
    foreach paper_operation in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE']
    loop
      if not has_table_privilege('authenticated', format('public.%I', paper_table), paper_operation) then
        raise exception 'authenticated lacks % on public.%', paper_operation, paper_table;
      end if;
      if has_table_privilege('anon', format('public.%I', paper_table), paper_operation) then
        raise exception 'anon unexpectedly has % on public.%', paper_operation, paper_table;
      end if;
    end loop;
  end loop;

  if not has_table_privilege('authenticated', 'public.profiles', 'SELECT') then
    raise exception 'authenticated role cannot read its permitted profile';
  end if;
  if has_table_privilege('authenticated', 'public.watchlist_items', 'SELECT')
     or has_table_privilege('authenticated', 'public.watchlist_items', 'INSERT')
     or has_table_privilege('authenticated', 'public.watchlist_items', 'UPDATE')
     or has_table_privilege('authenticated', 'public.watchlist_items', 'DELETE') then
    raise exception 'authenticated role unexpectedly has direct watchlist server-table privileges';
  end if;
  if has_table_privilege('authenticated', 'public.market_cache', 'SELECT')
     or has_table_privilege('authenticated', 'public.market_cache', 'INSERT')
     or has_table_privilege('authenticated', 'public.market_cache', 'UPDATE')
     or has_table_privilege('authenticated', 'public.market_cache', 'DELETE') then
    raise exception 'authenticated role unexpectedly has direct market cache privileges';
  end if;
  if not (
    has_table_privilege('service_role', 'public.profiles', 'SELECT')
    and has_table_privilege('service_role', 'public.profiles', 'INSERT')
    and has_table_privilege('service_role', 'public.profiles', 'UPDATE')
    and has_table_privilege('service_role', 'public.profiles', 'DELETE')
  ) then
    raise exception 'service_role lacks profile administration privileges';
  end if;
  if not (
    has_table_privilege('service_role', 'public.watchlist_items', 'SELECT')
    and has_table_privilege('service_role', 'public.watchlist_items', 'INSERT')
    and has_table_privilege('service_role', 'public.watchlist_items', 'UPDATE')
    and has_table_privilege('service_role', 'public.watchlist_items', 'DELETE')
  ) then
    raise exception 'service_role lacks watchlist server privileges';
  end if;

  foreach required_table in array array[
    'telegram_connections',
    'telegram_link_tokens',
    'user_execution_events',
    'notification_deliveries'
  ]
  loop
    if exists (
      select 1 from information_schema.table_privileges privilege
      where privilege.table_schema = 'public'
        and privilege.table_name = required_table
        and privilege.grantee in ('PUBLIC', 'anon', 'authenticated')
    ) then
      raise exception 'personal Telegram server table public.% is exposed to an API role', required_table;
    end if;
    if not (
      has_table_privilege('service_role', format('public.%I', required_table), 'SELECT')
      and has_table_privilege('service_role', format('public.%I', required_table), 'INSERT')
      and has_table_privilege('service_role', format('public.%I', required_table), 'UPDATE')
      and has_table_privilege('service_role', format('public.%I', required_table), 'DELETE')
    ) then
      raise exception 'service_role lacks personal Telegram storage privileges on public.%', required_table;
    end if;
    if (
      select count(*) <> 1
        or bool_or(policyname <> (required_table || '_server_only'))
        or bool_or(cmd <> 'ALL')
        or bool_or(qual <> 'false')
        or bool_or(with_check <> 'false')
      from pg_policies
      where schemaname = 'public' and tablename = required_table
    ) then
      raise exception 'personal Telegram storage policy on public.% is not exclusively fail-closed', required_table;
    end if;
  end loop;

  select count(*) into auth_user_count from auth.users;
  select count(*) into profile_count from public.profiles;
  if auth_user_count <> auth_before or profile_count <> profiles_before then
    raise exception 'staging bootstrap changed user rows (auth % -> %, profiles % -> %)',
      auth_before, auth_user_count, profiles_before, profile_count;
  end if;

  if not exists (
    select 1 from public.staging_bootstrap_state
    where singleton is true
      and project_ref = configured_ref
      and schema_version = '20260804.1'
  ) then
    raise exception 'staging bootstrap marker is missing or mismatched';
  end if;

  select count(*) into global_control_count
  from public.trade_system_controls
  where control_key = 'global' and emergency_stopped is false;
  if global_control_count <> 1 then
    raise exception 'staging bootstrap requires one safe global trade control row';
  end if;
end
$staging_bootstrap_assert$;

drop function if exists public.raise_exception(text);
