\set ON_ERROR_STOP on
do $assert_rollback$
begin
  if to_regclass('public.credential_vault_entries') is not null
    or to_regclass('public.broker_exchange_connections') is not null
    or to_regclass('public.account_snapshots') is not null
    or to_regclass('public.crypto_spot_holdings') is not null
    or to_regclass('public.futures_positions') is not null
    or to_regclass('public.automation_policies') is not null
    or to_regclass('public.order_intents') is not null
    or to_regclass('public.execution_previews') is not null
    or to_regclass('public.member_investment_audit_events') is not null then
    raise exception 'member investment rollback left canonical tables';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='portfolio_holdings' and column_name='connection_id'
  ) then raise exception 'member investment rollback left portfolio extension'; end if;
end
$assert_rollback$;
