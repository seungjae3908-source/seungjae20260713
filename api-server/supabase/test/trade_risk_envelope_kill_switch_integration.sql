-- Disposable PostgreSQL verification for PR #51 risk-envelope invariants.
-- No private exchange, staging, or production connectivity is used.

begin;

do $invalid_envelope_rejected$
begin
  begin
    insert into public.trade_order_plans(
      user_id, id, idempotency_key, state, payload, approval_expires_at, version, created_at, updated_at
    ) values (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      '81000000-0000-0000-0000-000000000001',
      'risk-envelope-missing',
      'SUBMITTED',
      jsonb_build_object(
        'id', '81000000-0000-0000-0000-000000000001',
        'userId', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'state', 'SUBMITTED',
        'version', 0,
        'estimatedKrw', 100000,
        'splitRatios', jsonb_build_array(100),
        'approvalExpiresAt', (clock_timestamp() + interval '10 minutes')::text,
        'approvedAt', clock_timestamp()::text
      ),
      clock_timestamp() + interval '10 minutes',
      0,
      clock_timestamp(),
      clock_timestamp()
    );
    raise exception 'risk envelope invariant accepted SUBMITTED plan without envelope';
  exception
    when others then
      if sqlerrm = 'risk envelope invariant accepted SUBMITTED plan without envelope' then
        raise;
      end if;
      if position('TRADE_RISK_ENVELOPE_REQUIRED' in sqlerrm) = 0 then
        raise;
      end if;
  end;
end
$invalid_envelope_rejected$;

do $valid_plan_and_cancel$
declare
  v_user uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_plan uuid := '81000000-0000-0000-0000-000000000010';
  v_leg1 uuid := '81000000-0000-0000-0000-000000000011';
  v_leg2 uuid := '81000000-0000-0000-0000-000000000012';
  v_order1 uuid := '81000000-0000-0000-0000-000000000021';
  v_order2 uuid := '81000000-0000-0000-0000-000000000022';
  v_approved_at timestamptz := clock_timestamp();
  v_expires_at timestamptz := clock_timestamp() + interval '10 minutes';
  v_result jsonb;
  v_state text;
  v_event_count integer;
begin
  insert into public.trade_order_plans(
    user_id, id, idempotency_key, state, payload, approval_expires_at, version, created_at, updated_at
  ) values (
    v_user,
    v_plan,
    'risk-envelope-valid',
    'SUBMITTED',
    jsonb_build_object(
      'id', v_plan,
      'userId', v_user,
      'idempotencyKey', 'risk-envelope-valid',
      'state', 'SUBMITTED',
      'version', 0,
      'approvedAt', v_approved_at::text,
      'approvalExpiresAt', v_expires_at::text,
      'estimatedKrw', 100000,
      'quoteAmount', 100000,
      'splitRatios', jsonb_build_array(50, 50),
      'riskEnvelope', jsonb_build_object(
        'version', 1,
        'investmentKrw', 100000,
        'maxLossKrw', 5250,
        'maxSlippagePercent', 0.25,
        'maxSplitCount', 2,
        'allowCancelUnfilled', true,
        'stopMethod', 'fixed_stop',
        'emergencyExitScope', 'cancel_unfilled_and_reduce_only',
        'approvedAt', v_approved_at::text,
        'expiresAt', v_expires_at::text
      )
    ),
    v_expires_at,
    0,
    v_approved_at,
    v_approved_at
  );

  v_result := public.create_trade_split_orders_atomic(
    v_user,
    v_plan,
    'SUBMITTED',
    0,
    jsonb_build_array(
      jsonb_build_object(
        'id', v_leg1, 'userId', v_user, 'planId', v_plan,
        'legKey', 'entry-1', 'legType', 'ENTRY', 'sequenceNo', 1,
        'idempotencyKey', 'risk-leg-1', 'plannedQuoteAmount', 50000,
        'filledQuantity', 0, 'state', 'PLANNED', 'version', 0
      ),
      jsonb_build_object(
        'id', v_leg2, 'userId', v_user, 'planId', v_plan,
        'legKey', 'entry-2', 'legType', 'ENTRY', 'sequenceNo', 2,
        'idempotencyKey', 'risk-leg-2', 'plannedQuoteAmount', 50000,
        'filledQuantity', 0, 'state', 'PLANNED', 'version', 0
      )
    ),
    jsonb_build_array(
      jsonb_build_object(
        'id', v_order1, 'userId', v_user, 'planId', v_plan,
        'exchange', 'upbit', 'clientOrderId', 'risk-child-1', 'state', 'SUBMITTED',
        'version', 0, 'legId', v_leg1, 'legKey', 'entry-1',
        'legSequenceNo', 1, 'legCount', 2, 'requestedQuoteAmount', 50000,
        'previousChildOrderId', null, 'approvedPlanVersion', 0,
        'createdAt', v_approved_at::text, 'updatedAt', v_approved_at::text
      ),
      jsonb_build_object(
        'id', v_order2, 'userId', v_user, 'planId', v_plan,
        'exchange', 'upbit', 'clientOrderId', 'risk-child-2', 'state', 'PLANNED',
        'version', 0, 'legId', v_leg2, 'legKey', 'entry-2',
        'legSequenceNo', 2, 'legCount', 2, 'requestedQuoteAmount', 50000,
        'previousChildOrderId', v_order1, 'approvedPlanVersion', 0,
        'createdAt', v_approved_at::text, 'updatedAt', v_approved_at::text
      )
    ),
    jsonb_build_array(
      jsonb_build_object(
        'id', '81000000-0000-0000-0000-000000000031', 'userId', v_user,
        'orderId', v_order1, 'toState', 'SUBMITTED', 'reason', 'SPLIT_CHILD_CREATED',
        'createdAt', v_approved_at::text
      ),
      jsonb_build_object(
        'id', '81000000-0000-0000-0000-000000000032', 'userId', v_user,
        'orderId', v_order2, 'toState', 'PLANNED', 'reason', 'SPLIT_CHILD_CREATED',
        'createdAt', v_approved_at::text
      )
    )
  );
  if jsonb_array_length(v_result) <> 2 then
    raise exception 'split creation did not return two children';
  end if;

  update public.trade_orders
  set state = 'FILLED',
      version = version + 1,
      payload = jsonb_set(jsonb_set(payload, '{state}', '"FILLED"'::jsonb, true), '{version}', '1'::jsonb, true),
      updated_at = clock_timestamp()
  where user_id = v_user and id = v_order1 and state = 'SUBMITTED';
  if not found then raise exception 'first child could not be marked filled in disposable fixture'; end if;

  v_result := public.cancel_trade_split_children_atomic(
    v_user,
    v_plan,
    0,
    2,
    jsonb_build_array(
      jsonb_build_object(
        'id', '81000000-0000-0000-0000-000000000033',
        'userId', v_user,
        'orderId', v_order2,
        'fromState', 'PLANNED',
        'toState', 'CANCELED',
        'reason', 'FAST_MOVE_DETECTED_CANCEL_PENDING_SPLIT',
        'createdAt', clock_timestamp()::text
      )
    )
  );
  if v_result is null or jsonb_array_length(v_result) <> 2 then
    raise exception 'atomic split cancellation did not return full child set';
  end if;

  select state into v_state
  from public.trade_orders
  where user_id = v_user and id = v_order2;
  if v_state <> 'CANCELED' then
    raise exception 'pending split child was not canceled atomically';
  end if;

  select count(*) into v_event_count
  from public.trade_order_events
  where user_id = v_user
    and order_id = v_order2
    and to_state = 'CANCELED'
    and payload->>'reason' = 'FAST_MOVE_DETECTED_CANCEL_PENDING_SPLIT';
  if v_event_count <> 1 then
    raise exception 'atomic split cancellation audit event missing';
  end if;
end
$valid_plan_and_cancel$;

rollback;
