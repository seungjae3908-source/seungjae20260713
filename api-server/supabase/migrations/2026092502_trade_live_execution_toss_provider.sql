-- Extend the existing member-scoped trading vault/order identity to Toss.
-- Schema only: this migration never inserts credentials and never enables live execution.
begin;

alter table public.trade_exchange_connections
  drop constraint if exists trade_exchange_connections_exchange_check;

alter table public.trade_exchange_connections
  add constraint trade_exchange_connections_exchange_check
  check (exchange in ('bitget', 'upbit', 'kiwoom', 'toss'));

alter table public.trade_orders
  drop constraint if exists trade_orders_exchange_check;

alter table public.trade_orders
  add constraint trade_orders_exchange_check
  check (exchange in ('bitget', 'upbit', 'kiwoom', 'toss'));

-- Encrypted trading credentials remain server-only. Browser/authenticated callers
-- may read only non-secret connection metadata under the existing owner RLS.
revoke all on public.trade_exchange_connections from anon, authenticated;
grant select(user_id, exchange, account_mode, configured, last_verified_at, last_error_code, created_at, updated_at)
  on public.trade_exchange_connections to authenticated;

commit;
