-- Canonical member investment storage. This release is schema/code only:
-- no provider private calls, no production apply, and no real-order authority.
begin;

create table if not exists public.credential_vault_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('toss','kiwoom','upbit','bitget')),
  encrypted_payload text not null,
  version integer not null check (version >= 1),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id, version)
);

create table if not exists public.broker_exchange_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('toss','kiwoom','upbit','bitget')),
  provider_type text not null check (provider_type in ('KR_BROKER','US_BROKER','CRYPTO_EXCHANGE')),
  account_scope text not null,
  connection_status text not null default 'UNVERIFIED'
    check (connection_status in ('CONNECTED','DEGRADED','DISCONNECTED','REVOKED','UNVERIFIED')),
  permissions text[] not null default '{}',
  read_only_capable boolean not null default false,
  trade_capable boolean not null default false,
  credential_reference uuid,
  credential_version integer,
  last_verified_at timestamptz,
  last_sync_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider, account_scope),
  foreign key (user_id, credential_reference, credential_version)
    references public.credential_vault_entries(user_id, id, version),
  check ((credential_reference is null and credential_version is null)
    or (credential_reference is not null and credential_version is not null))
);
create unique index if not exists broker_exchange_connections_user_id_id_unique
  on public.broker_exchange_connections(user_id, id);

create table if not exists public.account_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null,
  provider text not null check (provider in ('toss','kiwoom','upbit','bitget')),
  account_type text not null,
  currency text not null,
  total_equity numeric,
  cash_balance numeric,
  available_balance numeric,
  unrealized_pnl numeric,
  realized_pnl numeric,
  daily_loss numeric,
  drawdown numeric,
  data_as_of timestamptz not null,
  collected_at timestamptz not null default now(),
  freshness_status text not null check (freshness_status in ('FRESH','STALE','PARTIAL','MISSING','UNAVAILABLE')),
  provider_status text not null check (provider_status in ('HEALTHY','DEGRADED','UNAVAILABLE')),
  provenance text not null,
  snapshot_version integer not null check (snapshot_version >= 1),
  check (total_equity is null or total_equity >= 0),
  check (cash_balance is null or cash_balance >= 0),
  check (available_balance is null or available_balance >= 0),
  foreign key (user_id, connection_id) references public.broker_exchange_connections(user_id, id) on delete cascade
);

alter table public.portfolio_holdings add column if not exists connection_id uuid;
alter table public.portfolio_holdings add column if not exists provider text;
alter table public.portfolio_holdings add column if not exists symbol text;
alter table public.portfolio_holdings add column if not exists current_price numeric;
alter table public.portfolio_holdings add column if not exists market_value numeric;
alter table public.portfolio_holdings add column if not exists unrealized_pnl numeric;
alter table public.portfolio_holdings add column if not exists unrealized_pnl_pct numeric;
alter table public.portfolio_holdings add column if not exists data_as_of timestamptz;
alter table public.portfolio_holdings add column if not exists collected_at timestamptz;
alter table public.portfolio_holdings add column if not exists freshness_status text not null default 'MISSING';
alter table public.portfolio_holdings add column if not exists provider_status text not null default 'UNAVAILABLE';
alter table public.portfolio_holdings add column if not exists provenance text;
alter table public.portfolio_holdings add column if not exists snapshot_version integer not null default 1;
update public.portfolio_holdings set symbol = ticker where symbol is null;
alter table public.portfolio_holdings alter column symbol set not null;

do $constraints$
begin
  if not exists (select 1 from pg_constraint where conname = 'portfolio_holdings_connection_fk') then
    alter table public.portfolio_holdings add constraint portfolio_holdings_connection_fk
      foreign key (user_id, connection_id) references public.broker_exchange_connections(user_id, id) on delete set null (connection_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'portfolio_holdings_provider_check') then
    alter table public.portfolio_holdings add constraint portfolio_holdings_provider_check
      check (provider is null or provider in ('toss','kiwoom','upbit','bitget'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'portfolio_holdings_freshness_check') then
    alter table public.portfolio_holdings add constraint portfolio_holdings_freshness_check
      check (freshness_status in ('FRESH','STALE','PARTIAL','MISSING','UNAVAILABLE'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'portfolio_holdings_provider_status_check') then
    alter table public.portfolio_holdings add constraint portfolio_holdings_provider_status_check
      check (provider_status in ('HEALTHY','DEGRADED','UNAVAILABLE'));
  end if;
end
$constraints$;

create table if not exists public.crypto_spot_holdings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null,
  provider text not null check (provider in ('upbit','bitget')),
  asset text not null,
  free numeric,
  locked numeric,
  average_price numeric,
  current_price numeric,
  market_value numeric,
  unrealized_pnl numeric,
  data_as_of timestamptz not null,
  collected_at timestamptz not null default now(),
  freshness_status text not null check (freshness_status in ('FRESH','STALE','PARTIAL','MISSING','UNAVAILABLE')),
  provider_status text not null check (provider_status in ('HEALTHY','DEGRADED','UNAVAILABLE')),
  provenance text not null,
  snapshot_version integer not null default 1 check (snapshot_version >= 1),
  unique (user_id, connection_id, asset),
  check (free is null or free >= 0),
  check (locked is null or locked >= 0),
  foreign key (user_id, connection_id) references public.broker_exchange_connections(user_id, id) on delete cascade
);

create table if not exists public.futures_positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null,
  exchange text not null check (exchange in ('bitget')),
  symbol text not null,
  side text not null check (side in ('LONG','SHORT')),
  margin_mode text not null check (margin_mode in ('ISOLATED','CROSS')),
  leverage numeric,
  quantity numeric,
  entry_price numeric,
  mark_price numeric,
  liquidation_price numeric,
  liquidation_distance_pct numeric,
  market_value numeric,
  unrealized_pnl numeric,
  maintenance_margin numeric,
  data_as_of timestamptz not null,
  collected_at timestamptz not null default now(),
  freshness_status text not null check (freshness_status in ('FRESH','STALE','PARTIAL','MISSING','UNAVAILABLE')),
  provider_status text not null check (provider_status in ('HEALTHY','DEGRADED','UNAVAILABLE')),
  provenance text not null,
  snapshot_version integer not null default 1 check (snapshot_version >= 1),
  unique (user_id, connection_id, symbol, side),
  check (leverage is null or leverage > 0),
  check (quantity is null or quantity >= 0),
  foreign key (user_id, connection_id) references public.broker_exchange_connections(user_id, id) on delete cascade
);

create table if not exists public.automation_policies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null,
  market text not null check (market in ('KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES')),
  strategy_id text not null,
  strategy_version text not null,
  enabled boolean not null default false,
  execution_mode text not null default 'SHADOW' check (execution_mode in ('SHADOW','PAPER','PREVIEW','LIVE')),
  allowed_symbols text[] not null default '{}',
  max_position_value numeric not null default 0 check (max_position_value >= 0),
  max_position_pct numeric not null default 0 check (max_position_pct >= 0),
  max_daily_loss numeric not null default 0 check (max_daily_loss >= 0),
  max_drawdown numeric not null default 0 check (max_drawdown >= 0),
  max_orders_per_day integer not null default 0 check (max_orders_per_day >= 0),
  max_concurrent_positions integer not null default 0 check (max_concurrent_positions >= 0),
  cooldown_seconds integer not null default 0 check (cooldown_seconds >= 0),
  leverage_min numeric not null default 1 check (leverage_min > 0),
  leverage_max numeric not null default 1 check (leverage_max >= leverage_min),
  min_liquidation_buffer_pct numeric not null default 0 check (min_liquidation_buffer_pct >= 0),
  stop_loss_required boolean not null default true,
  take_profit_required boolean not null default true,
  kill_switch boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, connection_id, market, strategy_id),
  constraint automation_policies_live_locked check (execution_mode <> 'LIVE'),
  foreign key (user_id, connection_id) references public.broker_exchange_connections(user_id, id) on delete cascade
);

create table if not exists public.order_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null,
  source_signal_id text not null,
  source_signal_generated_at timestamptz not null,
  strategy_id text not null,
  market text not null check (market in ('KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES')),
  symbol text not null,
  side text not null check (side in ('BUY','LONG','SHORT','REDUCE','EXIT')),
  position_side text check (position_side in ('LONG','SHORT')),
  order_type text not null check (order_type in ('MARKET','LIMIT')),
  requested_quantity numeric not null check (requested_quantity > 0),
  requested_price numeric not null check (requested_price > 0),
  stop_loss numeric,
  take_profit numeric,
  leverage numeric,
  status text not null check (status in ('CREATED','RISK_BLOCKED','PREVIEW_READY','LIVE_APPROVAL_REQUIRED','SUBMITTED','ACKNOWLEDGED','PARTIALLY_FILLED','FILLED','CANCELLED','REJECTED','EXPIRED')),
  risk_decision text not null check (risk_decision in ('PENDING','BLOCKED','PREVIEW_ONLY')),
  risk_reasons text[] not null default '{}',
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (user_id, idempotency_key),
  check (expires_at > created_at),
  check ((market in ('KR_STOCK','US_STOCK','CRYPTO_SPOT') and side in ('BUY','REDUCE','EXIT') and position_side is null and leverage is null)
    or (market = 'CRYPTO_FUTURES' and ((side in ('LONG','SHORT') and position_side = side)
      or (side in ('REDUCE','EXIT') and position_side in ('LONG','SHORT'))))),
  foreign key (user_id, connection_id) references public.broker_exchange_connections(user_id, id) on delete cascade
);
create unique index if not exists order_intents_user_id_id_unique on public.order_intents(user_id, id);

create table if not exists public.execution_previews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  order_intent_id uuid not null,
  provider text not null check (provider in ('toss','kiwoom','upbit','bitget')),
  estimated_notional numeric not null check (estimated_notional > 0),
  reference_price numeric not null check (reference_price > 0),
  requested_quantity numeric not null check (requested_quantity > 0),
  status text not null default 'PREVIEW_ONLY' check (status = 'PREVIEW_ONLY'),
  warnings text[] not null default '{}',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (user_id, order_intent_id),
  foreign key (user_id, order_intent_id) references public.order_intents(user_id, id) on delete cascade
);

create table if not exists public.member_investment_audit_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  entity_type text not null,
  entity_id text not null,
  payload jsonb not null default '{}',
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists broker_exchange_connections_user_idx on public.broker_exchange_connections(user_id, updated_at desc);
create index if not exists account_snapshots_latest_idx on public.account_snapshots(user_id, connection_id, collected_at desc);
create index if not exists portfolio_holdings_connection_idx on public.portfolio_holdings(user_id, connection_id, collected_at desc);
create index if not exists crypto_spot_holdings_connection_idx on public.crypto_spot_holdings(user_id, connection_id, collected_at desc);
create index if not exists futures_positions_connection_idx on public.futures_positions(user_id, connection_id, symbol, side);
create index if not exists order_intents_recent_idx on public.order_intents(user_id, connection_id, created_at desc);
create index if not exists member_investment_audit_recent_idx on public.member_investment_audit_events(user_id, occurred_at desc);

alter table public.credential_vault_entries enable row level security;
alter table public.broker_exchange_connections enable row level security;
alter table public.account_snapshots enable row level security;
alter table public.portfolio_holdings enable row level security;
alter table public.crypto_spot_holdings enable row level security;
alter table public.futures_positions enable row level security;
alter table public.automation_policies enable row level security;
alter table public.order_intents enable row level security;
alter table public.execution_previews enable row level security;
alter table public.member_investment_audit_events enable row level security;

revoke all on public.credential_vault_entries from public, anon, authenticated;
grant all on public.credential_vault_entries to service_role;

grant select, insert, update, delete on public.broker_exchange_connections, public.account_snapshots,
  public.crypto_spot_holdings, public.futures_positions, public.automation_policies, public.order_intents to authenticated;
grant select, insert, update, delete on public.portfolio_holdings to authenticated;
grant select, insert on public.execution_previews, public.member_investment_audit_events to authenticated;
grant usage, select on sequence public.member_investment_audit_events_id_seq to authenticated;
grant all on public.broker_exchange_connections, public.account_snapshots, public.portfolio_holdings,
  public.crypto_spot_holdings, public.futures_positions, public.automation_policies, public.order_intents,
  public.execution_previews, public.member_investment_audit_events to service_role;
grant usage, select on sequence public.member_investment_audit_events_id_seq to service_role;

-- Replace legacy ownership-only portfolio policies with membership-aware ownership.
drop policy if exists "portfolio select own" on public.portfolio_holdings;
drop policy if exists "portfolio insert own" on public.portfolio_holdings;
drop policy if exists "portfolio update own" on public.portfolio_holdings;
drop policy if exists "portfolio delete own" on public.portfolio_holdings;
drop policy if exists portfolio_holdings_own on public.portfolio_holdings;

do $policies$
declare
  v_table text;
begin
  foreach v_table in array array[
    'broker_exchange_connections','account_snapshots','portfolio_holdings','crypto_spot_holdings',
    'futures_positions','automation_policies','order_intents','execution_previews'
  ] loop
    execute format('drop policy if exists member_investment_own on public.%I', v_table);
    execute format(
      'create policy member_investment_own on public.%I for all using (auth.uid() = user_id and public.current_membership_level() in (''regular'',''admin'')) with check (auth.uid() = user_id and public.current_membership_level() in (''regular'',''admin''))',
      v_table
    );
  end loop;
end
$policies$;

drop policy if exists member_investment_audit_select_own on public.member_investment_audit_events;
create policy member_investment_audit_select_own on public.member_investment_audit_events for select
  using (auth.uid() = user_id and public.current_membership_level() in ('regular','admin'));
drop policy if exists member_investment_audit_insert_own on public.member_investment_audit_events;
create policy member_investment_audit_insert_own on public.member_investment_audit_events for insert
  with check (auth.uid() = user_id and public.current_membership_level() in ('regular','admin'));

commit;
