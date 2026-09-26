-- Fail-closed rollback. Never delete or coerce Toss trading evidence.
begin;

do $rollback_toss_live_provider$
begin
  if exists (select 1 from public.trade_exchange_connections where exchange = 'toss') then
    raise exception 'TOSS_TRADING_CONNECTIONS_EXIST';
  end if;
  if exists (select 1 from public.trade_orders where exchange = 'toss') then
    raise exception 'TOSS_TRADING_ORDERS_EXIST';
  end if;
end
$rollback_toss_live_provider$;

alter table public.trade_exchange_connections
  drop constraint if exists trade_exchange_connections_exchange_check;

alter table public.trade_exchange_connections
  add constraint trade_exchange_connections_exchange_check
  check (exchange in ('bitget', 'upbit', 'kiwoom'));

alter table public.trade_orders
  drop constraint if exists trade_orders_exchange_check;

alter table public.trade_orders
  add constraint trade_orders_exchange_check
  check (exchange in ('bitget', 'upbit', 'kiwoom'));

commit;
