-- ============================================================
-- 승재주식 통합 스키마 마이그레이션 (idempotent)
-- Supabase Dashboard SQL Editor에서 실행하세요.
-- 여러 번 실행해도 기존 데이터는 보존됩니다.
-- ============================================================

-- 필요한 extension
create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";

-- ============================================================
-- 1. ENUM 타입 (이미 있으면 건너뜀)
-- ============================================================
do $$ begin
  create type public.member_status as enum ('pending','approved','rejected','suspended','withdrawn');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.member_role as enum ('user','admin');
exception when duplicate_object then null; end $$;

-- ============================================================
-- 2. 회원 프로필 (profiles)
-- ============================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  login_name text not null unique,
  display_name text not null,
  phone text,
  role public.member_role not null default 'user',
  status public.member_status not null default 'pending',
  approved_at timestamptz,
  approved_by uuid references auth.users(id),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profiles_status_created_idx on public.profiles(status, created_at desc);

-- ============================================================
-- 3. 감사 로그 (audit_logs)
-- ============================================================
create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id),
  action text not null,
  target_type text not null,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  ip_address inet,
  created_at timestamptz not null default now()
);

create index if not exists audit_logs_created_idx on public.audit_logs(created_at desc);
create index if not exists audit_logs_actor_idx on public.audit_logs(actor_id, created_at desc);

-- ============================================================
-- 4. 관심종목 (watchlist_items)
-- ============================================================
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

-- ============================================================
-- 5. 마켓 캐시 (market_cache)
-- ============================================================
create table if not exists public.market_cache (
  cache_key text primary key,
  payload jsonb not null,
  ttl_ms bigint,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists market_cache_expires_idx on public.market_cache(expires_at);

-- ============================================================
-- 6. 포트폴리오 (portfolio_holdings)
-- ============================================================
create table if not exists public.portfolio_holdings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  name text not null default '',
  market text not null check (market in ('KR','US','COIN')),
  currency text not null check (currency in ('KRW','USD')),
  quantity numeric not null check (quantity > 0),
  average_price numeric not null check (average_price > 0),
  memo text,
  purchase_date date default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, ticker)
);

-- 기존 테이블에 컬럼 추가 (이미 있으면 건너뜀)
alter table if exists public.portfolio_holdings
  add column if not exists purchase_date date;
alter table if exists public.portfolio_holdings
  add column if not exists memo text;

-- 기존 market 체크 제약이 COIN을 포함하지 않을 경우 업데이트
do $$ begin
  alter table public.portfolio_holdings drop constraint if exists portfolio_holdings_market_check;
  alter table public.portfolio_holdings add constraint portfolio_holdings_market_check
    check (market in ('KR','US','COIN'));
exception when others then null; end $$;

create index if not exists portfolio_holdings_user_idx on public.portfolio_holdings(user_id);

-- ============================================================
-- 7. 앱 백업 (app_backups)
-- ============================================================
create table if not exists public.app_backups (
  member_id uuid primary key references public.profiles(id) on delete cascade,
  schema_version integer not null default 1 check (schema_version between 1 and 20),
  payload jsonb not null default '{}'::jsonb,
  item_count integer not null default 0 check (item_count between 0 and 500),
  checksum text not null,
  client_updated_at timestamptz,
  updated_at timestamptz not null default now()
);

-- ============================================================
-- 8. 알림 설정 (notification_preferences)
-- ============================================================
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

-- ============================================================
-- 9. 푸시 구독 (push_subscriptions)
-- ============================================================
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  subscription jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_subscriptions_member_idx on public.push_subscriptions(member_id);

-- ============================================================
-- 10. 알림 기록 (notification_history)
-- ============================================================
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

create index if not exists notification_history_member_created_idx
  on public.notification_history(member_id, created_at desc);

-- ============================================================
-- 11. 가격 알림 (price_alerts)
-- ============================================================
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

-- ============================================================
-- 12. RLS 활성화
-- ============================================================
alter table public.profiles enable row level security;
alter table public.audit_logs enable row level security;
alter table public.watchlist_items enable row level security;
alter table public.market_cache enable row level security;
alter table public.portfolio_holdings enable row level security;
alter table public.app_backups enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_history enable row level security;
alter table public.price_alerts enable row level security;

-- ============================================================
-- 13. RLS 정책
-- ============================================================

-- 정책보다 먼저 헬퍼 함수 정의 (아래 정책들이 참조)
create or replace function public.is_approved_member()
returns boolean language sql stable security definer set search_path = public
as $ select exists(select 1 from public.profiles where id = auth.uid() and status = 'approved') $;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $ select exists(select 1 from public.profiles where id = auth.uid() and status = 'approved' and role = 'admin') $;

-- profiles
drop policy if exists "members read own profile" on public.profiles;
create policy "members read own profile" on public.profiles
  for select using (id = auth.uid());

-- 주의: profiles 정책 안에서 profiles를 직접 서브쿼리하면 무한 재귀(42P17)가
-- 발생하므로 반드시 security definer 함수(is_admin)를 사용합니다.
drop policy if exists "admins read profiles" on public.profiles;
create policy "admins read profiles" on public.profiles
  for select using (public.is_admin());

drop policy if exists "admins update profiles" on public.profiles;
create policy "admins update profiles" on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());

-- audit_logs
drop policy if exists "admins read audit logs" on public.audit_logs;
create policy "admins read audit logs" on public.audit_logs
  for select using (public.is_admin());

revoke insert, update, delete on public.audit_logs from anon, authenticated;
revoke delete on public.profiles from anon, authenticated;

-- portfolio_holdings
drop policy if exists portfolio_holdings_own on public.portfolio_holdings;
create policy portfolio_holdings_own on public.portfolio_holdings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- notification_preferences
drop policy if exists notification_preferences_own on public.notification_preferences;
create policy notification_preferences_own on public.notification_preferences
  for all using (auth.uid() = member_id) with check (auth.uid() = member_id);

-- push_subscriptions
drop policy if exists push_subscriptions_own on public.push_subscriptions;
create policy push_subscriptions_own on public.push_subscriptions
  for all using (auth.uid() = member_id) with check (auth.uid() = member_id);

-- notification_history
drop policy if exists notification_history_own on public.notification_history;
create policy notification_history_own on public.notification_history
  for select using (auth.uid() = member_id);

drop policy if exists notification_history_update_own on public.notification_history;
create policy notification_history_update_own on public.notification_history
  for update using (auth.uid() = member_id) with check (auth.uid() = member_id);

-- price_alerts
drop policy if exists price_alerts_own on public.price_alerts;
create policy price_alerts_own on public.price_alerts
  for all using (auth.uid() = member_id) with check (auth.uid() = member_id);

-- app_backups
drop policy if exists app_backups_own on public.app_backups;
create policy app_backups_own on public.app_backups
  for all using (auth.uid() = member_id) with check (auth.uid() = member_id);

-- ============================================================
-- 14. 헬퍼 함수
-- ============================================================

create or replace function public.is_approved_member()
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.profiles where id = auth.uid() and status = 'approved') $$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.profiles where id = auth.uid() and status = 'approved' and role = 'admin') $$;

-- ============================================================
-- 15. 신규 사용자 자동 프로필 생성 트리거
-- ============================================================

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
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
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- 16. 기존 Supabase Auth 사용자 프로필 백필 (데이터 보존, 중복 없음)
--     이미 profiles 행이 있는 사용자는 건드리지 않습니다.
-- ============================================================

insert into public.profiles(id, login_name, display_name)
select
  u.id,
  coalesce(nullif(u.raw_user_meta_data->>'login_name', ''), split_part(u.email, '@', 1)),
  coalesce(
    nullif(u.raw_user_meta_data->>'display_name', ''),
    nullif(u.raw_user_meta_data->>'login_name', ''),
    '사용자'
  )
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id)
on conflict (id) do nothing;

-- ============================================================
-- 17. (선택) 본인 계정을 관리자 승인 처리하려면 아래 주석을 해제하고
--     'YOUR_LOGIN_NAME'을 본인 아이디로 바꿔 실행하세요.
-- ============================================================
-- update public.profiles
--   set role = 'admin', status = 'approved', approved_at = now()
--   where login_name = 'YOUR_LOGIN_NAME';

-- ============================================================
-- 완료. 아래 쿼리로 생성된 테이블을 확인하세요.
-- select tablename from pg_tables where schemaname='public' order by tablename;
-- ============================================================
