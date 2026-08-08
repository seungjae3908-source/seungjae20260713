-- Atomic parent/child split-order storage and sequencing.
-- CI/disposable PostgreSQL only until separately approved for an environment.
begin;

alter table public.trade_orders
  drop constraint if exists trade_orders_user_id_plan_id_key;

alter table public.trade_orders
  add column if not exists leg_id uuid,
  add column if not exists leg_key text,
  add column if not exists leg_sequence_no integer,
  add column if not exists leg_count integer,
  add column if not exists requested_quote_amount numeric,
  add column if not exists previous_child_order_id uuid,
  add column if not exists approved_plan_version bigint;

alter table public.trade_orders
  drop constraint if exists trade_orders_leg_sequence_check,
  add constraint trade_orders_leg_sequence_check
    check ((leg_sequence_no is null and leg_count is null)
      or (leg_sequence_no > 0 and leg_count > 0 and leg_sequence_no <= leg_count)),
  drop constraint if exists trade_orders_requested_quote_amount_check,
  add constraint trade_orders_requested_quote_amount_check
    check (requested_quote_amount is null or requested_quote_amount > 0),
  drop constraint if exists trade_orders_leg_fk,
  add constraint trade_orders_leg_fk
    foreign key (user_id, leg_id) references public.trade_order_legs(user_id, id) on delete restrict,
  drop constraint if exists trade_orders_previous_child_fk,
  add constraint trade_orders_previous_child_fk
    foreign key (user_id, previous_child_order_id) references public.trade_orders(user_id, id) on delete restrict;

create unique index if not exists trade_orders_plan_version_leg_unique_idx
  on public.trade_orders(user_id, plan_id, approved_plan_version, leg_sequence_no)
  where approved_plan_version is not null and leg_sequence_no is not null;

create unique index if not exists trade_orders_plan_leg_key_unique_idx
  on public.trade_orders(user_id, plan_id, leg_key)
  where leg_key is not null;

create or replace function public.create_trade_split_orders_atomic(
  p_user_id uuid,
  p_plan_id uuid,
  p_expected_plan_state text,
  p_expected_plan_version bigint,
  p_leg_payloads jsonb,
  p_order_payloads jsonb,
  p_event_payloads jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $create_trade_split_orders_atomic$
declare
  v_plan_payload jsonb;
  v_count integer;
  v_existing_count integer;
  v_index integer;
  v_leg jsonb;
  v_order jsonb;
  v_event jsonb;
  v_order_id uuid;
  v_leg_id uuid;
  v_previous_id uuid;
  v_quantity_total numeric;
  v_quote_total numeric;
  v_parent_quantity numeric;
  v_parent_quote numeric;
  v_result jsonb;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'USER_SCOPE_MISMATCH';
  end if;
  if jsonb_typeof(p_leg_payloads) <> 'array'
    or jsonb_typeof(p_order_payloads) <> 'array'
    or jsonb_typeof(p_event_payloads) <> 'array' then
    raise exception 'TRADE_SPLIT_ATOMIC_INPUT_INVALID';
  end if;

  v_count := jsonb_array_length(p_order_payloads);
  if v_count < 1 or v_count > 20
    or jsonb_array_length(p_leg_payloads) <> v_count
    or jsonb_array_length(p_event_payloads) <> v_count then
    raise exception 'TRADE_SPLIT_ATOMIC_COUNT_INVALID';
  end if;

  select payload into v_plan_payload
  from public.trade_order_plans
  where user_id = p_user_id
    and id = p_plan_id
    and state = p_expected_plan_state
    and version = p_expected_plan_version
  for update;
  if v_plan_payload is null then
    return null;
  end if;

  select count(*) into v_existing_count
  from public.trade_orders
  where user_id = p_user_id
    and plan_id = p_plan_id
    and approved_plan_version = p_expected_plan_version;
  if v_existing_count > 0 then
    if v_existing_count <> v_count then
      raise exception 'TRADE_SPLIT_IDEMPOTENCY_MISMATCH';
    end if;
    select jsonb_agg(payload order by leg_sequence_no) into v_result
    from public.trade_orders
    where user_id = p_user_id
      and plan_id = p_plan_id
      and approved_plan_version = p_expected_plan_version;
    return v_result;
  end if;

  select coalesce(sum(nullif(item->>'requestedQuantity', '')::numeric), 0),
         coalesce(sum(nullif(item->>'requestedQuoteAmount', '')::numeric), 0)
    into v_quantity_total, v_quote_total
  from jsonb_array_elements(p_order_payloads) item;
  v_parent_quantity := nullif(v_plan_payload->>'quantity', '')::numeric;
  v_parent_quote := nullif(v_plan_payload->>'quoteAmount', '')::numeric;
  if v_parent_quantity is not null and v_quantity_total > v_parent_quantity then
    raise exception 'TRADE_SPLIT_QUANTITY_EXCEEDS_PARENT';
  end if;
  if v_parent_quote is not null and v_quote_total > v_parent_quote then
    raise exception 'TRADE_SPLIT_QUOTE_EXCEEDS_PARENT';
  end if;

  for v_index in 0..v_count - 1 loop
    v_leg := p_leg_payloads->v_index;
    v_order := p_order_payloads->v_index;
    v_event := p_event_payloads->v_index;
    v_leg_id := nullif(v_leg->>'id', '')::uuid;
    v_order_id := nullif(v_order->>'id', '')::uuid;
    v_previous_id := nullif(v_order->>'previousChildOrderId', '')::uuid;

    if v_leg_id is null or v_order_id is null
      or nullif(v_event->>'id', '')::uuid is null
      or (v_leg->>'sequenceNo')::integer <> v_index + 1
      or (v_order->>'legSequenceNo')::integer <> v_index + 1
      or (v_order->>'legCount')::integer <> v_count
      or nullif(v_order->>'legId', '')::uuid <> v_leg_id
      or (v_index = 0 and v_previous_id is not null)
      or (v_index > 0 and v_previous_id <> nullif((p_order_payloads->(v_index - 1))->>'id', '')::uuid)
      or (v_index = 0 and v_order->>'state' <> 'SUBMITTED')
      or (v_index > 0 and v_order->>'state' <> 'PLANNED') then
      raise exception 'TRADE_SPLIT_CHILD_CONTRACT_INVALID';
    end if;

    insert into public.trade_order_legs(
      user_id, id, plan_id, leg_key, leg_type, sequence_no, idempotency_key,
      planned_quantity, planned_quote_amount, planned_price, filled_quantity,
      state, payload, version, created_at, updated_at
    ) values (
      p_user_id, v_leg_id, p_plan_id, v_leg->>'legKey', v_leg->>'legType',
      (v_leg->>'sequenceNo')::integer, v_leg->>'idempotencyKey',
      nullif(v_leg->>'plannedQuantity', '')::numeric,
      nullif(v_leg->>'plannedQuoteAmount', '')::numeric,
      nullif(v_leg->>'plannedPrice', '')::numeric,
      coalesce(nullif(v_leg->>'filledQuantity', '')::numeric, 0),
      v_leg->>'state', v_leg, coalesce(nullif(v_leg->>'version', '')::bigint, 0),
      coalesce(nullif(v_order->>'createdAt', '')::timestamptz, clock_timestamp()),
      coalesce(nullif(v_order->>'updatedAt', '')::timestamptz, clock_timestamp())
    );

    insert into public.trade_orders(
      user_id, id, plan_id, exchange, client_order_id, exchange_order_id, state,
      payload, remaining_quantity, fills, fee_amount, fee_currency, cancelable,
      provider_status_code, version, leg_id, leg_key, leg_sequence_no, leg_count,
      requested_quote_amount, previous_child_order_id, approved_plan_version,
      created_at, updated_at
    ) values (
      p_user_id, v_order_id, p_plan_id, v_order->>'exchange', v_order->>'clientOrderId',
      nullif(v_order->>'exchangeOrderId', ''), v_order->>'state', v_order,
      nullif(v_order->>'remainingQuantity', '')::numeric,
      coalesce(v_order->'fills', '[]'::jsonb),
      nullif(v_order->>'feeAmount', '')::numeric,
      nullif(v_order->>'feeCurrency', ''),
      nullif(v_order->>'cancelable', '')::boolean,
      nullif(v_order->>'providerStatusCode', ''),
      coalesce(nullif(v_order->>'version', '')::bigint, 0),
      v_leg_id, v_order->>'legKey', (v_order->>'legSequenceNo')::integer,
      (v_order->>'legCount')::integer,
      nullif(v_order->>'requestedQuoteAmount', '')::numeric,
      v_previous_id, p_expected_plan_version,
      coalesce(nullif(v_order->>'createdAt', '')::timestamptz, clock_timestamp()),
      coalesce(nullif(v_order->>'updatedAt', '')::timestamptz, clock_timestamp())
    );

    insert into public.trade_order_events(user_id, id, order_id, to_state, payload, created_at)
    values (
      p_user_id, nullif(v_event->>'id', '')::uuid, v_order_id, v_event->>'toState',
      v_event, coalesce(nullif(v_event->>'createdAt', '')::timestamptz, clock_timestamp())
    );
  end loop;

  select jsonb_agg(payload order by leg_sequence_no) into v_result
  from public.trade_orders
  where user_id = p_user_id
    and plan_id = p_plan_id
    and approved_plan_version = p_expected_plan_version;
  return v_result;
end
$create_trade_split_orders_atomic$;

create or replace function public.activate_next_trade_split_child_atomic(
  p_user_id uuid,
  p_order_id uuid,
  p_expected_version bigint,
  p_order_payload jsonb,
  p_event_payload jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $activate_next_trade_split_child_atomic$
declare
  v_result jsonb;
  v_sequence integer;
  v_previous uuid;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'USER_SCOPE_MISMATCH';
  end if;
  select leg_sequence_no, previous_child_order_id
    into v_sequence, v_previous
  from public.trade_orders
  where user_id = p_user_id and id = p_order_id and state = 'PLANNED' and version = p_expected_version
  for update;
  if not found then return null; end if;
  if v_sequence > 1 and not exists (
    select 1 from public.trade_orders
    where user_id = p_user_id and id = v_previous and state = 'FILLED'
  ) then
    return null;
  end if;

  update public.trade_orders
  set state = 'SUBMITTED', version = version + 1,
      payload = jsonb_set(jsonb_set(p_order_payload, '{state}', '"SUBMITTED"'::jsonb, true),
        '{version}', to_jsonb(p_expected_version + 1), true),
      updated_at = clock_timestamp()
  where user_id = p_user_id and id = p_order_id and state = 'PLANNED' and version = p_expected_version
  returning payload into v_result;
  if v_result is null then return null; end if;

  insert into public.trade_order_events(user_id, id, order_id, to_state, payload, created_at)
  values (p_user_id, nullif(p_event_payload->>'id', '')::uuid, p_order_id, 'SUBMITTED',
    p_event_payload, coalesce(nullif(p_event_payload->>'createdAt', '')::timestamptz, clock_timestamp()));
  return v_result;
end
$activate_next_trade_split_child_atomic$;

revoke all on function public.create_trade_split_orders_atomic(uuid, uuid, text, bigint, jsonb, jsonb, jsonb)
  from public, anon;
revoke all on function public.activate_next_trade_split_child_atomic(uuid, uuid, bigint, jsonb, jsonb)
  from public, anon;
grant execute on function public.create_trade_split_orders_atomic(uuid, uuid, text, bigint, jsonb, jsonb, jsonb)
  to authenticated;
grant execute on function public.activate_next_trade_split_child_atomic(uuid, uuid, bigint, jsonb, jsonb)
  to authenticated;

commit;
