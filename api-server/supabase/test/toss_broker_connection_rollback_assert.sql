\set ON_ERROR_STOP on

begin;

do $toss_constraint_restored$
begin
  begin
    insert into public.trade_exchange_connections (
      user_id, exchange, account_mode, configured, encrypted_credentials
    ) values (
      '11111111-1111-1111-1111-111111111111', 'toss', 'paper', false, null
    );
    raise exception 'Toss provider remained allowed after rollback';
  exception when check_violation then null;
  end;
end
$toss_constraint_restored$;

rollback;
