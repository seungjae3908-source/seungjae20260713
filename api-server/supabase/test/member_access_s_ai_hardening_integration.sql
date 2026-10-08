\set ON_ERROR_STOP on

begin;

-- Seed evidence as the database owner. The associate must be able to read only
-- the self-owned journal row after the hardening policy is applied.
insert into public.paper_journal_entries (user_id, id, payload, version)
values
  ('33333333-3333-3333-3333-333333333333', 'associate-ai-analysis-journal', '{"netPnl":10}', 1),
  ('11111111-1111-1111-1111-111111111111', 'regular-private-analysis-journal', '{"netPnl":99}', 1)
on conflict (user_id, id) do update set payload = excluded.payload, version = excluded.version;

set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);

do $profile_acl_least_privilege$
begin
  if (select count(*) from public.profiles where id = auth.uid()) <> 1 then
    raise exception 'authenticated member cannot read own profile';
  end if;

  begin
    update public.profiles
    set display_name = display_name
    where id = auth.uid();
    raise exception 'authenticated member directly updated profile';
  exception
    when insufficient_privilege then null;
  end;

  begin
    truncate table public.profiles;
    raise exception 'authenticated member truncated profiles';
  exception
    when insufficient_privilege then null;
  end;
end
$profile_acl_least_privilege$;

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

-- Admin audit writes must use the narrow RPC. Direct authenticated INSERT is
-- denied even to an admin, while the RPC validates actor, target, reason and
-- writes only the fixed password-reset audit shape.
set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);

do $admin_password_reset_audit_rpc$
declare
  evidence jsonb;
begin
  evidence := public.record_member_password_reset_authorization(
    '33333333-3333-3333-3333-333333333333',
    'member hardening integration RPC'
  );
  if evidence->>'action' <> 'member.password.reset'
     or (evidence->>'resetAuthorized')::boolean is not true
     or (evidence->>'credentialStored')::boolean is not false then
    raise exception 'password reset audit RPC returned invalid evidence';
  end if;
  if not exists (
    select 1 from public.member_permission_audit
    where target_user_id = '33333333-3333-3333-3333-333333333333'
      and actor_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      and action = 'member.password.reset'
      and before_value = '{"password":"REDACTED"}'::jsonb
      and after_value = '{"resetAuthorized":true,"credentialStored":false}'::jsonb
  ) then
    raise exception 'password reset audit RPC did not write canonical evidence';
  end if;

  begin
    insert into public.member_permission_audit (
      actor_id, target_user_id, action, before_value, after_value, reason
    ) values (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      '33333333-3333-3333-3333-333333333333',
      'member.password.reset',
      '{}',
      '{}',
      'direct insert must be blocked'
    );
    raise exception 'admin directly inserted permission audit evidence';
  exception
    when insufficient_privilege then null;
  end;
end
$admin_password_reset_audit_rpc$;

reset role;

-- The audit action constraint still accepts the canonical action when written
-- by the database owner; the transaction rolls back and no credential is stored.
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
