-- Transaction-scoped bootstrap helper. The final assertion removes it before commit.
create or replace function public.raise_exception(message text)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $function$
begin
  raise exception '%', message;
end
$function$;

revoke all on function public.raise_exception(text) from public, anon, authenticated, service_role;
