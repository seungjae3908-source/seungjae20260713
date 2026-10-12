begin;
-- Never discard a live or released capital/audit reservation during rollback.
do $guard$ begin
  if exists(select 1 from public.trade_live_budget_reservations) then
    raise exception 'AUTOMATIC_LIVE_BUDGET_ROLLBACK_REQUIRES_EMPTY_RESERVATIONS';
  end if;
  if exists(select 1 from public.trade_order_plans where public.is_automatic_live_ledger_payload(payload)) then
    raise exception 'AUTOMATIC_LIVE_BUDGET_ROLLBACK_REQUIRES_NO_AUTO_LIVE_LEDGER';
  end if;
end $guard$;
do $policies$ declare relation text; begin
  foreach relation in array array['trade_order_plans','trade_orders','trade_order_events','trade_order_legs','trade_protection_orders'] loop
    execute format('drop policy if exists auto_live_server_insert_guard on public.%I',relation);
    execute format('drop policy if exists auto_live_server_update_guard on public.%I',relation);
    execute format('drop policy if exists auto_live_server_delete_guard on public.%I',relation);
  end loop;
end $policies$;
drop function if exists public.is_automatic_live_ledger_payload(jsonb);
drop function if exists public.read_automatic_live_budget_guard();
drop function if exists public.automatic_live_budget_schema_fingerprint();
drop function if exists public.reserve_automatic_live_entry_budget(uuid,uuid,uuid,jsonb,jsonb,boolean);
drop function if exists public.read_automatic_live_budget_snapshot(uuid);
drop table if exists public.trade_live_budget_reservations;
-- Keep the old AUTO bypass closed. The normal submission-fence rollback drops
-- claim_trade_order_execution later; do not silently restore unsafe authority.
notify pgrst,'reload schema';
commit;
