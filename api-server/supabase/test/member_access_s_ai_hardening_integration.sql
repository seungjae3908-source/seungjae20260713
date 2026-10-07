\set ON_ERROR_STOP on

begin;

-- The immediately preceding Production app uses the five-argument member RPC.
-- Prove that the compatibility bridge delegates safely and preserves expiry.
set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);

do $legacy_member_rpc_bridge$
declare
  expected_version timestamptz;
  expiry_before timestamptz;
  expiry_after timestamptz;
  result jsonb;
begin
  if to_regprocedure('public.apply_member_permission_change(uuid,text,boolean,text,timestamptz)') is null then
    raise exception 'legacy member permission RPC bridge is missing';
  end if;
  select permissions_updated_at, membership_expires_at
  into expected_version, expiry_before
  from public.profiles
  where id = '33333333-3333-3333-3333-333333333333';

  result := public.apply_member_permission_change(
    '33333333-3333-3333-3333-333333333333',
    'associate',
    true,
    'legacy bridge integration probe',
    expected_version
  );

  select membership_expires_at
  into expiry_after
  from public.profiles
  where id = '33333333-3333-3333-3333-333333333333';

  if expiry_after is distinct from expiry_before then
    raise exception 'legacy member permission RPC bridge changed membership expiry';
  end if;
  if result->'member'->>'id' <> '33333333-3333-3333-3333-333333333333' then
    raise exception 'legacy member permission RPC bridge returned invalid member';
  end if;
end
$legacy_member_rpc_bridge$;

reset role;

-- Seed evidence as the database owner. The associate must be able to read only
-- the self-owned journal row after the hardening policy is applied.
insert into public.paper_journal_entries (user_id, id, payload, version)
values
  ('33333333-3333-3333-3333-333333333333', 'associate-ai-analysis-journal', '{"netPnl":10}', 1),
  ('11111111-1111-1111-1111-111111111111', 'regular-private-analysis-journal', '{"netPnl":99}', 1)
on conflict (user_id, id) do update set payload = excluded.payload, version = excluded.version;

set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);

do $associate_read_only_analysis$
declare
  affected integer;
begin
  if public.current_membership_level() <> 'associate' then
    raise exception 'associate membership claim was not resolved';
  end if;

  if (select count(*) from public.paper_journal_entries where id = 'associate-ai-analysis-journal') <> 1 then
    raise exception 'associate cannot read own journal evidence for analytics';
  end if;

  if (select count(*) from public.paper_journal_entries where id = 'regular-private-analysis-journal') <> 0 then
    raise exception 'associate read another member journal evidence';
  end if;

  begin
    insert into public.paper_journal_entries (user_id, id, payload, version)
    values ('33333333-3333-3333-3333-333333333333', 'associate-write-forbidden', '{}', 1);
    raise exception 'associate inserted journal evidence';
  exception
    when insufficient_privilege then null;
  end;

  update public.paper_journal_entries
  set payload = '{"mutated":true}'
  where user_id = '33333333-3333-3333-3333-333333333333'
    and id = 'associate-ai-analysis-journal';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'associate updated journal evidence'; end if;

  delete from public.paper_journal_entries
  where user_id = '33333333-3333-3333-3333-333333333333'
    and id = 'associate-ai-analysis-journal';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'associate deleted journal evidence'; end if;
end
$associate_read_only_analysis$;

reset role;

-- Expiry must fail closed at both the helper and journal RLS boundary.
update public.profiles
set membership_expires_at = now() - interval '1 minute'
where id = '33333333-3333-3333-3333-333333333333';

set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);

do $expired_associate_block$
begin
  if public.current_membership_level() <> 'pending' then
    raise exception 'expired associate did not fail closed to pending';
  end if;
  if (select count(*) from public.paper_journal_entries where id = 'associate-ai-analysis-journal') <> 0 then
    raise exception 'expired associate retained journal analytics access';
  end if;
end
$expired_associate_block$;

reset role;

-- The new audit action must be accepted only as an audit record; this test runs
-- as the database owner and rolls back, so no credential or password is stored.
insert into public.member_permission_audit (
  actor_id, target_user_id, action, before_value, after_value, reason
) values (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '33333333-3333-3333-3333-333333333333',
  'member.password.reset',
  '{"password":"REDACTED"}',
  '{"temporaryPasswordIssued":true}',
  'member hardening integration'
);

rollback;
