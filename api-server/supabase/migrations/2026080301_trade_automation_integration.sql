-- Member-scoped automatic/approval trading storage.
-- Review/CI only: applying this migration to staging or production is not part
-- of this feature PR approval.
begin;

create table if not exists public.trade_system_controls (
  control_key text primary key check (control_key = 'global'),
  emergency_stopped boolean not null default false,
  changed_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.trade_system_controls(control_key, emergency_stopped)
values ('global', false)
on conflict (control_key) do nothing;

create table if not exists public.trade_automation_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{"mode":"approval","automaticEnabled":false,"emergencyStopped":false}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.trade_exchange_connections (
  user_id uuid not null references auth.users(id) on delete cascade,
  exchange text not null check (exchange in ('bitget', 'upbit', 'kiwoom')),
  account_mode text not null default 'paper' check (account_mode in ('paper', 'mock', 'live')),
  configured boolean not null default false,
  encrypted_credentials text,
  last_verified_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, exchange),
  check ((configured = false and encrypted_credentials is null) or (configured = true and encrypted_credentials is not null))
);

create table if not exists public.trade_order_plans (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  idempotency_key text not null,
  state text not null,
  payload jsonb not null,
  approval_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  unique (user_id, idempotency_key)
);

create table if not exists public.trade_orders (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  plan_id uuid not null,
  exchange text not null check (exchange in ('bitget', 'upbit', 'kiwoom')),
  client_order_id text not null,
  state text not null,
  payload jsonb not null,
  execution_claim_id uuid,
  execution_claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  unique (user_id, plan_id),
  unique (user_id, exchange, client_order_id),
  foreign key (user_id, plan_id) references public.trade_order_plans(user_id, id) on delete restrict
);

alter table public.trade_orders add column if not exists execution_claim_id uuid;
alter table public.trade_orders add column if not exists execution_claimed_at timestamptz;

create table if not exists public.trade_order_events (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  order_id uuid not null,
  to_state text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, order_id) references public.trade_orders(user_id, id) on delete restrict
);

create index if not exists trade_connections_user_updated_idx on public.trade_exchange_connections(user_id, updated_at desc);
create index if not exists trade_plans_user_updated_idx on public.trade_order_plans(user_id, updated_at desc);
create index if not exists trade_orders_user_updated_idx on public.trade_orders(user_id, updated_at desc);
create index if not exists trade_events_user_created_idx on public.trade_order_events(user_id, created_at desc);

alter table public.trade_automation_profiles enable row level security;
alter table public.trade_exchange_connections enable row level security;
alter table public.trade_order_plans enable row level security;
alter table public.trade_orders enable row level security;
alter table public.trade_order_events enable row level security;
alter table public.trade_system_controls enable row level security;

do $trade_rls$
declare
  candidate_table text;
  own_and_allowed text := '(auth.uid() = user_id and public.current_membership_level() in (''regular'', ''admin''))';
begin
  foreach candidate_table in array array[
    'trade_automation_profiles', 'trade_exchange_connections', 'trade_order_plans',
    'trade_orders', 'trade_order_events'
  ]
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
$trade_rls$;

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
set search_path = public, pg_temp
as $submit_trade_plan_order$
declare
  member_id uuid := auth.uid();
  v_plan_id uuid;
  v_order_id uuid;
  v_event_id uuid;
  current_plan_state text;
  stored_plan_payload jsonb;
  stored_order_payload jsonb;
  stored_claim_id uuid;
  did_transition boolean := false;
  did_insert_order boolean := false;
  did_claim_execution boolean := false;
begin
  if member_id is null then
    raise exception 'LOGIN_REQUIRED';
  end if;

  v_plan_id := nullif(p_plan_payload->>'id', '')::uuid;
  v_order_id := nullif(p_order_payload->>'id', '')::uuid;
  v_event_id := nullif(p_event_payload->>'id', '')::uuid;

  if v_plan_id is null or v_order_id is null or v_event_id is null
    or p_execution_claim_id is null then
    raise exception 'TRADE_ATOMIC_INPUT_INVALID';
  end if;
  if p_plan_payload->>'userId' <> member_id::text
    or p_order_payload->>'userId' <> member_id::text
    or p_event_payload->>'userId' <> member_id::text then
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

  select state, payload
  into current_plan_state, stored_plan_payload
  from public.trade_order_plans
  where user_id = member_id and id = v_plan_id
  for update;

  if not found then
    return;
  end if;

  if current_plan_state = p_expected_state then
    update public.trade_order_plans
    set state = 'SUBMITTED',
        payload = p_plan_payload,
        approval_expires_at = case
          when nullif(p_plan_payload->>'approvalExpiresAt', '') is null then null
          else (p_plan_payload->>'approvalExpiresAt')::timestamptz
        end,
        updated_at = (p_plan_payload->>'updatedAt')::timestamptz
    where user_id = member_id and id = v_plan_id and state = p_expected_state
    returning payload into stored_plan_payload;
    if not found then
      return;
    end if;
    did_transition := true;
  elsif current_plan_state <> 'SUBMITTED' then
    return;
  end if;

  insert into public.trade_orders(
    user_id, id, plan_id, exchange, client_order_id, state, payload,
    execution_claim_id, execution_claimed_at, created_at, updated_at
  )
  values (
    member_id,
    v_order_id,
    v_plan_id,
    p_order_payload->>'exchange',
    p_order_payload->>'clientOrderId',
    'SUBMITTED',
    p_order_payload,
    p_execution_claim_id,
    clock_timestamp(),
    (p_order_payload->>'createdAt')::timestamptz,
    (p_order_payload->>'updatedAt')::timestamptz
  )
  on conflict (user_id, plan_id) do nothing
  returning payload into stored_order_payload;

  if found then
    did_insert_order := true;
    did_claim_execution := true;
    insert into public.trade_order_events(user_id, id, order_id, to_state, payload, created_at)
    values (
      member_id,
      v_event_id,
      v_order_id,
      'SUBMITTED',
      p_event_payload,
      (p_event_payload->>'createdAt')::timestamptz
    );
  else
    select candidate.payload, candidate.execution_claim_id
    into stored_order_payload, stored_claim_id
    from public.trade_orders candidate
    where candidate.user_id = member_id and candidate.plan_id = v_plan_id;

    if not found then
      raise exception 'TRADE_ATOMIC_ORDER_MISSING';
    end if;
    if stored_order_payload->>'planId' <> v_plan_id::text
      or stored_order_payload->>'exchange' <> p_order_payload->>'exchange'
      or stored_order_payload->>'clientOrderId' <> p_order_payload->>'clientOrderId' then
      raise exception 'TRADE_ATOMIC_ORDER_CONFLICT';
    end if;

    if stored_claim_id is null and stored_order_payload->>'state' = 'SUBMITTED' then
      update public.trade_orders
      set execution_claim_id = p_execution_claim_id,
          execution_claimed_at = clock_timestamp()
      where user_id = member_id
        and id = (stored_order_payload->>'id')::uuid
        and state = 'SUBMITTED'
        and execution_claim_id is null
      returning payload into stored_order_payload;
      if found then
        did_claim_execution := true;
      end if;
    end if;
  end if;

  return query select
    stored_plan_payload,
    stored_order_payload,
    did_transition,
    did_insert_order,
    did_claim_execution;
end
$submit_trade_plan_order$;

grant select, insert, update, delete on public.trade_automation_profiles,
  public.trade_order_plans, public.trade_orders, public.trade_order_events to authenticated;
revoke all on public.trade_exchange_connections from anon, authenticated;
grant select(user_id, exchange, account_mode, configured, last_verified_at, last_error_code, created_at, updated_at)
  on public.trade_exchange_connections to authenticated;
revoke all privileges on table public.trade_system_controls from public, anon, authenticated;
revoke all on function public.submit_trade_plan_order(text, jsonb, jsonb, jsonb, uuid) from public, anon;
grant execute on function public.submit_trade_plan_order(text, jsonb, jsonb, jsonb, uuid) to authenticated;

commit;
