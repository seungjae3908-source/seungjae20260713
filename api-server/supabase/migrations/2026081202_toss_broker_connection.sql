-- Allow member-owned Toss Securities credentials in the existing encrypted
-- broker connection vault. Trading order rows remain limited to the execution
-- providers supported by the order engine.
begin;

alter table public.trade_exchange_connections
  drop constraint if exists trade_exchange_connections_exchange_check;

alter table public.trade_exchange_connections
  add constraint trade_exchange_connections_exchange_check
  check (exchange in ('toss', 'kiwoom', 'upbit', 'bitget'));

commit;
