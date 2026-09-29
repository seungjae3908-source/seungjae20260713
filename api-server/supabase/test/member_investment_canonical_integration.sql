\set ON_ERROR_STOP on

begin;
set local role service_role;
insert into public.credential_vault_entries(id,user_id,provider,encrypted_payload,version)
values ('00000000-0000-4000-8000-000000000501','11111111-1111-1111-1111-111111111111','bitget','AES_GCM_FIXTURE_NOT_PLAINTEXT',1)
on conflict do nothing;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',true);
insert into public.broker_exchange_connections(
  id,user_id,provider,provider_type,account_scope,connection_status,permissions,read_only_capable,trade_capable,credential_reference,credential_version
) values (
  '00000000-0000-4000-8000-000000000502','11111111-1111-1111-1111-111111111111','bitget','CRYPTO_EXCHANGE','fixture','CONNECTED',array['read'],true,false,
  '00000000-0000-4000-8000-000000000501',1
);
insert into public.account_snapshots(
  user_id,connection_id,provider,account_type,currency,total_equity,cash_balance,available_balance,unrealized_pnl,realized_pnl,daily_loss,drawdown,
  data_as_of,collected_at,freshness_status,provider_status,provenance,snapshot_version
) values (
  '11111111-1111-1111-1111-111111111111','00000000-0000-4000-8000-000000000502','bitget','futures','USDT',10000,8000,7000,10,0,0,0,
  now(),now(),'FRESH','HEALTHY','fixture:no-network',1
);
insert into public.portfolio_holdings(
  user_id,ticker,name,market,currency,quantity,average_price,connection_id,provider,symbol,current_price,market_value,
  data_as_of,collected_at,freshness_status,provider_status,provenance,snapshot_version
) values (
  '11111111-1111-1111-1111-111111111111','005930','Samsung','KR','KRW',1,70000,
  '00000000-0000-4000-8000-000000000502','kiwoom','005930',71000,71000,now(),now(),'FRESH','HEALTHY','fixture:no-network',1
);
insert into public.crypto_spot_holdings(
  user_id,connection_id,provider,asset,free,locked,average_price,current_price,market_value,unrealized_pnl,data_as_of,freshness_status,provider_status,provenance
) values (
  '11111111-1111-1111-1111-111111111111','00000000-0000-4000-8000-000000000502','bitget','BTC',0.1,0,50000,51000,5100,100,now(),'FRESH','HEALTHY','fixture:no-network'
);
insert into public.futures_positions(
  user_id,connection_id,exchange,symbol,side,margin_mode,leverage,quantity,entry_price,mark_price,liquidation_price,liquidation_distance_pct,market_value,
  unrealized_pnl,maintenance_margin,data_as_of,freshness_status,provider_status,provenance
) values
  ('11111111-1111-1111-1111-111111111111','00000000-0000-4000-8000-000000000502','bitget','BTCUSDT','LONG','ISOLATED',2,0.01,50000,51000,30000,40,510,10,25,now(),'FRESH','HEALTHY','fixture:no-network'),
  ('11111111-1111-1111-1111-111111111111','00000000-0000-4000-8000-000000000502','bitget','BTCUSDT','SHORT','ISOLATED',2,0.02,52000,51000,70000,35,1020,20,50,now(),'FRESH','HEALTHY','fixture:no-network');
insert into public.automation_policies(
  id,user_id,connection_id,market,strategy_id,strategy_version,enabled,execution_mode,allowed_symbols,max_position_value,max_position_pct,
  max_daily_loss,max_drawdown,max_orders_per_day,max_concurrent_positions,cooldown_seconds,leverage_min,leverage_max,min_liquidation_buffer_pct,kill_switch
) values (
  '00000000-0000-4000-8000-000000000503','11111111-1111-1111-1111-111111111111','00000000-0000-4000-8000-000000000502',
  'CRYPTO_FUTURES','trend','v1',true,'PREVIEW',array['BTCUSDT'],1000,20,500,20,10,3,30,1,5,15,false
);
insert into public.order_intents(
  id,user_id,connection_id,source_signal_id,source_signal_generated_at,strategy_id,market,symbol,side,position_side,order_type,
  requested_quantity,requested_price,stop_loss,take_profit,leverage,status,risk_decision,risk_reasons,idempotency_key,created_at,expires_at
) values (
  '00000000-0000-4000-8000-000000000504','11111111-1111-1111-1111-111111111111','00000000-0000-4000-8000-000000000502',
  'signal-fixture',now(),'trend','CRYPTO_FUTURES','BTCUSDT','LONG','LONG','LIMIT',0.01,50000,49000,52000,2,'PREVIEW_READY','PREVIEW_ONLY','{}','fixture-key',now(),now()+interval '1 minute'
);
insert into public.execution_previews(user_id,order_intent_id,provider,estimated_notional,reference_price,requested_quantity,status,expires_at)
values ('11111111-1111-1111-1111-111111111111','00000000-0000-4000-8000-000000000504','bitget',500,50000,0.01,'PREVIEW_ONLY',now()+interval '1 minute');
insert into public.member_investment_audit_events(user_id,event_type,entity_type,entity_id,payload)
values ('11111111-1111-1111-1111-111111111111','EXECUTION_PREVIEW_CREATED','order_intent','00000000-0000-4000-8000-000000000504','{"executionAuthority":"NONE"}');

do $assert_a$
begin
  if (select count(*) from public.futures_positions where symbol='BTCUSDT') <> 2 then
    raise exception 'LONG and SHORT were not stored independently';
  end if;
  if exists (select 1 from public.broker_exchange_connections where user_id <> auth.uid()) then
    raise exception 'cross-user connection row visible';
  end if;
  if (select execution_mode from public.automation_policies where id='00000000-0000-4000-8000-000000000503') <> 'PREVIEW' then
    raise exception 'preview policy unavailable';
  end if;
end
$assert_a$;

do $live_locked$
begin
  begin
    insert into public.automation_policies(user_id,connection_id,market,strategy_id,strategy_version,execution_mode)
    values ('11111111-1111-1111-1111-111111111111','00000000-0000-4000-8000-000000000502','CRYPTO_FUTURES','forbidden-live','v1','LIVE');
    raise exception 'LIVE policy unexpectedly persisted';
  exception when check_violation then null;
  end;
end
$live_locked$;

do $forged_owner$
begin
  begin
    insert into public.broker_exchange_connections(user_id,provider,provider_type,account_scope)
    values ('22222222-2222-2222-2222-222222222222','upbit','CRYPTO_EXCHANGE','forged');
    raise exception 'forged owner insert unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end
$forged_owner$;

select set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222',true);
do $assert_b$
begin
  if exists (select 1 from public.account_snapshots where user_id='11111111-1111-1111-1111-111111111111') then raise exception 'B read A account'; end if;
  if exists (select 1 from public.automation_policies where user_id='11111111-1111-1111-1111-111111111111') then raise exception 'B read A policy'; end if;
  if exists (select 1 from public.member_investment_audit_events where user_id='11111111-1111-1111-1111-111111111111') then raise exception 'B read A audit'; end if;
end
$assert_b$;

select set_config('request.jwt.claim.sub','44444444-4444-4444-4444-444444444444',true);
do $pending$
begin
  if exists (select 1 from public.broker_exchange_connections) then raise exception 'pending member read financial data'; end if;
  begin
    insert into public.broker_exchange_connections(user_id,provider,provider_type,account_scope)
    values ('44444444-4444-4444-4444-444444444444','upbit','CRYPTO_EXCHANGE','pending');
    raise exception 'pending member insert unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end
$pending$;

do $credential_locked$
begin
  begin
    perform encrypted_payload from public.credential_vault_entries;
    raise exception 'authenticated role read server-only credentials';
  exception when insufficient_privilege then null;
  end;
end
$credential_locked$;

rollback;
