\set ON_ERROR_STOP on
begin;

-- Dry-run this file only on a staging DB AFTER applying the migration.
-- Every row below is rolled back, including the generated auth profile.
insert into auth.users (id,email,raw_user_meta_data)
values ('99999999-9999-4999-8999-999999999999',
        'admin-wallet-v2-staging@tests.invalid',
        '{"display_name":"admin-v2-rls-test"}'::jsonb)
on conflict (id) do nothing;

update public.profiles
set membership_level='admin', status='approved', is_active=true
where id='99999999-9999-4999-8999-999999999999';

do $staging_owner_precondition$
begin
  if not exists (select 1 from public.profiles
    where id='99999999-9999-4999-8999-999999999999'
      and membership_level='admin' and status::text='approved' and is_active=true) then
    raise exception 'ADMIN_PAPER_RLS_STAGING_ADMIN_FIXTURE_INVALID';
  end if;
end
$staging_owner_precondition$;

insert into public.paper_accounts(user_id,id,payload,version)
values (
  '99999999-9999-4999-8999-999999999999',
  'automatic-paper-admin-v2:crypto_spot',
  '{
    "id":"automatic-paper-admin-v2:crypto_spot",
    "schemaVersion":"admin-four-market-paper-v2",
    "market":"crypto_spot",
    "initialBalance":1000000,
    "equity":1000000,
    "cashBalance":1000000,
    "availableMargin":1000000,
    "usedMargin":0,
    "reserveKrw":0,
    "compoundedProfitKrw":0,
    "compoundShare":0.5,
    "reserveShare":0.5,
    "reserveWithdrawalAutomatic":false
  }'::jsonb,1
);

-- The DB owner itself cannot create a V2 wallet with the wrong market,
-- fabricated cash or a 500k initial balance: RLS alone would not stop it.
do $seed_invariant$
declare
  denied boolean := false;
begin
  begin
    insert into public.paper_accounts(user_id,id,payload,version)
    values('99999999-9999-4999-8999-999999999999',
      'automatic-paper-admin-v2:us_stock',
      '{"id":"automatic-paper-admin-v2:us_stock","market":"us_stock",
         "schemaVersion":"admin-four-market-paper-v2","initialBalance":500000}'::jsonb,1);
  exception when check_violation then denied := true;
  end;
  if not denied then raise exception 'ADMIN_PAPER_DB_OWNER_FALSE_SEED_ALLOWED'; end if;
end
$seed_invariant$;

-- DB-owned fixtures represent a genuine V2 automatic Paper fill.
-- Ordinary browser roles must not be allowed to amend these canonical rows.
insert into public.trade_order_plans (
  user_id,id,idempotency_key,state,payload,version
) values (
  '99999999-9999-4999-8999-999999999999',
  '77777777-7777-4777-8777-777777777701',
  'v2-auto-paper-owner-fixture','SUBMITTED',
  '{"accountMode":"paper","executionMode":"automatic"}'::jsonb,0
);
insert into public.trade_orders (
  user_id,id,plan_id,exchange,client_order_id,state,payload,version
) values (
  '99999999-9999-4999-8999-999999999999',
  '77777777-7777-4777-8777-777777777702',
  '77777777-7777-4777-8777-777777777701',
  'upbit','v2-auto-paper-order-fixture','FILLED',
  '{"filledQuantity":1,"averageFillPrice":100}'::jsonb,0
);
insert into public.trade_order_events (
  user_id,id,order_id,to_state,payload
) values (
  '99999999-9999-4999-8999-999999999999',
  '77777777-7777-4777-8777-777777777703',
  '77777777-7777-4777-8777-777777777702',
  'FILLED','{}'::jsonb
);

set role authenticated;
select set_config('request.jwt.claim.sub','99999999-9999-4999-8999-999999999999',true);
do $client_guard$
declare
  updated integer;
  inserted boolean := false;
begin
  if public.current_membership_level() <> 'admin' then
    raise exception 'ADMIN_PAPER_RLS_TEST_MEMBERSHIP_INVALID';
  end if;
  if public.admin_four_paper_wallet_rls_guard_ready() is not true then
    raise exception 'ADMIN_PAPER_RLS_GUARD_READBACK_MISSING';
  end if;
  if (select count(*) from public.paper_accounts
    where id='automatic-paper-admin-v2:crypto_spot') <> 1 then
    raise exception 'ADMIN_PAPER_RLS_OWNER_CANNOT_READ_V2_WALLET';
  end if;
  begin
    insert into public.paper_accounts(user_id,id,payload,version)
    values(auth.uid(),'automatic-paper-admin-v2:us_stock',
      '{"initialBalance":999999999}'::jsonb,1);
    inserted := true;
  exception when insufficient_privilege then inserted := false;
  end;
  if inserted then raise exception 'ADMIN_PAPER_RLS_CLIENT_INSERT_ALLOWED'; end if;

  update public.paper_accounts set payload='{"equity":99999999}'::jsonb
  where user_id=auth.uid() and id='automatic-paper-admin-v2:crypto_spot';
  get diagnostics updated = row_count;
  if updated <> 0 then raise exception 'ADMIN_PAPER_RLS_CLIENT_UPDATE_ALLOWED'; end if;

  delete from public.paper_accounts where user_id=auth.uid()
    and id='automatic-paper-admin-v2:crypto_spot';
  get diagnostics updated = row_count;
  if updated <> 0 then raise exception 'ADMIN_PAPER_RLS_CLIENT_DELETE_ALLOWED'; end if;

  insert into public.paper_accounts(user_id,id,payload,version)
    values(auth.uid(),'normal-client-paper-wallet','{"initialBalance":10000}'::jsonb,1);
  update public.paper_accounts set payload='{"equity":9999}'::jsonb
    where user_id=auth.uid() and id='normal-client-paper-wallet';
  get diagnostics updated = row_count;
  if updated <> 1 then raise exception 'NORMAL_PAPER_CLIENT_UPDATE_REGRESSION'; end if;

  -- A normal owner wallet cannot be renamed into a protected administrator
  -- ID by UPDATE WITH CHECK. Otherwise no INSERT guard can be sufficient.
  begin
    update public.paper_accounts
    set id = 'automatic-paper-admin-v2:us_stock'
    where user_id=auth.uid() and id='normal-client-paper-wallet';
    get diagnostics updated = row_count;
    if updated <> 0 then raise exception 'ADMIN_PAPER_RLS_RENAME_ALLOWED'; end if;
  exception when insufficient_privilege then null;
  end;

  -- A direct client INSERT ... ON CONFLICT DO UPDATE must not overwrite
  -- an existing immutable administrator wallet.
  begin
    insert into public.paper_accounts(user_id,id,payload,version)
    values(auth.uid(),'automatic-paper-admin-v2:crypto_spot',
      '{"equity":12345678}'::jsonb,1)
    on conflict (user_id,id) do update set payload=excluded.payload;
    raise exception 'ADMIN_PAPER_RLS_UPSERT_ALLOWED';
  exception when insufficient_privilege then null;
  end;

  begin
    execute 'truncate table public.paper_accounts';
    raise exception 'ADMIN_PAPER_CLIENT_TRUNCATE_ALLOWED';
  exception when insufficient_privilege then null;
  end;
end
$client_guard$;

-- Canonical order evidence cannot be wiped with TRUNCATE despite broad
-- historical role-table grants. Keep scoped CRUD so manual trading is intact.
do $canonical_no_truncate$
declare
  target_table text;
begin
  foreach target_table in array array[
    'trade_order_plans','trade_orders','trade_order_events',
    'trade_automation_profiles','trade_exchange_connections'
  ]
  loop
    begin
      execute format('truncate table public.%I', target_table);
      raise exception 'CANONICAL_TRADE_CLIENT_TRUNCATE_ALLOWED:%', target_table;
    exception when insufficient_privilege then null;
    end;
  end loop;
end
$canonical_no_truncate$;
do $admin_v2_protect_canonical_auto_paper$
declare
  mutated integer;
  was_denied boolean;
begin
  if public.admin_four_paper_wallet_rls_guard_ready() is not true then
    raise exception 'ADMIN_V2_CANONICAL_RLS_NOT_VERIFIED';
  end if;

  was_denied := false;
  begin
    insert into public.trade_order_plans (
      user_id,id,idempotency_key,state,payload,version
    ) values (
      auth.uid(),'77777777-7777-4777-8777-777777777711',
      'direct-forged-v2-plan','SUBMITTED',
      '{"accountMode":"paper","executionMode":"automatic"}'::jsonb,0
    );
  exception when insufficient_privilege then was_denied := true;
  end;
  if not was_denied then raise exception 'ADMIN_V2_CLIENT_FORGED_PLAN_ALLOWED'; end if;

  update public.trade_order_plans
    set payload = '{"executionMode":"manual","accountMode":"paper"}'
    where user_id=auth.uid() and id='77777777-7777-4777-8777-777777777701';
  get diagnostics mutated = row_count;
  if mutated <> 0 then raise exception 'ADMIN_V2_CLIENT_PLAN_UPDATE_ALLOWED'; end if;

  was_denied := false;
  begin
    insert into public.trade_orders (
      user_id,id,plan_id,exchange,client_order_id,state,payload,version
    ) values (
      auth.uid(),'77777777-7777-4777-8777-777777777712',
      '77777777-7777-4777-8777-777777777701',
      'upbit','direct-forged-v2-order','FILLED',
      '{"filledQuantity":200,"averageFillPrice":500}'::jsonb,0
    );
  exception when insufficient_privilege then was_denied := true;
  end;
  if not was_denied then raise exception 'ADMIN_V2_CLIENT_FORGED_ORDER_ALLOWED'; end if;

  update public.trade_orders
    set payload='{"filledQuantity":1000000,"averageFillPrice":1000}'
    where user_id=auth.uid() and id='77777777-7777-4777-8777-777777777702';
  get diagnostics mutated = row_count;
  if mutated <> 0 then raise exception 'ADMIN_V2_CLIENT_ORDER_UPDATE_ALLOWED'; end if;

  was_denied := false;
  begin
    insert into public.trade_order_events (
      user_id,id,order_id,to_state,payload
    ) values (
      auth.uid(),'77777777-7777-4777-8777-777777777713',
      '77777777-7777-4777-8777-777777777702',
      'FILLED','{"forgedProfit":100000000}'::jsonb
    );
  exception when insufficient_privilege then was_denied := true;
  end;
  if not was_denied then raise exception 'ADMIN_V2_CLIENT_FORGED_EVENT_ALLOWED'; end if;

  update public.trade_order_events
    set payload='{"forgedProfit":100000000}'
    where user_id=auth.uid() and id='77777777-7777-4777-8777-777777777703';
  get diagnostics mutated = row_count;
  if mutated <> 0 then raise exception 'ADMIN_V2_CLIENT_EVENT_UPDATE_ALLOWED'; end if;

  -- Existing manual Paper workflows must retain their authenticated CRUD.
  insert into public.trade_order_plans (
    user_id,id,idempotency_key,state,payload,version
  ) values (
    auth.uid(),'77777777-7777-4777-8777-777777777714',
    'manual-paper-unaffected','APPROVAL_PENDING',
    '{"accountMode":"paper","executionMode":"manual"}'::jsonb,0
  );
  if (select count(*) from public.trade_order_plans
    where id='77777777-7777-4777-8777-777777777714') <> 1 then
    raise exception 'MANUAL_PAPER_CLIENT_WRITE_REGRESSION';
  end if;
end
$admin_v2_protect_canonical_auto_paper$;

reset role;
rollback;
