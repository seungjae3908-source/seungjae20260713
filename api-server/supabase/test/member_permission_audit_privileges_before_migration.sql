\set ON_ERROR_STOP on

do $audit_privileges_before_migration$
begin
  if has_table_privilege('authenticated', 'public.member_permission_audit', 'SELECT')
     or has_table_privilege('authenticated', 'public.member_permission_audit', 'INSERT')
     or has_table_privilege('authenticated', 'public.member_permission_audit', 'UPDATE')
     or has_table_privilege('authenticated', 'public.member_permission_audit', 'DELETE') then
    raise exception 'pre-migration authenticated audit privilege unexpectedly exists';
  end if;
  if has_table_privilege('anon', 'public.member_permission_audit', 'SELECT')
     or has_table_privilege('anon', 'public.member_permission_audit', 'INSERT')
     or has_table_privilege('anon', 'public.member_permission_audit', 'UPDATE')
     or has_table_privilege('anon', 'public.member_permission_audit', 'DELETE') then
    raise exception 'pre-migration anon audit privilege unexpectedly exists';
  end if;
  if exists (
    select 1
    from pg_class c
    cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
    where c.oid = 'public.member_permission_audit'::regclass
      and acl.grantee = 0
      and acl.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  ) then
    raise exception 'pre-migration PUBLIC audit privilege unexpectedly exists';
  end if;
end
$audit_privileges_before_migration$;
