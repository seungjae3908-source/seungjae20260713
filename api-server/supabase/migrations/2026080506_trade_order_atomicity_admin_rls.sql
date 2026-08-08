-- Finalize trade-order DB invariants after split-child storage landed.
-- Review/CI only: do not apply to staging or production without separate approval.
begin;

-- 2026080505 replaced the old one-order-per-plan constraint so a plan can own
-- multiple split children. Preserve the original invariant for non-split orders
-- at the table boundary as well as inside the RPC path.
do $trade_single_order_preflight$
begin
  if exists (
    select 1
    from public.trade_orders
    where leg_id is null
    group by user_id, plan_id
    having count(*) > 1
  ) then
    raise exception 'TRADE_SINGLE_ORDER_DUPLICATES_EXIST';
  end if;
end
$trade_single_order_preflight$;

create unique index if not exists trade_orders_single_plan_unique_idx
  on public.trade_orders(user_id, plan_id)
  where leg_id is null;

-- Auto-trading storage is administrator-only. Keep every record owner-scoped so
-- one administrator cannot browse or mutate another administrator's records.
-- current_membership_level() already maps inactive accounts to pending.
do $trade_admin_only_rls$
declare
  candidate_table text;
  admin_owner_only text := '(auth.uid() = user_id and public.current_membership_level() = ''admin'')';
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
    execute format(
      'create policy %I on public.%I for select using %s',
      candidate_table || ' select own', candidate_table, admin_owner_only
    );

    execute format('drop policy if exists %I on public.%I', candidate_table || ' insert own', candidate_table);
    execute format(
      'create policy %I on public.%I for insert with check %s',
      candidate_table || ' insert own', candidate_table, admin_owner_only
    );

    execute format('drop policy if exists %I on public.%I', candidate_table || ' update own', candidate_table);
    execute format(
      'create policy %I on public.%I for update using %s with check %s',
      candidate_table || ' update own', candidate_table, admin_owner_only, admin_owner_only
    );

    execute format('drop policy if exists %I on public.%I', candidate_table || ' delete own', candidate_table);
    execute format(
      'create policy %I on public.%I for delete using %s',
      candidate_table || ' delete own', candidate_table, admin_owner_only
    );
  end loop;
end
$trade_admin_only_rls$;

commit;
