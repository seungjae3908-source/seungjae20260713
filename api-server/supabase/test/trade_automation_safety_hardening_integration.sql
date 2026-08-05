\set ON_ERROR_STOP on

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

insert into public.trade_order_plans(
  user_id, id, idempotency_key, state, payload, version
) values (
  '11111111-1111-1111-1111-111111111111',
  '41000000-0000-0000-0000-000000000001',
  'safety-plan-a',
  'APPROVAL_PENDING',
  '{"id":"41000000-0000-0000-0000-000000000001","userId":"11111111-1111-1111-1111-111111111111","state":"APPROVAL_PENDING","version":0,"updatedAt":"2026-08-05T00:00:00.000Z"}',
  0
);

select public.transition_trade_plan_atomic(
  '11111111-1111-1111-1111-111111111111',
  '41000000-0000-0000-0000-000000000001',
  'APPROVAL_PENDING', 0, 'SUBMITTED',
  '{"id":"41000000-0000-0000-0000-000000000001","userId":"11111111-1111-1111-1111-111111111111","state":"SUBMITTED","version":0,"updatedAt":"2026-08-05T00:00:01.000Z"}'
);

do $plan_cas$
begin
  if (select version from public.trade_order_plans where id = '41000000-0000-0000-0000-000000000001') <> 1 then
    raise exception 'plan version did not advance';
  end if;
  if public.transition_trade_plan_atomic(
    '11111111-1111-1111-1111-111111111111',
    '41000000-0000-0000-0000-000000000001',
    'APPROVAL_PENDING', 0, 'SUBMITTED', '{}'
  ) is not null then
    raise exception 'stale plan CAS unexpectedly succeeded';
  end if;
end
$plan_cas$;

select * from public.create_trade_order_atomic(
  '11111111-1111-1111-1111-111111111111',
  '41000000-0000-0000-0000-000000000001',
  'SUBMITTED',
  '{"id":"51000000-0000-0000-0000-000000000001","userId":"11111111-1111-1111-1111-111111111111","planId":"41000000-0000-0000-0000-000000000001","exchange":"upbit","clientOrderId":"safety-client-a","exchangeOrderId":null,"state":"SUBMITTED","requestedQuantity":1,"remainingQuantity":1,"filledQuantity":0,"fills":[],"feeAmount":null,"feeCurrency":null,"version":0,"createdAt":"2026-08-05T00:00:02.000Z","updatedAt":"2026-08-05T00:00:02.000Z"}',
  '{"id":"61000000-0000-0000-0000-000000000001","userId":"11111111-1111-1111-1111-111111111111","orderId":"51000000-0000-0000-0000-000000000001","fromState":null,"toState":"SUBMITTED","reason":"ORDER_CREATED","metadata":{},"createdAt":"2026-08-05T00:00:02.000Z"}'
);

do $order_insert_atomic$
declare
  duplicate_inserted boolean;
begin
  if (select count(*) from public.trade_orders where plan_id = '41000000-0000-0000-0000-000000000001') <> 1 then
    raise exception 'atomic order insert count mismatch';
  end if;
  if (select count(*) from public.trade_order_events where order_id = '51000000-0000-0000-0000-000000000001') <> 1 then
    raise exception 'atomic order event count mismatch';
  end if;
  select inserted into duplicate_inserted from public.create_trade_order_atomic(
    '11111111-1111-1111-1111-111111111111',
    '41000000-0000-0000-0000-000000000001',
    'SUBMITTED',
    '{"id":"51000000-0000-0000-0000-000000000002","userId":"11111111-1111-1111-1111-111111111111","planId":"41000000-0000-0000-0000-000000000001","exchange":"upbit","clientOrderId":"safety-client-b","state":"SUBMITTED","version":0,"createdAt":"2026-08-05T00:00:03.000Z","updatedAt":"2026-08-05T00:00:03.000Z"}',
    '{"id":"61000000-0000-0000-0000-000000000002","userId":"11111111-1111-1111-1111-111111111111","orderId":"51000000-0000-0000-0000-000000000002","toState":"SUBMITTED","reason":"ORDER_CREATED","createdAt":"2026-08-05T00:00:03.000Z"}'
  );
  if duplicate_inserted is distinct from false then raise exception 'duplicate order insert was not rejected'; end if;
end
$order_insert_atomic$;

select public.claim_trade_order_execution(
  '11111111-1111-1111-1111-111111111111',
  '51000000-0000-0000-0000-000000000001',
  0,
  '71000000-0000-0000-0000-000000000001',
  30
);

do $execution_claim$
begin
  if (select execution_claim_id from public.trade_orders where id = '51000000-0000-0000-0000-000000000001')
    <> '71000000-0000-0000-0000-000000000001'::uuid then
    raise exception 'execution claim missing';
  end if;
  if public.claim_trade_order_execution(
    '11111111-1111-1111-1111-111111111111',
    '51000000-0000-0000-0000-000000000001',
    0,
    '71000000-0000-0000-0000-000000000002',
    30
  ) is not null then
    raise exception 'second execution claim unexpectedly succeeded';
  end if;
end
$execution_claim$;

select public.transition_trade_order_atomic(
  '11111111-1111-1111-1111-111111111111',
  '51000000-0000-0000-0000-000000000001',
  'SUBMITTED', 1, 'ACCEPTED',
  '{"id":"51000000-0000-0000-0000-000000000001","userId":"11111111-1111-1111-1111-111111111111","planId":"41000000-0000-0000-0000-000000000001","exchange":"upbit","clientOrderId":"safety-client-a","exchangeOrderId":"exchange-a","state":"ACCEPTED","requestedQuantity":1,"remainingQuantity":1,"filledQuantity":0,"fills":[],"version":1,"cancelable":true,"providerStatusCode":"wait","updatedAt":"2026-08-05T00:00:04.000Z"}',
  '{"id":"61000000-0000-0000-0000-000000000003","userId":"11111111-1111-1111-1111-111111111111","orderId":"51000000-0000-0000-0000-000000000001","fromState":"SUBMITTED","toState":"ACCEPTED","reason":"EXCHANGE_RECONCILED","metadata":{},"createdAt":"2026-08-05T00:00:04.000Z"}'
);

do $order_cas_and_event$
begin
  if (select version from public.trade_orders where id = '51000000-0000-0000-0000-000000000001') <> 2 then
    raise exception 'order version did not advance through claim and transition';
  end if;
  if (select exchange_order_id from public.trade_orders where id = '51000000-0000-0000-0000-000000000001') <> 'exchange-a' then
    raise exception 'normalized exchange order id missing';
  end if;
  if (select count(*) from public.trade_order_events where order_id = '51000000-0000-0000-0000-000000000001') <> 2 then
    raise exception 'order transition event was not atomic';
  end if;
  if public.transition_trade_order_atomic(
    '11111111-1111-1111-1111-111111111111',
    '51000000-0000-0000-0000-000000000001',
    'SUBMITTED', 1, 'REJECTED', '{}',
    '{"id":"61000000-0000-0000-0000-000000000004","createdAt":"2026-08-05T00:00:05.000Z"}'
  ) is not null then
    raise exception 'stale order CAS unexpectedly succeeded';
  end if;
end
$order_cas_and_event$;

insert into public.trade_order_legs(
  user_id, id, plan_id, leg_key, leg_type, sequence_no, idempotency_key,
  planned_quantity, planned_price, state, payload
) values (
  '11111111-1111-1111-1111-111111111111', '81000000-0000-0000-0000-000000000001',
  '41000000-0000-0000-0000-000000000001', 'entry-1', 'ENTRY', 1, 'safety-plan-a:entry:1',
  1, 100, 'PLANNED', '{}'
);

insert into public.trade_protection_orders(
  user_id, id, parent_order_id, protection_type, sequence_no, client_order_id,
  quantity, trigger_price, reduce_only, state, payload
) values (
  '11111111-1111-1111-1111-111111111111', '91000000-0000-0000-0000-000000000001',
  '51000000-0000-0000-0000-000000000001', 'STOP', 1, 'protect-stop-a',
  1, 90, true, 'PENDING', '{}'
);

reset role;
select set_config('request.jwt.claim.sub', '', false);
