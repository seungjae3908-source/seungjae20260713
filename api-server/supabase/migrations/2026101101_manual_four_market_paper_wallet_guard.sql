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

commit;
