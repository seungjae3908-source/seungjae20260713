-- Fail closed rather than deleting Kiwoom ciphertext during rollback.
begin;

do $$
begin
  if exists (
    select 1
    from public.account_readonly_credentials
    where provider = 'kiwoom'
  ) then
    raise exception 'ACCOUNT_READONLY_KIWOOM_ROWS_MUST_BE_REMOVED_EXPLICITLY_BEFORE_ROLLBACK';
  end if;
end
$$;

alter table public.account_readonly_credentials
  drop constraint if exists account_readonly_credentials_provider_check;

alter table public.account_readonly_credentials
  add constraint account_readonly_credentials_provider_check
  check (provider in ('toss', 'upbit', 'bitget'));

commit;
