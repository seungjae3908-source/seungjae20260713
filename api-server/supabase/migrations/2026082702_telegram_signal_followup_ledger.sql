-- Durable public Scanner -> Telegram follow-up lifecycle state.
-- This table stores only public signal tracking state required to avoid losing
-- TP/stop/lifecycle progress across API process restarts. It grants no order
-- authority and is deliberately inaccessible to anon/authenticated clients.
begin;

create table if not exists public.telegram_signal_followup_ledger (
  signal_id text primary key,
  expires_at timestamptz not null,
  last_state text not null,
  last_price double precision,
  reached_targets jsonb not null default '[]'::jsonb,
  stop_reached boolean not null default false,
  announced_at timestamptz not null,
  last_seen_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint telegram_signal_followup_state_check check (
    last_state in (
      'CANDIDATE','CONFIRMED','ARMED','ENTRY_ZONE','APPROVAL_PENDING','APPROVED',
      'EXECUTING','PARTIALLY_FILLED','FILLED','MANAGING','CLOSED','INVALIDATED',
      'EXPIRED','REJECTED','CANCELLED','DETECTED','WATCHING','READY_FOR_APPROVAL','WEAKENED'
    )
  ),
  constraint telegram_signal_followup_price_check check (
    last_price is null or (last_price > 0 and last_price < 1e18)
  ),
  constraint telegram_signal_followup_targets_check check (
    jsonb_typeof(reached_targets) = 'array'
  ),
  constraint telegram_signal_followup_time_order_check check (
    last_seen_at >= announced_at
  )
);

create index if not exists telegram_signal_followup_last_seen_idx
  on public.telegram_signal_followup_ledger(last_seen_at);

alter table public.telegram_signal_followup_ledger enable row level security;
revoke all privileges on table public.telegram_signal_followup_ledger from public, anon, authenticated;
grant all privileges on table public.telegram_signal_followup_ledger to service_role;

comment on table public.telegram_signal_followup_ledger is
  'Server-only Telegram signal lifecycle state; no user secrets, private account data, or order authority.';

commit;
