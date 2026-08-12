-- Restore the pre-Toss provider constraint and the administrator-only broker
-- connection RLS installed by 2026080506. If Toss rows exist, PostgreSQL aborts
-- this transaction instead of deleting or rewriting member data.
begin;

alter table public.trade_exchange_connections
  drop constraint if exists trade_exchange_connections_exchange_check;

alter table public.trade_exchange_connections
  add constraint trade_exchange_connections_exchange_check
  check (exchange in ('kiwoom', 'upbit', 'bitget'));

drop policy if exists "trade_exchange_connections select own" on public.trade_exchange_connections;
create policy "trade_exchange_connections select own"
  on public.trade_exchange_connections for select
  using (auth.uid() = user_id and public.current_membership_level() = 'admin');

drop policy if exists "trade_exchange_connections insert own" on public.trade_exchange_connections;
create policy "trade_exchange_connections insert own"
  on public.trade_exchange_connections for insert
  with check (auth.uid() = user_id and public.current_membership_level() = 'admin');

drop policy if exists "trade_exchange_connections update own" on public.trade_exchange_connections;
create policy "trade_exchange_connections update own"
  on public.trade_exchange_connections for update
  using (auth.uid() = user_id and public.current_membership_level() = 'admin')
  with check (auth.uid() = user_id and public.current_membership_level() = 'admin');

drop policy if exists "trade_exchange_connections delete own" on public.trade_exchange_connections;
create policy "trade_exchange_connections delete own"
  on public.trade_exchange_connections for delete
  using (auth.uid() = user_id and public.current_membership_level() = 'admin');

commit;