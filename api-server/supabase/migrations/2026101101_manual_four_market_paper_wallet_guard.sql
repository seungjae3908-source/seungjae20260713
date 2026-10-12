-- DRAFT ONLY. Apply after 2026100901 admin and 2026101001 member Paper V2
-- guards. This creates *manual* 4-market immutable virtual seed protection.
-- It does not issue any seed, run a worker, unlock LIVE, or grant account API
-- authority. Service-role INSERT of 4 seeds requires separate confirmation.
begin;

do $preflight$
begin
  if to_regclass('public.paper_accounts') is null
     or to_regprocedure('public.four_market_paper_wallet_rls_guard_ready()') is null
     or public.four_market_paper_wallet_rls_guard_ready() is not true then
    raise exception 'MANUAL_FOUR_MARKET_PAPER_V2_GUARDS_REQUIRED';
  end if;
end
$preflight$;

-- The entire manual-paper-* namespace is protected. Reject forged
-- unknown roles, markets, versions and future seed identifiers unless a
-- separately reviewed migration explicitly introduces them.
alter table public.paper_accounts enable row level security;
alter table public.paper_accounts
  add constraint manual_four_market_paper_seed_contract check (
    case when id like 'manual-paper-%' then
      coalesce(
        id = ('manual-paper-' || payload->>'role' || '-v1:' || payload->>'market')
        and payload->>'role' in ('admin','member')
        and payload->>'mode' = 'manual'
        and payload->>'market' in ('domestic_stock','us_stock','crypto_spot','crypto_futures')
        and payload->>'schemaVersion' = 'manual-four-market-paper-v1'
        and payload->>'id' = id
        and (payload->>'initialBalance')::numeric = 1000000
        and (payload->>'equity')::numeric = 1000000
        and (payload->>'cashBalance')::numeric = 1000000
        and (payload->>'availableMargin')::numeric = 1000000
        and (payload->>'usedMargin')::numeric = 0
        and (payload->>'realizedPnl')::numeric = 0
        and (payload->>'unrealizedPnl')::numeric = 0
        and (payload->>'reserveKrw')::numeric = 0
        and (payload->>'compoundedProfitKrw')::numeric = 0
        and (payload->>'compoundShare')::numeric = 0.5
        and (payload->>'reserveShare')::numeric = 0.5
        and (payload->>'reserveWithdrawalAutomatic')::boolean is false
        and version = 1 and deleted_at is null,
        false
      )
    else true end
  );

-- No authenticated browser may mint, amend or delete any manual-mode seed,
-- even if another permissive owner policy is later introduced.
create policy "manual_v1_paper_wallet_insert_guard"
on public.paper_accounts as restrictive for insert to authenticated
with check (id not like 'manual-paper-%');
create policy "manual_v1_paper_wallet_update_guard"
on public.paper_accounts as restrictive for update to authenticated
using (id not like 'manual-paper-%')
with check (id not like 'manual-paper-%');
create policy "manual_v1_paper_wallet_delete_guard"
on public.paper_accounts as restrictive for delete to authenticated
using (id not like 'manual-paper-%');

-- Even service-role may INSERT the immutable seed only once. Disallow any
-- subsequent amendment/deletion to its original evidence at DB trigger level.
create function public.manual_paper_seed_immutable_v1()
returns trigger
language plpgsql security invoker
set search_path=public,pg_temp
as $immutable$
begin
  if tg_op = 'UPDATE' then
    if old.id like 'manual-paper-%'
      or new.id like 'manual-paper-%' then
      raise exception 'MANUAL_PAPER_SEED_IMMUTABLE' using errcode='23514';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.id like 'manual-paper-%' then
      raise exception 'MANUAL_PAPER_SEED_IMMUTABLE' using errcode='23514';
    end if;
    return old;
  end if;
  raise exception 'MANUAL_PAPER_SEED_UNEXPECTED_MUTATION';
end
$immutable$;
create trigger manual_four_market_paper_seed_immutability
before update or delete on public.paper_accounts
for each row execute function public.manual_paper_seed_immutable_v1();

-- TRUNCATE bypasses row-level security and row triggers.
revoke truncate,references,trigger on table public.paper_accounts
from public,anon,authenticated;

create function public.manual_four_market_paper_wallet_rls_guard_ready()
returns boolean
language sql stable security invoker set search_path=public,pg_temp
as $readiness$
  select public.four_market_paper_wallet_rls_guard_ready() is true
    and (select count(*) from pg_catalog.pg_policies
      where schemaname='public' and tablename='paper_accounts'
        and policyname in (
          'manual_v1_paper_wallet_insert_guard',
          'manual_v1_paper_wallet_update_guard',
          'manual_v1_paper_wallet_delete_guard'
        )
        and permissive='RESTRICTIVE'
        and 'authenticated'::name = any(roles)
        and (
          (cmd='INSERT'
            and with_check like '%manual-paper-%'
            and with_check ~* '(!~~|not[[:space:]]+like)')
          or (cmd='UPDATE'
            and qual like '%manual-paper-%'
            and with_check like '%manual-paper-%'
            and qual ~* '(!~~|not[[:space:]]+like)'
            and with_check ~* '(!~~|not[[:space:]]+like)')
          or (cmd='DELETE'
            and qual like '%manual-paper-%'
            and qual ~* '(!~~|not[[:space:]]+like)')
        )
    ) = 3
    and exists (
      select 1 from pg_catalog.pg_constraint
      where conrelid='public.paper_accounts'::regclass
        and conname='manual_four_market_paper_seed_contract'
        and contype='c'
    )
    and exists (
      select 1 from pg_catalog.pg_trigger
      where tgrelid='public.paper_accounts'::regclass
        and tgname='manual_four_market_paper_seed_immutability'
        and tgenabled='O'
    )
    and not exists (
      select 1 from information_schema.role_table_grants
      where table_schema='public' and table_name='paper_accounts'
        and grantee in ('PUBLIC','anon','authenticated')
        and privilege_type='TRUNCATE'
    )
$readiness$;
revoke all on function public.manual_four_market_paper_wallet_rls_guard_ready()
from public,anon,authenticated;
grant execute on function public.manual_four_market_paper_wallet_rls_guard_ready()
to authenticated,service_role;

do $verify$
begin
  if public.manual_four_market_paper_wallet_rls_guard_ready() is not true then
    raise exception 'MANUAL_FOUR_MARKET_PAPER_GUARD_NOT_PROVEN';
  end if;
end
$verify$;


-- Four-market manual Paper RESEARCH receipts are not executed orders or wallet
-- settlements. Append-only receipts preserve historical loss/profit arithmetic,
-- never authorize funding, withdrawals, LIVE orders or 50/50 reserve transfers.
create table public.paper_manual_four_market_research_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  cycle_id text not null,
  wallet_id text not null,
  owner_role text not null,
  market text not null,
  epoch_id text not null,
  round_number integer not null,
  receipt_sha256 text not null,
  receipt jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, cycle_id),
  constraint paper_manual_research_receipt_wallet_fk
    foreign key (user_id, wallet_id)
    references public.paper_accounts(user_id, id),
  constraint paper_manual_research_receipt_identity check (
    cycle_id ~ '^paper-manual-cycle-v1:[0-9a-f]{64}
    and receipt_sha256 ~ '^[0-9a-f]{64}
    and owner_role in ('admin','member')
    and market in ('domestic_stock','us_stock','crypto_spot','crypto_futures')
    and wallet_id = ('manual-paper-' || owner_role || '-v1:' || market)
    and length(epoch_id) between 1 and 150
    and round_number between 1 and 100000
  ),
  constraint paper_manual_research_receipt_claims check (
    jsonb_typeof(receipt) = 'object'
    and receipt->>'schemaVersion' = 'manual-four-market-research-receipt-v1'
    and receipt->>'cycleId' = cycle_id
    and receipt->>'ownerId' = user_id::text
    and receipt->>'role' = owner_role
    and receipt->>'market' = market
    and receipt->>'walletId' = wallet_id
    and receipt->>'epochId' = epoch_id
    and (receipt->>'roundNumber')::integer = round_number
    and receipt->>'status' = 'RESEARCH_SIMULATED_CLOSED'
    and receipt->>'executionAuthority' = 'NONE'
    and receipt->>'actualPaperLedgerWritten' = 'false'
    and receipt->>'realOrderSubmitted' = 'false'
    and receipt->>'profitabilityProven' = 'false'
    and receipt->>'financialMutationCount' = '0'
  )
);
create index paper_manual_research_receipt_owner_recent
  on public.paper_manual_four_market_research_receipts
  (user_id, created_at desc);

alter table public.paper_manual_four_market_research_receipts
  enable row level security;
alter table public.paper_manual_four_market_research_receipts
  force row level security;
-- Explicit grants are distinct from RLS: browser may read its own receipts,
-- but NEVER mint, alter, remove, truncate or convert a receipt into capital.
revoke all on table public.paper_manual_four_market_research_receipts
  from public,anon,authenticated,service_role;
grant select on public.paper_manual_four_market_research_receipts
  to authenticated,service_role;
grant insert on public.paper_manual_four_market_research_receipts
  to service_role;
create policy "paper_manual_research_receipt_owner_read_v1"
  on public.paper_manual_four_market_research_receipts
  for select to authenticated
  using ((select auth.uid()) = user_id);

create function public.paper_manual_research_receipt_immutable_v1()
returns trigger language plpgsql security invoker
set search_path=public,pg_temp as $receipt_immutable$
begin
  raise exception 'PAPER_MANUAL_RESEARCH_RECEIPT_IMMUTABLE'
    using errcode = '23514';
end
$receipt_immutable$;
create trigger paper_manual_research_receipt_no_update_delete
before update or delete on public.paper_manual_four_market_research_receipts
for each row execute function public.paper_manual_research_receipt_immutable_v1();
revoke truncate,update,delete on table
  public.paper_manual_four_market_research_receipts
  from public,anon,authenticated,service_role;

create function public.manual_four_market_paper_receipt_rls_guard_ready()
returns boolean language sql stable security invoker
set search_path=public,pg_temp as $receipt_ready$
  select public.manual_four_market_paper_wallet_rls_guard_ready() is true
    and exists(
      select 1 from pg_catalog.pg_class
      where oid='public.paper_manual_four_market_research_receipts'::regclass
        and relrowsecurity and relforcerowsecurity
    )
    and exists(
      select 1 from pg_catalog.pg_policies
      where schemaname='public'
        and tablename='paper_manual_four_market_research_receipts'
        and policyname='paper_manual_research_receipt_owner_read_v1'
        and cmd='SELECT' and permissive='PERMISSIVE'
        and 'authenticated'::name=any(roles)
        and qual like '%auth.uid()%'
        and qual like '%user_id%'
    )
    and not exists(
      select 1 from information_schema.role_table_grants
      where table_schema='public'
        and table_name='paper_manual_four_market_research_receipts'
        and grantee in ('PUBLIC','anon','authenticated','service_role')
        and privilege_type in ('UPDATE','DELETE','TRUNCATE')
    )
    and not exists(
      select 1 from information_schema.role_table_grants
      where table_schema='public'
        and table_name='paper_manual_four_market_research_receipts'
        and grantee in ('PUBLIC','anon','authenticated')
        and privilege_type='INSERT'
    )
    and exists(
      select 1 from pg_catalog.pg_trigger
      where tgrelid='public.paper_manual_four_market_research_receipts'::regclass
        and tgname='paper_manual_research_receipt_no_update_delete'
        and tgenabled='O'
    )
    and exists(
      select 1 from pg_catalog.pg_constraint
      where conrelid='public.paper_manual_four_market_research_receipts'::regclass
        and conname='paper_manual_research_receipt_wallet_fk'
        and contype='f'
    )
$receipt_ready$;
revoke all on function public.manual_four_market_paper_receipt_rls_guard_ready()
  from public,anon,authenticated;
grant execute on function public.manual_four_market_paper_receipt_rls_guard_ready()
  to authenticated,service_role;

do $verify_receipt$
begin
  if public.manual_four_market_paper_receipt_rls_guard_ready() is not true then
    raise exception 'MANUAL_PAPER_RESEARCH_RECEIPT_RLS_NOT_READY';
  end if;
end
$verify_receipt$;

commit;
