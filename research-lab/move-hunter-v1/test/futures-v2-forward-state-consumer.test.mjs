import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeFuturesV2ForwardState } from '../src/futures-v2-forward-state-consumer.mjs';

const HOUR_MS = 60 * 60 * 1000;
const DECISION = '2026-09-29T00:00:00.000Z';
const START = Date.parse(DECISION) - 420 * HOUR_MS;
const costModel = Object.freeze({
  modelId: 'PUBLIC_RESEARCH_COST_MODEL_V1',
  feeBps: 5,
  slippageBps: 5,
  spreadBps: 6,
  canonicalFullCostProven: false,
});

function candles() {
  return Array.from({ length: 420 }, (_, index) => {
    const base = 100 + index * 0.07 + Math.sin(index / 6) * 1.4;
    return {
      timestamp: START + index * HOUR_MS,
      open: base - 0.2,
      high: base + 0.9,
      low: base - 0.9,
      close: base + 0.2,
      volume: 1500 + (index % 20) * 40,
    };
  });
}
function observation({
  id = 'fut-1',
  symbol = 'BTCUSDT',
  direction = 'LONG',
  timestamp = DECISION,
  status = 'PENDING',
} = {}) {
  return {
    schemaVersion: 'forward-recommendation-observation-v2',
    observationId: id,
    source: 'LIVE_RECOMMENDATION',
    status,
    identity: {
      strategyId: 'scanner-swing',
      strategyVersion: 'v1',
      parameterHash: 'p',
      researchCodeSha: 'a'.repeat(40),
      market: 'CRYPTO_FUTURES',
      symbol,
      timeframe: '60m',
      horizon: 24,
      direction,
    },
    dataTimestamp: timestamp,
    publicDataOnly: true,
    snapshot: {
      timestamp,
      market: 'CRYPTO_FUTURES',
      symbol,
      direction,
      entryPrice: 100,
      stopLoss: direction === 'SHORT' ? 101.5 : 98.5,
    },
    outcome: status === 'SETTLED'
      ? { outcome: 'WIN', returnPercent: 1.2, target1Hit: true, target2Hit: false, stopLossHit: false }
      : null,
    settledAt: status === 'SETTLED' ? '2026-09-29T03:00:00.000Z' : null,
    executionAuthority: 'NONE',
    simulatedOnly: true,
    financialMutationAllowed: false,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    profitabilityClaimAllowed: false,
  };
}
function state(observations) {
  return {
    schemaVersion: 1,
    researchCodeSha: 'b'.repeat(40),
    createdAt: '2026-09-28T08:00:00.000Z',
    updatedAt: '2026-09-29T00:10:00.000Z',
    cursors: { KR_SWING_60M: 0, US_SWING_60M: 0, SPOT_SWING_4H: 0, FUTURES_SWING_60M: 0 },
    observations,
    safety: {
      publicDataOnly: true,
      artifactOnly: true,
      executionAuthority: 'NONE',
      financialMutationAllowed: false,
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
      profitabilityClaimAllowed: false,
    },
  };
}

test('Futures V2 consumer reads only post-freeze futures scope and never mutates canonical state', async () => {
  const kr = observation({ id: 'kr' });
  kr.identity.market = 'KR_STOCK';
  kr.identity.symbol = '005930';
  kr.snapshot.market = 'KR_STOCK';
  kr.snapshot.symbol = '005930';
  const source = state([
    observation(),
    observation({ id: 'short', symbol: 'ETHUSDT', direction: 'SHORT' }),
    observation({ id: 'old', timestamp: '2026-09-28T07:30:00.000Z' }),
    kr,
  ]);
  const before = JSON.stringify(source);
  let loads = 0;
  const result = await consumeFuturesV2ForwardState({
    state: source,
    costModel,
    loadCandles: async ({ symbol, timeframe }) => {
      loads += 1;
      assert.ok(['BTCUSDT', 'ETHUSDT'].includes(symbol));
      assert.equal(timeframe, '60m');
      return candles();
    },
  });
  assert.equal(result.status, 'READY');
  assert.equal(result.sourceObservationCount, 4);
  assert.equal(result.candidateObservationCount, 2);
  assert.equal(result.records.length, 2);
  assert.equal(result.sourceStateMutated, false);
  assert.equal(result.canonicalStateWriteAllowed, false);
  assert.equal(JSON.stringify(source), before);
  assert.equal(result.summary.performanceWinner, null);
  assert.equal(result.summary.winnerSelectionAllowed, false);
  assert.equal(result.economicSampleCredit, 0);
  assert.equal(result.executionAuthority, 'NONE');
  assert.equal(loads, 2);
});

test('Futures V2 consumer caches per-symbol candles and preserves pending/settled counts', async () => {
  let loads = 0;
  const result = await consumeFuturesV2ForwardState({
    state: state([
      observation({ id: 'a' }),
      observation({ id: 'b', timestamp: '2026-09-29T01:00:00.000Z', status: 'SETTLED' }),
    ]),
    costModel,
    loadCandles: async () => {
      loads += 1;
      return candles();
    },
  });
  assert.equal(loads, 1);
  assert.equal(result.summary.acceptedN, 2);
  assert.equal(result.summary.pendingN, 1);
  assert.equal(result.summary.settledN, 1);
  assert.equal(result.summary.performanceWinner, null);
});

test('unsafe state and missing explicit cost model fail closed before provider use', async () => {
  const unsafe = state([observation()]);
  unsafe.safety.liveOrderAllowed = true;
  let loaded = false;
  const blockedState = await consumeFuturesV2ForwardState({
    state: unsafe,
    costModel,
    loadCandles: async () => {
      loaded = true;
      return candles();
    },
  });
  assert.equal(blockedState.status, 'BLOCKED_DATA');
  assert.equal(blockedState.reason, 'CANONICAL_FORWARD_STATE_SAFETY_INVALID');
  assert.equal(loaded, false);

  const blockedCost = await consumeFuturesV2ForwardState({
    state: state([observation()]),
    loadCandles: async () => {
      loaded = true;
      return candles();
    },
  });
  assert.equal(blockedCost.status, 'BLOCKED_DATA');
  assert.equal(blockedCost.reason, 'EXPLICIT_COST_MODEL_REQUIRED');
});

test('provider failure remains blocked evidence instead of aborting the whole consumer', async () => {
  const result = await consumeFuturesV2ForwardState({
    state: state([observation()]),
    costModel,
    loadCandles: async () => {
      throw new Error('provider unavailable');
    },
  });
  assert.equal(result.status, 'READY');
  assert.equal(result.records[0].status, 'BLOCKED_DATA');
  assert.equal(result.records[0].reason, 'FORWARD_FEATURE_CANDLE_LOAD_FAILED');
  assert.equal(result.summary.blockedN, 1);
  assert.equal(result.economicSampleCredit, 0);
});
