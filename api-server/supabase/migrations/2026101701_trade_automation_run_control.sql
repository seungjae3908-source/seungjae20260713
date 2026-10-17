begin;

-- 작동/정지 (run/stop) control for member automatic trading.
-- The run switch itself stays in trade_automation_profiles.payload
-- (mode=automatic && automaticEnabled); these tables hold server-written
-- metadata (LIVE markets acknowledged without per-order approval, last
-- change and reason) and an append-only audit trail. Members may read their
-- own rows; only the server (service_role) writes.

create table if not exists public.trade_automation_run_controls (
  user_id uuid primary key references auth.users(id) on delete cascade,
  live_confirmed_markets text[] not null default '{}'::text[]
    check (live_confirmed_markets <@ array['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures']::text[]),
  last_action text check (last_action is null or last_action in ('RUN', 'STOP', 'AUTO_STOP', 'KILL_SWITCH')),
  last_reason text check (last_reason is null or char_length(last_reason) <= 120),
  changed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.trade_automation_run_audit (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null check (action in ('RUN', 'STOP', 'AUTO_STOP', 'KILL_SWITCH')),
  reason text check (reason is null or char_length(reason) <= 120),
  actor text not null check (actor in ('member', 'system')),
  live_markets text[] not null default '{}'::text[]
    check (live_markets <@ array['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures']::text[]),
  paper_markets text[] not null default '{}'::text[]
    check (paper_markets <@ array['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures']::text[]),
  created_at timestamptz not null default now()
);

create index if not exists idx_trade_automation_run_audit_user_created
  on public.trade_automation_run_audit (user_id, created_at desc);

alter table public.trade_automation_run_controls enable row level security;
alter table public.trade_automation_run_controls force row level security;
alter table public.trade_automation_run_audit enable row level security;
alter table public.trade_automation_run_audit force row level security;

revoke all on table public.trade_automation_run_controls from public, anon, authenticated;
revoke all on table public.trade_automation_run_audit from public, anon, authenticated;
grant select on table public.trade_automation_run_controls to authenticated;
grant select on table public.trade_automation_run_audit to authenticated;
grant all on table public.trade_automation_run_controls to service_role;
grant all on table public.trade_automation_run_audit to service_role;

drop policy if exists trade_automation_run_controls_select_own on public.trade_automation_run_controls;
create policy trade_automation_run_controls_select_own
  on public.trade_automation_run_controls
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists trade_automation_run_audit_select_own on public.trade_automation_run_audit;
create policy trade_automation_run_audit_select_own
  on public.trade_automation_run_audit
  for select
  to authenticated
  using (auth.uid() = user_id);

commit;
