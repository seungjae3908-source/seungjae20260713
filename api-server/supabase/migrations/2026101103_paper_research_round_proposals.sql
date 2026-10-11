-- DRAFT: protected, append-only proposals for future research Paper epochs.
-- This is NOT a money ledger, wallet, activation or simulated trade receipt.
-- No seed is created or re-funded by this migration.
begin;

create table public.paper_research_round_proposals (
  proposal_id text primary key
    check (proposal_id ~ '^paper-round-v1:[0-9a-f]{64}$'),
  user_id uuid not null,
  owner_role text not null check (owner_role in ('admin','member')),
  trading_mode text not null check (trading_mode in ('automatic','manual')),
  market text not null check (market in
    ('domestic_stock','us_stock','crypto_spot','crypto_futures')),
  current_epoch_id text not null
    check (length(current_epoch_id) between 3 and 128),
  next_round_number integer not null check (next_round_number between 2 and 100000),
  previous_settlement_digest_sha256 text not null
    check (previous_settlement_digest_sha256 ~ '^[0-9a-f]{64}$'),
  proposed_seed_krw numeric(20,2) not null default 1000000
    check (proposed_seed_krw = 1000000),
  previous_operating_capital_krw numeric(20,2) not null
    check (previous_operating_capital_krw >= 0),
  previous_locked_reserve_krw numeric(20,2) not null
    check (previous_locked_reserve_krw >= 0),
  minimum_entry_krw numeric(20,2)
    check (minimum_entry_krw is null or minimum_entry_krw > 0),
  observed_at timestamptz not null,
  proposed_at timestamptz not null default now(),
  status text not null default 'PROPOSAL_ONLY'
    check (status = 'PROPOSAL_ONLY'),
  execution_authority text not null default 'NONE'
    check (execution_authority = 'NONE'),
  financial_mutation_allowed boolean not null default false
    check (financial_mutation_allowed is false),
  reserve_transfer_allowed boolean not null default false
    check (reserve_transfer_allowed is false),
  historical_record_deletion_allowed boolean not null default false
    check (historical_record_deletion_allowed is false),
  unique (user_id,owner_role,trading_mode,market,current_epoch_id),
  unique (user_id,owner_role,trading_mode,market,next_round_number)
);
create index paper_research_round_proposals_owner_history
on public.paper_research_round_proposals
  (user_id,trading_mode,market,next_round_number desc);
alter table public.paper_research_round_proposals enable row level security;

-- Owner may read their own *proposals* after login; no browser can issue
-- seed/profit credit, change a proposal, remove bankruptcy or touch other owners.
revoke all on table public.paper_research_round_proposals
from public, anon, authenticated;
grant select on table public.paper_research_round_proposals to authenticated;
grant select, insert on table public.paper_research_round_proposals to service_role;
create policy "paper_round_proposal_owner_read"
on public.paper_research_round_proposals for select to authenticated
using (user_id = (select auth.uid()));

-- Service role also cannot erase or rewrite historical proposal rows.
create function public.paper_round_proposal_immutable()
returns trigger language plpgsql security invoker
set search_path = public, pg_temp
as $immutable$
begin
  raise exception 'PAPER_ROUND_PROPOSAL_APPEND_ONLY' using errcode='23514';
end
$immutable$;
create trigger paper_research_round_proposal_append_only
before update or delete on public.paper_research_round_proposals
for each row execute function public.paper_round_proposal_immutable();

revoke all on function public.paper_round_proposal_immutable()
from public, anon, authenticated;

-- Only service_role can send proposal-only rows. No security-definer RPC,
-- automatic 1m credit, wallet UPDATE or worker activation is installed.
commit;
