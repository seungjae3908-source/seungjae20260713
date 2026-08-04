\set ON_ERROR_STOP on

do $trade_atomicity$
declare
  member_id constant uuid := '11111111-1111-1111-1111-111111111111';
  first_plan constant uuid := '40000000-0000-0000-0000-000000000001';
  second_plan constant uuid := '40000000-0000-0000-0000-000000000002';
  first_order constant uuid := '50000000-0000-0000-0000-000000000001';
  affected integer;
begin
  delete from public.trade_orders where user_id = member_id and id = first_order;
  delete from public.trade_order_plans where user_id = member_id and id in (first_plan, second_plan);

  insert into public.trade_order_plans(user_id, id, idempotency_key, state, payload)
  values (member_id, first_plan, 'atomic-plan-key', 'APPROVAL_PENDING',
    jsonb_build_object('id', first_plan, 'userId', member_id, 'state', 'APPROVAL_PENDING'));

  begin
    insert into public.trade_order_plans(user_id, id, idempotency_key, state, payload)
    values (member_id, second_plan, 'atomic-plan-key', 'APPROVAL_PENDING', '{}');
    raise exception 'duplicate idempotency key was accepted';
  exception when unique_violation then null;
  end;

  update public.trade_order_plans
  set state = 'SUBMITTED',
      payload = jsonb_set(payload, '{state}', '"SUBMITTED"'::jsonb),
      updated_at = clock_timestamp()
  where user_id = member_id and id = first_plan and state = 'APPROVAL_PENDING';
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'first approval CAS affected % rows instead of 1', affected;
  end if;

  update public.trade_order_plans
  set state = 'SUBMITTED', updated_at = clock_timestamp()
  where user_id = member_id and id = first_plan and state = 'APPROVAL_PENDING';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'second approval CAS affected % rows instead of 0', affected;
  end if;

  insert into public.trade_order_plans(user_id, id, idempotency_key, state, payload)
  values (member_id, second_plan, 'atomic-second-plan-key', 'SUBMITTED',
    jsonb_build_object('id', second_plan, 'userId', member_id, 'state', 'SUBMITTED'));

  insert into public.trade_orders(user_id, id, plan_id, exchange, client_order_id, state, payload)
  values (member_id, first_order, first_plan, 'upbit', 'atomic-client-order', 'SUBMITTED',
    jsonb_build_object('id', first_order, 'userId', member_id, 'planId', first_plan, 'state', 'SUBMITTED'));

  begin
    insert into public.trade_orders(user_id, id, plan_id, exchange, client_order_id, state, payload)
    values (member_id, '50000000-0000-0000-0000-000000000002', first_plan,
      'upbit', 'atomic-client-order-two', 'SUBMITTED', '{}');
    raise exception 'second order for one plan was accepted';
  exception when unique_violation then null;
  end;

  begin
    insert into public.trade_orders(user_id, id, plan_id, exchange, client_order_id, state, payload)
    values (member_id, '50000000-0000-0000-0000-000000000003', second_plan,
      'upbit', 'atomic-client-order', 'SUBMITTED', '{}');
    raise exception 'duplicate client order id was accepted';
  exception when unique_violation then null;
  end;

  if (select count(*) from public.trade_order_plans
      where user_id = member_id and idempotency_key = 'atomic-plan-key') <> 1 then
    raise exception 'idempotency constraint did not preserve one plan';
  end if;
  if (select count(*) from public.trade_orders
      where user_id = member_id and plan_id = first_plan) <> 1 then
    raise exception 'plan order constraint did not preserve one order';
  end if;

  delete from public.trade_orders where user_id = member_id and id = first_order;
  delete from public.trade_order_plans where user_id = member_id and id in (first_plan, second_plan);
end
$trade_atomicity$;
