-- Add Kiwoom to the user-scoped READ-ONLY credential vault.
-- This is schema-only. It does not configure a provider, activate private access,
-- grant trading authority, or copy execution credentials.
begin;

alter table public.account_readonly_credentials
  drop constraint if exists account_readonly_credentials_provider_check;

alter table public.account_readonly_credentials
  add constraint account_readonly_credentials_provider_check
  check (provider in ('toss', 'kiwoom', 'upbit', 'bitget'));

commit;
