begin;

drop function if exists public.activate_next_trade_split_child_atomic(uuid, uuid, bigint, jsonb, jsonb);
drop function if exists public.create_trade_split_orders_atomic(uuid, uuid, text, bigint, jsonb, jsonb, jsonb);

drop index if exists public.trade_orders_plan_leg_key_unique_idx;
drop index if exists public.trade_orders_plan_version_leg_unique_idx;

alter table public.trade_orders
  drop constraint if exists trade_orders_previous_child_fk,
  drop constraint if exists trade_orders_leg_fk,
  drop constraint if exists trade_orders_requested_quote_amount_check,
  drop constraint if exists trade_orders_leg_sequence_check,
  drop column if exists approved_plan_version,
  drop column if exists previous_child_order_id,
  drop column if exists requested_quote_amount,
  drop column if exists leg_count,
  drop column if exists leg_sequence_no,
  drop column if exists leg_key,
  drop column if exists leg_id;

alter table public.trade_orders
  add constraint trade_orders_user_id_plan_id_key unique (user_id, plan_id);

commit;
