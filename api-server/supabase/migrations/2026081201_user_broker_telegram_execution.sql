-- Per-user Telegram link, durable execution-event outbox, and notification delivery storage.
-- Review/CI only. This migration MUST NOT be applied to staging or production by this PR.
begin;

create table if not exists public.telegram_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  telegram_chat_id text not null unique,
  telegram_user_id text not null,
  status text not null check (status in ('ACTIVE', 'REVOKED')) default 'ACTIVE',
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

create table if not exists public.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_execution_events (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  source_event_id text not null,
  event_type text not null check (event_type in (
    'ORDER_SUBMITTED', 'ORDER_PARTIALLY_FILLED', 'ORDER_FILLED', 'ORDER_CANCELLED', 'ORDER_REJECTED',
    'POSITION_OPENED', 'POSITION_REDUCED', 'POSITION_CLOSED', 'MANUAL_PORTFOLIO_ENTRY'
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
  attempts integer not null default 0 check (attempts >= 0 and attempts <= 3),
  next_retry_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  unique (user_id, dedupe_key),
  foreign key (user_id, event_id) references public.user_execution_events(user_id, id) on delete cascade
);

create index if not exists telegram_link_tokens_user_expiry_idx on public.telegram_link_tokens(user_id, expires_at desc);
create index if not exists user_execution_events_user_occurred_idx on public.user_execution_events(user_id, occurred_at desc);
create index if not exists notification_deliveries_due_idx on public.notification_deliveries(state, next_retry_at, created_at);

alter table public.telegram_connections enable row level security;
alter table public.telegram_link_tokens enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.user_execution_events enable row level security;
alter table public.notification_deliveries enable row level security;

-- All link-token and Telegram identity mutation is server-only. Tokens are stored only as SHA-256 hashes.
revoke all on public.telegram_connections from anon, authenticated;
revoke all on public.telegram_link_tokens from anon, authenticated;
revoke all on public.notification_preferences from anon, authenticated;
revoke all on public.user_execution_events from anon, authenticated;
revoke all on public.notification_deliveries from anon, authenticated;

-- Defense in depth: even if grants are widened later, RLS remains owner-scoped for user-readable state.
do $user_broker_telegram_rls$
declare
  candidate_table text;
begin
  foreach candidate_table in array array[
    'telegram_connections', 'notification_preferences', 'user_execution_events', 'notification_deliveries'
  ] loop
    execute format('drop policy if exists %I on public.%I', candidate_table || ' select own', candidate_table);
    execute format(
      'create policy %I on public.%I for select using (auth.uid() = user_id)',
      candidate_table || ' select own', candidate_table
    );
  end loop;
end
$user_broker_telegram_rls$;

-- No client policy is created for telegram_link_tokens. A browser can never read token hashes.
commit;
