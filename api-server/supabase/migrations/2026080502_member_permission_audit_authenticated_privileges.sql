-- Explicit PostgREST privileges for the administrator-only permission audit log.
-- RLS remains the authority: authenticated receives only SELECT/INSERT table ACLs,
-- while the existing policies continue to restrict both operations to active admins.
-- Review/CI only until a separate staging database application is approved.

begin;

revoke all privileges on table public.member_permission_audit
from public, anon, authenticated;

grant select, insert on table public.member_permission_audit
to authenticated;

commit;
