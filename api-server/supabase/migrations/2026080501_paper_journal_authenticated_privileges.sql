-- Explicit PostgREST table privileges for user-scoped paper journal storage.
-- RLS remains the authority for owner and membership-tier isolation.
-- Review/CI only until a separate staging database application is approved.

begin;

revoke all privileges on table
  public.paper_accounts,
  public.paper_orders,
  public.paper_positions,
  public.paper_fills,
  public.paper_journal_entries,
  public.paper_sync_state
from public, anon;

grant select, insert, update, delete on table
  public.paper_accounts,
  public.paper_orders,
  public.paper_positions,
  public.paper_fills,
  public.paper_journal_entries,
  public.paper_sync_state
to authenticated;

commit;
