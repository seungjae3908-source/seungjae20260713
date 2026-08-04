\set ON_ERROR_STOP on

-- Keep only the disposable harness role/schema/function grants. The paper
-- table privileges under test must come from the real migration chain.
grant usage on schema public, auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;
grant execute on function public.current_membership_level() to authenticated, anon;

-- Assign the explicit tier introduced by Phase 8 after the compatibility
-- migration has converted legacy approved users to regular.
update public.profiles
set membership_level = 'associate', permissions_updated_at = now()
where id = '33333333-3333-3333-3333-333333333333';

update public.profiles
set membership_level = 'pending', permissions_updated_at = now()
where id = '44444444-4444-4444-4444-444444444444';

-- Associate: authenticated but no paper-trading/journal capability at RLS.
set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);

do $associate_paper_block$
declare
  affected integer;
begin
  if public.current_membership_level() <> 'associate' then
    raise exception 'associate membership claim was not resolved';
  end if;
  if (select count(*) from public.paper_accounts) <> 0 then
    raise exception 'associate read paper rows';
  end if;

  begin
    insert into public.paper_accounts (user_id, id, payload, version)
    values ('33333333-3333-3333-3333-333333333333', 'associate-account', '{}', 1);
    raise exception 'associate inserted paper account';
  exception
    when insufficient_privilege then null;
  end;

  update public.paper_accounts set payload = '{"bypass":true}'
  where user_id = '33333333-3333-3333-3333-333333333333';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'associate updated paper rows'; end if;

  delete from public.paper_accounts
  where user_id = '33333333-3333-3333-3333-333333333333';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'associate deleted paper rows'; end if;
end
$associate_paper_block$;

-- Pending: no paper capability even with a valid authenticated JWT subject.
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', false);

do $pending_paper_block$
begin
  if public.current_membership_level() <> 'pending' then
    raise exception 'pending membership claim was not resolved';
  end if;
  if (select count(*) from public.paper_journal_entries) <> 0 then
    raise exception 'pending user read journal rows';
  end if;

  begin
    insert into public.paper_journal_entries (user_id, id, payload, version)
    values ('44444444-4444-4444-4444-444444444444', 'pending-journal', '{}', 1);
    raise exception 'pending user inserted journal row';
  exception
    when insufficient_privilege then null;
  end;
end
$pending_paper_block$;

-- Regular retains self-owned paper capability.
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
insert into public.paper_fills (user_id, id, payload, version)
values ('11111111-1111-1111-1111-111111111111', 'regular-capability-fill', '{"ok":true}', 1)
on conflict (user_id, id) do update set payload = excluded.payload, version = excluded.version;

do $regular_capability$
begin
  if public.current_membership_level() <> 'regular' then
    raise exception 'regular membership claim was not resolved';
  end if;
  if (select count(*) from public.paper_fills where id = 'regular-capability-fill') <> 1 then
    raise exception 'regular user lost self-owned paper capability';
  end if;
end
$regular_capability$;

-- Admin may use only self-owned paper rows, never another user's journal.
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false);
insert into public.paper_accounts (user_id, id, payload, version)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'admin-own-account', '{}', 1)
on conflict (user_id, id) do nothing;

do $admin_scope$
begin
  if (select count(*) from public.paper_accounts where id = 'admin-own-account') <> 1 then
    raise exception 'admin cannot use own paper account';
  end if;
  if (select count(*) from public.paper_journal_entries where user_id = '11111111-1111-1111-1111-111111111111') <> 0 then
    raise exception 'admin read another user private journal';
  end if;
end
$admin_scope$;

reset role;
select set_config('request.jwt.claim.sub', '', false);
