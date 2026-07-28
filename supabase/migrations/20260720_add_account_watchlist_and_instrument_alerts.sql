-- Account-scoped favourites and per-instrument notification settings.
-- Existing device-scoped rows are preserved but are no longer read by the API.

alter type public.member_role add value if not exists 'member';

alter table public.profiles
  add column if not exists birth_date_digest text;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles(id, login_name, display_name, birth_date_digest)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'login_name', ''), split_part(new.email, '@', 1)),
    coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), nullif(new.raw_user_meta_data->>'login_name', ''), '사용자'),
    nullif(new.raw_user_meta_data->>'birth_date_digest', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

alter table public.watchlist_items
  add column if not exists member_id uuid references public.profiles(id) on delete cascade;

create unique index if not exists watchlist_items_member_ticker_idx
  on public.watchlist_items(member_id, ticker)
  where member_id is not null;

create index if not exists watchlist_items_member_created_idx
  on public.watchlist_items(member_id, created_at)
  where member_id is not null;

drop policy if exists watchlist_items_own on public.watchlist_items;
create policy watchlist_items_own on public.watchlist_items
  for all
  using (auth.uid() = member_id)
  with check (auth.uid() = member_id);

create table if not exists public.instrument_alert_settings (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles(id) on delete cascade,
  asset_type text not null check (asset_type in ('stock','coin_spot','coin_futures')),
  market text not null,
  symbol text not null,
  instrument_name text not null default '',
  alert_type text not null,
  enabled boolean not null default false,
  timeframe text not null default '1D',
  trigger_value numeric,
  trigger_unit text check (trigger_unit is null or trigger_unit in ('price','percent')),
  min_confidence numeric not null default 70 check (min_confidence between 0 and 100),
  min_condition_count integer not null default 2 check (min_condition_count between 1 and 20),
  cooldown_minutes integer not null default 60 check (cooldown_minutes between 1 and 10080),
  allowed_start time,
  allowed_end time,
  dnd_start time,
  dnd_end time,
  push_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(member_id, asset_type, market, symbol, alert_type)
);

create index if not exists instrument_alert_settings_lookup_idx
  on public.instrument_alert_settings(member_id, asset_type, market, symbol);

alter table public.instrument_alert_settings enable row level security;
drop policy if exists instrument_alert_settings_own on public.instrument_alert_settings;
create policy instrument_alert_settings_own on public.instrument_alert_settings
  for all
  using (auth.uid() = member_id)
  with check (auth.uid() = member_id);

alter table public.notification_history
  add column if not exists asset_type text,
  add column if not exists market text,
  add column if not exists symbol text,
  add column if not exists timeframe text,
  add column if not exists conditions jsonb not null default '[]'::jsonb,
  add column if not exists confidence numeric,
  add column if not exists event_key text,
  add column if not exists delivery_status text not null default 'created',
  add column if not exists failure_reason text,
  add column if not exists delivered_at timestamptz,
  add column if not exists clicked_at timestamptz;

create unique index if not exists notification_history_member_event_key_idx
  on public.notification_history(member_id, event_key)
  where event_key is not null;

create index if not exists notification_history_signal_lookup_idx
  on public.notification_history(member_id, symbol, notification_type, created_at desc);
