-- Roll back only the PR #51 risk-envelope/fast-move additions.
-- CI/disposable PostgreSQL only. Do not apply to staging or production without separate approval.
begin;

revoke all on function public.cancel_trade_split_children_atomic(uuid, uuid, bigint, integer, jsonb)
  from public, anon, authenticated;
drop function if exists public.cancel_trade_split_children_atomic(uuid, uuid, bigint, integer, jsonb);

drop trigger if exists trade_order_plans_risk_envelope_guard on public.trade_order_plans;
drop function if exists public.enforce_trade_plan_risk_envelope();

commit;
