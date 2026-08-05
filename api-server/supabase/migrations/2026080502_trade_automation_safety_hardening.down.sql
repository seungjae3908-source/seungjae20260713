begin;

revoke all on function public.claim_trade_recovery_orders(uuid, integer, integer) from service_role;
revoke all on function public.claim_trade_order_execution(uuid, uuid, bigint, uuid, integer) from authenticated, service_role;
revoke all on function public.transition_trade_order_atomic(uuid, uuid, text, bigint, text, jsonb, jsonb) from authenticated, service_role;
revoke all on function public.create_trade_order_atomic(uuid, uuid, text, jsonb, jsonb) from authenticated, service_role;
revoke all on function public.transition_trade_plan_atomic(uuid, uuid, text, bigint, text, jsonb) from authenticated, service_role;

drop function if exists public.claim_trade_recovery_orders(uuid, integer, integer);
drop function if exists public.claim_trade_order_execution(uuid, uuid, bigint, uuid, integer);
drop function if exists public.transition_trade_order_atomic(uuid, uuid, text, bigint, text, jsonb, jsonb);
drop function if exists public.create_trade_order_atomic(uuid, uuid, text, jsonb, jsonb);
drop function if exists public.transition_trade_plan_atomic(uuid, uuid, text, bigint, text, jsonb);

drop table if exists public.trade_protection_orders;
drop table if exists public.trade_order_legs;

drop index if exists public.trade_orders_recovery_due_idx;
drop index if exists public.trade_orders_exchange_order_unique_idx;

alter table public.trade_orders
  drop column if exists protection_error_code,
  drop column if exists protection_status,
  drop column if exists recovery_lease_until,
  drop column if exists recovery_lease_owner,
  drop column if exists execution_claimed_at,
  drop column if exists execution_claim_id,
  drop column if exists manual_review_required,
  drop column if exists last_reconciled_at,
  drop column if exists next_retry_at,
  drop column if exists provider_status_code,
  drop column if exists cancelable,
  drop column if exists exchange_updated_at,
  drop column if exists exchange_created_at,
  drop column if exists fee_currency,
  drop column if exists fee_amount,
  drop column if exists fills,
  drop column if exists remaining_quantity,
  drop column if exists exchange_order_id,
  drop column if exists version;

alter table public.trade_order_plans
  drop column if exists version;

commit;
