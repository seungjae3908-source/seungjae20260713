begin;

revoke select on public.trade_order_plans from service_role;
revoke select on public.trade_exchange_connections from service_role;
revoke select, update on public.trade_orders from service_role;
revoke insert on public.trade_order_events from service_role;

drop function if exists public.transition_trade_recovery_order_atomic(
  uuid, uuid, uuid, text, bigint, text, jsonb, jsonb, boolean
);

commit;
