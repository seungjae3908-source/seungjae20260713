-- Fail closed before any schema mutation unless the target is an isolated staging project.
-- On first application the hosted project must contain no Auth users or profiles.
-- Later idempotent runs are allowed only when the source-controlled marker matches.

do $staging_empty_project_guard$
declare
  configured_ref text := current_setting('app.staging_project_ref', true);
  bootstrap_enabled text := current_setting('app.staging_bootstrap', true);
  auth_user_count bigint;
  profile_count bigint := 0;
  marked_ref text := null;
begin
  if bootstrap_enabled is distinct from 'true' then
    raise exception 'staging bootstrap session marker is missing';
  end if;
  if configured_ref is null or configured_ref !~ '^[a-z0-9]{10,40}$' then
    raise exception 'staging bootstrap project ref is missing or invalid';
  end if;
  if configured_ref = 'bawcbkoyovbeajkrnduq' then
    raise exception 'staging bootstrap refuses the known production Supabase project';
  end if;
  if current_database() ~* '(^|[_-])(prod|production)([_-]|$)' then
    raise exception 'staging bootstrap refuses a production-looking database name';
  end if;
  if to_regclass('auth.users') is null then
    raise exception 'staging bootstrap requires the Supabase auth.users table';
  end if;

  if to_regclass('public.staging_bootstrap_state') is not null then
    execute 'select project_ref from public.staging_bootstrap_state where singleton is true'
      into marked_ref;
    if marked_ref is null or marked_ref <> configured_ref then
      raise exception 'staging bootstrap project marker mismatch';
    end if;
  else
    select count(*) into auth_user_count from auth.users;
    if auth_user_count <> 0 then
      raise exception 'first staging bootstrap requires an empty auth.users table; found % row(s)', auth_user_count;
    end if;

    if to_regclass('public.profiles') is not null then
      execute 'select count(*) from public.profiles' into profile_count;
      if profile_count <> 0 then
        raise exception 'first staging bootstrap requires an empty public.profiles table; found % row(s)', profile_count;
      end if;
    end if;
  end if;

  select count(*) into auth_user_count from auth.users;
  if to_regclass('public.profiles') is not null then
    execute 'select count(*) from public.profiles' into profile_count;
  end if;
  perform set_config('app.staging_auth_users_before', auth_user_count::text, true);
  perform set_config('app.staging_profiles_before', profile_count::text, true);
end
$staging_empty_project_guard$;
