-- Draft-only: administrator V2 market-wallet protection (not applied to Production).
-- This migration MUST precede V2 wallet creation: user RLS permits reading
-- one's own V2 wallet but NEVER mutating it by authenticated Data API calls.
-- Trusted insertion is a narrowly scoped, administrator-confirmed server path.
begin;

do $admin_v2_wallet_prereqs$
begin
  if to_regclass('public.paper_accounts') is null
    or to_regprocedure('public.current_membership_level()') is null then
    raise exception 'ADMIN_PAPER_WALLET_RLS_PREREQUISITES_MISSING';
  end if;
end
$admin_v2_wallet_prereqs$;

alter table public.paper_accounts enable row level security;

-- Immutable administrator market-wallet *seed* evidence. Live virtual equity
-- is recomputed from canonical settled fills, not by rewriting this row.
-- Even privileged server code must never insert a 500k, cross-market, or
-- malformed V2 seed which could be mistaken for 1m capital later.
alter table public.paper_accounts
  drop constraint if exists admin_four_market_paper_seed_contract;
alter table public.paper_accounts
  add constraint admin_four_market_paper_seed_contract check (
    case when id like 'automatic-paper-admin-v2:%' then
      coalesce(
        id = ('automatic-paper-admin-v2:' || (payload->>'market'))
        and (payload->>'market') in (
          'domestic_stock','us_stock','crypto_spot','crypto_futures'
        )
        and (payload->>'id') = id
        and (payload->>'schemaVersion') = 'admin-four-market-paper-v2'
        and (payload->>'initialBalance')::numeric = 1000000
        and (payload->>'equity')::numeric = 1000000
        and (payload->>'cashBalance')::numeric = 1000000
        and (payload->>'availableMargin')::numeric = 1000000
        and (payload->>'usedMargin')::numeric = 0
        and (payload->>'reserveKrw')::numeric = 0
        and (payload->>'compoundedProfitKrw')::numeric = 0
        and (payload->>'compoundShare')::numeric = 0.5
        and (payload->>'reserveShare')::numeric = 0.5
        and (payload->>'reserveWithdrawalAutomatic')::boolean is false
        and deleted_at is null
        and version = 1,
        false
      )
    else true end
  );

-- Existing permissive owner-scoped policies are retained for normal Paper.
-- RESTRICTIVE write policies are logically AND-ed with every permissive
-- policy: even an accidentally-added permissive owner policy cannot grant
-- direct mutation of the protected V2 wallet ID namespace.
drop policy if exists "admin_v2_paper_wallet_insert_guard" on public.paper_accounts;
create policy "admin_v2_paper_wallet_insert_guard"
on public.paper_accounts as restrictive for insert to authenticated
with check (id not like 'automatic-paper-admin-v2:%');

drop policy if exists "admin_v2_paper_wallet_update_guard" on public.paper_accounts;
create policy "admin_v2_paper_wallet_update_guard"
on public.paper_accounts as restrictive for update to authenticated
using (id not like 'automatic-paper-admin-v2:%')
with check (id not like 'automatic-paper-admin-v2:%');

drop policy if exists "admin_v2_paper_wallet_delete_guard" on public.paper_accounts;
create policy "admin_v2_paper_wallet_delete_guard"
on public.paper_accounts as restrictive for delete to authenticated
using (id not like 'automatic-paper-admin-v2:%');

-- PostgreSQL TRUNCATE bypasses RLS. It must not be available to ordinary
-- clients, neither on wallets nor any adjacent Paper evidence table.
revoke truncate, references, trigger
on table public.paper_accounts, public.paper_orders, public.paper_positions,
  public.paper_fills, public.paper_journal_entries, public.paper_sync_state
from public, anon, authenticated;

-- An ordinary authenticated client can inspect whether its DB rollout is
-- protected; the RPC is SECURITY INVOKER and returns only a boolean, not rows.
create or replace function public.admin_four_paper_wallet_rls_guard_ready()
returns boolean
language sql stable security invoker
set search_path = public, pg_temp
as $readiness$
  select (select count(*) from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'paper_accounts'
      and policyname in (
        'admin_v2_paper_wallet_insert_guard',
        'admin_v2_paper_wallet_update_guard',
        'admin_v2_paper_wallet_delete_guard'
      )
      and permissive = 'RESTRICTIVE'
      -- A policy belonging only to anon or a different role is NOT an
      -- authenticated wallet guard. Check both role and denial operator;
      -- matching the wallet prefix alone would also accept an unsafe LIKE.
      and 'authenticated'::name = any(roles)
      and (
        (cmd = 'INSERT' and with_check like '%automatic-paper-admin-v2:%'
          and with_check ~* '(!~~|not[[:space:]]+like)')
        or (cmd = 'UPDATE'
          and qual like '%automatic-paper-admin-v2:%'
          and with_check like '%automatic-paper-admin-v2:%'
          and qual ~* '(!~~|not[[:space:]]+like)'
          and with_check ~* '(!~~|not[[:space:]]+like)')
        or (cmd = 'DELETE' and qual like '%automatic-paper-admin-v2:%'
          and qual ~* '(!~~|not[[:space:]]+like)')
      )
  ) = 3
  and exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.paper_accounts'::regclass
      and conname = 'admin_four_market_paper_seed_contract'
      and contype = 'c'
  )
  and not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in (
        'paper_accounts','paper_orders','paper_positions',
        'paper_fills','paper_journal_entries','paper_sync_state'
      )
      and grantee in ('PUBLIC','anon','authenticated')
      and privilege_type = 'TRUNCATE'
  )
$readiness$;

revoke all on function public.admin_four_paper_wallet_rls_guard_ready()
from public, anon, authenticated;
grant execute on function public.admin_four_paper_wallet_rls_guard_ready()
to authenticated;

do $verify$
begin
  if public.admin_four_paper_wallet_rls_guard_ready() is not true then
    raise exception 'ADMIN_PAPER_WALLET_RLS_GUARD_NOT_PROVEN';
  end if;
end
$verify$;

commit;
