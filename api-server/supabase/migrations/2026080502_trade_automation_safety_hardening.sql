-- Durable trade automation safety contracts.
-- CI/disposable PostgreSQL only until a separate production migration approval.
begin;

alter table public.trade_order_plans
  add column if not exists version bigint not null default 0;

alter table public.trade_orders
  add column if not exists version bigint not null default 0,
  add column if not exists exchange_order_id text,
  add column if not exists remaining_quantity numeric,
  add column if not exists fills jsonb not null default '[]'::jsonb,
  add column if not exists fee_amount numeric,
  add column if not exists fee_currency text,
  add column if not exists exchange_created_at timestamptz,
  add column if not exists exchange_updated_at timestamptz,
  add column if not exists cancelable boolean,
  add column if not exists provider_status_code text,
  add column if not exists next_retry_at timestamptz,
  add column if not exists last_reconciled_at timestamptz,
  add column if not exists manual_review_required boolean not null default false,
  add column if not exists execution_claim_id uuid,
  add column if not exists execution_claimed_at timestamptz,
  add column if not exists recovery_lease_owner uuid,
  add column if not exists recovery_lease_until timestamptz,
  add column if not exists protection_status text not null default 'NOT_REQUIRED'
    check (protection_status in ('NOT_REQUIRED', 'PENDING', 'PROTECTED', 'UNPROTECTED_POSITION')),
  add column if not exists protection_error_code text;

create unique index if not exists trade_orders_exchange_order_unique_idx
  on public.trade_orders(exchange, exchange_order_id)
  where exchange_order_id is not null;

create index if not exists trade_orders_recovery_due_idx
  on public.trade_orders(next_retry_at, updated_at)
  where state in ('SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'CANCEL_REQUESTED', 'RECOVERY_REQUIRED');

create table if not exists public.trade_order_legs (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  plan_id uuid not null,
  leg_key text not null,
  leg_type text not null check (leg_type in ('ENTRY', 'TARGET', 'STOP')),
  sequence_no integer not null check (sequence_no > 0),
  idempotency_key text not null,
  planned_quantity numeric,
  planned_quote_amount numeric,
  planned_price numeric,
  filled_quantity numeric not null default 0,
  state text not null default 'PLANNED',
  payload jsonb not null,
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, plan_id) references public.trade_order_plans(user_id, id) on delete restrict,
  unique (user_id, plan_id, leg_key),
  unique (user_id, idempotency_key)
);

create table if not exists public.trade_protection_orders (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  parent_order_id uuid not null,
  protection_type text not null check (protection_type in ('STOP', 'TARGET')),
  sequence_no integer not null check (sequence_no > 0),
  client_order_id text not null,
  exchange_order_id text,
  quantity numeric not null check (quantity >= 0),
  trigger_price numeric not null check (trigger_price > 0),
  reduce_only boolean not null default true,
  state text not null,
  payload jsonb not null,
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, parent_order_id) references public.trade_orders(user_id, id) on delete restrict,
  unique (user_id, parent_order_id, protection_type, sequence_no),
  unique (user_id, client_order_id)
);

create unique index if not exists trade_protection_exchange_order_unique_idx
  on public.trade_protection_orders(exchange_order_id)
  where exchange_order_id is not null;

alter table public.trade_order_legs enable row level security;
alter table public.trade_protection_orders enable row level security;

do $trade_safety_rls$
declare
  candidate_table text;
  own_and_allowed text := '(auth.uid() = user_id and public.current_membership_level() in (''regular'', ''admin''))';
begin
  foreach candidate_table in array array['trade_order_legs', 'trade_protection_orders']
  loop
    execute format('drop policy if exists %I on public.%I', candidate_table || ' select own', candidate_table);
    execute format('create policy %I on public.%I for select using %s', candidate_table || ' select own', candidate_table, own_and_allowed);
    execute format('drop policy if exists %I on public.%I', candidate_table || ' insert own', candidate_table);
    execute format('create policy %I on public.%I for insert with check %s', candidate_table || ' insert own', candidate_table, own_and_allowed);
    execute format('drop policy if exists %I on public.%I', candidate_table || ' update own', candidate_table);
    execute format('create policy %I on public.%I for update using %s with check %s', candidate_table || ' update own', candidate_table, own_and_allowed, own_and_allowed);
    execute format('drop policy if exists %I on public.%I', candidate_table || ' delete own', candidate_table);
    execute format('create policy %I on public.%I for delete using %s', candidate_table || ' delete own', candidate_table, own_and_allowed);
  end loop;
end
$trade_safety_rls$;

grant select, insert, update, delete on public.trade_order_legs, public.trade_protection_orders to authenticated;

create or replace function public.transition_trade_plan_atomic(
  p_user_id uuid,
  p_plan_id uuid,
  p_expected_state text,
  p_expected_version bigint,
  p_next_state text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $transition_trade_plan_atomic$
declare
  result jsonb;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'USER_SCOPE_MISMATCH';
  end if;
  update public.trade_order_plans
  set state = p_next_state,
      version = version + 1,
      payload = jsonb_set(p_payload, '{version}', to_jsonb(version + 1), true),
      approval_expires_at = case
        when nullif(p_payload->>'approvalExpiresAt', '') is null then null
        else (p_payload->>'approvalExpiresAt')::timestamptz
      end,
      updated_at = coalesce(nullif(p_payload->>'updatedAt', '')::timestamptz, clock_timestamp())
  where user_id = p_user_id
    and id = p_plan_id
    and state = p_expected_state
    and version = p_expected_version
  returning payload into result;
  return result;
end
$transition_trade_plan_atomic$;

create or replace function public.create_trade_order_atomic(
  p_user_id uuid,
  p_plan_id uuid,
  p_expected_plan_state text,
  p_order_payload jsonb,
  p_event_payload jsonb
)
returns table(order_payload jsonb, inserted boolean)
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $create_trade_order_atomic$
declare
  v_order_id uuid;
  v_event_id uuid;
  existing_payload jsonb;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'USER_SCOPE_MISMATCH';
  end if;
  v_order_id := nullif(p_order_payload->>'id', '')::uuid;
  v_event_id := nullif(p_event_payload->>'id', '')::uuid;
  if v_order_id is null or v_event_id is null then raise exception 'TRADE_ATOMIC_INPUT_INVALID'; end if;

  perform 1 from public.trade_order_plans
  where user_id = p_user_id and id = p_plan_id and state = p_expected_plan_state
  for update;
  if not found then return; end if;

  select payload into existing_payload from public.trade_orders
  where user_id = p_user_id and plan_id = p_plan_id
  for update;
  if found then
    return query select existing_payload, false;
    return;
  end if;

  insert into public.trade_orders(
    user_id, id, plan_id, exchange, client_order_id, exchange_order_id, state, payload,
    remaining_quantity, fills, fee_amount, fee_currency, cancelable, provider_status_code,
    version, created_at, updated_at
  ) values (
    p_user_id, v_order_id, p_plan_id, p_order_payload->>'exchange', p_order_payload->>'clientOrderId',
    nullif(p_order_payload->>'exchangeOrderId', ''), p_order_payload->>'state', p_order_payload,
    nullif(p_order_payload->>'remainingQuantity', '')::numeric,
    coalesce(p_order_payload->'fills', '[]'::jsonb),
    nullif(p_order_payload->>'feeAmount', '')::numeric,
    nullif(p_order_payload->>'feeCurrency', ''),
    nullif(p_order_payload->>'cancelable', '')::boolean,
    nullif(p_order_payload->>'providerStatusCode', ''),
    coalesce(nullif(p_order_payload->>'version', '')::bigint, 0),
    coalesce(nullif(p_order_payload->>'createdAt', '')::timestamptz, clock_timestamp()),
    coalesce(nullif(p_order_payload->>'updatedAt', '')::timestamptz, clock_timestamp())
  );

  insert into public.trade_order_events(user_id, id, order_id, to_state, payload, created_at)
  values (
    p_user_id, v_event_id, v_order_id, p_event_payload->>'toState', p_event_payload,
    coalesce(nullif(p_event_payload->>'createdAt', '')::timestamptz, clock_timestamp())
  );
  return query select p_order_payload, true;
end
$create_trade_order_atomic$;

create or replace function public.transition_trade_order_atomic(
  p_user_id uuid,
  p_order_id uuid,
  p_expected_state text,
  p_expected_version bigint,
  p_next_state text,
  p_order_payload jsonb,
  p_event_payload jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $transition_trade_order_atomic$
declare
  result jsonb;
  next_payload jsonb;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'USER_SCOPE_MISMATCH';
  end if;
  next_payload := jsonb_set(p_order_payload, '{version}', to_jsonb(p_expected_version + 1), true);
  update public.trade_orders
  set state = p_next_state,
      version = version + 1,
      payload = next_payload,
      exchange_order_id = nullif(next_payload->>'exchangeOrderId', ''),
      remaining_quantity = nullif(next_payload->>'remainingQuantity', '')::numeric,
      fills = coalesce(next_payload->'fills', '[]'::jsonb),
      fee_amount = nullif(next_payload->>'feeAmount', '')::numeric,
      fee_currency = nullif(next_payload->>'feeCurrency', ''),
      exchange_created_at = nullif(next_payload->>'exchangeCreatedAt', '')::timestamptz,
      exchange_updated_at = nullif(next_payload->>'exchangeUpdatedAt', '')::timestamptz,
      cancelable = nullif(next_payload->>'cancelable', '')::boolean,
      provider_status_code = nullif(next_payload->>'providerStatusCode', ''),
      next_retry_at = nullif(next_payload->>'nextRetryAt', '')::timestamptz,
      last_reconciled_at = nullif(next_payload->>'lastReconciledAt', '')::timestamptz,
      manual_review_required = coalesce((next_payload->>'manualReviewRequired')::boolean, false),
      recovery_lease_owner = null,
      recovery_lease_until = null,
      protection_status = coalesce(nullif(next_payload->>'protectionStatus', ''), protection_status),
      protection_error_code = nullif(next_payload->>'protectionErrorCode', ''),
      updated_at = coalesce(nullif(next_payload->>'updatedAt', '')::timestamptz, clock_timestamp())
  where user_id = p_user_id
    and id = p_order_id
    and state = p_expected_state
    and version = p_expected_version
  returning payload into result;

  if result is null then return null; end if;
  insert into public.trade_order_events(user_id, id, order_id, to_state, payload, created_at)
  values (
    p_user_id, nullif(p_event_payload->>'id', '')::uuid, p_order_id, p_next_state,
    p_event_payload,
    coalesce(nullif(p_event_payload->>'createdAt', '')::timestamptz, clock_timestamp())
  );
  return result;
end
$transition_trade_order_atomic$;

create or replace function public.claim_trade_order_execution(
  p_user_id uuid,
  p_order_id uuid,
  p_expected_version bigint,
  p_claim_id uuid,
  p_lease_seconds integer default 30
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $claim_trade_order_execution$
declare
  result jsonb;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then raise exception 'USER_SCOPE_MISMATCH'; end if;
  if p_lease_seconds < 5 or p_lease_seconds > 300 then raise exception 'TRADE_EXECUTION_LEASE_INVALID'; end if;
  update public.trade_orders
  set execution_claim_id = p_claim_id,
      execution_claimed_at = clock_timestamp(),
      version = version + 1,
      payload = jsonb_set(
        jsonb_set(payload, '{version}', to_jsonb(version + 1), true),
        '{executionClaimId}', to_jsonb(p_claim_id::text), true
      ),
      updated_at = clock_timestamp()
  where user_id = p_user_id
    and id = p_order_id
    and state = 'SUBMITTED'
    and version = p_expected_version
    and (execution_claimed_at is null or execution_claimed_at < clock_timestamp() - make_interval(secs => p_lease_seconds))
  returning payload into result;
  return result;
end
$claim_trade_order_execution$;

create or replace function public.claim_trade_recovery_orders(
  p_worker_id uuid,
  p_limit integer default 20,
  p_lease_seconds integer default 60
)
returns setof jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $claim_trade_recovery_orders$
begin
  if p_limit < 1 or p_limit > 100 then raise exception 'TRADE_RECOVERY_LIMIT_INVALID'; end if;
  if p_lease_seconds < 10 or p_lease_seconds > 600 then raise exception 'TRADE_RECOVERY_LEASE_INVALID'; end if;
  return query
  with candidates as (
    select user_id, id
    from public.trade_orders
    where state in ('SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'CANCEL_REQUESTED', 'RECOVERY_REQUIRED')
      and coalesce(next_retry_at, updated_at) <= clock_timestamp()
      and (recovery_lease_until is null or recovery_lease_until < clock_timestamp())
      and manual_review_required = false
    order by coalesce(next_retry_at, updated_at), updated_at
    for update skip locked
    limit p_limit
  )
  update public.trade_orders candidate
  set recovery_lease_owner = p_worker_id,
      recovery_lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
      payload = jsonb_set(
        jsonb_set(candidate.payload, '{recoveryLeaseOwner}', to_jsonb(p_worker_id::text), true),
        '{recoveryLeaseUntil}', to_jsonb((clock_timestamp() + make_interval(secs => p_lease_seconds))::text), true
      ),
      updated_at = clock_timestamp()
  from candidates
  where candidate.user_id = candidates.user_id and candidate.id = candidates.id
  returning candidate.payload;
end
$claim_trade_recovery_orders$;

revoke all on function public.transition_trade_plan_atomic(uuid, uuid, text, bigint, text, jsonb) from public, anon;
revoke all on function public.create_trade_order_atomic(uuid, uuid, text, jsonb, jsonb) from public, anon;
revoke all on function public.transition_trade_order_atomic(uuid, uuid, text, bigint, text, jsonb, jsonb) from public, anon;
revoke all on function public.claim_trade_order_execution(uuid, uuid, bigint, uuid, integer) from public, anon;
revoke all on function public.claim_trade_recovery_orders(uuid, integer, integer) from public, anon, authenticated;

grant execute on function public.transition_trade_plan_atomic(uuid, uuid, text, bigint, text, jsonb) to authenticated, service_role;
grant execute on function public.create_trade_order_atomic(uuid, uuid, text, jsonb, jsonb) to authenticated, service_role;
grant execute on function public.transition_trade_order_atomic(uuid, uuid, text, bigint, text, jsonb, jsonb) to authenticated, service_role;
grant execute on function public.claim_trade_order_execution(uuid, uuid, bigint, uuid, integer) to authenticated, service_role;
grant execute on function public.claim_trade_recovery_orders(uuid, integer, integer) to service_role;

commit;
