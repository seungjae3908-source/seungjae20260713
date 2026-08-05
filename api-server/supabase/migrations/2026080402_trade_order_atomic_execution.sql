-- Trade order atomic execution hardening for PR #51.
-- Review/CI only: do not apply to staging or production without separate approval.
-- The verification harness reapplies this migration, so owned columns must be
-- created idempotently while the paired rollback remains responsible for them.
begin;

alter table public.trade_orders
  add column if not exists execution_claim_id uuid;
alter table public.trade_orders
  add column if not exists execution_claimed_at timestamptz;

create or replace function public.submit_trade_plan_order(
  p_expected_state text,
  p_plan_payload jsonb,
  p_order_payload jsonb,
  p_event_payload jsonb,
  p_execution_claim_id uuid
)
returns table (
  plan_payload jsonb,
  order_payload jsonb,
  transitioned boolean,
  order_inserted boolean,
  execution_claimed boolean
)
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $submit_trade_plan_order$
declare
  administrator_id uuid := auth.uid();
  v_plan_id uuid;
  v_order_id uuid;
  v_event_id uuid;
  v_plan_state text;
  v_plan_payload jsonb;
  v_order_payload jsonb;
  v_order_claim_id uuid;
begin
  if administrator_id is null then
    raise exception 'LOGIN_REQUIRED';
  end if;
  if public.current_membership_level() <> 'admin' then
    raise exception 'ADMIN_REQUIRED';
  end if;
  if p_expected_state not in ('APPROVAL_PENDING', 'PLANNED') then
    raise exception 'TRADE_ATOMIC_EXPECTED_STATE_INVALID';
  end if;
  if p_execution_claim_id is null then
    raise exception 'TRADE_ATOMIC_CLAIM_REQUIRED';
  end if;

  begin
    v_plan_id := nullif(p_plan_payload->>'id', '')::uuid;
    v_order_id := nullif(p_order_payload->>'id', '')::uuid;
    v_event_id := nullif(p_event_payload->>'id', '')::uuid;
  exception when invalid_text_representation then
    raise exception 'TRADE_ATOMIC_INPUT_INVALID';
  end;

  if v_plan_id is null or v_order_id is null or v_event_id is null then
    raise exception 'TRADE_ATOMIC_INPUT_INVALID';
  end if;
  if p_plan_payload->>'userId' <> administrator_id::text
    or p_order_payload->>'userId' <> administrator_id::text
    or p_event_payload->>'userId' <> administrator_id::text then
    raise exception 'USER_SCOPE_MISMATCH';
  end if;
  if p_order_payload->>'planId' <> v_plan_id::text
    or p_event_payload->>'orderId' <> v_order_id::text then
    raise exception 'TRADE_ATOMIC_RELATION_MISMATCH';
  end if;
  if p_plan_payload->>'state' <> 'SUBMITTED'
    or p_order_payload->>'state' <> 'SUBMITTED'
    or p_event_payload->>'toState' <> 'SUBMITTED'
    or p_event_payload->>'reason' <> 'ORDER_CREATED' then
    raise exception 'TRADE_ATOMIC_STATE_INVALID';
  end if;

  select candidate.state, candidate.payload
  into v_plan_state, v_plan_payload
  from public.trade_order_plans candidate
  where candidate.user_id = administrator_id
    and candidate.id = v_plan_id
  for update;

  if not found then
    return;
  end if;

  if v_plan_state = 'SUBMITTED' then
    select candidate.payload, candidate.execution_claim_id
    into v_order_payload, v_order_claim_id
    from public.trade_orders candidate
    where candidate.user_id = administrator_id
      and candidate.plan_id = v_plan_id
    for update;

    if not found then
      raise exception 'TRADE_ATOMIC_ORDER_MISSING';
    end if;
    if v_order_payload->>'planId' <> v_plan_id::text
      or v_order_payload->>'exchange' <> p_order_payload->>'exchange'
      or v_order_payload->>'clientOrderId' <> p_order_payload->>'clientOrderId' then
      raise exception 'TRADE_ATOMIC_ORDER_CONFLICT';
    end if;

    return query select
      v_plan_payload,
      v_order_payload,
      false,
      false,
      false;
    return;
  end if;

  if v_plan_state <> p_expected_state then
    return;
  end if;

  if exists (
    select 1
    from public.trade_orders candidate
    where candidate.user_id = administrator_id
      and candidate.plan_id = v_plan_id
  ) then
    raise exception 'TRADE_ATOMIC_ORDER_PREEXISTS';
  end if;

  update public.trade_order_plans
  set state = 'SUBMITTED',
      payload = p_plan_payload,
      approval_expires_at = case
        when nullif(p_plan_payload->>'approvalExpiresAt', '') is null then null
        else (p_plan_payload->>'approvalExpiresAt')::timestamptz
      end,
      updated_at = coalesce(
        nullif(p_plan_payload->>'updatedAt', '')::timestamptz,
        clock_timestamp()
      )
  where user_id = administrator_id
    and id = v_plan_id
    and state = p_expected_state
  returning payload into v_plan_payload;

  if not found then
    return;
  end if;

  insert into public.trade_orders(
    user_id,
    id,
    plan_id,
    exchange,
    client_order_id,
    state,
    payload,
    execution_claim_id,
    execution_claimed_at,
    created_at,
    updated_at
  ) values (
    administrator_id,
    v_order_id,
    v_plan_id,
    p_order_payload->>'exchange',
    p_order_payload->>'clientOrderId',
    'SUBMITTED',
    p_order_payload,
    p_execution_claim_id,
    clock_timestamp(),
    coalesce(nullif(p_order_payload->>'createdAt', '')::timestamptz, clock_timestamp()),
    coalesce(nullif(p_order_payload->>'updatedAt', '')::timestamptz, clock_timestamp())
  )
  returning payload into v_order_payload;

  insert into public.trade_order_events(
    user_id,
    id,
    order_id,
    to_state,
    payload,
    created_at
  ) values (
    administrator_id,
    v_event_id,
    v_order_id,
    'SUBMITTED',
    p_event_payload,
    coalesce(nullif(p_event_payload->>'createdAt', '')::timestamptz, clock_timestamp())
  );

  return query select
    v_plan_payload,
    v_order_payload,
    true,
    true,
    true;
end
$submit_trade_plan_order$;

revoke all on function public.submit_trade_plan_order(text, jsonb, jsonb, jsonb, uuid)
  from public, anon;
grant execute on function public.submit_trade_plan_order(text, jsonb, jsonb, jsonb, uuid)
  to authenticated;

commit;
