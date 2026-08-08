\set ON_ERROR_STOP on

begin;

do $audit_acl_contract$
begin
  if not has_table_privilege('authenticated', 'public.member_permission_audit', 'SELECT')
     or not has_table_privilege('authenticated', 'public.member_permission_audit', 'INSERT') then
    raise exception 'authenticated lacks required audit SELECT/INSERT privileges';
  end if;
  if has_table_privilege('authenticated', 'public.member_permission_audit', 'UPDATE')
     or has_table_privilege('authenticated', 'public.member_permission_audit', 'DELETE') then
    raise exception 'authenticated unexpectedly has audit UPDATE/DELETE privileges';
  end if;
  if has_table_privilege('anon', 'public.member_permission_audit', 'SELECT')
     or has_table_privilege('anon', 'public.member_permission_audit', 'INSERT')
     or has_table_privilege('anon', 'public.member_permission_audit', 'UPDATE')
     or has_table_privilege('anon', 'public.member_permission_audit', 'DELETE') then
    raise exception 'anon unexpectedly has audit table privileges';
  end if;
  if exists (
    select 1
    from pg_class c
    cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
    where c.oid = 'public.member_permission_audit'::regclass
      and acl.grantee = 0
      and acl.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  ) then
    raise exception 'PUBLIC unexpectedly has audit table privileges';
  end if;
  if not exists (
    select 1 from pg_class
    where oid = 'public.member_permission_audit'::regclass
      and relrowsecurity
  ) then
    raise exception 'member_permission_audit RLS is not enabled';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'member_permission_audit'
      and policyname = 'member audit admins select'
      and cmd = 'SELECT'
  ) then
    raise exception 'admin audit SELECT policy is missing';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'member_permission_audit'
      and policyname = 'member audit admins insert'
      and cmd = 'INSERT'
  ) then
    raise exception 'admin audit INSERT policy is missing';
  end if;
end
$audit_acl_contract$;

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $regular_audit_block$
begin
  if (select count(*) from public.member_permission_audit) <> 0 then
    raise exception 'regular member read administrator audit rows';
  end if;
  begin
    insert into public.member_permission_audit (
      actor_id, target_user_id, action, before_value, after_value, reason
    ) values (
      '11111111-1111-1111-1111-111111111111',
      '33333333-3333-3333-3333-333333333333',
      'member.membership.change', '{}', '{}', 'regular must be blocked'
    );
    raise exception 'regular member inserted administrator audit row';
  exception
    when insufficient_privilege then null;
  end;
end
$regular_audit_block$;

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false);

insert into public.member_permission_audit (
  actor_id, target_user_id, action, before_value, after_value, reason
) values (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '11111111-1111-1111-1111-111111111111',
  'member.membership.change',
  '{"membership_level":"associate"}',
  '{"membership_level":"regular"}',
  'disposable admin audit verification'
);

do $admin_audit_scope$
begin
  if (select count(*) from public.member_permission_audit
      where actor_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') <> 1 then
    raise exception 'admin could not read the audit row allowed by RLS';
  end if;
end
$admin_audit_scope$;

reset role;
select set_config('request.jwt.claim.sub', '', false);
rollback;
