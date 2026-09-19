import test from 'node:test';
import assert from 'node:assert/strict';
import type { MemberAutoTradingPaperHandoffEntry } from '../../../market-prediction-lab/src/member-auto-trading-paper-handoff-v1.js';
import type { TradingOrder, TradingPlan } from './trade-automation.types';
import { InMemoryTradingRepository } from './trade-automation.repository';
import {
  buildMemberAutoTradingPaperPositionBridge,
  persistMemberAutoTradingPaperPositionBridge,
  MEMBER_AUTO_TRADING_PAPER_POSITION_BRIDGE_VERSION,
} from './member-auto-trading-paper-position-bridge.service';

const USER='11111111-1111-1111-1111-111111111111';
const NOW='2026-09-19T05:20:00.000Z';

function entry(): MemberAutoTradingPaperHandoffEntry {
  return {
    handoffId:'paper-auto-handoff:sha256:'+'a'.repeat(64),
    cycleId:'cycle-1',
    evaluatedAtMs:Date.parse(NOW)-1000,
    identity:{
      signalId:'signal-1',candidateId:'paper-candidate-v1:'+'b'.repeat(64),
      market:'CRYPTO_SPOT',symbol:'BTC',timeframe:'15m',horizon:4,direction:'BUY',
      regime:'TREND',strategyId:'trend-breakout-v1',strategyVersion:'1.0.0',
      parameterHash:'params-v1',researchCodeSha:'c'.repeat(40),costPolicyVersion:'cost-v1',
      executionAuthority:'NONE',
    },
    signal:{
      signalId:'signal-1',market:'CRYPTO_SPOT',symbol:'BTC',
      timestampMs:Date.parse(NOW)-30_000,expiresAtMs:Date.parse(NOW)+3_600_000,ttlMs:3_630_000,
      style:'SWING',timeframe:'15m',horizon:4,direction:'BUY',regime:'TREND',
      strategyIdentity:{candidateId:'paper-candidate-v1:'+'b'.repeat(64),strategyId:'trend-breakout-v1',strategyVersion:'1.0.0',parameterHash:'params-v1',researchCodeSha:'c'.repeat(40)},
      learningSnapshot:{stopLoss:95,target1:110,target2:120,entryPrice:100,immutable:true,executionAuthority:'NONE'},
    },
    profitEvidence:{status:'READY',costPolicyId:'cost-v1'},
    riskEvidence:{
      status:'APPROVED',source:'TRADING_RISK_ENGINE',evaluatedAtMs:Date.parse(NOW)-1000,
      simulatedOnly:true,allowed:true,blockCodes:[],recommendedQuantity:1,
      actualRiskPercent:0.5,riskReward1:2,riskReward2:3,policyIdentity:null,executionAuthority:'NONE',
    },
    execution:{
      marketAdapterIdentity:{id:'upbit-paper-v1'},
      costPolicy:{version:'cost-v1'},
      executionPolicy:{sameBarPolicy:'STOP_FIRST'},
      dataEvidence:{publicOnly:true,dataQuality:'READY',provenance:'fixture',asOfMs:Date.parse(NOW)-1000,maxAgeMs:60_000},
    },
    simulatedOrder:{type:'MARKET',quantity:1,direction:'BUY'},
    publicQuote:{bid:99,ask:100,last:100,asOfMs:Date.parse(NOW)-1000,maxAgeMs:60_000},
    safety:{executionAuthority:'NONE',simulatedOnly:true,liveOrderAllowed:false,privateTradingApiAllowed:false,orderSubmitted:false,exchangeRequestSent:false},
  };
}

function plan(): TradingPlan {
  return {
    id:'plan-1',userId:USER,idempotencyKey:'plan-key-1',state:'SUBMITTED',version:1,
    approvalExpiresAt:null,approvedAt:NOW,createdAt:NOW,updatedAt:NOW,
    exchange:'upbit',accountMode:'paper',strategyId:'trend-breakout-v1',signalId:'signal-1',
    symbol:'BTC',market:'KRW',side:'buy',orderType:'market',quantity:1,quoteAmount:100,
    limitPrice:100,estimatedKrw:100_000,stopPrice:95,targetPrices:[110,120],splitRatios:[100],
    leverage:null,marginMode:null,reduceOnly:false,invalidateAction:'hold',signalReasons:['fixture'],
    marketSnapshot:{
      observedAt:NOW,riskObservedAt:NOW,dataDelayMs:0,oneMinuteMovePercent:0,spreadPercent:0.1,
      orderbookGapPercent:0.1,halted:false,availableBalance:1_000_000,accountValueKrw:1_000_000,
      dailyPnlPercent:0,assetExposurePercent:0,openPositionCount:0,dailyOrderCount:0,consecutiveLosses:0,
      currentPrice:100,plannedPrice:100,marketStatus:'OPEN',availableLiquidityKrw:1_000_000,
      estimatedSlippagePercent:0.05,estimatedFeePercent:0.05,signalState:'entry_ready',signalObservedAt:NOW,
    },
    entryPrice:null,entryZoneLow:null,entryZoneHigh:null,estimatedSlippagePercent:null,averageSpreadPercent:null,economics:null,
  };
}

function order(): TradingOrder {
  return {
    id:'order-1',userId:USER,planId:'plan-1',exchange:'upbit',clientOrderId:'client-1',
    exchangeOrderId:'paper-client-1',state:'FILLED',version:3,requestedQuantity:1,remainingQuantity:0,
    filledQuantity:1,averageFillPrice:100,retryCount:0,lastErrorCode:null,createdAt:NOW,updatedAt:NOW,
  };
}

test('maps one existing FILLED Paper order into the canonical Natural lifecycle without resimulating a fill', () => {
  const result=buildMemberAutoTradingPaperPositionBridge({userId:USER,plan:plan(),order:order(),entry:entry()});
  assert.equal(result.schemaVersion,MEMBER_AUTO_TRADING_PAPER_POSITION_BRIDGE_VERSION);
  assert.equal(result.status,'READY');
  assert.match(result.bridgeId ?? '',/^member-auto-position-bridge:sha256:[0-9a-f]{64}$/u);
  assert.equal(result.safety.economicSampleCredit,0);
  assert.equal(result.position?.entryFillPrice,100);
  assert.equal((result.position?.sample as any).fill.filledQuantity,1);
  assert.equal((result.position?.lifecycle as any).status,'OPEN');
  assert.equal((result.position?.lifecycle as any).sampleEligibility.provenanceClass,'MISSING_EVIDENCE');
  assert.equal((result.position?.lifecycle as any).sampleEligibility.naturalSampleCredit,0);
});

test('blocks non-filled, live, or identity-mismatched input before creating a lifecycle', () => {
  const pending=order(); pending.state='ACCEPTED';
  assert.equal(buildMemberAutoTradingPaperPositionBridge({userId:USER,plan:plan(),order:pending,entry:entry()}).status,'BLOCKED_DATA');
  const live=plan(); live.accountMode='live';
  assert.equal(buildMemberAutoTradingPaperPositionBridge({userId:USER,plan:live,order:order(),entry:entry()}).status,'BLOCKED_DATA');
  const wrong=entry(); (wrong.identity as any).signalId='other';
  assert.equal(buildMemberAutoTradingPaperPositionBridge({userId:USER,plan:plan(),order:order(),entry:wrong}).status,'BLOCKED_DATA');
});

test('requires STOP_FIRST exit semantics and genuine fill price/quantity evidence', () => {
  const badPolicy=entry(); (badPolicy.execution.executionPolicy as any).sameBarPolicy='TARGET_FIRST';
  assert.equal(buildMemberAutoTradingPaperPositionBridge({userId:USER,plan:plan(),order:order(),entry:badPolicy}).status,'BLOCKED_DATA');
  const missingFill=order(); missingFill.averageFillPrice=null;
  const blocked=buildMemberAutoTradingPaperPositionBridge({userId:USER,plan:plan(),order:missingFill,entry:entry()});
  assert.equal(blocked.status,'BLOCKED_DATA');
  assert.ok(blocked.blockers.includes('PAPER_POSITION_BRIDGE_FILL_EVIDENCE_REQUIRED'));
});

test('bridge identity is deterministic and user scoped', () => {
  const a=buildMemberAutoTradingPaperPositionBridge({userId:USER,plan:plan(),order:order(),entry:entry()});
  const b=buildMemberAutoTradingPaperPositionBridge({userId:USER,plan:plan(),order:order(),entry:entry()});
  assert.equal(a.bridgeId,b.bridgeId);
  const mismatch=buildMemberAutoTradingPaperPositionBridge({userId:'22222222-2222-2222-2222-222222222222',plan:plan(),order:order(),entry:entry()});
  assert.equal(mismatch.status,'BLOCKED_DATA');
  assert.ok(mismatch.blockers.includes('PAPER_POSITION_BRIDGE_USER_IDENTITY_MISMATCH'));
});


test('persists one append-only lifecycle event and becomes idempotent on repeat', async () => {
  const repository = new InMemoryTradingRepository();
  const first = await persistMemberAutoTradingPaperPositionBridge({
    repository,
    userId: USER,
    plan: plan(),
    order: order(),
    entry: entry(),
    now: new Date(NOW),
  });
  assert.equal(first.status, 'PERSISTED');
  assert.equal(first.event?.fromState, 'FILLED');
  assert.equal(first.event?.toState, 'FILLED');
  assert.equal(first.event?.reason, 'PAPER_POSITION_LIFECYCLE_OPENED');
  assert.equal(first.event?.metadata?.bridgeId, first.bridge.bridgeId);
  assert.equal((first.event?.metadata?.safety as any).executionAuthority, 'NONE');
  assert.equal((first.event?.metadata?.safety as any).liveTrading, false);
  assert.equal((first.event?.metadata?.safety as any).privateTradingApiAllowed, false);
  assert.equal((first.event?.metadata?.safety as any).economicSampleCredit, 0);

  const second = await persistMemberAutoTradingPaperPositionBridge({
    repository,
    userId: USER,
    plan: plan(),
    order: order(),
    entry: entry(),
    now: new Date(NOW),
  });
  assert.equal(second.status, 'IDEMPOTENT');
  const events = (await repository.listEvents(USER))
    .filter((event) => event.reason === 'PAPER_POSITION_LIFECYCLE_OPENED');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.id, first.event?.id);
});

test('conflicting lifecycle event for the same FILLED order fails closed without overwrite', async () => {
  const repository = new InMemoryTradingRepository();
  await repository.appendEvent({
    id: '11111111-1111-5111-8111-111111111111',
    userId: USER,
    orderId: 'order-1',
    fromState: 'FILLED',
    toState: 'FILLED',
    reason: 'PAPER_POSITION_LIFECYCLE_OPENED',
    metadata: { bridgeId: 'member-auto-position-bridge:sha256:' + 'f'.repeat(64) },
    createdAt: NOW,
  });
  const result = await persistMemberAutoTradingPaperPositionBridge({
    repository,
    userId: USER,
    plan: plan(),
    order: order(),
    entry: entry(),
    now: new Date(NOW),
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.deepEqual(result.blockers, ['PAPER_POSITION_BRIDGE_EVENT_CONFLICT']);
  assert.equal((await repository.listEvents(USER)).length, 1);
});

test('blocked bridge never appends a lifecycle event', async () => {
  const repository = new InMemoryTradingRepository();
  const pending = order();
  pending.state = 'ACCEPTED';
  const result = await persistMemberAutoTradingPaperPositionBridge({
    repository,
    userId: USER,
    plan: plan(),
    order: pending,
    entry: entry(),
    now: new Date(NOW),
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal((await repository.listEvents(USER)).length, 0);
});
