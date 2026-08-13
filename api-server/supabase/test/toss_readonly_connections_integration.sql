do $$
declare
  has_raw_secret_column boolean;
begin
  if to_regclass('public.toss_readonly_connections') is null then
    raise exception 'toss_readonly_connections table missing';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.toss_readonly_connections'::regclass) then
    raise exception 'toss_readonly_connections RLS must be enabled';
  end if;

  if has_table_privilege('anon', 'public.toss_readonly_connections', 'SELECT')
     or has_table_privilege('authenticated', 'public.toss_readonly_connections', 'SELECT')
     or has_table_privilege('authenticated', 'public.toss_readonly_connections', 'INSERT')
     or has_table_privilege('authenticated', 'public.toss_readonly_connections', 'UPDATE')
     or has_table_privilege('authenticated', 'public.toss_readonly_connections', 'DELETE') then
    raise exception 'browser roles must not have Toss credential table privileges';
  end if;

  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'toss_readonly_connections'
      and column_name in ('client_id', 'client_secret', 'access_token', 'account_number', 'account_seq')
  ) into has_raw_secret_column;

  if has_raw_secret_column then
    raise exception 'raw Toss credential/account columns are forbidden';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'toss_readonly_connections'
      and column_name = 'encrypted_credentials'
  ) then
    raise exception 'encrypted_credentials column missing';
  end if;
end
$$;
