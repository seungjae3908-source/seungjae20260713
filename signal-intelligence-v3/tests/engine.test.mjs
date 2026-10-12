import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSignalIntelligenceV3Snapshot,
  recommendConservativeLeverage,
  runSignalIntelligenceV3,
} from '../src/engine.mjs';

function baseCandidate(overrides = {}) {
  return {
    market: 'KR_STOCK',
    symbol: '005930',
    strategy: 'SWING',
    timeframe: '1D',
    direction: 'BUY',
    dataStatus: 'READY',
    quantEligible: true,
    profitEligible: true,
    riskReady: true,
    evidence: {
      expectedNetEdgeR: 1.2,
      tailLossPenaltyR: 0.2,
      uncertaintyPenaltyR: 0.1,
      executionPenaltyR: 0.1,
    },
    ...overrides,
  };
}

function futuresCandidate(direction, overrides = {}) {
  return baseCandidate({
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    strategy: 'SWING',
    timeframe: '1h',
    direction,
    leverageEvidence: {
      stopDistancePct: 2,
      maeQ95Pct: 2.2,
      downsideIntervalPct: 2.4,
      spreadPct: 0.05,
      slippagePct: 0.10,
      uncertainty: 'LOW',
      volatility: 'NORMAL',
      liquidity: 'HIGH',
      tiers: [
        { leverage: 1, liquidationDistancePct: 60, maintenanceMarginRatePct: 0.5, verified: true },
        { leverage: 2, liquidationDistancePct: 30, maintenanceMarginRatePct: 0.5, verified: true },
        { leverage: 3, liquidationDistancePct: 20, maintenanceMarginRatePct: 0.6, verified: true },
        { leverage: 5, liquidationDistancePct: 8, maintenanceMarginRatePct: 0.8, verified: true },
      ],
    },
    ...overrides,
  });
}

test('cash markets expose BUY candidates only', () => {
  const snapshot = runSignalIntelligenceV3([
    baseCandidate({ market: 'KR_STOCK', symbol: '005930', direction: 'BUY' }),
    baseCandidate({ market: 'KR_STOCK', symbol: '000660', direction: 'SELL' }),
    baseCandidate({ market: 'US_STOCK', symbol: 'AAPL', direction: 'BUY' }),
    baseCandidate({ market: 'US_STOCK', symbol: 'TSLA', direction: 'SHORT' }),
    baseCandidate({ market: 'CRYPTO_SPOT', symbol: 'KRW-BTC', direction: 'BUY' }),
    baseCandidate({ market: 'CRYPTO_SPOT', symbol: 'KRW-ETH', direction: 'SELL' }),
  ]);

  assert.deepEqual(snapshot.lists.krBuy.map((row) => row.symbol), ['005930']);
  assert.deepEqual(snapshot.lists.usBuy.map((row) => row.symbol), ['AAPL']);
  assert.deepEqual(snapshot.lists.spotBuy.map((row) => row.symbol), ['KRW-BTC']);
  assert.equal(snapshot.rows.find((row) => row.symbol === '000660').state, 'NO_TRADE');
  assert.equal(snapshot.rows.find((row) => row.symbol === 'TSLA').state, 'NO_TRADE');
  assert.equal(snapshot.rows.find((row) => row.symbol === 'KRW-ETH').state, 'NO_TRADE');
  assert.equal(assertSignalIntelligenceV3Snapshot(snapshot), true);
});

test('futures keeps independent LONG and SHORT lists when symbols differ', () => {
  const snapshot = runSignalIntelligenceV3([
    futuresCandidate('LONG', { symbol: 'BTCUSDT' }),
    futuresCandidate('SHORT', { symbol: 'ETHUSDT' }),
  ]);
  assert.deepEqual(snapshot.lists.futuresLong.map((row) => row.symbol), ['BTCUSDT']);
  assert.deepEqual(snapshot.lists.futuresShort.map((row) => row.symbol), ['ETHUSDT']);
});

test('direction auction keeps the stronger side for the same futures identity', () => {
  const snapshot = runSignalIntelligenceV3([
    futuresCandidate('LONG', {
      evidence: { expectedNetEdgeR: 1.8, tailLossPenaltyR: 0.2, uncertaintyPenaltyR: 0.1, executionPenaltyR: 0.1 },
    }),
    futuresCandidate('SHORT', {
      evidence: { expectedNetEdgeR: 0.9, tailLossPenaltyR: 0.2, uncertaintyPenaltyR: 0.1, executionPenaltyR: 0.1 },
    }),
  ]);
  assert.equal(snapshot.lists.futuresLong.length, 1);
  assert.equal(snapshot.lists.futuresShort.length, 0);
  const short = snapshot.rows.find((row) => row.direction === 'SHORT');
  assert.equal(short.state, 'NO_TRADE');
  assert.deepEqual(short.reasons, ['DIRECTION_LOST_AUCTION']);
});

test('near-tie LONG and SHORT both abstain instead of forcing a side', () => {
  const snapshot = runSignalIntelligenceV3([
    futuresCandidate('LONG', {
      evidence: { expectedNetEdgeR: 1.0, tailLossPenaltyR: 0.2, uncertaintyPenaltyR: 0.1, executionPenaltyR: 0.1 },
    }),
    futuresCandidate('SHORT', {
      evidence: { expectedNetEdgeR: 0.9, tailLossPenaltyR: 0.2, uncertaintyPenaltyR: 0.1, executionPenaltyR: 0.1 },
    }),
  ], { futuresDirectionSeparationMinR: 0.20 });
  assert.equal(snapshot.lists.futuresLong.length, 0);
  assert.equal(snapshot.lists.futuresShort.length, 0);
  assert.equal(snapshot.rows.filter((row) => row.state === 'ABSTAIN').length, 2);
});

test('AI catalyst can request rescan but cannot promote a rejected quant candidate', () => {
  const snapshot = runSignalIntelligenceV3([
    baseCandidate({
      quantEligible: false,
      ai: { catalyst: { signal: 'POSITIVE', impact: 'HIGH' } },
    }),
  ]);
  assert.equal(snapshot.lists.krBuy.length, 0);
  assert.equal(snapshot.rows[0].state, 'NO_TRADE');
  assert.equal(snapshot.rows[0].ai.rescanRequested, true);
  assert.equal(snapshot.events.some((event) => event.type === 'RESCAN_REQUESTED'), true);
});

test('AI contradiction or risk critic can only reduce authority to ABSTAIN', () => {
  const snapshot = runSignalIntelligenceV3([
    baseCandidate({
      ai: {
        contradiction: { conflict: true, reasons: ['news_vs_price'] },
        riskCritic: { veto: true, reasons: ['tail_risk'] },
      },
    }),
  ]);
  assert.equal(snapshot.rows[0].state, 'ABSTAIN');
  assert.equal(snapshot.lists.krBuy.length, 0);
  assert.equal(snapshot.rows[0].ai.promotionAuthority, false);
  assert.equal(snapshot.rows[0].ai.leverageAuthority, false);
});

test('verified low-risk tiers may conservatively support leverage above 2x', () => {
  const result = recommendConservativeLeverage({
    stopDistancePct: 1.5,
    maeQ95Pct: 1.7,
    downsideIntervalPct: 1.8,
    spreadPct: 0.05,
    slippagePct: 0.05,
    uncertainty: 'LOW',
    volatility: 'LOW',
    liquidity: 'HIGH',
    tiers: [
      { leverage: 1, liquidationDistancePct: 60, maintenanceMarginRatePct: 0.4, verified: true },
      { leverage: 2, liquidationDistancePct: 35, maintenanceMarginRatePct: 0.5, verified: true },
      { leverage: 3, liquidationDistancePct: 22, maintenanceMarginRatePct: 0.6, verified: true },
      { leverage: 5, liquidationDistancePct: 10, maintenanceMarginRatePct: 0.8, verified: true },
    ],
  });
  assert.equal(result.status, 'INDICATIVE_ONLY');
  assert.ok(result.hardMaximum >= 3);
  assert.ok(result.recommendedRange.max >= 2);
  assert.equal(result.executionAuthority, 'NONE');
});

test('tail risk and uncertainty shrink leverage instead of applying a fixed leverage ban', () => {
  const result = recommendConservativeLeverage({
    stopDistancePct: 3,
    maeQ95Pct: 5,
    downsideIntervalPct: 6,
    spreadPct: 0.2,
    slippagePct: 0.3,
    uncertainty: 'HIGH',
    volatility: 'HIGH',
    liquidity: 'LOW',
    tiers: [
      { leverage: 1, liquidationDistancePct: 60, maintenanceMarginRatePct: 0.4, verified: true },
      { leverage: 2, liquidationDistancePct: 32, maintenanceMarginRatePct: 0.5, verified: true },
      { leverage: 3, liquidationDistancePct: 20, maintenanceMarginRatePct: 0.6, verified: true },
      { leverage: 5, liquidationDistancePct: 9, maintenanceMarginRatePct: 0.8, verified: true },
    ],
  });
  assert.equal(result.status, 'INDICATIVE_ONLY');
  assert.ok(result.hardMaximum <= 2);
});

test('leverage fails closed without verified exchange tier evidence', () => {
  const result = recommendConservativeLeverage({
    stopDistancePct: 2,
    maeQ95Pct: 2,
    downsideIntervalPct: 2,
    spreadPct: 0.1,
    slippagePct: 0.1,
    uncertainty: 'LOW',
    volatility: 'LOW',
    liquidity: 'HIGH',
    tiers: [{ leverage: 10, liquidationDistancePct: 8, verified: false }],
  });
  assert.equal(result.status, 'NOT_AVAILABLE');
  assert.equal(result.reason, 'NO_VERIFIED_EXCHANGE_TIER_EVIDENCE');
});

test('signal state changes produce Telegram-ready canonical events', () => {
  const first = runSignalIntelligenceV3([baseCandidate()]);
  assert.equal(first.events.some((event) => event.type === 'NEW_CANDIDATE'), true);

  const second = runSignalIntelligenceV3([
    baseCandidate({ ai: { contradiction: { conflict: true, reasons: ['catalyst_not_confirmed'] } } }),
  ], { previousSnapshot: first });
  assert.equal(second.events.some((event) => event.type === 'STATE_CHANGED' && event.state === 'ABSTAIN'), true);
});

test('requested max is a ceiling and never force-fills missing candidates', () => {
  const snapshot = runSignalIntelligenceV3([baseCandidate()], { maxCandidatesPerList: 10 });
  assert.equal(snapshot.lists.krBuy.length, 1);
});

test('historical futures LONG cannot veto a distinct current-source SHORT epoch',()=>{
 const older='11111111-1111-4111-8111-111111111111';
 const current='22222222-2222-4222-8222-222222222222';
 const oldLong=futuresCandidate('LONG',{
   provenance:{sourceCycleId:older},
   evidence:{expectedNetEdgeR:2.5},
 });
 const newShort=futuresCandidate('SHORT',{
   provenance:{sourceCycleId:current},
   evidence:{expectedNetEdgeR:0.9},
 });
 const snapshot=runSignalIntelligenceV3([oldLong,newShort]);
 assert.equal(snapshot.rows.find(row=>row.direction==='LONG').state,'CANDIDATE');
 assert.equal(snapshot.rows.find(row=>row.direction==='SHORT').state,'CANDIDATE');
 assert.equal(snapshot.lists.futuresShort.length,1,
   'an old LONG is not same-time evidence against a new SHORT');
 // The auction remains mandatory for contradictory same-epoch candidates.
 const together=runSignalIntelligenceV3([
   {...oldLong,provenance:{sourceCycleId:current}},
   newShort,
 ]);
 assert.equal(together.lists.futuresShort.length,0);
 assert.ok(together.rows.find(row=>row.direction==='SHORT')
   .reasons.includes('DIRECTION_LOST_AUCTION'));
 // Unverified epoch metadata must never bypass the conservative auction.
 const invalid=runSignalIntelligenceV3([
   {...oldLong,provenance:{sourceCycleId:'INVALID_EPOCH'}},
   {...newShort,provenance:{sourceCycleId:'INVALID_EPOCH'}},
 ]);
 assert.equal(invalid.lists.futuresShort.length,0);
});
test('previous cycle near-tie cannot make an independently sourced SHORT abstain',()=>{
 const oldLong=futuresCandidate('LONG',{
   provenance:{sourceCycleId:'11111111-1111-4111-8111-111111111111'},
   evidence:{expectedNetEdgeR:1.00},
 });
 const newShort=futuresCandidate('SHORT',{
   provenance:{sourceCycleId:'22222222-2222-4222-8222-222222222222'},
   evidence:{expectedNetEdgeR:0.91},
 });
 const snapshot=runSignalIntelligenceV3([oldLong,newShort]);
 assert.equal(snapshot.rows.find(row=>row.direction==='SHORT').state,'CANDIDATE');
 const sameTime=runSignalIntelligenceV3([
   {...oldLong,provenance:{sourceCycleId:'22222222-2222-4222-8222-222222222222'}},
   newShort,
 ]);
 assert.equal(sameTime.rows.filter(row=>row.state==='ABSTAIN').length,2);
});

test('a prior research-only CANDIDATE cannot suppress the first newly publishable source event',()=>{
 const previousEngine=runSignalIntelligenceV3([baseCandidate()]);
 assert.equal(previousEngine.stateById[previousEngine.rows[0].id],'CANDIDATE');
 const unpublished={...previousEngine,lists:{
   ...previousEngine.lists,krBuy:[],
 },events:[]}; // matches public source gating of a blocked page
 const next=runSignalIntelligenceV3([baseCandidate()],{
   previousSnapshot:unpublished,
 });
 assert.equal(next.events.filter(e=>e.type==='NEW_CANDIDATE').length,1,
   'a raw prior CANDIDATE was never actually published');
 const alreadyPublished=runSignalIntelligenceV3([baseCandidate()],{
   previousSnapshot:previousEngine,
 });
 assert.equal(alreadyPublished.events.some(e=>e.type==='NEW_CANDIDATE'),false,
   'a still-published candidate must not produce a duplicate episode');
});

test('previous publication history is market and direction scoped, not arbitrary state aliases',()=>{
 const initial=runSignalIntelligenceV3([
   baseCandidate({market:'US_STOCK',symbol:'AAPL',direction:'BUY'}),
 ]);
 const unknown={...initial,lists:{...initial.lists,usBuy:[],
   krBuy:initial.lists.usBuy}};
 const next=runSignalIntelligenceV3([
   baseCandidate({market:'US_STOCK',symbol:'AAPL',direction:'BUY'}),
 ],{previousSnapshot:unknown});
 assert.equal(next.events.filter(e=>e.type==='NEW_CANDIDATE').length,1,
   'a forged cross-market list must not suppress a real current candidate');
});

test('a genuinely new dated source opportunity survives prior published identity; same-day replay does not',()=>{
 const opportunity={
   sourceAsOf:'2026-10-12T12:00:00.000Z',
   provenance:{
     scannerSignalId:'scanner-stable-1',
     paperIdentity:{strategyVersion:'v1',parameterHash:'p1',
       researchCodeSha:'a'.repeat(40),costPolicyVersion:'cost1'},
   },
 };
 const first=runSignalIntelligenceV3([baseCandidate(opportunity)]);
 const sameDay=runSignalIntelligenceV3([baseCandidate({
   ...opportunity,sourceAsOf:'2026-10-12T13:30:00.000Z',
 })],{previousSnapshot:first});
 assert.equal(sameDay.events.filter(e=>e.type==='NEW_CANDIDATE').length,0);
 const nextDay=runSignalIntelligenceV3([baseCandidate({
   ...opportunity,sourceAsOf:'2026-10-13T12:00:00.000Z',
 })],{previousSnapshot:first});
 assert.equal(nextDay.events.filter(e=>e.type==='NEW_CANDIDATE').length,1);
 const retest=runSignalIntelligenceV3([baseCandidate(opportunity)],
   {previousSnapshot:{...first,lists:{...first.lists,krBuy:[]}}});
 assert.equal(retest.events.filter(e=>e.type==='NEW_CANDIDATE').length,1);
});
