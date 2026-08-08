-- Disposable PostgreSQL verification for PR #51 risk-envelope invariants.
-- No private exchange, staging, or production connectivity is used.

begin;

create or replace function pg_temp.assert_risk_plan_rejected(
  p_key text,
  p_payload jsonb,
  p_approval_expires_at timestamptz,
  p_expected_error text
)
returns void
language plpgsql
as $assert_risk_plan_rejected$
begin
  begin
    insert into public.trade_order_plans(
      user_id, id, idempotency_key, state, payload, approval_expires_at, version, created_at, updated_at
    ) values (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      gen_random_uuid(),
      p_key,
      'SUBMITTED',
      p_payload,
      p_approval_expires_at,
      0,
      clock_timestamp(),
      clock_timestamp()
    );
    raise exception 'RISK_ENVELOPE_TEST_UNEXPECTED_ACCEPT:%', p_key;
  exception
    when others then
      if position('RISK_ENVELOPE_TEST_UNEXPECTED_ACCEPT:' in sqlerrm) = 1 then
        raise;
      end if;
      if position(p_expected_error in sqlerrm) = 0 then
        raise exception 'risk envelope case % expected %, got %', p_key, p_expected_error, sqlerrm;
      end if;
  end;
end
$assert_risk_plan_rejected$;

do $risk_envelope_rejections$
declare
  v_user uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_approved_at timestamptz := clock_timestamp();
  v_expires_at timestamptz := clock_timestamp() + interval '10 minutes';
  v_expired_approved_at timestamptz := clock_timestamp() - interval '20 minutes';
  v_expired_at timestamptz := clock_timestamp() - interval '10 minutes';
  v_base jsonb;
begin
  v_base := jsonb_build_object(
    'id', gen_random_uuid(),
    'userId', v_user,
    'state', 'SUBMITTED',
    'version', 0,
    'approvedAt', v_approved_at::text,
    'approvalExpiresAt', v_expires_at::text,
    'estimatedKrw', 100000,
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
  );

  perform pg_temp.assert_risk_plan_rejected(
    'risk-envelope-missing',
    v_base - 'riskEnvelope',
    v_expires_at,
    'TRADE_RISK_ENVELOPE_REQUIRED'
  );

  perform pg_temp.assert_risk_plan_rejected(
    'risk-approval-missing',
    v_base - 'approvedAt',
    v_expires_at,
    'TRADE_RISK_ENVELOPE_APPROVAL_MISMATCH'
  );

  perform pg_temp.assert_risk_plan_rejected(
    'risk-envelope-expired',
    jsonb_set(
      jsonb_set(
        jsonb_set(v_base, '{approvedAt}', to_jsonb(v_expired_approved_at::text), true),
        '{approvalExpiresAt}', to_jsonb(v_expired_at::text), true
      ),
      '{riskEnvelope}',
      jsonb_set(
        jsonb_set(v_base->'riskEnvelope', '{approvedAt}', to_jsonb(v_expired_approved_at::text), true),
        '{expiresAt}', to_jsonb(v_expired_at::text), true
      ),
      true
    ),
    v_expired_at,
    'TRADE_RISK_ENVELOPE_EXPIRED'
  );

  perform pg_temp.assert_risk_plan_rejected(
    'risk-investment-exceeded',
    jsonb_set(v_base, '{riskEnvelope,investmentKrw}', '99999'::jsonb, true),
    v_expires_at,
    'TRADE_RISK_ENVELOPE_LIMIT_INVALID'
  );

  perform pg_temp.assert_risk_plan_rejected(
    'risk-max-loss-invalid',
    jsonb_set(v_base, '{riskEnvelope,maxLossKrw}', '0'::jsonb, true),
    v_expires_at,
    'TRADE_RISK_ENVELOPE_LIMIT_INVALID'
  );

  perform pg_temp.assert_risk_plan_rejected(
    'risk-slippage-invalid',
    jsonb_set(v_base, '{riskEnvelope,maxSlippagePercent}', '-0.01'::jsonb, true),
    v_expires_at,
    'TRADE_RISK_ENVELOPE_LIMIT_INVALID'
  );

  perform pg_temp.assert_risk_plan_rejected(
    'risk-split-count-exceeded',
    jsonb_set(v_base, '{riskEnvelope,maxSplitCount}', '1'::jsonb, true),
    v_expires_at,
    'TRADE_RISK_ENVELOPE_SPLIT_EXCEEDED'
  );
end
$risk_envelope_rejections$;

do $valid_plan_cancel_replay_and_cas$
declare
  v_user uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_plan uuid := '81000000-0000-0000-0000-000000000010';
  v_leg1 uuid := '81000000-0000-0000-0000-000000000011';
  v_leg2 uuid := '81000000-0000-0000-0000-000000000012';
  v_order1 uuid := '81000000-0000-0000-0000-000000000021';
  v_order2 uuid := '81000000-0000-0000-0000-000000000022';
  v_event_id uuid := '81000000-0000-0000-0000-000000000033';
  v_approved_at timestamptz := clock_timestamp();
  v_expires_at timestamptz := clock_timestamp() + interval '10 minutes';
  v_cancel_at timestamptz := clock_timestamp();
  v_cancel_event jsonb;
  v_cancel_events jsonb;
  v_result jsonb;
  v_state text;
  v_version bigint;
  v_event_count integer;
  v_from_state text;
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

  v_cancel_event := jsonb_build_object(
    'id', v_event_id,
    'userId', v_user,
    'orderId', v_order2,
    'fromState', 'PLANNED',
    'toState', 'CANCELED',
    'reason', 'FAST_MOVE_DETECTED_CANCEL_PENDING_SPLIT',
    'createdAt', v_cancel_at::text
  );
  v_cancel_events := jsonb_build_array(v_cancel_event);

  v_result := public.cancel_trade_split_children_atomic(v_user, v_plan, 0, 2, v_cancel_events);
  if v_result is null or jsonb_array_length(v_result) <> 2 then
    raise exception 'atomic split cancellation did not return full child set';
  end if;

  select state, version into v_state, v_version
  from public.trade_orders
  where user_id = v_user and id = v_order2;
  if v_state <> 'CANCELED' or v_version <> 1 then
    raise exception 'pending split child was not canceled exactly once: %/%', v_state, v_version;
  end if;

  select state, version into v_state, v_version
  from public.trade_orders
  where user_id = v_user and id = v_order1;
  if v_state <> 'FILLED' or v_version <> 1 then
    raise exception 'filled split child was modified by cancellation: %/%', v_state, v_version;
  end if;

  select count(*), max(payload->>'fromState')
  into v_event_count, v_from_state
  from public.trade_order_events
  where user_id = v_user
    and order_id = v_order2
    and to_state = 'CANCELED'
    and payload->>'reason' = 'FAST_MOVE_DETECTED_CANCEL_PENDING_SPLIT';
  if v_event_count <> 1 or v_from_state <> 'PLANNED' then
    raise exception 'atomic split cancellation audit contract mismatch: %/%', v_event_count, v_from_state;
  end if;

  v_result := public.cancel_trade_split_children_atomic(v_user, v_plan, 0, 2, v_cancel_events);
  if v_result is null or jsonb_array_length(v_result) <> 2 then
    raise exception 'duplicate cancellation replay did not return current child set';
  end if;
  select version into v_version from public.trade_orders where user_id = v_user and id = v_order2;
  select count(*) into v_event_count
  from public.trade_order_events
  where user_id = v_user and id = v_event_id and order_id = v_order2 and to_state = 'CANCELED';
  if v_version <> 1 or v_event_count <> 1 then
    raise exception 'duplicate cancellation was not idempotent: version=% event_count=%', v_version, v_event_count;
  end if;

  v_result := public.cancel_trade_split_children_atomic(v_user, v_plan, 1, 2, v_cancel_events);
  if v_result is not null then
    raise exception 'stale approved plan version unexpectedly passed CAS';
  end if;
  select version into v_version from public.trade_orders where user_id = v_user and id = v_order2;
  select count(*) into v_event_count
  from public.trade_order_events
  where user_id = v_user and id = v_event_id;
  if v_version <> 1 or v_event_count <> 1 then
    raise exception 'stale CAS mutated cancellation state';
  end if;
end
$valid_plan_cancel_replay_and_cas$;

rollback;
