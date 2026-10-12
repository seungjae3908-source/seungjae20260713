-- Verify the additive administrator audit-log privilege contract after the
-- existing complete bootstrap assertion. No user or audit rows are inserted.

do $staging_audit_privilege_assert$
begin
  if not has_table_privilege('authenticated', 'public.member_permission_audit', 'SELECT') then
    raise exception 'authenticated lacks required member_permission_audit SELECT privilege';
  end if;
  if has_table_privilege('authenticated', 'public.member_permission_audit', 'INSERT')
     or has_table_privilege('authenticated', 'public.member_permission_audit', 'UPDATE')
     or has_table_privilege('authenticated', 'public.member_permission_audit', 'DELETE')
     or has_table_privilege('authenticated', 'public.member_permission_audit', 'TRUNCATE') then
    raise exception 'authenticated unexpectedly has member_permission_audit mutation privileges';
  end if;
  if has_table_privilege('anon', 'public.member_permission_audit', 'SELECT')
     or has_table_privilege('anon', 'public.member_permission_audit', 'INSERT')
     or has_table_privilege('anon', 'public.member_permission_audit', 'UPDATE')
     or has_table_privilege('anon', 'public.member_permission_audit', 'DELETE') then
    raise exception 'anon unexpectedly has member_permission_audit privileges';
  end if;
  if exists (
    select 1
    from pg_class c
    cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
    where c.oid = 'public.member_permission_audit'::regclass
      and acl.grantee = 0
      and acl.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  ) then
    raise exception 'PUBLIC unexpectedly has member_permission_audit privileges';
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
    raise exception 'member_permission_audit admin select policy is missing';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'member_permission_audit'
      and cmd = 'INSERT'
  ) then
    raise exception 'member_permission_audit direct insert policy is present';
  end if;
  if to_regprocedure('public.record_member_password_reset_authorization(uuid,text)') is null then
    raise exception 'member password reset audit RPC is missing';
  end if;
end
$staging_audit_privilege_assert$;

update public.staging_bootstrap_state
set schema_version = '20260805.1',
    applied_at = now()
where singleton is true
  and project_ref = current_setting('app.staging_project_ref');

do $staging_schema_version_assert$
begin
  if not exists (
    select 1 from public.staging_bootstrap_state
    where singleton is true
      and project_ref = current_setting('app.staging_project_ref')
      and schema_version = '20260805.1'
  ) then
    raise exception 'staging bootstrap schema version 20260805.1 is missing or mismatched';
  end if;
end
$staging_schema_version_assert$;
