-- Durable, server-only storage for personal Telegram links and delivery outbox.
-- This migration deliberately leaves the existing unified notification_preferences
-- table and its authenticated-role grants unchanged.
begin;

create table if not exists public.telegram_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  telegram_chat_id text not null unique,
  telegram_user_id text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'REVOKED')),
  connected_at timestamptz not null default now(),
  revoked_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.telegram_link_tokens (
  token_hash text primary key check (length(token_hash) = 64),
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create table if not exists public.user_execution_events (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  source_event_id text not null,
  event_type text not null check (event_type in (
    'ORDER_SUBMITTED', 'ORDER_PARTIALLY_FILLED', 'ORDER_FILLED', 'ORDER_CANCELLED', 'ORDER_REJECTED',
    'POSITION_OPENED', 'POSITION_INCREASED', 'POSITION_REDUCED', 'POSITION_CLOSED',
    'TAKE_PROFIT_FILLED', 'STOP_FILLED', 'MANUAL_PORTFOLIO_ENTRY'
  )),
  source text not null check (source in ('BROKER_EXECUTION', 'PAPER_EXECUTION', 'MANUAL_PORTFOLIO_ENTRY')),
  payload jsonb not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (user_id, id),
  unique (user_id, source_event_id)
);

create table if not exists public.notification_deliveries (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  event_id uuid not null,
  dedupe_key text not null,
  state text not null check (state in ('PENDING', 'SENDING', 'SENT', 'FAILED', 'RETRY_SCHEDULED', 'DEAD_LETTER')),
  attempts integer not null default 0 check (attempts between 0 and 3),
  next_retry_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  unique (user_id, dedupe_key),
  foreign key (user_id, event_id)
    references public.user_execution_events(user_id, id)
    on delete cascade
);

create index if not exists telegram_link_tokens_user_expiry_idx
  on public.telegram_link_tokens(user_id, expires_at desc);
create index if not exists user_execution_events_user_occurred_idx
  on public.user_execution_events(user_id, occurred_at desc);
create index if not exists notification_deliveries_due_idx
  on public.notification_deliveries(state, next_retry_at, created_at);

alter table public.telegram_connections enable row level security;
alter table public.telegram_link_tokens enable row level security;
alter table public.user_execution_events enable row level security;
alter table public.notification_deliveries enable row level security;

revoke all privileges on table public.telegram_connections from public, anon, authenticated;
revoke all privileges on table public.telegram_link_tokens from public, anon, authenticated;
revoke all privileges on table public.user_execution_events from public, anon, authenticated;
revoke all privileges on table public.notification_deliveries from public, anon, authenticated;

grant all privileges on table public.telegram_connections to service_role;
grant all privileges on table public.telegram_link_tokens to service_role;
grant all privileges on table public.user_execution_events to service_role;
grant all privileges on table public.notification_deliveries to service_role;

drop policy if exists telegram_connections_server_only on public.telegram_connections;
create policy telegram_connections_server_only on public.telegram_connections
  for all using (false) with check (false);
drop policy if exists telegram_link_tokens_server_only on public.telegram_link_tokens;
create policy telegram_link_tokens_server_only on public.telegram_link_tokens
  for all using (false) with check (false);
drop policy if exists user_execution_events_server_only on public.user_execution_events;
create policy user_execution_events_server_only on public.user_execution_events
  for all using (false) with check (false);
drop policy if exists notification_deliveries_server_only on public.notification_deliveries;
create policy notification_deliveries_server_only on public.notification_deliveries
  for all using (false) with check (false);

commit;
