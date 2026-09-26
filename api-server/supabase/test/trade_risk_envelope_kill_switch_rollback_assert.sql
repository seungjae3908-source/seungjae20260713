-- Disposable PostgreSQL rollback assertion for PR #51 risk-envelope additions.
do $risk_envelope_rollback$
begin
  if to_regprocedure('public.cancel_trade_split_children_atomic(uuid,uuid,bigint,integer,jsonb)') is not null then
    raise exception 'cancel_trade_split_children_atomic remained after rollback';
  end if;
  if to_regprocedure('public.enforce_trade_plan_risk_envelope()') is not null then
    raise exception 'enforce_trade_plan_risk_envelope remained after rollback';
  end if;
  if exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.trade_order_plans'::regclass
      and tgname = 'trade_order_plans_risk_envelope_guard'
      and not tgisinternal
  ) then
    raise exception 'trade_order_plans_risk_envelope_guard remained after rollback';
  end if;
end
$risk_envelope_rollback$;
