do $$
declare
  constraint_row record;
begin
  if to_regclass('public.portfolio_holdings') is null then
    raise notice 'portfolio_holdings table does not exist; migration skipped';
    return;
  end if;

  for constraint_row in
    select conname
    from pg_constraint
    where conrelid = 'public.portfolio_holdings'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%market%'
  loop
    execute format(
      'alter table public.portfolio_holdings drop constraint if exists %I',
      constraint_row.conname
    );
  end loop;

  for constraint_row in
    select conname
    from pg_constraint
    where conrelid = 'public.portfolio_holdings'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%currency%'
  loop
    execute format(
      'alter table public.portfolio_holdings drop constraint if exists %I',
      constraint_row.conname
    );
  end loop;

  alter table public.portfolio_holdings
    add constraint portfolio_holdings_market_check
    check (market in ('KR', 'US', 'COIN'));

  alter table public.portfolio_holdings
    add constraint portfolio_holdings_currency_check
    check (currency in ('KRW', 'USD', 'USDT'));
end
$$;
