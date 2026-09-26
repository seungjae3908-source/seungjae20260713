begin;

drop index if exists public.trade_orders_single_plan_unique_idx;

do $trade_admin_rls_rollback$
declare
  candidate_table text;
  owner_policy text := '(auth.uid() = user_id and public.current_membership_level() in (''regular'', ''admin''))';
begin
  foreach candidate_table in array array[
    'trade_automation_profiles',
    'trade_exchange_connections',
    'trade_order_plans',
    'trade_orders',
    'trade_order_events',
    'trade_order_legs',
    'trade_protection_orders'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', candidate_table || ' select own', candidate_table);
    execute format('create policy %I on public.%I for select using %s', candidate_table || ' select own', candidate_table, owner_policy);
    execute format('drop policy if exists %I on public.%I', candidate_table || ' insert own', candidate_table);
    execute format('create policy %I on public.%I for insert with check %s', candidate_table || ' insert own', candidate_table, owner_policy);
    execute format('drop policy if exists %I on public.%I', candidate_table || ' update own', candidate_table);
    execute format('create policy %I on public.%I for update using %s with check %s', candidate_table || ' update own', candidate_table, owner_policy, owner_policy);
    execute format('drop policy if exists %I on public.%I', candidate_table || ' delete own', candidate_table);
    execute format('create policy %I on public.%I for delete using %s', candidate_table || ' delete own', candidate_table, owner_policy);
  end loop;
end
$trade_admin_rls_rollback$;

commit;
