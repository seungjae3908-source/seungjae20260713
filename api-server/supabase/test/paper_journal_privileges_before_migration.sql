\set ON_ERROR_STOP on

-- Run only on the disposable CI database after the privilege down migration.
-- This reproduces the exact pre-fix condition without touching RLS or user data.
do $paper_privileges_before_migration$
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
      if has_table_privilege('authenticated', format('public.%I', paper_table), operation) then
        raise exception 'pre-migration authenticated unexpectedly has % on public.%', operation, paper_table;
      end if;
      if has_table_privilege('anon', format('public.%I', paper_table), operation) then
        raise exception 'pre-migration anon unexpectedly has % on public.%', operation, paper_table;
      end if;
    end loop;

    select c.relrowsecurity into rls_enabled
    from pg_class c
    where c.oid = format('public.%I', paper_table)::regclass;
    if rls_enabled is not true then
      raise exception 'pre-migration reproduction changed RLS for public.%', paper_table;
    end if;

    select count(*) into policy_count
    from pg_policies
    where schemaname = 'public' and tablename = paper_table;
    if policy_count < 4 then
      raise exception 'pre-migration reproduction lost paper policies for public.%', paper_table;
    end if;
  end loop;
end
$paper_privileges_before_migration$;

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
do $paper_preview_failure_reproduction$
begin
  begin
    perform count(*) from public.paper_journal_entries;
    raise exception 'pre-migration paper_journal_entries SELECT unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;
end
$paper_preview_failure_reproduction$;
reset role;
select set_config('request.jwt.claim.sub', '', false);
