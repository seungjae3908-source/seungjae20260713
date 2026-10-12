begin;

-- No time-based release: an unknown provider outcome continues to consume its
-- whole reservation across crashes, lease expiry, deployments and PM2 restart.
create table if not exists public.trade_live_budget_reservations (
  user_id uuid not null,
  order_id uuid not null,
  plan_id uuid not null,
  market text not null check (market in ('domestic_stock','us_stock','crypto_spot','crypto_futures')),
  instrument text not null check (length(instrument) between 1 and 255),
  strategy text not null check (length(strategy) between 1 and 255),
  amount_krw numeric(16,2) not null check (amount_krw > 0 and amount_krw <= 10000000000),
  risk_krw numeric(16,2) not null check (risk_krw >= 0 and risk_krw <= 10000000000),
  state text not null default 'HELD' check (state in ('HELD','RELEASED')),
  created_at timestamptz not null default now(),
  released_at timestamptz,
  primary key (user_id, order_id),
  foreign key (user_id, order_id) references public.trade_orders(user_id,id) on delete restrict,
  foreign key (user_id, plan_id) references public.trade_order_plans(user_id,id) on delete restrict,
  check ((state='HELD' and released_at is null) or (state='RELEASED' and released_at is not null))
);
alter table public.trade_live_budget_reservations enable row level security;
revoke all on public.trade_live_budget_reservations from public, anon, authenticated;
grant select, insert, update on public.trade_live_budget_reservations to service_role;
create index if not exists trade_live_budget_active_user_idx
  on public.trade_live_budget_reservations(user_id) where state='HELD';

create or replace function public.read_automatic_live_budget_snapshot(p_user_id uuid)
returns jsonb language plpgsql stable security invoker
set search_path=pg_catalog,public,pg_temp
as $snapshot$
declare result jsonb;
begin
  if p_user_id is null or (auth.uid() is not null and auth.uid()<>p_user_id) then raise exception 'USER_SCOPE_MISMATCH'; end if;
  -- One SELECT = one MVCC snapshot. This JSON scalar is not silently truncated
  -- by the Data API's 1,000-row limit. Never expose it to member/browser roles.
  select jsonb_build_object(
    'policy',(select payload from public.trade_automation_profiles where user_id=p_user_id),
    'emergencyStopped',coalesce((select emergency_stopped from public.trade_system_controls where control_key='global'),true),
    'plans',coalesce((select jsonb_agg(payload order by id) from public.trade_order_plans where user_id=p_user_id),'[]'::jsonb),
    'orders',coalesce((select jsonb_agg(payload order by id) from public.trade_orders where user_id=p_user_id),'[]'::jsonb),
    'holds',coalesce((select jsonb_agg(jsonb_build_object('orderId',order_id::text,'market',market,
      'instrument',instrument,'strategy',strategy,'amountKrw',amount_krw,'riskKrw',risk_krw) order by order_id)
      from public.trade_live_budget_reservations where user_id=p_user_id and state='HELD'),'[]'::jsonb)
  ) into result;
  if jsonb_array_length(result->'plans')>100000 or jsonb_array_length(result->'orders')>100000
    or jsonb_array_length(result->'holds')>100000 then raise exception 'AUTOMATIC_LIVE_BUDGET_HISTORY_BOUND_EXCEEDED'; end if;
  return result;
end $snapshot$;
revoke all on function public.read_automatic_live_budget_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.read_automatic_live_budget_snapshot(uuid) to service_role;

create or replace function public.reserve_automatic_live_entry_budget(
  p_user_id uuid, p_order_id uuid, p_claim_id uuid,
  p_expected_snapshot jsonb, p_projection jsonb, p_verify_only boolean default false
) returns jsonb language plpgsql volatile security invoker
set search_path=pg_catalog,public,pg_temp
-- PostgREST applies this function setting before starting its transaction.
-- Direct SQL callers must also start a SERIALIZABLE transaction; fail closed
-- rather than assuming a READ COMMITTED snapshot protects concurrent ledger edits.
set default_transaction_isolation='serializable'
set lock_timeout='3s'
as $reserve$
declare
  current_order public.trade_orders%rowtype;
  current_plan jsonb;
  limits jsonb:=p_projection->'limits';
  exposure record;
  code text;
  result jsonb;
begin
  if current_setting('transaction_isolation')<>'serializable' then raise exception 'AUTOMATIC_LIVE_BUDGET_SERIALIZABLE_REQUIRED'; end if;
  if p_user_id is null or p_order_id is null or p_claim_id is null
    or (auth.uid() is not null and auth.uid()<>p_user_id) then raise exception 'USER_SCOPE_MISMATCH'; end if;
  -- Validate container/scalar shapes before any set-returning function or
  -- numeric cast. SQL OR evaluation order is not a type-validation fence.
  if p_verify_only is null or jsonb_typeof(p_projection) is distinct from 'object'
    or jsonb_typeof(limits) is distinct from 'object'
    or jsonb_typeof(p_projection->'baseCharges') is distinct from 'array'
    or jsonb_typeof(p_projection->'releases') is distinct from 'array'
    or exists(select 1 from unnest(array['expectedVersion','amountKrw','riskKrw']) k
      where jsonb_typeof(p_projection->k) is distinct from 'number')
    or exists(select 1 from unnest(array['market','instrument','strategy']) k
      where jsonb_typeof(p_projection->k) is distinct from 'string' or length(p_projection->>k)=0) then
    raise exception 'AUTOMATIC_LIVE_BUDGET_PROJECTION_INVALID';
  end if;
  if (p_projection->>'expectedVersion')::numeric<0
    or (p_projection->>'expectedVersion')::numeric<>floor((p_projection->>'expectedVersion')::numeric)
    or (p_projection->>'expectedVersion')::numeric>9007199254740991 then
    raise exception 'AUTOMATIC_LIVE_BUDGET_PROJECTION_INVALID';
  end if;
  -- Short DB transaction only. No lock is retained during provider HTTP calls.
  perform pg_advisory_xact_lock(hashtextextended('automatic-live-budget:'||p_user_id::text,0));
  if public.read_automatic_live_budget_snapshot(p_user_id) is distinct from p_expected_snapshot then
    return jsonb_build_object('status','SNAPSHOT_STALE');
  end if;
  select * into current_order from public.trade_orders where user_id=p_user_id and id=p_order_id for update;
  select payload into current_plan from public.trade_order_plans where user_id=p_user_id and id=current_order.plan_id for share;
  if not found or current_order.state is distinct from 'SUBMITTED'
    or jsonb_typeof(p_projection) is distinct from 'object'
    or jsonb_typeof(p_projection->'expectedVersion') is distinct from 'number'
    or current_order.version is distinct from (p_projection->>'expectedVersion')::bigint
    or coalesce(current_order.payload->>'submissionStartedAt','')<>'' then
    return jsonb_build_object('status','CLAIM_UNAVAILABLE');
  end if;
  if current_plan->>'accountMode' is distinct from 'live' or current_plan->>'state' is distinct from 'SUBMITTED'
    or coalesce((current_plan->>'reduceOnly')::boolean,false)
    or not coalesce(current_plan->>'executionMode'='automatic' or current_plan->'signalReasons' ? 'CANONICAL_LIVE_AUTO_HANDOFF',false)
    or not (p_projection ?& array['userId','orderId','planId','expectedVersion','market','instrument','strategy','amountKrw','riskKrw','limits','baseCharges','releases'])
    or p_projection->>'userId' is distinct from p_user_id::text or p_projection->>'orderId' is distinct from p_order_id::text
    or p_projection->>'planId' is distinct from current_order.plan_id::text
    or jsonb_typeof(p_projection->'amountKrw') is distinct from 'number'
    or jsonb_typeof(p_projection->'riskKrw') is distinct from 'number'
    or (p_projection->>'amountKrw')::numeric is distinct from ceil((current_plan->>'estimatedKrw')::numeric*100)/100
    or (p_projection->>'amountKrw')::numeric<=0 or (p_projection->>'amountKrw')::numeric>10000000000
    or (p_projection->>'riskKrw')::numeric<0 or (p_projection->>'riskKrw')::numeric>10000000000
    or jsonb_typeof(limits) is distinct from 'object'
    or not (limits ?& array['total','market','instrument','strategy','risk','positions','order'])
    or exists(select 1 from jsonb_each(limits) v where case when jsonb_typeof(v.value) is distinct from 'number' then true
      else (v.value::text)::numeric<=0 or (v.value::text)::numeric>10000000000 end)
    or p_projection->>'market' not in ('domestic_stock','us_stock','crypto_spot','crypto_futures')
    or exists(select 1 from unnest(array['market','instrument','strategy']) k
      where jsonb_typeof(p_projection->k) is distinct from 'string' or length(p_projection->>k)=0)
    or jsonb_typeof(p_projection->'baseCharges') is distinct from 'array'
    or jsonb_typeof(p_projection->'releases') is distinct from 'array' then
    raise exception 'AUTOMATIC_LIVE_BUDGET_PROJECTION_INVALID';
  end if;
  if p_verify_only then
    if current_order.execution_claim_id is distinct from p_claim_id or not exists(
      select 1 from public.trade_live_budget_reservations where user_id=p_user_id and order_id=p_order_id and state='HELD'
      and amount_krw=(p_projection->>'amountKrw')::numeric and risk_krw=(p_projection->>'riskKrw')::numeric
    ) then return jsonb_build_object('status','BLOCKED','blockCode','AUTOMATIC_LIVE_BUDGET_RESERVATION_REQUIRED'); end if;
  elsif current_order.execution_claimed_at is not null and current_order.execution_claimed_at>=clock_timestamp()-interval '30 seconds' then
    return jsonb_build_object('status','CLAIM_UNAVAILABLE');
  end if;
  -- All base/release rows must belong to this owner and immutable snapshot.
  if exists(select 1 from jsonb_array_elements(p_projection->'baseCharges') c
    where jsonb_typeof(c) is distinct from 'object'
      or not (c ?& array['orderId','market','instrument','strategy','amountKrw','riskKrw'])
      or exists(select 1 from unnest(array['orderId','market','instrument','strategy']) k
        where jsonb_typeof(c->k) is distinct from 'string' or length(c->>k)=0)
      or exists(select 1 from unnest(array['amountKrw','riskKrw']) k
        where jsonb_typeof(c->k) is distinct from 'number')
      or not exists(select 1 from public.trade_orders o where o.user_id=p_user_id and o.id::text=c->>'orderId')
      or c->>'orderId'=p_order_id::text
      or (c->>'amountKrw')::numeric<=0 or (c->>'amountKrw')::numeric>10000000000
      or (c->>'riskKrw')::numeric<0 or (c->>'riskKrw')::numeric>10000000000)
    or (select count(*)<>count(distinct c->>'orderId') from jsonb_array_elements(p_projection->'baseCharges') c)
    or exists(select 1 from jsonb_array_elements(p_projection->'releases') r where jsonb_typeof(r) is distinct from 'string')
    or exists(select 1 from jsonb_array_elements_text(p_projection->'releases') r
      where not exists(select 1 from public.trade_live_budget_reservations h where h.user_id=p_user_id and h.order_id::text=r.value and h.state='HELD')) then
    raise exception 'AUTOMATIC_LIVE_BUDGET_PROJECTION_SCOPE_INVALID';
  end if;
  -- Actual fill repricing can exceed the original hold. Retain the greater
  -- amount/risk per order without double-counting its position or principal.
  if exists(select 1 from jsonb_array_elements(p_projection->'baseCharges') c
    join public.trade_live_budget_reservations h on h.user_id=p_user_id and h.order_id::text=c->>'orderId' and h.state='HELD'
    where h.market is distinct from c->>'market' or h.instrument is distinct from c->>'instrument'
      or h.strategy is distinct from c->>'strategy') then
    raise exception 'AUTOMATIC_LIVE_BUDGET_CHARGE_LINEAGE_DRIFT';
  end if;
  with candidates as (
    select order_id::text order_id,market,instrument,strategy,amount_krw,risk_krw from public.trade_live_budget_reservations
      where user_id=p_user_id and state='HELD' and order_id<>p_order_id
        and not (p_projection->'releases' ? order_id::text)
    union all
    select c->>'orderId',c->>'market',c->>'instrument',c->>'strategy',(c->>'amountKrw')::numeric,(c->>'riskKrw')::numeric
      from jsonb_array_elements(p_projection->'baseCharges') c
    union all
    select p_order_id::text,p_projection->>'market',p_projection->>'instrument',p_projection->>'strategy',
      (p_projection->>'amountKrw')::numeric,(p_projection->>'riskKrw')::numeric
  ), charges as (
    select order_id,market,instrument,strategy,max(amount_krw) amount_krw,max(risk_krw) risk_krw
      from candidates group by order_id,market,instrument,strategy
  ) select sum(amount_krw) total,sum(risk_krw) risk,count(*) positions,
    sum(amount_krw) filter(where market=p_projection->>'market') market,
    sum(amount_krw) filter(where instrument=p_projection->>'instrument') instrument,
    count(*) filter(where instrument=p_projection->>'instrument') instrument_count,
    sum(amount_krw) filter(where strategy=p_projection->>'strategy') strategy into exposure from charges;
  code:=case
    when (p_projection->>'amountKrw')::numeric>(limits->>'order')::numeric then 'ORDER'
    when exposure.total>(limits->>'total')::numeric then 'TOTAL'
    when exposure.market>(limits->>'market')::numeric then 'MARKET'
    when exposure.instrument>(limits->>'instrument')::numeric then 'INSTRUMENT'
    when exposure.instrument_count<>1 then 'DUPLICATE_INSTRUMENT'
    when exposure.strategy>(limits->>'strategy')::numeric then 'STRATEGY'
    when exposure.risk>(limits->>'risk')::numeric then 'RISK'
    when exposure.positions>(limits->>'positions')::numeric then 'POSITIONS'
    else null end;
  if code is not null then return jsonb_build_object('status','BLOCKED','blockCode','AUTOMATIC_LIVE_BUDGET_'||code||'_EXCEEDED'); end if;
  if p_verify_only then return jsonb_build_object('status','RESERVED','order',current_order.payload); end if;
  update public.trade_live_budget_reservations set state='RELEASED',released_at=clock_timestamp()
    where user_id=p_user_id and state='HELD' and p_projection->'releases' ? order_id::text;
  insert into public.trade_live_budget_reservations(user_id,order_id,plan_id,market,instrument,strategy,amount_krw,risk_krw)
    values(p_user_id,p_order_id,current_order.plan_id,p_projection->>'market',p_projection->>'instrument',p_projection->>'strategy',
      (p_projection->>'amountKrw')::numeric,(p_projection->>'riskKrw')::numeric)
    on conflict(user_id,order_id) do nothing;
  if not exists(select 1 from public.trade_live_budget_reservations where user_id=p_user_id and order_id=p_order_id and state='HELD'
    and amount_krw=(p_projection->>'amountKrw')::numeric and risk_krw=(p_projection->>'riskKrw')::numeric) then
    raise exception 'AUTOMATIC_LIVE_BUDGET_RESERVATION_DRIFT';
  end if;
  update public.trade_orders set execution_claim_id=p_claim_id,execution_claimed_at=clock_timestamp(),
    version=version+1,payload=jsonb_set(jsonb_set(payload,'{version}',to_jsonb(version+1),true),
      '{executionClaimId}',to_jsonb(p_claim_id::text),true),updated_at=clock_timestamp()
    where user_id=p_user_id and id=p_order_id returning payload into result;
  return jsonb_build_object('status','RESERVED','order',result);
end $reserve$;
revoke all on function public.reserve_automatic_live_entry_budget(uuid,uuid,uuid,jsonb,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.reserve_automatic_live_entry_budget(uuid,uuid,uuid,jsonb,jsonb,boolean) to service_role;

-- Legacy per-order claiming remains for manual/Paper/exits, but cannot bypass
-- the server-only aggregate-budget claim for an automatic LIVE entry.
create or replace function public.claim_trade_order_execution(
  p_user_id uuid,p_order_id uuid,p_expected_version bigint,p_claim_id uuid,p_lease_seconds integer default 30
) returns jsonb language plpgsql security invoker set search_path=pg_catalog,public,pg_temp
as $claim$
declare result jsonb;
begin
  if auth.uid() is not null and auth.uid()<>p_user_id then raise exception 'USER_SCOPE_MISMATCH'; end if;
  if p_lease_seconds<5 or p_lease_seconds>300 then raise exception 'TRADE_EXECUTION_LEASE_INVALID'; end if;
  if exists(select 1 from public.trade_orders o join public.trade_order_plans p on p.user_id=o.user_id and p.id=o.plan_id
    where o.user_id=p_user_id and o.id=p_order_id and p.payload->>'accountMode'='live'
      and not coalesce((p.payload->>'reduceOnly')::boolean,false)
      and (p.payload->>'executionMode'='automatic' or p.payload->'signalReasons' ? 'CANONICAL_LIVE_AUTO_HANDOFF')) then
    raise exception 'AUTOMATIC_LIVE_ATOMIC_BUDGET_CLAIM_REQUIRED';
  end if;
  update public.trade_orders set execution_claim_id=p_claim_id,execution_claimed_at=clock_timestamp(),version=version+1,
    payload=jsonb_set(jsonb_set(payload,'{version}',to_jsonb(version+1),true),'{executionClaimId}',to_jsonb(p_claim_id::text),true),updated_at=clock_timestamp()
    where user_id=p_user_id and id=p_order_id and state='SUBMITTED' and version=p_expected_version
      and coalesce(payload->>'submissionStartedAt','')=''
      and (execution_claimed_at is null or execution_claimed_at<clock_timestamp()-make_interval(secs=>p_lease_seconds))
    returning payload into result;
  return result;
end $claim$;
revoke all on function public.claim_trade_order_execution(uuid,uuid,bigint,uuid,integer) from public,anon;
grant execute on function public.claim_trade_order_execution(uuid,uuid,bigint,uuid,integer) to authenticated,service_role;

-- Budget/ownership proofs are meaningless if a browser can forge an AUTO LIVE
-- fill, fee, closing event or entry provenance through the Data API. Preserve
-- existing owner SELECT and manual/Paper permissions; only AUTO LIVE ledger
-- writes require the scoped server repository. This grants no trading authority.
create or replace function public.is_automatic_live_ledger_payload(p_payload jsonb)
returns boolean language sql immutable security invoker set search_path=pg_catalog,public,pg_temp
as $payload$
  select coalesce(p_payload->>'accountMode'='live' and (
    p_payload->>'executionMode'='automatic'
    or p_payload->'signalReasons' ? 'CANONICAL_LIVE_AUTO_HANDOFF'
    or coalesce((p_payload->'signalReasons')::text,'') like '%AUTO_EXIT_ENTRY_PLAN:%'
  ),false);
$payload$;
revoke all on function public.is_automatic_live_ledger_payload(jsonb) from public,anon;
grant execute on function public.is_automatic_live_ledger_payload(jsonb) to authenticated,service_role;
do $ledger_policies$
declare row record; expr text;
begin
  for row in select * from (values
    ('trade_order_plans','not public.is_automatic_live_ledger_payload(payload)'),
    ('trade_orders','not exists(select 1 from public.trade_order_plans p where p.user_id=trade_orders.user_id and p.id=trade_orders.plan_id and public.is_automatic_live_ledger_payload(p.payload))'),
    ('trade_order_events','not exists(select 1 from public.trade_orders o join public.trade_order_plans p on p.user_id=o.user_id and p.id=o.plan_id where o.user_id=trade_order_events.user_id and o.id=trade_order_events.order_id and public.is_automatic_live_ledger_payload(p.payload))'),
    ('trade_order_legs','not exists(select 1 from public.trade_order_plans p where p.user_id=trade_order_legs.user_id and p.id=trade_order_legs.plan_id and public.is_automatic_live_ledger_payload(p.payload))'),
    ('trade_protection_orders','not exists(select 1 from public.trade_orders o join public.trade_order_plans p on p.user_id=o.user_id and p.id=o.plan_id where o.user_id=trade_protection_orders.user_id and o.id=trade_protection_orders.parent_order_id and public.is_automatic_live_ledger_payload(p.payload))')
  ) rules(relation,expression) loop
    expr:=row.expression;
    execute format('drop policy if exists auto_live_server_insert_guard on public.%I',row.relation);
    execute format('create policy auto_live_server_insert_guard on public.%I as restrictive for insert to authenticated with check (%s)',row.relation,expr);
    execute format('drop policy if exists auto_live_server_update_guard on public.%I',row.relation);
    execute format('create policy auto_live_server_update_guard on public.%I as restrictive for update to authenticated using (%s) with check (%s)',row.relation,expr,expr);
    execute format('drop policy if exists auto_live_server_delete_guard on public.%I',row.relation);
    execute format('create policy auto_live_server_delete_guard on public.%I as restrictive for delete to authenticated using (%s)',row.relation,expr);
  end loop;
end $ledger_policies$;

create or replace function public.read_automatic_live_budget_guard()
returns jsonb language sql stable security invoker set search_path=pg_catalog,public,pg_temp
set default_transaction_isolation='serializable'
as $guard$
  select jsonb_build_object('version','automatic-live-atomic-budget-v2','ready',coalesce(
    current_setting('transaction_isolation')='serializable'
    and
    (select relrowsecurity from pg_class where oid='public.trade_live_budget_reservations'::regclass)
    and not has_table_privilege('anon','public.trade_live_budget_reservations','SELECT,INSERT,UPDATE,DELETE')
    and not has_table_privilege('authenticated','public.trade_live_budget_reservations','SELECT,INSERT,UPDATE,DELETE')
    and has_table_privilege('service_role','public.trade_live_budget_reservations','SELECT')
    and has_table_privilege('service_role','public.trade_live_budget_reservations','INSERT')
    and has_table_privilege('service_role','public.trade_live_budget_reservations','UPDATE')
    and (select count(*)=3 and bool_and(not p.prosecdef
      and not has_function_privilege('anon',p.oid,'EXECUTE')
      and not has_function_privilege('authenticated',p.oid,'EXECUTE')
      and has_function_privilege('service_role',p.oid,'EXECUTE'))
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
        and p.proname in ('read_automatic_live_budget_snapshot','reserve_automatic_live_entry_budget','read_automatic_live_budget_guard'))
    and (select 'default_transaction_isolation=serializable'=any(proconfig) from pg_proc
      where oid='public.reserve_automatic_live_entry_budget(uuid,uuid,uuid,jsonb,jsonb,boolean)'::regprocedure)
    and (select count(*)=15 and bool_and(polpermissive=false and 'authenticated'::regrole::oid=any(polroles))
      from pg_policy where polrelid in ('public.trade_order_plans'::regclass,'public.trade_orders'::regclass,
        'public.trade_order_events'::regclass,'public.trade_order_legs'::regclass,'public.trade_protection_orders'::regclass)
        and polname in ('auto_live_server_insert_guard','auto_live_server_update_guard','auto_live_server_delete_guard'))
  ,false));
$guard$;
revoke all on function public.read_automatic_live_budget_guard() from public,anon,authenticated;
grant execute on function public.read_automatic_live_budget_guard() to service_role;
notify pgrst,'reload schema';
commit;
