-- Source-controlled allowlist bootstrap for a brand-new isolated staging Supabase project.
-- No production dump, auth user, storage object, credential, or application row is copied.

create extension if not exists pgcrypto;

create table if not exists public.staging_bootstrap_state (
  singleton boolean primary key default true check (singleton),
  project_ref text not null check (project_ref ~ '^[a-z0-9]{10,40}$'),
  schema_version text not null,
  applied_at timestamptz not null default now(),
  check (project_ref <> 'bawcbkoyovbeajkrnduq')
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  login_name text not null unique,
  display_name text not null,
  role text not null default 'user' check (role in ('user', 'admin')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'suspended', 'withdrawn')),
  membership_level text not null default 'pending',
  is_active boolean not null default true,
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  permissions_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists login_name text,
  add column if not exists display_name text,
  add column if not exists role text not null default 'user',
  add column if not exists status text not null default 'pending',
  add column if not exists membership_level text not null default 'pending',
  add column if not exists is_active boolean not null default true,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid references auth.users(id) on delete set null,
  add column if not exists permissions_updated_at timestamptz not null default now(),
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists profiles_login_name_unique_idx on public.profiles(login_name);
create index if not exists profiles_status_created_idx on public.profiles(status, created_at desc);
create index if not exists profiles_membership_active_idx
  on public.profiles(membership_level, is_active, permissions_updated_at desc);

create table if not exists public.watchlist_items (
  id uuid primary key default gen_random_uuid(),
  device_id text not null default 'default',
  ticker text not null,
  name text not null default '',
  market text,
  currency text,
  target_price numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (device_id, ticker)
);
create index if not exists watchlist_items_device_idx on public.watchlist_items(device_id);

create table if not exists public.market_cache (
  cache_key text primary key,
  payload jsonb not null,
  ttl_ms bigint,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists market_cache_expires_idx on public.market_cache(expires_at);

create table if not exists public.portfolio_holdings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  name text not null default '',
  market text not null check (market in ('KR', 'US', 'COIN')),
  currency text not null check (currency in ('KRW', 'USD')),
  quantity numeric not null check (quantity > 0),
  average_price numeric not null check (average_price > 0),
  memo text,
  purchase_date date default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, ticker)
);
create index if not exists portfolio_holdings_user_idx
  on public.portfolio_holdings(user_id, created_at desc);

create table if not exists public.app_backups (
  member_id uuid primary key references public.profiles(id) on delete cascade,
  schema_version integer not null default 1 check (schema_version between 1 and 20),
  payload jsonb not null default '{}'::jsonb,
  item_count integer not null default 0 check (item_count between 0 and 500),
  checksum text not null,
  client_updated_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.notification_preferences (
  member_id uuid primary key references public.profiles(id) on delete cascade,
  enabled_types text[] not null default array[
    'news_positive','news_negative','disclosure_positive','disclosure_negative',
    'ai_strong_buy','ai_sell_signal','golden_cross','volume_surge',
    'capital_event','price_target','auto_trade','system'
  ],
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
create index if not exists push_subscriptions_member_idx
  on public.push_subscriptions(member_id);

create table if not exists public.notification_history (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles(id) on delete cascade,
  notification_type text not null,
  title text not null,
  body text not null default '',
  url text,
  channel text not null check (channel in ('app', 'push', 'both')),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notification_history_member_created_idx
  on public.notification_history(member_id, created_at desc);

create table if not exists public.price_alerts (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles(id) on delete cascade,
  asset_type text not null check (asset_type in ('stock', 'coin_spot', 'coin_futures')),
  market text not null,
  symbol text not null,
  direction text not null check (direction in ('above', 'below')),
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
create index if not exists price_alerts_member_idx
  on public.price_alerts(member_id, enabled);

create or replace function public.is_approved_member()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select exists(
    select 1 from public.profiles
    where id = auth.uid() and status = 'approved' and is_active is true
  )
$function$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select exists(
    select 1 from public.profiles
    where id = auth.uid() and status = 'approved' and role = 'admin' and is_active is true
  )
$function$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  insert into public.profiles(id, login_name, display_name)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'login_name', ''), split_part(new.email, '@', 1)),
    coalesce(
      nullif(new.raw_user_meta_data->>'display_name', ''),
      nullif(new.raw_user_meta_data->>'login_name', ''),
      '사용자'
    )
  )
  on conflict (id) do nothing;
  return new;
end
$function$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.watchlist_items enable row level security;
alter table public.market_cache enable row level security;
alter table public.portfolio_holdings enable row level security;
alter table public.app_backups enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_history enable row level security;
alter table public.price_alerts enable row level security;

drop policy if exists portfolio_holdings_own on public.portfolio_holdings;
create policy portfolio_holdings_own on public.portfolio_holdings
  for all
  using (auth.uid() = user_id and public.is_approved_member())
  with check (auth.uid() = user_id and public.is_approved_member());

drop policy if exists app_backups_own on public.app_backups;
create policy app_backups_own on public.app_backups
  for all
  using (auth.uid() = member_id and public.is_approved_member())
  with check (auth.uid() = member_id and public.is_approved_member());

drop policy if exists notification_preferences_own on public.notification_preferences;
create policy notification_preferences_own on public.notification_preferences
  for all
  using (auth.uid() = member_id and public.is_approved_member())
  with check (auth.uid() = member_id and public.is_approved_member());

drop policy if exists push_subscriptions_own on public.push_subscriptions;
create policy push_subscriptions_own on public.push_subscriptions
  for all
  using (auth.uid() = member_id and public.is_approved_member())
  with check (auth.uid() = member_id and public.is_approved_member());

drop policy if exists notification_history_own on public.notification_history;
create policy notification_history_own on public.notification_history
  for select using (auth.uid() = member_id and public.is_approved_member());

drop policy if exists notification_history_update_own on public.notification_history;
create policy notification_history_update_own on public.notification_history
  for update
  using (auth.uid() = member_id and public.is_approved_member())
  with check (auth.uid() = member_id and public.is_approved_member());

drop policy if exists price_alerts_own on public.price_alerts;
create policy price_alerts_own on public.price_alerts
  for all
  using (auth.uid() = member_id and public.is_approved_member())
  with check (auth.uid() = member_id and public.is_approved_member());

grant usage on schema public to anon, authenticated, service_role;
revoke all on function public.is_approved_member() from public;
revoke all on function public.is_admin() from public;
revoke all on function public.handle_new_user() from public;
grant execute on function public.is_approved_member() to anon, authenticated, service_role;
grant execute on function public.is_admin() to anon, authenticated, service_role;

grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.portfolio_holdings to authenticated;
grant select, insert, update, delete on public.app_backups to authenticated;
grant select, insert, update, delete on public.notification_preferences to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant select, update on public.notification_history to authenticated;
grant select, insert, update, delete on public.price_alerts to authenticated;

revoke all on public.watchlist_items from anon, authenticated;
revoke all on public.market_cache from anon, authenticated;
grant all on public.staging_bootstrap_state to service_role;
grant all on public.profiles to service_role;
grant all on public.watchlist_items to service_role;
grant all on public.market_cache to service_role;
grant all on public.portfolio_holdings to service_role;
grant all on public.app_backups to service_role;
grant all on public.notification_preferences to service_role;
grant all on public.push_subscriptions to service_role;
grant all on public.notification_history to service_role;
grant all on public.price_alerts to service_role;

insert into public.staging_bootstrap_state(singleton, project_ref, schema_version, applied_at)
values (
  true,
  current_setting('app.staging_project_ref'),
  '20260804.1',
  now()
)
on conflict (singleton) do update
set schema_version = excluded.schema_version,
    applied_at = excluded.applied_at
where public.staging_bootstrap_state.project_ref = excluded.project_ref;

select case
  when (select project_ref from public.staging_bootstrap_state where singleton) = current_setting('app.staging_project_ref')
  then true
  else public.raise_exception('staging bootstrap project marker mismatch')
end;
