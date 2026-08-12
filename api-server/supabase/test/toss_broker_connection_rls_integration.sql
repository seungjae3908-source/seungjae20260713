\set ON_ERROR_STOP on

begin;

insert into public.trade_exchange_connections (
  user_id, exchange, account_mode, configured, encrypted_credentials
) values (
  '11111111-1111-1111-1111-111111111111', 'toss', 'live', true, 'test-ciphertext-not-a-secret'
);

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

do $owner_can_see_redacted_connection$
begin
  if (select count(*) from public.trade_exchange_connections where exchange = 'toss') <> 1 then
    raise exception 'Toss connection owner cannot read the connection metadata';
  end if;
  begin
    perform encrypted_credentials from public.trade_exchange_connections where exchange = 'toss';
    raise exception 'Toss connection owner can read encrypted credentials directly';
  exception when insufficient_privilege then null;
  end;
end
$owner_can_see_redacted_connection$;

select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

do $other_member_is_isolated$
begin
  if (select count(*) from public.trade_exchange_connections where exchange = 'toss') <> 0 then
    raise exception 'another member can read the Toss connection';
  end if;
end
$other_member_is_isolated$;

reset role;

do $unknown_provider_is_rejected$
begin
  begin
    insert into public.trade_exchange_connections (
      user_id, exchange, account_mode, configured, encrypted_credentials
    ) values (
      '11111111-1111-1111-1111-111111111111', 'unknown', 'paper', false, null
    );
    raise exception 'unknown broker provider was accepted';
  exception when check_violation then null;
  end;
end
$unknown_provider_is_rejected$;

rollback;
