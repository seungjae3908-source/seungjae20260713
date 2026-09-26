-- Phase 8 capability overlay for Phase 7 paper tables.
-- Review/CI only. Do not apply to the production database in this phase.

begin;

do $phase8_paper_capability_rls$
declare
  candidate_table text;
  own_and_allowed text := '(auth.uid() = user_id and public.current_membership_level() in (''regular'', ''admin''))';
begin
  if to_regprocedure('public.current_membership_level()') is null then
    raise exception 'Phase 8 membership migration must be applied first';
  end if;

  foreach candidate_table in array array[
    'paper_accounts', 'paper_orders', 'paper_positions',
    'paper_fills', 'paper_journal_entries', 'paper_sync_state'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', candidate_table || ' select own', candidate_table);
    execute format('create policy %I on public.%I for select using %s', candidate_table || ' select own', candidate_table, own_and_allowed);

    execute format('drop policy if exists %I on public.%I', candidate_table || ' insert own', candidate_table);
    execute format('create policy %I on public.%I for insert with check %s', candidate_table || ' insert own', candidate_table, own_and_allowed);

    execute format('drop policy if exists %I on public.%I', candidate_table || ' update own', candidate_table);
    execute format('create policy %I on public.%I for update using %s with check %s', candidate_table || ' update own', candidate_table, own_and_allowed, own_and_allowed);

    execute format('drop policy if exists %I on public.%I', candidate_table || ' delete own', candidate_table);
    execute format('create policy %I on public.%I for delete using %s', candidate_table || ' delete own', candidate_table, own_and_allowed);
  end loop;
end
$phase8_paper_capability_rls$;

commit;
