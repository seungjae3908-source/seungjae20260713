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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  unique (user_id, plan_id),
  unique (user_id, exchange, client_order_id),
  foreign key (user_id, plan_id) references public.trade_order_plans(user_id, id) on delete restrict
);

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

grant select, insert, update, delete on public.trade_automation_profiles,
  public.trade_order_plans, public.trade_orders, public.trade_order_events to authenticated;
revoke all on public.trade_exchange_connections from anon, authenticated;
grant select(user_id, exchange, account_mode, configured, last_verified_at, last_error_code, created_at, updated_at)
  on public.trade_exchange_connections to authenticated;
revoke all on public.trade_system_controls from anon, authenticated;

commit;
