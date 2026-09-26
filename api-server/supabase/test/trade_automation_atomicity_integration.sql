\set ON_ERROR_STOP on

do $trade_atomicity$
declare
  member_id constant uuid := '11111111-1111-1111-1111-111111111111';
  first_plan constant uuid := '40000000-0000-0000-0000-000000000001';
  second_plan constant uuid := '40000000-0000-0000-0000-000000000002';
  first_order constant uuid := '50000000-0000-0000-0000-000000000001';
  affected integer;
begin
  delete from public.trade_order_events where user_id = member_id
    and order_id in (
      select id from public.trade_orders where user_id = member_id
        and plan_id in (first_plan, second_plan)
    );
  delete from public.trade_orders where user_id = member_id
    and plan_id in (first_plan, second_plan);
  delete from public.trade_order_plans where user_id = member_id
    and id in (first_plan, second_plan);

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
    jsonb_build_object('id', first_order, 'userId', member_id, 'planId', first_plan,
      'exchange', 'upbit', 'clientOrderId', 'atomic-client-order', 'state', 'SUBMITTED'));

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

  delete from public.trade_order_events where user_id = member_id
    and order_id in (
      select id from public.trade_orders where user_id = member_id
        and plan_id in (first_plan, second_plan)
    );
  delete from public.trade_orders where user_id = member_id
    and plan_id in (first_plan, second_plan);
  delete from public.trade_order_plans where user_id = member_id
    and id in (first_plan, second_plan);
end
$trade_atomicity$;

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $trade_rpc_atomicity$
declare
  member_id constant uuid := '11111111-1111-1111-1111-111111111111';
  v_plan_id constant uuid := '41000000-0000-0000-0000-000000000001';
  v_rollback_plan_id constant uuid := '41000000-0000-0000-0000-000000000002';
  v_order_id constant uuid := '51000000-0000-0000-0000-000000000001';
  v_rollback_order_id constant uuid := '51000000-0000-0000-0000-000000000002';
  v_event_id constant uuid := '61000000-0000-0000-0000-000000000001';
  now_text text := clock_timestamp()::text;
  approval_text text := (clock_timestamp() + interval '10 minutes')::text;
  first_result record;
  second_result record;
begin
  insert into public.trade_order_plans(user_id, id, idempotency_key, state, payload, approval_expires_at)
  values (
    member_id, v_plan_id, 'rpc-atomic-plan', 'APPROVAL_PENDING',
    jsonb_build_object(
      'id', v_plan_id, 'userId', member_id, 'state', 'APPROVAL_PENDING',
      'approvalExpiresAt', approval_text, 'updatedAt', now_text
    ),
    approval_text::timestamptz
  );

  select * into first_result
  from public.submit_trade_plan_order(
    'APPROVAL_PENDING',
    jsonb_build_object(
      'id', v_plan_id, 'userId', member_id, 'state', 'SUBMITTED',
      'approvalExpiresAt', approval_text, 'updatedAt', now_text
    ),
    jsonb_build_object(
      'id', v_order_id, 'userId', member_id, 'planId', v_plan_id, 'exchange', 'upbit',
      'clientOrderId', 'rpc-atomic-client', 'state', 'SUBMITTED',
      'createdAt', now_text, 'updatedAt', now_text
    ),
    jsonb_build_object(
      'id', v_event_id, 'userId', member_id, 'orderId', v_order_id,
      'fromState', null, 'toState', 'SUBMITTED', 'reason', 'ORDER_CREATED',
      'metadata', '{}'::jsonb, 'createdAt', now_text
    ),
    '71000000-0000-0000-0000-000000000001'
  );

  if first_result.transitioned is distinct from true
    or first_result.order_inserted is distinct from true
    or first_result.execution_claimed is distinct from true then
    raise exception 'first atomic RPC did not transition, insert, and claim exactly once';
  end if;

  select * into second_result
  from public.submit_trade_plan_order(
    'APPROVAL_PENDING',
    jsonb_build_object(
      'id', v_plan_id, 'userId', member_id, 'state', 'SUBMITTED',
      'approvalExpiresAt', approval_text, 'updatedAt', now_text
    ),
    jsonb_build_object(
      'id', '51000000-0000-0000-0000-000000000099', 'userId', member_id,
      'planId', v_plan_id, 'exchange', 'upbit',
      'clientOrderId', 'rpc-atomic-client', 'state', 'SUBMITTED',
      'createdAt', now_text, 'updatedAt', now_text
    ),
    jsonb_build_object(
      'id', '61000000-0000-0000-0000-000000000099', 'userId', member_id,
      'orderId', '51000000-0000-0000-0000-000000000099',
      'fromState', null, 'toState', 'SUBMITTED', 'reason', 'ORDER_CREATED',
      'metadata', '{}'::jsonb, 'createdAt', now_text
    ),
    '71000000-0000-0000-0000-000000000099'
  );

  if second_result.transitioned is distinct from false
    or second_result.order_inserted is distinct from false
    or second_result.execution_claimed is distinct from false then
    raise exception 'duplicate atomic RPC acquired a second transition, order, or claim';
  end if;
  if second_result.order_payload->>'id' <> v_order_id::text then
    raise exception 'duplicate atomic RPC did not return the persisted order';
  end if;

  if (select count(*) from public.trade_orders candidate where candidate.user_id = member_id and candidate.plan_id = v_plan_id) <> 1
    or (select count(*) from public.trade_order_events candidate where candidate.user_id = member_id and candidate.order_id = v_order_id) <> 1 then
    raise exception 'atomic RPC did not preserve one order and one event';
  end if;

  insert into public.trade_order_plans(user_id, id, idempotency_key, state, payload, approval_expires_at)
  values (
    member_id, v_rollback_plan_id, 'rpc-rollback-plan', 'APPROVAL_PENDING',
    jsonb_build_object(
      'id', v_rollback_plan_id, 'userId', member_id, 'state', 'APPROVAL_PENDING',
      'approvalExpiresAt', approval_text, 'updatedAt', now_text
    ),
    approval_text::timestamptz
  );

  begin
    perform *
    from public.submit_trade_plan_order(
      'APPROVAL_PENDING',
      jsonb_build_object(
        'id', v_rollback_plan_id, 'userId', member_id, 'state', 'SUBMITTED',
        'approvalExpiresAt', approval_text, 'updatedAt', now_text
      ),
      jsonb_build_object(
        'id', v_rollback_order_id, 'userId', member_id, 'planId', v_rollback_plan_id,
        'exchange', 'upbit', 'clientOrderId', 'rpc-rollback-client', 'state', 'SUBMITTED',
        'createdAt', now_text, 'updatedAt', now_text
      ),
      jsonb_build_object(
        'id', v_event_id, 'userId', member_id, 'orderId', v_rollback_order_id,
        'fromState', null, 'toState', 'SUBMITTED', 'reason', 'ORDER_CREATED',
        'metadata', '{}'::jsonb, 'createdAt', now_text
      ),
      '71000000-0000-0000-0000-000000000002'
    );
    raise exception 'duplicate event id did not fail the atomic RPC';
  exception when unique_violation then null;
  end;

  if (select state from public.trade_order_plans where user_id = member_id and id = v_rollback_plan_id)
      <> 'APPROVAL_PENDING' then
    raise exception 'failed atomic RPC left the plan submitted';
  end if;
  if exists (select 1 from public.trade_orders where user_id = member_id and plan_id = v_rollback_plan_id) then
    raise exception 'failed atomic RPC left a partial order';
  end if;
end
$trade_rpc_atomicity$;

reset role;
select set_config('request.jwt.claim.sub', '', false);

delete from public.trade_order_events
where user_id = '11111111-1111-1111-1111-111111111111'
  and order_id in (
    select id from public.trade_orders
    where user_id = '11111111-1111-1111-1111-111111111111'
      and plan_id in (
        '41000000-0000-0000-0000-000000000001',
        '41000000-0000-0000-0000-000000000002'
      )
  );
delete from public.trade_orders
where user_id = '11111111-1111-1111-1111-111111111111'
  and plan_id in (
    '41000000-0000-0000-0000-000000000001',
    '41000000-0000-0000-0000-000000000002'
  );
delete from public.trade_order_plans
where user_id = '11111111-1111-1111-1111-111111111111'
  and id in (
    '41000000-0000-0000-0000-000000000001',
    '41000000-0000-0000-0000-000000000002'
  );
