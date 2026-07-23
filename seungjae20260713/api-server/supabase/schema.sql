-- 지식정보 Supabase schema
-- Apply with: psql "$SUPABASE_DB_URL" -f artifacts/api-server/supabase/schema.sql
-- (or paste into the Supabase dashboard SQL Editor)

-- ---------------------------------------------------------------------------
-- 1) 관심 종목 + 타겟 가격 (Target Price)
-- ---------------------------------------------------------------------------
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

create index if not exists watchlist_items_device_idx
  on public.watchlist_items (device_id);

-- ---------------------------------------------------------------------------
-- 2) 시장 분석 / 공시 / TTL 마켓 캐시 (Market & Analytics)
--    key 예시: filings:v1:005930 (DART/SEC 공시), stock-list:all-listings:v1,
--    market-home:v7 등 — api-server의 cached() 두 번째 계층으로 사용.
-- ---------------------------------------------------------------------------
create table if not exists public.market_cache (
  cache_key text primary key,
  payload jsonb not null,
  ttl_ms bigint,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists market_cache_expires_idx
  on public.market_cache (expires_at);

-- ---------------------------------------------------------------------------
-- 보안: RLS 활성화 + 정책 없음.
-- 공개(anon publishable) 키로는 어떤 행도 읽거나 쓸 수 없고,
-- api-server가 secret 키로만 접근한다 (secret 키는 RLS를 우회).
-- ---------------------------------------------------------------------------
alter table public.watchlist_items enable row level security;
alter table public.market_cache enable row level security;

-- ---------------------------------------------------------------------------
-- 3) 사용자별 포트폴리오
-- ---------------------------------------------------------------------------
create table if not exists public.portfolio_holdings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  name text not null default '',
  market text not null check (market in ('KR', 'US')),
  currency text not null check (currency in ('KRW', 'USD')),
  quantity numeric not null check (quantity > 0),
  average_price numeric not null check (average_price > 0),
  memo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, ticker)
);

create index if not exists portfolio_holdings_user_idx
  on public.portfolio_holdings (user_id, created_at desc);

alter table public.portfolio_holdings enable row level security;

drop policy if exists "portfolio select own" on public.portfolio_holdings;
create policy "portfolio select own"
  on public.portfolio_holdings for select
  using (auth.uid() = user_id);

drop policy if exists "portfolio insert own" on public.portfolio_holdings;
create policy "portfolio insert own"
  on public.portfolio_holdings for insert
  with check (auth.uid() = user_id);

drop policy if exists "portfolio update own" on public.portfolio_holdings;
create policy "portfolio update own"
  on public.portfolio_holdings for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "portfolio delete own" on public.portfolio_holdings;
create policy "portfolio delete own"
  on public.portfolio_holdings for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 4) 사용자별 알림 환경설정
-- ---------------------------------------------------------------------------
create table if not exists public.alert_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  news_enabled boolean not null default true,
  disclosure_enabled boolean not null default true,
  price_move_enabled boolean not null default true,
  target_enabled boolean not null default true,
  stop_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.alert_preferences enable row level security;

drop policy if exists "alert prefs select own" on public.alert_preferences;
create policy "alert prefs select own"
  on public.alert_preferences for select
  using (auth.uid() = user_id);

drop policy if exists "alert prefs insert own" on public.alert_preferences;
create policy "alert prefs insert own"
  on public.alert_preferences for insert
  with check (auth.uid() = user_id);

drop policy if exists "alert prefs update own" on public.alert_preferences;
create policy "alert prefs update own"
  on public.alert_preferences for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
