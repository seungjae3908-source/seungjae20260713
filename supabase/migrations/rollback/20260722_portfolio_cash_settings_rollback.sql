-- 20260722_portfolio_cash_settings.sql 롤백
-- 추가된 테이블/정책/인덱스만 되돌립니다.

drop policy if exists portfolio_cash_settings_own on public.portfolio_cash_settings;
drop index if exists public.portfolio_cash_settings_user_idx;
drop table if exists public.portfolio_cash_settings;
