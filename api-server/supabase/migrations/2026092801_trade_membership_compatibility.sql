-- Minimal legacy-membership compatibility required by the trade storage RLS stack.
-- No profile rows or profile RLS policies are changed here.
begin;

do $trade_membership_compatibility$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'TRADE_MEMBERSHIP_PROFILES_REQUIRED';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'id'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'role'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'status'
  ) then
    raise exception 'TRADE_MEMBERSHIP_LEGACY_PROFILE_COLUMNS_REQUIRED';
  end if;

  if to_regprocedure('public.current_membership_level()') is null then
    execute $ddl$
      create function public.current_membership_level()
      returns text
      language sql
      stable
      security definer
      set search_path = public, pg_temp
      as $function$
        select case
          when coalesce(p.status::text, 'pending') <> 'approved' then 'pending'
          when p.role in ('admin', 'master') then 'admin'
          when p.role = 'associate' then 'associate'
          when p.role in ('full', 'regular') then 'regular'
          else 'regular'
        end
        from public.profiles p
        where p.id = auth.uid()
        limit 1
      $function$
    $ddl$;
  end if;
end
$trade_membership_compatibility$;

revoke all on function public.current_membership_level() from public;
grant execute on function public.current_membership_level() to anon, authenticated;

commit;
