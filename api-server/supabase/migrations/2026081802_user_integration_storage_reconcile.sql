-- Production-safe reconciliation for user read-only account credentials and personal Telegram storage.
-- This migration performs schema/policy reconciliation only. It does not copy, insert, update,
-- or delete credential payloads, and it grants no trading, transfer, or withdrawal authority.
begin;

do $user_integration_prerequisite$
declare
  missing_column_count integer;
begin
  if to_regclass('public.notification_preferences') is null then
    raise exception 'canonical notification_preferences table is missing';
  end if;

  select count(*) into missing_column_count
  from unnest(array['member_id', 'enabled_types']) as required(column_name)
  where not exists (
    select 1
    from information_schema.columns candidate
    where candidate.table_schema = 'public'
      and candidate.table_name = 'notification_preferences'
      and candidate.column_name = required.column_name
  );

  if missing_column_count <> 0 then
    raise exception 'canonical notification_preferences columns are missing';
  end if;
end
$user_integration_prerequisite$;

create table if not exists public.account_readonly_credentials (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('toss', 'upbit', 'bitget')),
  configured boolean not null default false,
  encrypted_credentials text,
  last_verified_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider),
  check ((configured = false and encrypted_credentials is null)
    or (configured = true and encrypted_credentials is not null))
);

create index if not exists account_readonly_credentials_user_updated_idx
  on public.account_readonly_credentials(user_id, updated_at desc);

alter table public.account_readonly_credentials enable row level security;
revoke all privileges on table public.account_readonly_credentials from public, anon, authenticated;
grant select, insert, update, delete on table public.account_readonly_credentials to service_role;

do $account_readonly_policy_cleanup$
declare
  policy_name text;
begin
  for policy_name in
    select pol.polname
    from pg_policy pol
    where pol.polrelid = 'public.account_readonly_credentials'::regclass
  loop
    execute format('drop policy %I on public.account_readonly_credentials', policy_name);
  end loop;
end
$account_readonly_policy_cleanup$;

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

do $personal_telegram_storage_reconcile$
declare
  target_table text;
  policy_name text;
begin
  foreach target_table in array array[
    'telegram_connections',
    'telegram_link_tokens',
    'user_execution_events',
    'notification_deliveries'
  ]
  loop
    execute format('alter table public.%I enable row level security', target_table);
    execute format('revoke all privileges on table public.%I from public, anon, authenticated', target_table);
    execute format('grant select, insert, update, delete on table public.%I to service_role', target_table);

    for policy_name in
      select pol.polname
      from pg_policy pol
      where pol.polrelid = format('public.%I', target_table)::regclass
    loop
      execute format('drop policy %I on public.%I', policy_name, target_table);
    end loop;

    execute format(
      'create policy %I on public.%I for all using (false) with check (false)',
      target_table || '_server_only',
      target_table
    );
  end loop;
end
$personal_telegram_storage_reconcile$;

commit;
