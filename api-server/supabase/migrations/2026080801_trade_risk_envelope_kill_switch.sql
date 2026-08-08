-- Risk-envelope invariant and atomic cancellation for unsubmitted split children.
-- CI/disposable PostgreSQL only. Do not apply to staging or production without separate approval.
begin;

create or replace function public.enforce_trade_plan_risk_envelope()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $enforce_trade_plan_risk_envelope$
declare
  v_envelope jsonb;
  v_approved_at timestamptz;
  v_expires_at timestamptz;
  v_estimated numeric;
  v_investment numeric;
  v_max_loss numeric;
  v_max_slippage numeric;
  v_max_splits integer;
  v_split_count integer;
begin
  if new.state <> 'SUBMITTED' then
    return new;
  end if;

  v_envelope := new.payload->'riskEnvelope';
  if v_envelope is null or jsonb_typeof(v_envelope) <> 'object' then
    raise exception 'TRADE_RISK_ENVELOPE_REQUIRED';
  end if;
  if coalesce((v_envelope->>'version')::integer, 0) <> 1
    or coalesce((v_envelope->>'allowCancelUnfilled')::boolean, false) is not true
    or v_envelope->>'stopMethod' <> 'fixed_stop'
    or v_envelope->>'emergencyExitScope' <> 'cancel_unfilled_and_reduce_only' then
    raise exception 'TRADE_RISK_ENVELOPE_INVALID';
  end if;

  v_approved_at := nullif(v_envelope->>'approvedAt', '')::timestamptz;
  v_expires_at := nullif(v_envelope->>'expiresAt', '')::timestamptz;
  if v_approved_at is null or v_expires_at is null or v_expires_at <= v_approved_at then
    raise exception 'TRADE_RISK_ENVELOPE_EXPIRATION_INVALID';
  end if;
  if nullif(new.payload->>'approvedAt', '')::timestamptz is distinct from v_approved_at then
    raise exception 'TRADE_RISK_ENVELOPE_APPROVAL_MISMATCH';
  end if;
  if nullif(new.payload->>'approvalExpiresAt', '')::timestamptz is distinct from v_expires_at then
    raise exception 'TRADE_RISK_ENVELOPE_EXPIRATION_MISMATCH';
  end if;

  v_estimated := nullif(new.payload->>'estimatedKrw', '')::numeric;
  v_investment := nullif(v_envelope->>'investmentKrw', '')::numeric;
  v_max_loss := nullif(v_envelope->>'maxLossKrw', '')::numeric;
  v_max_slippage := nullif(v_envelope->>'maxSlippagePercent', '')::numeric;
  v_max_splits := nullif(v_envelope->>'maxSplitCount', '')::integer;
  if v_estimated is null or v_estimated <= 0
    or v_investment is null or v_investment <= 0 or v_investment < v_estimated
    or v_max_loss is null or v_max_loss <= 0
    or v_max_slippage is null or v_max_slippage < 0
    or v_max_splits is null or v_max_splits < 1 then
    raise exception 'TRADE_RISK_ENVELOPE_LIMIT_INVALID';
  end if;

  if jsonb_typeof(new.payload->'splitRatios') <> 'array' then
    raise exception 'TRADE_RISK_ENVELOPE_SPLIT_INVALID';
  end if;
  v_split_count := jsonb_array_length(new.payload->'splitRatios');
  if v_split_count < 1 or v_split_count > v_max_splits then
    raise exception 'TRADE_RISK_ENVELOPE_SPLIT_EXCEEDED';
  end if;

  return new;
end
$enforce_trade_plan_risk_envelope$;

drop trigger if exists trade_order_plans_risk_envelope_guard on public.trade_order_plans;
create trigger trade_order_plans_risk_envelope_guard
before insert or update of state, payload on public.trade_order_plans
for each row execute function public.enforce_trade_plan_risk_envelope();

create or replace function public.cancel_trade_split_children_atomic(
  p_user_id uuid,
  p_plan_id uuid,
  p_approved_plan_version bigint,
  p_from_sequence integer,
  p_event_payloads jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $cancel_trade_split_children_atomic$
declare
  v_expected integer;
  v_index integer := 0;
  v_order record;
  v_event jsonb;
  v_payload jsonb;
  v_result jsonb;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'USER_SCOPE_MISMATCH';
  end if;
  if p_from_sequence < 1 or jsonb_typeof(p_event_payloads) <> 'array' then
    raise exception 'TRADE_SPLIT_CANCEL_INPUT_INVALID';
  end if;

  perform 1
  from public.trade_order_plans
  where user_id = p_user_id
    and id = p_plan_id
    and state = 'SUBMITTED'
    and version = p_approved_plan_version
  for update;
  if not found then return null; end if;

  select count(*) into v_expected
  from public.trade_orders
  where user_id = p_user_id
    and plan_id = p_plan_id
    and approved_plan_version = p_approved_plan_version
    and leg_sequence_no >= p_from_sequence
    and state = 'PLANNED';

  if jsonb_array_length(p_event_payloads) <> v_expected then
    raise exception 'TRADE_SPLIT_CANCEL_EVENT_COUNT_MISMATCH';
  end if;

  for v_order in
    select id, version, payload
    from public.trade_orders
    where user_id = p_user_id
      and plan_id = p_plan_id
      and approved_plan_version = p_approved_plan_version
      and leg_sequence_no >= p_from_sequence
      and state = 'PLANNED'
    order by leg_sequence_no
    for update
  loop
    v_event := p_event_payloads->v_index;
    if nullif(v_event->>'id', '')::uuid is null
      or nullif(v_event->>'orderId', '')::uuid <> v_order.id
      or v_event->>'toState' <> 'CANCELED' then
      raise exception 'TRADE_SPLIT_CANCEL_EVENT_INVALID';
    end if;

    v_payload := jsonb_set(
      jsonb_set(v_order.payload, '{state}', '"CANCELED"'::jsonb, true),
      '{version}', to_jsonb(v_order.version + 1), true
    );
    v_payload := jsonb_set(v_payload, '{updatedAt}', to_jsonb(clock_timestamp()::text), true);

    update public.trade_orders
    set state = 'CANCELED',
        version = version + 1,
        payload = v_payload,
        updated_at = clock_timestamp()
    where user_id = p_user_id and id = v_order.id and state = 'PLANNED' and version = v_order.version;
    if not found then
      raise exception 'TRADE_SPLIT_CANCEL_CONCURRENT_CHANGE';
    end if;

    insert into public.trade_order_events(user_id, id, order_id, from_state, to_state, payload, created_at)
    values (
      p_user_id,
      nullif(v_event->>'id', '')::uuid,
      v_order.id,
      'PLANNED',
      'CANCELED',
      v_event,
      coalesce(nullif(v_event->>'createdAt', '')::timestamptz, clock_timestamp())
    );
    v_index := v_index + 1;
  end loop;

  select jsonb_agg(payload order by leg_sequence_no) into v_result
  from public.trade_orders
  where user_id = p_user_id
    and plan_id = p_plan_id
    and approved_plan_version = p_approved_plan_version;
  return coalesce(v_result, '[]'::jsonb);
end
$cancel_trade_split_children_atomic$;

revoke all on function public.cancel_trade_split_children_atomic(uuid, uuid, bigint, integer, jsonb)
  from public, anon;
grant execute on function public.cancel_trade_split_children_atomic(uuid, uuid, bigint, integer, jsonb)
  to authenticated;

commit;
