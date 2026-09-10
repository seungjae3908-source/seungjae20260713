-- Disposable-CI rollback only. Production application requires separate approval.
begin;

drop table if exists public.member_investment_audit_events;
drop table if exists public.execution_previews;
drop table if exists public.order_intents;
drop table if exists public.automation_policies;
drop table if exists public.futures_positions;
drop table if exists public.crypto_spot_holdings;
drop table if exists public.account_snapshots;

drop policy if exists member_investment_own on public.portfolio_holdings;
drop policy if exists "portfolio select own" on public.portfolio_holdings;
create policy "portfolio select own" on public.portfolio_holdings for select using (auth.uid() = user_id);
drop policy if exists "portfolio insert own" on public.portfolio_holdings;
create policy "portfolio insert own" on public.portfolio_holdings for insert with check (auth.uid() = user_id);
drop policy if exists "portfolio update own" on public.portfolio_holdings;
create policy "portfolio update own" on public.portfolio_holdings for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "portfolio delete own" on public.portfolio_holdings;
create policy "portfolio delete own" on public.portfolio_holdings for delete using (auth.uid() = user_id);

alter table public.portfolio_holdings drop constraint if exists portfolio_holdings_connection_fk;
alter table public.portfolio_holdings drop constraint if exists portfolio_holdings_provider_check;
alter table public.portfolio_holdings drop constraint if exists portfolio_holdings_freshness_check;
alter table public.portfolio_holdings drop constraint if exists portfolio_holdings_provider_status_check;
drop index if exists public.portfolio_holdings_connection_idx;
alter table public.portfolio_holdings drop column if exists connection_id;
alter table public.portfolio_holdings drop column if exists provider;
alter table public.portfolio_holdings drop column if exists symbol;
alter table public.portfolio_holdings drop column if exists current_price;
alter table public.portfolio_holdings drop column if exists market_value;
alter table public.portfolio_holdings drop column if exists unrealized_pnl;
alter table public.portfolio_holdings drop column if exists unrealized_pnl_pct;
alter table public.portfolio_holdings drop column if exists data_as_of;
alter table public.portfolio_holdings drop column if exists collected_at;
alter table public.portfolio_holdings drop column if exists freshness_status;
alter table public.portfolio_holdings drop column if exists provider_status;
alter table public.portfolio_holdings drop column if exists provenance;
alter table public.portfolio_holdings drop column if exists snapshot_version;

drop table if exists public.broker_exchange_connections;
drop table if exists public.credential_vault_entries;

commit;
