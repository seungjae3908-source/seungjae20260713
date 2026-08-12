-- Restore the pre-Toss provider constraint. If Toss rows exist, PostgreSQL
-- aborts this transaction instead of deleting or rewriting member data.
begin;

alter table public.trade_exchange_connections
  drop constraint if exists trade_exchange_connections_exchange_check;

alter table public.trade_exchange_connections
  add constraint trade_exchange_connections_exchange_check
  check (exchange in ('kiwoom', 'upbit', 'bitget'));

commit;
