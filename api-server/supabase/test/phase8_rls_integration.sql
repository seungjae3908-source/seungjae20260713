\set ON_ERROR_STOP on

-- Keep only the role/schema/function fixture required by the disposable
-- PostgreSQL harness. Table privileges must come from the real migrations.
grant usage on schema public, auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;
grant execute on function public.current_membership_level() to authenticated;

do $schema_assertions$
declare
  table_name text;
  policy_count integer;
  has_primary_key boolean;
  has_index boolean;
  rls_enabled boolean;
begin
  foreach table_name in array array[
    'paper_accounts', 'paper_orders', 'paper_positions',
    'paper_fills', 'paper_journal_entries', 'paper_sync_state'
  ]
  loop
    if to_regclass('public.' || table_name) is null then
      raise exception 'missing table: %', table_name;
    end if;

    select c.relrowsecurity into rls_enabled
      from pg_class c where c.oid = to_regclass('public.' || table_name);
    if rls_enabled is not true then
      raise exception 'RLS is not enabled: %', table_name;
    end if;

    select exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('public.' || table_name) and contype = 'p'
    ) into has_primary_key;
    if has_primary_key is not true then
      raise exception 'primary key missing: %', table_name;
    end if;

    select exists (
      select 1 from pg_indexes
      where schemaname = 'public' and tablename = table_name
        and indexname not like '%_pkey'
    ) into has_index;
    if has_index is not true then
      raise exception 'supporting index missing: %', table_name;
    end if;

    select count(*) into policy_count
      from pg_policies where schemaname = 'public' and tablename = table_name;
    if policy_count < 4 then
      raise exception 'expected four CRUD policies on %, found %', table_name, policy_count;
    end if;
  end loop;
end
$schema_assertions$;

-- User A: actual CRUD against every user-owned table.
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

insert into public.paper_accounts (user_id, id, payload, version)
values ('11111111-1111-1111-1111-111111111111', 'shared-id', '{"balance":10000}', 1);
insert into public.paper_orders (user_id, id, payload, version)
values ('11111111-1111-1111-1111-111111111111', 'shared-id', '{"side":"long"}', 1);
insert into public.paper_positions (user_id, id, payload, version)
values ('11111111-1111-1111-1111-111111111111', 'position-a', '{"quantity":1}', 1);
insert into public.paper_fills (user_id, id, payload, version)
values ('11111111-1111-1111-1111-111111111111', 'fill-a', '{"price":100}', 1);
insert into public.paper_journal_entries (user_id, id, payload, version)
values ('11111111-1111-1111-1111-111111111111', 'journal-a', '{"note":"private-a"}', 1);
insert into public.paper_sync_state (user_id, id, state_type, status, payload, version)
values ('11111111-1111-1111-1111-111111111111', 'device-a', 'device', 'open', '{"cursor":1}', 1);

update public.paper_positions
set payload = '{"quantity":2}', version = 2, updated_at = now()
where user_id = '11111111-1111-1111-1111-111111111111' and id = 'position-a';
delete from public.paper_fills
where user_id = '11111111-1111-1111-1111-111111111111' and id = 'fill-a';
update public.paper_sync_state
set status = 'completed', version = 2, updated_at = now()
where user_id = '11111111-1111-1111-1111-111111111111' and id = 'device-a';

do $user_a_assertions$
begin
  if (select count(*) from public.paper_accounts where id = 'shared-id') <> 1 then
    raise exception 'user A cannot read own account';
  end if;
  if (select payload->>'quantity' from public.paper_positions where id = 'position-a') <> '2' then
    raise exception 'user A position update failed';
  end if;
  if exists (select 1 from public.paper_fills where id = 'fill-a') then
    raise exception 'user A fill delete failed';
  end if;
  if (select payload->>'note' from public.paper_journal_entries where id = 'journal-a') <> 'private-a' then
    raise exception 'user A cannot read own journal';
  end if;
  if (select status from public.paper_sync_state where id = 'device-a') <> 'completed' then
    raise exception 'user A sync-state update failed';
  end if;
end
$user_a_assertions$;

-- User B: A rows are invisible and immutable, but identical record IDs are valid in B scope.
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);

do $user_b_isolation$
declare
  affected integer;
begin
  if (select count(*) from public.paper_accounts where user_id = '11111111-1111-1111-1111-111111111111') <> 0
     or (select count(*) from public.paper_orders where user_id = '11111111-1111-1111-1111-111111111111') <> 0
     or (select count(*) from public.paper_positions where user_id = '11111111-1111-1111-1111-111111111111') <> 0
     or (select count(*) from public.paper_fills where user_id = '11111111-1111-1111-1111-111111111111') <> 0
     or (select count(*) from public.paper_journal_entries where user_id = '11111111-1111-1111-1111-111111111111') <> 0
     or (select count(*) from public.paper_sync_state where user_id = '11111111-1111-1111-1111-111111111111') <> 0 then
    raise exception 'user B can read user A rows';
  end if;

  begin
    insert into public.paper_orders (user_id, id, payload, version)
    values ('11111111-1111-1111-1111-111111111111', 'injected-a', '{}', 1);
    raise exception 'user B injected user A id';
  exception
    when insufficient_privilege then null;
  end;

  update public.paper_positions set payload = '{"ownedBy":"b"}'
  where user_id = '11111111-1111-1111-1111-111111111111';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'user B updated user A data'; end if;

  delete from public.paper_journal_entries
  where user_id = '11111111-1111-1111-1111-111111111111';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'user B deleted user A data'; end if;
end
$user_b_isolation$;

insert into public.paper_accounts (user_id, id, payload, version)
values ('22222222-2222-2222-2222-222222222222', 'shared-id', '{"balance":20000}', 1);

do $same_id_scope$
begin
  if (select count(*) from public.paper_accounts where id = 'shared-id') <> 1 then
    raise exception 'user-scoped identical record ID failed';
  end if;
end
$same_id_scope$;

-- Unauthenticated role has no table privilege at all; this is stricter than
-- relying on RLS to hide rows from anon.
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false);

do $anonymous_isolation$
begin
  begin
    perform count(*) from public.paper_accounts;
    raise exception 'anonymous SELECT was not blocked';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.paper_accounts (user_id, id, payload, version)
    values ('11111111-1111-1111-1111-111111111111', 'anon-insert', '{}', 1);
    raise exception 'anonymous INSERT was not blocked';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update public.paper_accounts set payload = '{}' where id = 'shared-id';
    raise exception 'anonymous UPDATE was not blocked';
  exception
    when insufficient_privilege then null;
  end;

  begin
    delete from public.paper_accounts where id = 'shared-id';
    raise exception 'anonymous DELETE was not blocked';
  exception
    when insufficient_privilege then null;
  end;
end
$anonymous_isolation$;

-- Admin can manage profiles/audit, but receives no blanket paper-journal access.
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false);

do $admin_privacy$
begin
  if (select count(*) from public.profiles) < 3 then
    raise exception 'admin cannot list profiles';
  end if;
  if (select count(*) from public.paper_journal_entries) <> 0 then
    raise exception 'admin can read private journal rows';
  end if;
end
$admin_privacy$;

insert into public.member_permission_audit (
  actor_id, target_user_id, action, before_value, after_value, reason
) values (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '22222222-2222-2222-2222-222222222222',
  'member.membership.change',
  '{"membership_level":"regular"}',
  '{"membership_level":"associate"}',
  'Phase 8 RLS integration test'
);

reset role;
select set_config('request.jwt.claim.sub', '', false);
