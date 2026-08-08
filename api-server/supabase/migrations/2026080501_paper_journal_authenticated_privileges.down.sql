-- Restore the pre-migration paper-table privilege state.
-- RLS policies and user data are intentionally untouched.

begin;

revoke all privileges on table
  public.paper_accounts,
  public.paper_orders,
  public.paper_positions,
  public.paper_fills,
  public.paper_journal_entries,
  public.paper_sync_state
from public, anon, authenticated;

commit;
