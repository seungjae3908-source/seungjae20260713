create extension if not exists pgcrypto;

create table if not exists public.notification_preferences (
  member_id uuid primary key references public.profiles(id) on delete cascade,
  enabled_types text[] not null default array['news_positive','news_negative','disclosure_positive','disclosure_negative','ai_strong_buy','ai_sell_signal','golden_cross','volume_surge','capital_event','price_target','auto_trade','system'],
  app_enabled boolean not null default true,
  push_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  subscription jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_subscriptions_member_idx on public.push_subscriptions(member_id);

create table if not exists public.notification_history (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles(id) on delete cascade,
  notification_type text not null,
  title text not null,
  body text not null default '',
  url text,
  channel text not null check (channel in ('app','push','both')),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notification_history_member_created_idx on public.notification_history(member_id, created_at desc);

create table if not exists public.price_alerts (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles(id) on delete cascade,
  asset_type text not null check (asset_type in ('stock','coin_spot','coin_futures')),
  market text not null,
  symbol text not null,
  direction text not null check (direction in ('above','below')),
  target_price numeric not null check (target_price > 0),
  repeat_enabled boolean not null default false,
  app_enabled boolean not null default true,
  push_enabled boolean not null default true,
  enabled boolean not null default true,
  expires_at timestamptz,
  last_triggered_at timestamptz,
  condition_met boolean not null default false,
  last_checked_price numeric,
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(member_id, asset_type, market, symbol, direction, target_price)
);
create index if not exists price_alerts_member_idx on public.price_alerts(member_id, enabled);

alter table public.notification_preferences enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_history enable row level security;
alter table public.price_alerts enable row level security;

drop policy if exists notification_preferences_own on public.notification_preferences;
create policy notification_preferences_own on public.notification_preferences for all using (auth.uid() = member_id) with check (auth.uid() = member_id);
drop policy if exists push_subscriptions_own on public.push_subscriptions;
create policy push_subscriptions_own on public.push_subscriptions for all using (auth.uid() = member_id) with check (auth.uid() = member_id);
drop policy if exists notification_history_own on public.notification_history;
create policy notification_history_own on public.notification_history for select using (auth.uid() = member_id);
drop policy if exists notification_history_update_own on public.notification_history;
create policy notification_history_update_own on public.notification_history for update using (auth.uid() = member_id) with check (auth.uid() = member_id);
drop policy if exists price_alerts_own on public.price_alerts;
create policy price_alerts_own on public.price_alerts for all using (auth.uid() = member_id) with check (auth.uid() = member_id);
