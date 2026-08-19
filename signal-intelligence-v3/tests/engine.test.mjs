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
