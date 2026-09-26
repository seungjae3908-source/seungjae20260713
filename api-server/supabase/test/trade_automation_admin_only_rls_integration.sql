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

-- Add a second administrator fixture to prove owner isolation between admins.
insert into auth.users(id, email)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'admin-b@test.invalid')
on conflict (id) do nothing;
insert into public.profiles(
  id, login_name, display_name, role, status, membership_level, is_active,
  approved_at, permissions_updated_at
) values (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'admin-b', 'Admin B', 'admin',
  'approved', 'admin', true, now(), now()
)
on conflict (id) do update set
  role = excluded.role,
  status = excluded.status,
  membership_level = excluded.membership_level,
  is_active = excluded.is_active,
  updated_at = now();

-- Seed one regular-owned row as the database owner. Browser roles must not see it.
delete from public.trade_automation_profiles
where user_id in (
  '11111111-1111-1111-1111-111111111111',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
);
insert into public.trade_automation_profiles(user_id, payload)
values ('11111111-1111-1111-1111-111111111111', '{"mode":"approval","automaticEnabled":false}');

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $regular_trade_denied$
declare affected integer;
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

  update public.trade_automation_profiles set payload = '{}';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'regular member updated trade data'; end if;
  delete from public.trade_automation_profiles;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'regular member deleted trade data'; end if;

  begin
    perform * from public.submit_trade_plan_order(
      'APPROVAL_PENDING', '{}', '{}', '{}', gen_random_uuid()
    );
    raise exception 'regular member invoked administrator atomic RPC';
  exception when raise_exception then
    if sqlerrm <> 'ADMIN_REQUIRED' then raise; end if;
  end;
end
$regular_trade_denied$;

reset role;
select set_config('request.jwt.claim.sub', '', false);

-- Associate and pending tiers are independently denied all visible rows.
set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
do $associate_denied$
begin
  if (select count(*) from public.trade_automation_profiles) <> 0
    or (select count(*) from public.trade_order_plans) <> 0
    or (select count(*) from public.trade_orders) <> 0 then
    raise exception 'associate member can read administrator trade data';
  end if;
end
$associate_denied$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', false);
do $pending_denied$
begin
  if (select count(*) from public.trade_automation_profiles) <> 0
    or (select count(*) from public.trade_order_plans) <> 0
    or (select count(*) from public.trade_orders) <> 0 then
    raise exception 'pending member can read administrator trade data';
  end if;
end
$pending_denied$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- Administrator A owns a complete trade record graph.
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

-- Administrator B owns separate records.
set role authenticated;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', false);
insert into public.trade_automation_profiles(user_id, payload)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"mode":"approval","automaticEnabled":false}');
insert into public.trade_order_plans(user_id, id, idempotency_key, state, payload)
values (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  '10000000-0000-0000-0000-00000000000c',
  'admin-signal-b',
  'APPROVAL_PENDING',
  '{}'
);
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false);
do $admin_a_owner_access$
begin
  if (select count(*) from public.trade_automation_profiles) <> 1
    or (select count(*) from public.trade_exchange_connections) <> 1
    or (select count(*) from public.trade_order_plans) <> 1
    or (select count(*) from public.trade_orders) <> 1
    or (select count(*) from public.trade_order_events) <> 1 then
    raise exception 'administrator A cannot access exactly owned trade records or can see admin B';
  end if;
  if exists (
    select 1 from public.trade_order_plans
    where user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  ) then
    raise exception 'administrator A can browse administrator B records';
  end if;
  begin
    perform encrypted_credentials from public.trade_exchange_connections limit 1;
    raise exception 'administrator can read encrypted credentials directly';
  exception when insufficient_privilege then null;
  end;
end
$admin_a_owner_access$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', false);
do $admin_b_owner_access$
begin
  if (select count(*) from public.trade_automation_profiles) <> 1
    or (select count(*) from public.trade_order_plans) <> 1
    or (select count(*) from public.trade_orders) <> 0 then
    raise exception 'administrator B cannot access exactly owned records or can see administrator A';
  end if;
  if exists (
    select 1 from public.trade_order_plans
    where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  ) then
    raise exception 'administrator B can browse administrator A records';
  end if;
end
$admin_b_owner_access$;
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

-- Cleanup uses the database owner and leaves the reusable tier fixtures intact.
delete from public.trade_order_events
where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  and order_id = '20000000-0000-0000-0000-00000000000a';
delete from public.trade_orders
where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  and id = '20000000-0000-0000-0000-00000000000a';
delete from public.trade_order_plans
where (user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    and id = '10000000-0000-0000-0000-00000000000a')
   or (user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    and id = '10000000-0000-0000-0000-00000000000c');
delete from public.trade_exchange_connections
where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and exchange = 'upbit';
delete from public.trade_automation_profiles
where user_id in (
  '11111111-1111-1111-1111-111111111111',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
);
delete from public.profiles where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
delete from auth.users where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
