\set ON_ERROR_STOP on

grant select, insert, update, delete on public.trade_automation_profiles,
  public.trade_order_plans, public.trade_orders, public.trade_order_events to authenticated;
grant select(user_id, exchange, account_mode, configured, last_verified_at, last_error_code, created_at, updated_at)
  on public.trade_exchange_connections to authenticated, anon;

do $trade_admin_policy_contract$
declare
  candidate_table text;
  candidate record;
  browser_acl text;
begin
  foreach candidate_table in array array[
    'trade_automation_profiles',
    'trade_exchange_connections',
    'trade_order_plans',
    'trade_orders',
    'trade_order_events'
  ]
  loop
    if (select count(*) from pg_policies
        where schemaname = 'public' and tablename = candidate_table) <> 4 then
      raise exception '% does not have exactly four owner policies', candidate_table;
    end if;
    for candidate in
      select qual, with_check from pg_policies
      where schemaname = 'public' and tablename = candidate_table
    loop
      if coalesce(candidate.qual, candidate.with_check, '') not like '%admin%'
        or coalesce(candidate.qual, '') like '%regular%'
        or coalesce(candidate.with_check, '') like '%regular%' then
        raise exception '% contains a non-admin trade policy', candidate_table;
      end if;
    end loop;
  end loop;

  select string_agg(
    coalesce(grantee_role.rolname, 'PUBLIC') || ':' || privilege.privilege_type,
    ', ' order by coalesce(grantee_role.rolname, 'PUBLIC'), privilege.privilege_type
  )
  into browser_acl
  from pg_class candidate_table
  cross join lateral aclexplode(coalesce(candidate_table.relacl, acldefault('r', candidate_table.relowner))) privilege
  left join pg_roles grantee_role on grantee_role.oid = privilege.grantee
  where candidate_table.oid = 'public.trade_system_controls'::regclass
    and (privilege.grantee = 0 or grantee_role.rolname in ('authenticated', 'anon'));

  if browser_acl is not null then
    raise exception 'browser role or PUBLIC has direct global-stop ACL entries: %', browser_acl;
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'trade_system_controls'
  ) then
    raise exception 'browser-visible policy exists on service-only global stop control';
  end if;
end
$trade_admin_policy_contract$;

-- Seed one regular-owned row as the database owner. Neither the regular member
-- nor another administrator may read it through the administrator-only RLS.
delete from public.trade_automation_profiles
where user_id in (
  '11111111-1111-1111-1111-111111111111',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
);
insert into public.trade_automation_profiles(user_id, payload)
values ('11111111-1111-1111-1111-111111111111', '{"mode":"approval","automaticEnabled":false}');

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $regular_trade_denied$
begin
  if (select count(*) from public.trade_automation_profiles) <> 0
    or (select count(*) from public.trade_exchange_connections) <> 0
    or (select count(*) from public.trade_order_plans) <> 0
    or (select count(*) from public.trade_orders) <> 0
    or (select count(*) from public.trade_order_events) <> 0 then
    raise exception 'regular member can read administrator-only trade data';
  end if;

  begin
    insert into public.trade_order_plans(user_id, id, idempotency_key, state, payload)
    values (
      '11111111-1111-1111-1111-111111111111',
      '10000000-0000-0000-0000-00000000000b',
      'regular-insert-must-be-denied',
      'APPROVAL_PENDING',
      '{}'
    );
    raise exception 'regular member inserted an auto-trading plan';
  exception when insufficient_privilege then null;
  end;
end
$regular_trade_denied$;

reset role;
select set_config('request.jwt.claim.sub', '', false);

set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false);

insert into public.trade_automation_profiles(user_id, payload)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"mode":"approval","automaticEnabled":false}');
insert into public.trade_order_plans(user_id, id, idempotency_key, state, payload)
values (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '10000000-0000-0000-0000-00000000000a',
  'admin-signal-a',
  'APPROVAL_PENDING',
  '{}'
);
insert into public.trade_orders(user_id, id, plan_id, exchange, client_order_id, state, payload)
values (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '20000000-0000-0000-0000-00000000000a',
  '10000000-0000-0000-0000-00000000000a',
  'upbit',
  'admin-client-a',
  'SUBMITTED',
  '{}'
);
insert into public.trade_order_events(user_id, id, order_id, to_state, payload)
values (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '30000000-0000-0000-0000-00000000000a',
  '20000000-0000-0000-0000-00000000000a',
  'SUBMITTED',
  '{}'
);

reset role;
insert into public.trade_exchange_connections(
  user_id, exchange, account_mode, configured, encrypted_credentials
) values (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'upbit', 'paper', true, 'ciphertext-only'
);
set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false);

do $admin_owner_access$
begin
  if (select count(*) from public.trade_automation_profiles) <> 1
    or (select count(*) from public.trade_exchange_connections) <> 1
    or (select count(*) from public.trade_order_plans) <> 1
    or (select count(*) from public.trade_orders) <> 1
    or (select count(*) from public.trade_order_events) <> 1 then
    raise exception 'administrator cannot access exactly the owned trade records';
  end if;

  begin
    perform encrypted_credentials from public.trade_exchange_connections limit 1;
    raise exception 'administrator can read encrypted credentials directly';
  exception when insufficient_privilege then null;
  end;
end
$admin_owner_access$;

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);

do $other_regular_denied$
begin
  if (select count(*) from public.trade_automation_profiles) <> 0
    or (select count(*) from public.trade_exchange_connections) <> 0
    or (select count(*) from public.trade_order_plans) <> 0
    or (select count(*) from public.trade_orders) <> 0
    or (select count(*) from public.trade_order_events) <> 0 then
    raise exception 'another regular member can read administrator trade records';
  end if;
end
$other_regular_denied$;

reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false);
do $anonymous_denied$
begin
  if (select count(user_id) from public.trade_exchange_connections) <> 0 then
    raise exception 'anonymous user can read trade connections';
  end if;
end
$anonymous_denied$;

reset role;
select set_config('request.jwt.claim.sub', '', false);

delete from public.trade_order_events
where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  and order_id = '20000000-0000-0000-0000-00000000000a';
delete from public.trade_orders
where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  and id = '20000000-0000-0000-0000-00000000000a';
delete from public.trade_order_plans
where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  and id = '10000000-0000-0000-0000-00000000000a';
delete from public.trade_exchange_connections
where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and exchange = 'upbit';
delete from public.trade_automation_profiles
where user_id in (
  '11111111-1111-1111-1111-111111111111',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
);
