-- DRAFT ONLY: next AUTOMATIC Paper research epoch *staging*, not activation.
-- This depends on 2026101103 immutable verified PROPOSAL_ONLY receipts.
-- New rows are not broker accounts and have no order, settlement, reserve
-- transfer or worker authority. No production SQL is applied by this PR.
begin;

do $readiness$
begin
  if to_regclass('public.paper_research_round_proposals') is null
     or to_regclass('public.paper_accounts') is null then
    raise exception 'PAPER_V3_VERIFIED_PROPOSAL_PREDECESSOR_REQUIRED';
  end if;
end
$readiness$;

-- A composite reference prevents an unrelated owner's or market's proposal
-- from being recycled to create a virtual epoch.
alter table public.paper_research_round_proposals
  add constraint paper_v3_exact_proposal_binding unique (
    proposal_id,user_id,owner_role,trading_mode,market,next_round_number,
    previous_settlement_digest_sha256,ending_cause
  );

create table public.paper_research_round_wallet_epochs (
  epoch_id text primary key
    check (epoch_id ~ '^paper-v3-epoch:[0-9a-f]{64}$'),
  proposal_id text not null,
  user_id uuid not null,
  owner_role text not null check (owner_role in ('admin','member')),
  market text not null check (
    market in ('domestic_stock','us_stock','crypto_spot','crypto_futures')
  ),
  mode text not null check (mode='automatic'),
  source_epoch_id text not null check (length(source_epoch_id) between 3 and 128),
  previous_settlement_digest_sha256 text not null
    check (previous_settlement_digest_sha256 ~ '^[0-9a-f]{64}$'),
  next_round_number integer not null check(next_round_number between 2 and 100000),
  virtual_seed_krw numeric(20,2) not null check (virtual_seed_krw=1000000),
  operating_balance_seed_krw numeric(20,2) not null check (operating_balance_seed_krw=1000000),
  locked_reserve_seed_krw numeric(20,2) not null check (locked_reserve_seed_krw=0),
  previous_locked_reserve_krw numeric(20,2) not null check (previous_locked_reserve_krw>=0),
  previous_residual_operating_krw numeric(20,2) not null
    check (previous_residual_operating_krw>=0),
  ending_cause text not null check (
    ending_cause in ('ZERO_EQUITY','BELOW_VERIFIED_MINIMUM')
  ),
  activation_state text not null check (activation_state='STAGED_NOT_ACTIVE'),
  execution_authority text not null check(execution_authority='NONE'),
  real_order_enabled boolean not null check(real_order_enabled=false),
  previous_history_preserved boolean not null check(previous_history_preserved=true),
  actual_paper_worker_attached boolean not null check(actual_paper_worker_attached=false),
  created_from_verified_receipt boolean not null check(created_from_verified_receipt=true),
  created_at timestamptz not null default now(),
  -- DB-level foreign key binds BOTH immutable economic evidence fields
  -- to the proposal; another market or an altered bankruptcy claim cannot
  -- reuse a genuine 1m virtual seed receipt.
  foreign key(proposal_id,user_id,owner_role,mode,market,next_round_number,
    previous_settlement_digest_sha256,ending_cause)
    references public.paper_research_round_proposals(
      proposal_id,user_id,owner_role,trading_mode,market,next_round_number,
      previous_settlement_digest_sha256,ending_cause
    ) on update restrict on delete restrict,
  constraint paper_v3_ending_evidence_check check (
    (ending_cause='ZERO_EQUITY' and previous_residual_operating_krw=0)
    or (ending_cause='BELOW_VERIFIED_MINIMUM' and previous_residual_operating_krw>0)
  ),
  unique (user_id,owner_role,mode,market,source_epoch_id),
  unique (user_id,owner_role,mode,market,next_round_number)
);
create index paper_research_round_v3_owner_readback
  on public.paper_research_round_wallet_epochs
  (user_id,owner_role,mode,market,next_round_number desc);
alter table public.paper_research_round_wallet_epochs enable row level security;

revoke all on table public.paper_research_round_wallet_epochs from public,anon,authenticated;
grant select on table public.paper_research_round_wallet_epochs to authenticated;
grant select,insert on table public.paper_research_round_wallet_epochs to service_role;

create policy "paper_v3_owner_staged_read"
  on public.paper_research_round_wallet_epochs for select to authenticated
  using (user_id=(select auth.uid()));

-- Historical virtual research epochs cannot be silently reset, rewritten,
-- removed, promoted to ACTIVE, or have locked reserve moved by DB UPDATE.
create function public.paper_v3_epoch_append_only()
returns trigger language plpgsql security invoker
set search_path=public,pg_temp
as $append_only$
begin
  raise exception 'PAPER_V3_EPOCH_IMMUTABLE' using errcode='23514';
end
$append_only$;
create trigger paper_v3_epoch_immutable
before update or delete on public.paper_research_round_wallet_epochs
for each row execute function public.paper_v3_epoch_append_only();
revoke all on function public.paper_v3_epoch_append_only()
from public,anon,authenticated;

-- TRUNCATE ignores row trigger and RLS, so no browser role may have it.
revoke truncate,references,trigger on public.paper_research_round_wallet_epochs
from public,anon,authenticated;

commit;
