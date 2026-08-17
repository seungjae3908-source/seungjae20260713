begin;
revoke select, insert, update, delete on table public.account_readonly_credentials from service_role;
commit;
