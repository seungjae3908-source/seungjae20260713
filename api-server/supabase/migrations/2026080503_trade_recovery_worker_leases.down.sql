begin;

drop function if exists public.transition_trade_recovery_order_atomic(
  uuid, uuid, uuid, text, bigint, text, jsonb, jsonb, boolean
);

commit;
