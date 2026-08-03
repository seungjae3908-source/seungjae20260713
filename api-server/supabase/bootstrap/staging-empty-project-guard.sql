-- Fail closed before any schema mutation unless the target is an empty staging project.
-- The shell wrapper separately rejects the known production project ref and
-- requires the database URL to resolve to the same Supabase project ref.

do $staging_empty_project_guard$
declare
  auth_user_count bigint;
  profile_count bigint := 0;
begin
  if to_regclass('auth.users') is null then
    raise exception 'staging bootstrap requires the Supabase auth.users table';
  end if;

  select count(*) into auth_user_count from auth.users;
  if auth_user_count <> 0 then
    raise exception 'staging bootstrap requires an empty auth.users table; found % row(s)', auth_user_count;
  end if;

  if to_regclass('public.profiles') is not null then
    execute 'select count(*) from public.profiles' into profile_count;
    if profile_count <> 0 then
      raise exception 'staging bootstrap requires an empty public.profiles table; found % row(s)', profile_count;
    end if;
  end if;

  if current_database() ~* '(^|[_-])(prod|production)([_-]|$)' then
    raise exception 'staging bootstrap refuses a production-looking database name';
  end if;
end
$staging_empty_project_guard$;
