\set ON_ERROR_STOP on

do $single_order_index$
begin
  if to_regclass('public.trade_orders_single_plan_unique_idx') is null then
    raise exception 'single-order-per-plan partial unique index is missing';
  end if;
end
$single_order_index$;

-- A regular member must not be able to read or write any trading storage after
-- the administrator-only migration is active.
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $regular_trade_blocked$
begin
  if (select count(*) from public.trade_order_plans) <> 0
    or (select count(*) from public.trade_orders) <> 0
    or (select count(*) from public.trade_order_events) <> 0
    or (select count(*) from public.trade_order_legs) <> 0
    or (select count(*) from public.trade_protection_orders) <> 0 then
    raise exception 'regular member can read administrator-only trading storage';
  end if;

  begin
    insert into public.trade_order_plans(user_id, id, idempotency_key, state, payload, version)
    values (
      '11111111-1111-1111-1111-111111111111',
      '46000000-0000-0000-0000-000000000099',
      'regular-must-not-create',
      'APPROVAL_PENDING', '{}', 0
    );
    raise exception 'regular member created an administrator-only trade plan';
  exception when insufficient_privilege then null;
  end;
end
$regular_trade_blocked$;

reset role;

-- An active admin can access only their own trading rows, and the database must
-- independently reject a second non-split order for the same plan even if a
-- caller bypasses the atomic order-creation RPC.
set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false);

insert into public.trade_order_plans(user_id, id, idempotency_key, state, payload, version)
values (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '46000000-0000-0000-0000-000000000001',
  'admin-single-order-plan',
  'SUBMITTED', '{}', 0
);

insert into public.trade_orders(
  user_id, id, plan_id, exchange, client_order_id, state, payload, version
) values (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '56000000-0000-0000-0000-000000000001',
  '46000000-0000-0000-0000-000000000001',
  'upbit', 'admin-single-order-a', 'SUBMITTED', '{}', 0
);

do $non_split_duplicate_blocked$
begin
  begin
    insert into public.trade_orders(
      user_id, id, plan_id, exchange, client_order_id, state, payload, version
    ) values (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      '56000000-0000-0000-0000-000000000002',
      '46000000-0000-0000-0000-000000000001',
      'upbit', 'admin-single-order-b', 'SUBMITTED', '{}', 0
    );
    raise exception 'second non-split order for one plan was inserted';
  exception when unique_violation then null;
  end;

  if (select count(*) from public.trade_orders
      where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        and plan_id = '46000000-0000-0000-0000-000000000001'
        and leg_id is null) <> 1 then
    raise exception 'non-split one-order-per-plan invariant mismatch';
  end if;
end
$non_split_duplicate_blocked$;

reset role;

-- Another administrator must remain unable to browse the first administrator's
-- rows. The fixture suite has one admin identity, so use a direct policy shape
-- assertion to cover all current trading tables as well.
do $all_trade_tables_admin_only$
declare
  candidate_table text;
  policy_count integer;
begin
  foreach candidate_table in array array[
    'trade_automation_profiles',
    'trade_exchange_connections',
    'trade_order_plans',
    'trade_orders',
    'trade_order_events',
    'trade_order_legs',
    'trade_protection_orders'
  ]
  loop
    select count(*) into policy_count
    from pg_policies
    where schemaname = 'public'
      and tablename = candidate_table
      and policyname in (
        candidate_table || ' select own',
        candidate_table || ' insert own',
        candidate_table || ' update own',
        candidate_table || ' delete own'
      )
      and coalesce(qual, with_check, '') like '%current_membership_level()%admin%';

    if policy_count <> 4 then
      raise exception 'administrator-only RLS policy set incomplete for %: %', candidate_table, policy_count;
    end if;
  end loop;
end
$all_trade_tables_admin_only$;

-- Cleanup runs as the database owner and does not exercise browser-role access.
delete from public.trade_order_events
where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  and order_id in ('56000000-0000-0000-0000-000000000001', '56000000-0000-0000-0000-000000000002');
delete from public.trade_orders
where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  and plan_id = '46000000-0000-0000-0000-000000000001';
delete from public.trade_order_plans
where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  and id = '46000000-0000-0000-0000-000000000001';

select set_config('request.jwt.claim.sub', '', false);
