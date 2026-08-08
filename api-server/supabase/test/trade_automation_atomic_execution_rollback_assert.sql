\set ON_ERROR_STOP on

do $atomic_execution_rollback_assert$
begin
  if to_regprocedure('public.submit_trade_plan_order(text,jsonb,jsonb,jsonb,uuid)') is not null then
    raise exception 'atomic execution RPC remained after rollback';
  end if;
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'trade_orders'
      and column_name in ('execution_claim_id', 'execution_claimed_at')
  ) then
    raise exception 'execution claim columns remained after rollback';
  end if;
  if to_regclass('public.trade_order_plans') is null
    or to_regclass('public.trade_orders') is null
    or to_regclass('public.trade_order_events') is null then
    raise exception 'atomic execution rollback removed existing trade tables';
  end if;
end
$atomic_execution_rollback_assert$;
