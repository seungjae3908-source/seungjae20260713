-- Restore the pre-migration permission-audit table privilege state.
-- RLS policies, audit rows, profiles, and user data are intentionally untouched.

begin;

revoke all privileges on table public.member_permission_audit
from public, anon, authenticated;

commit;
