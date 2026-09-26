\set ON_ERROR_STOP on

do $paper_privileges_after_migration$
declare
  paper_table text;
  operation text;
  rls_enabled boolean;
  policy_count integer;
begin
  foreach paper_table in array array[
    'paper_accounts',
    'paper_orders',
    'paper_positions',
    'paper_fills',
    'paper_journal_entries',
    'paper_sync_state'
  ]
  loop
    foreach operation in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE']
    loop
      if not has_table_privilege('authenticated', format('public.%I', paper_table), operation) then
        raise exception 'authenticated lacks % on public.%', operation, paper_table;
      end if;
      if has_table_privilege('anon', format('public.%I', paper_table), operation) then
        raise exception 'anon unexpectedly has % on public.%', operation, paper_table;
      end if;
    end loop;

    select c.relrowsecurity into rls_enabled
    from pg_class c
    where c.oid = format('public.%I', paper_table)::regclass;
    if rls_enabled is not true then
      raise exception 'RLS is disabled for public.%', paper_table;
    end if;

    select count(*) into policy_count
    from pg_policies
    where schemaname = 'public' and tablename = paper_table;
    if policy_count < 4 then
      raise exception 'expected four CRUD policies on public.%, found %', paper_table, policy_count;
    end if;
  end loop;
end
$paper_privileges_after_migration$;
