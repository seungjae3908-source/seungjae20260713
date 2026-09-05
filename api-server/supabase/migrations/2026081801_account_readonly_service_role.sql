-- Harden server-only account read-only credential storage privileges.
-- The browser roles stay fully revoked; only the service role may access the
-- encrypted ciphertext table through the authenticated API server.
begin;

alter table public.account_readonly_credentials enable row level security;

revoke all privileges on table public.account_readonly_credentials from public, anon, authenticated;
grant select, insert, update, delete on table public.account_readonly_credentials to service_role;

commit;
