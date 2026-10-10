-- Four independent 1m automatic Paper wallets for every non-admin member.
-- Admin V2 protections remain unchanged. This migration only adds the member
-- namespace and a combined read-only guard; it never creates/reset wallets or
-- modifies historic Paper/canonical trading rows.
begin;

do $member_v2_wallet_prereqs$
begin
  if to_regclass('public.paper_accounts') is null
    or to_regprocedure('public.admin_four_paper_wallet_rls_guard_ready()') is null then
    raise exception 'MEMBER_PAPER_WALLET_RLS_PREREQUISITES_MISSING';
  end if;
end
$member_v2_wallet_prereqs$;

alter table public.paper_accounts enable row level security;

alter table public.paper_accounts
  drop constraint if exists member_four_market_paper_seed_contract;
alter table public.paper_accounts
  add constraint member_four_market_paper_seed_contract check (
    case when id like 'automatic-paper-member-v2:%' then
      coalesce(
        id = ('automatic-paper-member-v2:' || (payload->>'market'))
        and (payload->>'market') in (
          'domestic_stock','us_stock','crypto_spot','crypto_futures'
        )
        and (payload->>'id') = id
        and (payload->>'schemaVersion') = 'member-four-market-paper-v2'
        and (payload->>'role') = 'member'
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

-- Existing permissive owner policies still allow reads. These restrictive
-- policies deny every authenticated browser mutation in the member namespace.
drop policy if exists "member_v2_paper_wallet_insert_guard" on public.paper_accounts;
create policy "member_v2_paper_wallet_insert_guard"
on public.paper_accounts as restrictive for insert to authenticated
with check (id not like 'automatic-paper-member-v2:%');

drop policy if exists "member_v2_paper_wallet_update_guard" on public.paper_accounts;
create policy "member_v2_paper_wallet_update_guard"
on public.paper_accounts as restrictive for update to authenticated
using (id not like 'automatic-paper-member-v2:%')
with check (id not like 'automatic-paper-member-v2:%');

drop policy if exists "member_v2_paper_wallet_delete_guard" on public.paper_accounts;
create policy "member_v2_paper_wallet_delete_guard"
on public.paper_accounts as restrictive for delete to authenticated
using (id not like 'automatic-paper-member-v2:%');

-- Once a member V2 wallet exists, canonical automatic-Paper execution rows
-- are Worker-owned evidence. A browser must not forge FILLED profit, reserve,
-- a child leg, or protection state that could mint compound capital.
do $member_v2_canonical_auto_paper_write_guard$
declare
  rule record;
  p_name text;
begin
  for rule in select *
    from (values
      ('trade_order_plans', $plan_guard$
        not (
          coalesce(payload->>'accountMode','') = 'paper'
          and coalesce(payload->>'executionMode','') = 'automatic'
          and exists (select 1 from public.paper_accounts wallet
            where wallet.user_id = trade_order_plans.user_id
              and wallet.id like 'automatic-paper-member-v2:%')
        )
      $plan_guard$),
      ('trade_orders', $order_guard$
        not exists (
          select 1 from public.trade_order_plans plan
          join public.paper_accounts wallet on wallet.user_id = plan.user_id
          where plan.user_id = trade_orders.user_id
            and plan.id = trade_orders.plan_id
            and coalesce(plan.payload->>'accountMode','') = 'paper'
            and coalesce(plan.payload->>'executionMode','') = 'automatic'
            and wallet.id like 'automatic-paper-member-v2:%'
        )
      $order_guard$),
      ('trade_order_events', $event_guard$
        not exists (
          select 1 from public.trade_orders ord
          join public.trade_order_plans plan
            on plan.id = ord.plan_id and plan.user_id = ord.user_id
          join public.paper_accounts wallet on wallet.user_id = plan.user_id
          where ord.id = trade_order_events.order_id
            and ord.user_id = trade_order_events.user_id
            and coalesce(plan.payload->>'accountMode','') = 'paper'
            and coalesce(plan.payload->>'executionMode','') = 'automatic'
            and wallet.id like 'automatic-paper-member-v2:%'
        )
      $event_guard$),
      ('trade_order_legs', $leg_guard$
        not exists (
          select 1 from public.trade_order_plans plan
          join public.paper_accounts wallet on wallet.user_id = plan.user_id
          where plan.id = trade_order_legs.plan_id
            and plan.user_id = trade_order_legs.user_id
            and coalesce(plan.payload->>'accountMode','') = 'paper'
            and coalesce(plan.payload->>'executionMode','') = 'automatic'
            and wallet.id like 'automatic-paper-member-v2:%'
        )
      $leg_guard$),
      ('trade_protection_orders', $protection_guard$
        not exists (
          select 1 from public.trade_orders parent
          join public.trade_order_plans plan
            on plan.id = parent.plan_id and plan.user_id = parent.user_id
          join public.paper_accounts wallet on wallet.user_id = plan.user_id
          where parent.id = trade_protection_orders.parent_order_id
            and parent.user_id = trade_protection_orders.user_id
            and coalesce(plan.payload->>'accountMode','') = 'paper'
            and coalesce(plan.payload->>'executionMode','') = 'automatic'
            and wallet.id like 'automatic-paper-member-v2:%'
        )
      $protection_guard$)
    ) as guards(table_name, predicate)
  loop
    p_name := 'member_v2_auto_paper_insert_guard';
    execute format('drop policy if exists %I on public.%I', p_name, rule.table_name);
    execute format(
      'create policy %I on public.%I as restrictive for insert to authenticated with check (%s)',
      p_name, rule.table_name, rule.predicate
    );
    p_name := 'member_v2_auto_paper_update_guard';
    execute format('drop policy if exists %I on public.%I', p_name, rule.table_name);
    execute format(
      'create policy %I on public.%I as restrictive for update to authenticated using (%s) with check (%s)',
      p_name, rule.table_name, rule.predicate, rule.predicate
    );
    p_name := 'member_v2_auto_paper_delete_guard';
    execute format('drop policy if exists %I on public.%I', p_name, rule.table_name);
    execute format(
      'create policy %I on public.%I as restrictive for delete to authenticated using (%s)',
      p_name, rule.table_name, rule.predicate
    );
  end loop;
end
$member_v2_canonical_auto_paper_write_guard$;

create or replace function public.four_market_paper_wallet_rls_guard_ready()
returns boolean
language sql stable security invoker
set search_path = public, pg_temp
as $readiness$
  select public.admin_four_paper_wallet_rls_guard_ready() is true
  and (select count(*) from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'paper_accounts'
      and policyname in (
        'member_v2_paper_wallet_insert_guard',
        'member_v2_paper_wallet_update_guard',
        'member_v2_paper_wallet_delete_guard'
      )
      and permissive = 'RESTRICTIVE'
      and 'authenticated'::name = any(roles)
      and (
        (cmd = 'INSERT' and with_check like '%automatic-paper-member-v2:%'
          and with_check ~* '(!~~|not[[:space:]]+like)')
        or (cmd = 'UPDATE'
          and qual like '%automatic-paper-member-v2:%'
          and with_check like '%automatic-paper-member-v2:%'
          and qual ~* '(!~~|not[[:space:]]+like)'
          and with_check ~* '(!~~|not[[:space:]]+like)')
        or (cmd = 'DELETE' and qual like '%automatic-paper-member-v2:%'
          and qual ~* '(!~~|not[[:space:]]+like)')
      )
  ) = 3
  and exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.paper_accounts'::regclass
      and conname = 'member_four_market_paper_seed_contract'
      and contype = 'c'
  )
  and (
    select count(*) from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename in ('trade_order_plans','trade_orders','trade_order_events',
        'trade_order_legs','trade_protection_orders')
      and policyname in ('member_v2_auto_paper_insert_guard',
        'member_v2_auto_paper_update_guard','member_v2_auto_paper_delete_guard')
      and permissive = 'RESTRICTIVE'
      and 'authenticated'::name = any(roles)
      and (coalesce(qual,'') like '%automatic-paper-member-v2:%'
        or coalesce(with_check,'') like '%automatic-paper-member-v2:%')
  ) = 15
$readiness$;

revoke all on function public.four_market_paper_wallet_rls_guard_ready()
from public, anon, authenticated;
grant execute on function public.four_market_paper_wallet_rls_guard_ready()
to authenticated, service_role;

do $verify$
begin
  if public.four_market_paper_wallet_rls_guard_ready() is not true then
    raise exception 'MEMBER_PAPER_WALLET_RLS_GUARD_NOT_PROVEN';
  end if;
end
$verify$;

commit;
