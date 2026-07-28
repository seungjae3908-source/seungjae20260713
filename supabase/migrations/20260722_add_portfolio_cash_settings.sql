-- 포트폴리오 잔여 현금 설정 (portfolio_cash_settings)
-- 사용자별로 통화(KRW/USD/USDT)별 보유 현금과 최소 보유 현금을 저장한다.
-- 실주문·출금과 무관한 순수 조회/기록용 테이블이다.
-- 롤백: supabase/migrations/rollback/20260722_portfolio_cash_settings_rollback.sql
-- 이 마이그레이션은 관리자가 Supabase에서 수동 실행한다.
create table if not exists public.portfolio_cash_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  currency text not null check (currency in ('KRW','USD','USDT')),
  amount numeric not null default 0 check (amount >= 0),
  min_amount numeric not null default 0 check (min_amount >= 0),
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, currency)
);

create index if not exists portfolio_cash_settings_user_idx
  on public.portfolio_cash_settings(user_id);

alter table public.portfolio_cash_settings enable row level security;

drop policy if exists portfolio_cash_settings_own on public.portfolio_cash_settings;
create policy portfolio_cash_settings_own on public.portfolio_cash_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
