-- Phase 7 paper journal sync and analytics storage.
-- IMPORTANT: this migration is committed for review/CI only.
-- Do not apply it to the production database as part of this change.

begin;

create table if not exists public.paper_accounts (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  payload jsonb not null default '{}'::jsonb,
  version bigint not null default 1 check (version >= 1),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.paper_orders (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  payload jsonb not null default '{}'::jsonb,
  version bigint not null default 1 check (version >= 1),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.paper_positions (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  payload jsonb not null default '{}'::jsonb,
  version bigint not null default 1 check (version >= 1),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.paper_fills (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  payload jsonb not null default '{}'::jsonb,
  version bigint not null default 1 check (version >= 1),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.paper_journal_entries (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  payload jsonb not null default '{}'::jsonb,
  version bigint not null default 1 check (version >= 1),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- request rows keep idempotent responses; conflict rows keep both user-owned
-- versions until the same user explicitly resolves them.
create table if not exists public.paper_sync_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  state_type text not null check (state_type in ('request', 'conflict', 'device')),
  status text not null default 'open' check (status in ('open', 'resolved', 'completed')),
  payload jsonb not null default '{}'::jsonb,
  version bigint not null default 1 check (version >= 1),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists paper_accounts_user_updated_idx on public.paper_accounts (user_id, updated_at desc);
create index if not exists paper_orders_user_updated_idx on public.paper_orders (user_id, updated_at desc);
create index if not exists paper_positions_user_updated_idx on public.paper_positions (user_id, updated_at desc);
create index if not exists paper_fills_user_updated_idx on public.paper_fills (user_id, updated_at desc);
create index if not exists paper_journal_entries_user_updated_idx on public.paper_journal_entries (user_id, updated_at desc);
create index if not exists paper_sync_state_user_type_idx on public.paper_sync_state (user_id, state_type, updated_at desc);

alter table public.paper_accounts enable row level security;
alter table public.paper_orders enable row level security;
alter table public.paper_positions enable row level security;
alter table public.paper_fills enable row level security;
alter table public.paper_journal_entries enable row level security;
alter table public.paper_sync_state enable row level security;

-- No admin or service-role browsing policy is added. Personal notes remain
-- visible only to the owning authenticated user through these policies.
do $phase7_rls$
declare
  table_name text;
begin
  foreach table_name in array array[
    'paper_accounts',
    'paper_orders',
    'paper_positions',
    'paper_fills',
    'paper_journal_entries',
    'paper_sync_state'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', table_name || ' select own', table_name);
    execute format('create policy %I on public.%I for select using (auth.uid() = user_id)', table_name || ' select own', table_name);

    execute format('drop policy if exists %I on public.%I', table_name || ' insert own', table_name);
    execute format('create policy %I on public.%I for insert with check (auth.uid() = user_id)', table_name || ' insert own', table_name);

    execute format('drop policy if exists %I on public.%I', table_name || ' update own', table_name);
    execute format('create policy %I on public.%I for update using (auth.uid() = user_id) with check (auth.uid() = user_id)', table_name || ' update own', table_name);

    execute format('drop policy if exists %I on public.%I', table_name || ' delete own', table_name);
    execute format('create policy %I on public.%I for delete using (auth.uid() = user_id)', table_name || ' delete own', table_name);
  end loop;
end
$phase7_rls$;

-- Table privileges are owned by the base migration so a rollback/reapply that
-- recreates the tables does not leave authenticated clients unable to reach
-- the RLS policies. Anonymous access stays fail-closed.
grant select, insert, update, delete on table
  public.paper_accounts,
  public.paper_orders,
  public.paper_positions,
  public.paper_fills,
  public.paper_journal_entries,
  public.paper_sync_state
  to authenticated;

revoke all on table
  public.paper_accounts,
  public.paper_orders,
  public.paper_positions,
  public.paper_fills,
  public.paper_journal_entries,
  public.paper_sync_state
  from anon;

commit;