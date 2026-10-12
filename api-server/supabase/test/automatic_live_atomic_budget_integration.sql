\set ON_ERROR_STOP on
-- Disposable database only. Every fixture and reservation is rolled back.
begin isolation level serializable;
select set_config('request.jwt.claim.sub','',true);

do $acl$ begin
  if (public.read_automatic_live_budget_guard()->>'ready')::boolean is distinct from true then
    raise exception 'atomic budget schema/ACL/isolation guard not ready';
  end if;
  if has_function_privilege('authenticated','public.reserve_automatic_live_entry_budget(uuid,uuid,uuid,jsonb,jsonb,boolean)','EXECUTE')
    or has_function_privilege('anon','public.read_automatic_live_budget_snapshot(uuid)','EXECUTE')
    or has_table_privilege('authenticated','public.trade_live_budget_reservations','INSERT') then
    raise exception 'member/anonymous can bypass server-owned budget derivation';
  end if;
end $acl$;

insert into public.trade_automation_profiles(user_id,payload)
values('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','{"mode":"automatic","automaticEnabled":true}')
on conflict(user_id) do update set payload=excluded.payload;

insert into public.trade_order_plans(user_id,id,idempotency_key,state,version,approval_expires_at,payload)
select 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',('47000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
  'atomic-budget-probe-'||n,'SUBMITTED',0,transaction_timestamp()+interval '10 minutes',
  jsonb_build_object('id','47000000-0000-0000-0000-'||lpad(n::text,12,'0'),
    'userId','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','state','SUBMITTED','version',0,
    'accountMode','live','executionMode','automatic','exchange','upbit','market','KRW',
    'symbol','BUDGET'||n,'strategyId','budget-test','signalReasons','[]'::jsonb,
    'reduceOnly',false,'estimatedKrw',70000,'approvedAt',transaction_timestamp()::text,
    'approvalExpiresAt',(transaction_timestamp()+interval '10 minutes')::text,'splitRatios','[100]'::jsonb,
    'riskEnvelope',jsonb_build_object('version',1,'investmentKrw',70000,'maxLossKrw',700,
      'maxSlippagePercent',0.25,'maxSplitCount',1,'allowCancelUnfilled',true,'stopMethod','fixed_stop',
      'emergencyExitScope','cancel_unfilled_and_reduce_only','approvedAt',transaction_timestamp()::text,
      'expiresAt',(transaction_timestamp()+interval '10 minutes')::text))
from generate_series(1,2) n;

insert into public.trade_orders(user_id,id,plan_id,exchange,client_order_id,state,version,payload)
select 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',('57000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
  ('47000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'upbit','atomic-budget-order-'||n,'SUBMITTED',0,
  jsonb_build_object('id','57000000-0000-0000-0000-'||lpad(n::text,12,'0'),
    'planId','47000000-0000-0000-0000-'||lpad(n::text,12,'0'),'userId','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'state','SUBMITTED','version',0,'exchange','upbit','filledQuantity',0)
from generate_series(1,2) n;

do $admission$
declare
  owner uuid:='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  first_id uuid:='57000000-0000-0000-0000-000000000001';
  second_id uuid:='57000000-0000-0000-0000-000000000002';
  claim_id uuid:='67000000-0000-0000-0000-000000000001';
  snap jsonb; projection jsonb; response jsonb; invalid_key text;
begin
  snap:=public.read_automatic_live_budget_snapshot(owner);
  projection:=jsonb_build_object('userId',owner::text,'orderId',first_id::text,
    'planId','47000000-0000-0000-0000-000000000001','expectedVersion',0,
    'market','crypto_spot','instrument','upbit:KRW:BUDGET1','strategy','budget-test',
    'amountKrw',70000,'riskKrw',700,'baseCharges','[]'::jsonb,'releases','[]'::jsonb,
    'limits',jsonb_build_object('total',400000,'market',100000,'instrument',100000,
      'strategy',400000,'risk',8000,'positions',8,'order',100000));
  -- JSON null is not a valid owner/budget assertion. SQL's three-valued
  -- comparisons must never let a missing/null control become an admission.
  foreach invalid_key in array array['userId','orderId','planId','amountKrw','riskKrw','limits','market','instrument','strategy'] loop
    begin
      perform public.reserve_automatic_live_entry_budget(owner,first_id,claim_id,snap,
        jsonb_set(projection,array[invalid_key],'null'::jsonb),false);
      raise exception 'null budget projection was accepted: %',invalid_key;
    exception when raise_exception then
      if sqlerrm<>'AUTOMATIC_LIVE_BUDGET_PROJECTION_INVALID' then raise; end if;
    end;
  end loop;
  response:=public.reserve_automatic_live_entry_budget(owner,first_id,claim_id,snap,projection,false);
  if response->>'status'<>'RESERVED' then raise exception 'first budget claim failed: %',response; end if;
  if (select count(*) from public.trade_live_budget_reservations where user_id=owner and state='HELD')<>1
    or (select execution_claim_id from public.trade_orders where user_id=owner and id=first_id) is distinct from claim_id then
    raise exception 'hold and execution claim were not atomic';
  end if;
  if public.reserve_automatic_live_entry_budget(owner,second_id,claim_id,snap,projection,false)->>'status'<>'SNAPSHOT_STALE' then
    raise exception 'old snapshot reused after first budget claim';
  end if;
  projection:=projection||jsonb_build_object('orderId',second_id::text,
    'planId','47000000-0000-0000-0000-000000000002','instrument','upbit:KRW:BUDGET2');
  response:=public.reserve_automatic_live_entry_budget(owner,second_id,claim_id,
    public.read_automatic_live_budget_snapshot(owner),projection,false);
  if response->>'blockCode'<>'AUTOMATIC_LIVE_BUDGET_MARKET_EXCEEDED' then
    raise exception 'distinct second signal exceeded market budget: %',response;
  end if;
  if (select execution_claim_id from public.trade_orders where user_id=owner and id=second_id) is not null then
    raise exception 'blocked second signal still acquired execution claim';
  end if;
  begin
    perform public.claim_trade_order_execution(owner,second_id,0,claim_id,30);
    raise exception 'legacy claim bypassed AUTO aggregate guard';
  exception when raise_exception then
    if sqlerrm<>'AUTOMATIC_LIVE_ATOMIC_BUDGET_CLAIM_REQUIRED' then raise; end if;
  end;
  -- Restart/old lease cannot remove the durable held amount.
  update public.trade_orders set execution_claimed_at='2020-01-01',
    state='RECOVERY_REQUIRED',payload=payload||'{"state":"RECOVERY_REQUIRED","submissionStartedAt":"2020-01-01"}'::jsonb
    where user_id=owner and id=first_id;
  response:=public.reserve_automatic_live_entry_budget(owner,second_id,claim_id,
    public.read_automatic_live_budget_snapshot(owner),projection,false);
  if response->>'blockCode'<>'AUTOMATIC_LIVE_BUDGET_MARKET_EXCEEDED' then
    raise exception 'unknown/expired-lease capital was released';
  end if;
end $admission$;

select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',true);
set local role authenticated;
do $ledger_forgery$
declare changed bigint;
begin
  if (select count(*) from public.trade_order_plans where user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    and id in ('47000000-0000-0000-0000-000000000001','47000000-0000-0000-0000-000000000002'))<>2 then
    raise exception 'server-only AUTO guard unexpectedly hid owner readonly plans';
  end if;
  update public.trade_orders set payload=payload||'{"state":"FILLED","filledQuantity":100}'::jsonb
    where user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and id='57000000-0000-0000-0000-000000000001';
  get diagnostics changed=row_count;
  if changed<>0 then raise exception 'client forged AUTO LIVE fill'; end if;
  update public.trade_order_plans set payload=payload||'{"executionMode":"manual"}'::jsonb
    where user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and id='47000000-0000-0000-0000-000000000001';
  get diagnostics changed=row_count;
  if changed<>0 then raise exception 'client declassified AUTO LIVE entry provenance'; end if;
  begin
    insert into public.trade_order_plans(user_id,id,idempotency_key,state,payload)
    values('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','47000000-0000-0000-0000-000000000003',
      'forged-auto-budget-plan','APPROVAL_PENDING','{"accountMode":"live","executionMode":"automatic"}'::jsonb);
    raise exception 'client forged AUTO LIVE plan';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.trade_order_events(user_id,id,order_id,to_state,payload)
    values('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','77000000-0000-0000-0000-000000000001',
      '57000000-0000-0000-0000-000000000001','FILLED','{"filledQuantity":100}'::jsonb);
    raise exception 'client forged AUTO LIVE execution event';
  exception when insufficient_privilege then null; end;
  delete from public.trade_orders where user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    and id='57000000-0000-0000-0000-000000000001';
  get diagnostics changed=row_count;
  if changed<>0 then raise exception 'client deleted AUTO LIVE ownership proof'; end if;
end $ledger_forgery$;
do $deny$ begin
  begin
    perform public.read_automatic_live_budget_snapshot('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    raise exception 'authenticated obtained server-only history';
  exception when insufficient_privilege then null; end;
end $deny$;
reset role;
rollback;
