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
  '{"id":"automatic-paper-admin-v2:crypto_spot","initialBalance":1000000}'::jsonb,1
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
end
$client_guard$;
reset role;
rollback;
