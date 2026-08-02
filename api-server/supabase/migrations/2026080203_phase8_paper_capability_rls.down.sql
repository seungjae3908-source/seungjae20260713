-- Rollback Phase 8 paper capability overlay to Phase 7 ownership-only RLS.
-- CI/test use only in this phase.

begin;

do $phase8_restore_phase7_rls$
declare
  candidate_table text;
  own_only text := '(auth.uid() = user_id)';
begin
  foreach candidate_table in array array[
    'paper_accounts', 'paper_orders', 'paper_positions',
    'paper_fills', 'paper_journal_entries', 'paper_sync_state'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', candidate_table || ' select own', candidate_table);
    execute format('create policy %I on public.%I for select using %s', candidate_table || ' select own', candidate_table, own_only);

    execute format('drop policy if exists %I on public.%I', candidate_table || ' insert own', candidate_table);
    execute format('create policy %I on public.%I for insert with check %s', candidate_table || ' insert own', candidate_table, own_only);

    execute format('drop policy if exists %I on public.%I', candidate_table || ' update own', candidate_table);
    execute format('create policy %I on public.%I for update using %s with check %s', candidate_table || ' update own', candidate_table, own_only, own_only);

    execute format('drop policy if exists %I on public.%I', candidate_table || ' delete own', candidate_table);
    execute format('create policy %I on public.%I for delete using %s', candidate_table || ' delete own', candidate_table, own_only);
  end loop;
end
$phase8_restore_phase7_rls$;

commit;
