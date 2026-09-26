-- Rollback for Phase 7 paper journal storage.
-- CI/test use only in Phase 8. Do not run against production without an approved rollback plan.

begin;

drop table if exists public.paper_sync_state cascade;
drop table if exists public.paper_journal_entries cascade;
drop table if exists public.paper_fills cascade;
drop table if exists public.paper_positions cascade;
drop table if exists public.paper_orders cascade;
drop table if exists public.paper_accounts cascade;

commit;
