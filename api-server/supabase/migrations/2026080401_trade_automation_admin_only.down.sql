begin;

-- Disposable rollback restores the previous regular/admin owner-scoped policy.
-- This file is not executed against staging or production without a separate
-- migration approval.
do $trade_admin_only_rls_down$
declare
  candidate_table text;
  member_owner_only text := '(auth.uid() = user_id and public.current_membership_level() in (''regular'', ''admin''))';
begin
  foreach candidate_table in array array[
    'trade_automation_profiles',
    'trade_exchange_connections',
    'trade_order_plans',
    'trade_orders',
    'trade_order_events'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', candidate_table || ' select own', candidate_table);
    execute format(
      'create policy %I on public.%I for select using %s',
      candidate_table || ' select own', candidate_table, member_owner_only
    );

    execute format('drop policy if exists %I on public.%I', candidate_table || ' insert own', candidate_table);
    execute format(
      'create policy %I on public.%I for insert with check %s',
      candidate_table || ' insert own', candidate_table, member_owner_only
    );

    execute format('drop policy if exists %I on public.%I', candidate_table || ' update own', candidate_table);
    execute format(
      'create policy %I on public.%I for update using %s with check %s',
      candidate_table || ' update own', candidate_table, member_owner_only, member_owner_only
    );

    execute format('drop policy if exists %I on public.%I', candidate_table || ' delete own', candidate_table);
    execute format(
      'create policy %I on public.%I for delete using %s',
      candidate_table || ' delete own', candidate_table, member_owner_only
    );
  end loop;
end
$trade_admin_only_rls_down$;

commit;
