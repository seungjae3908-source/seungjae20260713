-- Promote Toss Securities from connection/read provider to an execution-capable
-- provider in the persisted order identity contract. This migration changes no
-- live flags and performs no broker mutation.
begin;

alter table public.trade_orders
  drop constraint if exists trade_orders_exchange_check;

alter table public.trade_orders
  add constraint trade_orders_exchange_check
  check (exchange in ('bitget', 'upbit', 'kiwoom', 'toss'));

commit;
