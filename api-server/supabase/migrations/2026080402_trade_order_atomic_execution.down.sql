begin;

revoke all on function public.submit_trade_plan_order(text, jsonb, jsonb, jsonb, uuid)
  from public, anon, authenticated;
drop function if exists public.submit_trade_plan_order(text, jsonb, jsonb, jsonb, uuid);

alter table public.trade_orders
  drop column if exists execution_claimed_at;
alter table public.trade_orders
  drop column if exists execution_claim_id;

commit;
