-- Restore the pre-Toss execution provider constraint. If Toss order rows exist,
-- PostgreSQL fails this transaction rather than deleting or rewriting history.
begin;

alter table public.trade_orders
  drop constraint if exists trade_orders_exchange_check;

alter table public.trade_orders
  add constraint trade_orders_exchange_check
  check (exchange in ('bitget', 'upbit', 'kiwoom'));

commit;
