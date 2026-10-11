import test from 'node:test';
import assert from 'node:assert/strict';
import {
  issueProtectedPaperFundingCertificate,
  isProtectedPaperFundingCertificate,
  readHistoricalUpbitUsdtKrwMinute,
  type CompletePublicFundingHistory,
} from './paper-futures-funding-certificate.service';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { TradeAutomationService } from './trade-automation.service';
import type { TradingPlan, TradingOrder } from './trade-automation.types';

const OWNER = '11111111-1111-1111-1111-111111111111';
const symbol = 'BTCUSDT';
function setup(direction: 'LONG' | 'SHORT' = 'LONG') {
  const now = Date.now();
  const eventTime = Math.floor((now - 180_000) / 60_000) * 60_000;
  const entryAt = new Date(eventTime - 3_600_000).toISOString();
  const entryPlan = {
    id: 'fund-entry-plan', userId: OWNER, accountMode: 'paper', executionMode: 'automatic',
    exchange: 'bitget', market: 'USDT-FUTURES', symbol, strategyId: 'paper-funding',
    side: direction === 'LONG' ? 'long' : 'short', reduceOnly: false,
  } as unknown as TradingPlan;
  const exitPlan = {
    ...entryPlan, id: 'fund-exit-plan', reduceOnly: true,
    side: direction === 'LONG' ? 'short' : 'long',
    signalReasons: [
      'AUTO_EXIT', 'AUTO_EXIT_ENTRY_PLAN:' + entryPlan.id,
      'AUTO_EXIT_ENTRY_ORDER:fund-entry-order',
    ],
  } as TradingPlan;
  const entryOrder = {
    id: 'fund-entry-order', userId: OWNER, planId: entryPlan.id,
    exchange: 'bitget', clientOrderId:'entry', exchangeOrderId:'paper-entry',
    state:'FILLED', filledQuantity: 2, averageFillPrice:100,
    updatedAt:entryAt, createdAt:entryAt,
  } as TradingOrder;
  const exitOrder = {
    ...entryOrder, id:'fund-exit-order', planId:exitPlan.id,
    clientOrderId:'exit', exchangeOrderId:'paper-exit',
    updatedAt:new Date(now).toISOString(),
  } as TradingOrder;
  return { eventTime, now, entryPlan, exitPlan, entryOrder, exitOrder };
}
function funding(scope: { symbol: string; direction: string; quantity: number;
  startTime: number; endTime: number }, eventTime: number,
  rate = 0.001): CompletePublicFundingHistory {
  const positionValue = scope.quantity * 100;
  const charge = positionValue * Math.abs(rate);
  const payer = scope.direction === 'LONG' ? rate > 0 : rate < 0;
  return {
    schemaVersion:'bitget-funding-cost-only-owner-v1',status:'PRESENT',
    complete:true, fullCoverage:true, publicOnly:true,executionAuthority:'NONE',
    symbol:scope.symbol,direction:scope.direction,quantity:scope.quantity,
    startTime:scope.startTime,endTime:scope.endTime,
    collectedAtMs:Date.now(),fundingEventCount:1,
    payments:[{asOfMs:eventTime,markPrice:100,positionValue,
      fundingRate:rate,payer,amount:payer?charge:0,
      receiptCreditExcluded:payer?0:charge,
      source:'BITGET_PUBLIC_FUNDING_RATE_X_EXACT_1M_MARK_OPEN'}],
    totalFundingCost:payer?charge:0,excludedFundingCredit:payer?0:charge,
  };
}
const fx = async (atMs: number) => ({
  atMs,source:'UPBIT:KRW-USDT_HISTORICAL_1M' as const,krwPerUsdt:1400,
});
const req = (v: ReturnType<typeof setup>, overrides: Record<string, unknown> = {}) => ({
  entryOrder:v.entryOrder,entryPlan:v.entryPlan,
  exitOrder:v.exitOrder,exitPlan:v.exitPlan,
  exitAtMs:v.now-1000,
  collectHistory:async (scope: Parameters<typeof funding>[0]) => funding(scope,v.eventTime),
  historicalFx:fx,
  ...overrides,
});

test('funding issue: verified LONG payment debits KRW, SHORT receipt credits KRW', async () => {
  const long=setup('LONG');
  const paid=await issueProtectedPaperFundingCertificate(req(long));
  assert.ok(paid);
  assert.equal(paid.netFundingKrw,280);
  assert.equal(paid.eventCount,1);
  assert.match(paid.eventDigest,/^[a-f0-9]{64}$/u);
  assert.equal(paid.entryBrokerOrderId,'paper-entry');
  assert.equal(paid.exitBrokerOrderId,'paper-exit');
  assert.equal(paid.complete,true);
  assert.equal(isProtectedPaperFundingCertificate(paid),true);
  assert.equal(isProtectedPaperFundingCertificate(structuredClone(paid)),false,
    'serialized JSON must not forge the server-only issuer');
  const short=setup('SHORT');
  const received=await issueProtectedPaperFundingCertificate(req(short));
  assert.ok(received);
  assert.equal(received.netFundingKrw,-280);
});

test('funding issue: missing, incomplete, altered event FX or unbound positions fail closed', async () => {
  const v=setup();
  assert.equal(await issueProtectedPaperFundingCertificate(req(v,{
    collectHistory:async()=>{throw new Error('BITGET_OUTAGE');},
  })),null);
  assert.equal(await issueProtectedPaperFundingCertificate(req(v,{
    collectHistory:async(scope: Parameters<typeof funding>[0])=>({
      ...funding(scope,v.eventTime),complete:false,
    }),
  })),null);
  assert.equal(await issueProtectedPaperFundingCertificate(req(v,{
    historicalFx:async(atMs:number)=>({...await fx(atMs),atMs:atMs-60_000}),
  })),null);
  assert.equal(await issueProtectedPaperFundingCertificate(req(v,{
    collectHistory:async(scope: Parameters<typeof funding>[0])=>({
      ...funding(scope,v.eventTime),totalFundingCost:0,
    }),
  })),null);
  assert.equal(await issueProtectedPaperFundingCertificate(req(v,{
    exitPlan:{...v.exitPlan,accountMode:'live'},
  })),null);
  assert.equal(await issueProtectedPaperFundingCertificate(req(v,{
    entryOrder:{...v.entryOrder,filledQuantity:1},
  })),null);
  assert.equal(await issueProtectedPaperFundingCertificate(req(v,{
    exitAtMs:v.now+60_000,
  })),null);
});

test('funding issue: complete zero-event public history is required for exactly zero cost', async () => {
  const v=setup();
  const complete=await issueProtectedPaperFundingCertificate(req(v,{
    collectHistory:async(scope: Parameters<typeof funding>[0])=>({
      ...funding(scope,v.eventTime),
      payments:[], fundingEventCount:0,totalFundingCost:0,excludedFundingCredit:0,
    }),
  }));
  assert.ok(complete);
  assert.equal(complete.netFundingKrw,0);
  assert.equal(complete.eventCount,0);
  const bad=await issueProtectedPaperFundingCertificate(req(v,{
    collectHistory:async(scope: Parameters<typeof funding>[0])=>({
      ...funding(scope,v.eventTime),
      payments:[], fundingEventCount:0,totalFundingCost:0,excludedFundingCredit:0,
      fullCoverage:false,
    }),
  }));
  assert.equal(bad,null);
});

test('funding issue: Upbit public historical FX requires exact closed one-minute candle', async () => {
  const minute=Math.floor((Date.now()-180_000)/60_000)*60_000;
  const good=async ()=>new Response(JSON.stringify([{
    market:'KRW-USDT',unit:1,
    candle_date_time_utc:new Date(minute).toISOString().slice(0,19),
    opening_price:1450,
  }]),{status:200});
  const value=await readHistoricalUpbitUsdtKrwMinute(minute,good as typeof fetch);
  assert.equal(value.krwPerUsdt,1450);
  const invalid=async ()=>new Response(JSON.stringify([{
    market:'KRW-USDT',unit:1,
    candle_date_time_utc:new Date(minute-60_000).toISOString().slice(0,19),
    opening_price:1450,
  }]),{status:200});
  await assert.rejects(readHistoricalUpbitUsdtKrwMinute(minute,invalid as typeof fetch),
    /PAPER_FUNDING_HISTORICAL_FX_EXACT_MINUTE_REQUIRED/);
});

test('simulated reducing FILLED transition persists only server-issued bound funding proof', async () => {
  const v=setup();
  const cert=await issueProtectedPaperFundingCertificate(req(v));
  assert.ok(cert);
  const repository=new InMemoryTradingRepository();
  const pending={...v.exitOrder,state:'ACCEPTED' as const,exchangeOrderId:null};
  await repository.savePlan(v.entryPlan);
  await repository.savePlan(v.exitPlan);
  await repository.saveOrder(v.entryOrder);
  await repository.saveOrder(pending);
  const service=new TradeAutomationService(repository);
  await service.transition(pending,'FILLED','PAPER_BROKER_FILLED',{
    exchangeOrderId:'paper-exit',filledQuantity:2,averageFillPrice:102,
    feeAmount:0.1,feeCurrency:'USDT',
    paperFundingSettlementEvidence:cert,
  });
  const persisted=await repository.getOrder(OWNER,pending.id);
  assert.equal(persisted?.paperFundingSettlementEvidence?.eventDigest,cert.eventDigest);
  const forgedRepo=new InMemoryTradingRepository();
  await forgedRepo.savePlan(v.entryPlan);
  await forgedRepo.savePlan(v.exitPlan);
  await forgedRepo.saveOrder(v.entryOrder);
  await forgedRepo.saveOrder({...pending,id:'forged-exit',state:'ACCEPTED',exchangeOrderId:null});
  const forged={...pending,id:'forged-exit',state:'ACCEPTED' as const,exchangeOrderId:null};
  await new TradeAutomationService(forgedRepo).transition(forged,'FILLED','PAPER_BROKER_FILLED',{
    exchangeOrderId:'paper-exit',filledQuantity:2,averageFillPrice:102,
    paperFundingSettlementEvidence:structuredClone(cert),
  });
  assert.equal((await forgedRepo.getOrder(OWNER,forged.id))?.paperFundingSettlementEvidence??null,null);
});
