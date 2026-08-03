\set ON_ERROR_STOP on

grant select, insert, update, delete on public.trade_automation_profiles,
  public.trade_order_plans, public.trade_orders, public.trade_order_events to authenticated;
grant select(user_id, exchange, account_mode, configured, last_verified_at, last_error_code, created_at, updated_at)
  on public.trade_exchange_connections to authenticated, anon;

set session authorization authenticated;
do $authenticated_global_stop_service_only$
begin
  begin
    perform emergency_stopped from public.trade_system_controls where control_key = 'global';
    raise exception 'authenticated member can read the global emergency stop control';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.trade_system_controls set emergency_stopped = false where control_key = 'global';
    raise exception 'authenticated member can change the global emergency stop control';
  exception when insufficient_privilege then null;
  end;
end
$authenticated_global_stop_service_only$;
reset session authorization;

set session authorization anon;
do $anonymous_global_stop_service_only$
begin
  begin
    perform emergency_stopped from public.trade_system_controls where control_key = 'global';
    raise exception 'anonymous user can read the global emergency stop control';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.trade_system_controls set emergency_stopped = false where control_key = 'global';
    raise exception 'anonymous user can change the global emergency stop control';
  exception when insufficient_privilege then null;
  end;
end
$anonymous_global_stop_service_only$;
reset session authorization;

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

insert into public.trade_automation_profiles(user_id, payload)
values ('11111111-1111-1111-1111-111111111111', '{"mode":"approval","automaticEnabled":false}');
insert into public.trade_order_plans(user_id, id, idempotency_key, state, payload)
values ('11111111-1111-1111-1111-111111111111', '10000000-0000-0000-0000-000000000001', 'signal-a', 'APPROVAL_PENDING', '{}');
insert into public.trade_orders(user_id, id, plan_id, exchange, client_order_id, state, payload)
values ('11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'upbit', 'client-a', 'SUBMITTED', '{}');
insert into public.trade_order_events(user_id, id, order_id, to_state, payload)
values ('11111111-1111-1111-1111-111111111111', '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'SUBMITTED', '{}');

reset role;
insert into public.trade_exchange_connections(user_id, exchange, account_mode, configured, encrypted_credentials)
values ('11111111-1111-1111-1111-111111111111', 'upbit', 'paper', true, 'ciphertext-only');
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
do $credential_column_hidden$
begin
  begin
    perform encrypted_credentials from public.trade_exchange_connections limit 1;
    raise exception 'member can read encrypted credentials directly';
  exception when insufficient_privilege then null;
  end;
end
$credential_column_hidden$;

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);

do $member_isolation$
declare affected integer;
begin
  if (select count(*) from public.trade_automation_profiles) <> 0
    or (select count(*) from public.trade_exchange_connections) <> 0
    or (select count(*) from public.trade_order_plans) <> 0
    or (select count(*) from public.trade_orders) <> 0
    or (select count(*) from public.trade_order_events) <> 0 then
    raise exception 'member B can read member A trading records';
  end if;
  update public.trade_automation_profiles set payload = '{}' where user_id = '11111111-1111-1111-1111-111111111111';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'member B updated member A trading policy'; end if;
  begin
    insert into public.trade_exchange_connections(user_id, exchange, account_mode, configured, encrypted_credentials)
    values ('11111111-1111-1111-1111-111111111111', 'bitget', 'paper', true, 'injected');
    raise exception 'member B injected member A credentials';
  exception when insufficient_privilege then null;
  end;
end
$member_isolation$;

reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false);
do $anonymous_isolation$
begin
  if (select count(user_id) from public.trade_exchange_connections) <> 0 then
    raise exception 'anonymous user can read encrypted credentials';
  end if;
end
$anonymous_isolation$;

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false);
do $admin_no_member_browse$
begin
  if (select count(*) from public.trade_orders) <> 0 then
    raise exception 'admin can browse member trading orders';
  end if;
end
$admin_no_member_browse$;

reset role;
select set_config('request.jwt.claim.sub', '', false);
