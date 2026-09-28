import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeMarketHypothesisForwardState } from '../src/market-hypothesis-forward-state-consumer.mjs';

const HOUR_MS = 60 * 60 * 1000;
const START = Date.parse('2026-09-10T00:00:00.000Z');
const DECISION = Date.parse('2026-09-28T07:00:00.000Z');

function candles() {
  return Array.from({ length: 500 }, (_, index) => {
    const base = 100 + index * 0.05 + Math.sin(index / 7) * 1.6;
    return {
      timestamp: START + index * HOUR_MS,
      open: base - 0.2,
      high: base + 0.9,
      low: base - 0.9,
      close: base + 0.2,
      volume: 1000 + (index % 24) * 30,
    };
  });
}
function observation({
  id = 'obs-1',
  symbol = '005930',
  timestamp = new Date(DECISION).toISOString(),
  market = 'KR_STOCK',
  timeframe = '60m',
  direction = 'BUY',
} = {}) {
  return {
    schemaVersion: 'forward-recommendation-observation-v2',
    observationId: id,
    source: 'LIVE_RECOMMENDATION',
    status: 'PENDING',
    identity: {
      strategyId: 'scanner-swing',
      strategyVersion: 'v1',
      parameterHash: 'p',
      researchCodeSha: 'a'.repeat(40),
      market,
      symbol,
      timeframe,
      horizon: 24,
      direction,
    },
    dataTimestamp: timestamp,
    publicDataOnly: true,
    snapshot: { timestamp, market, symbol, direction },
    outcome: null,
    settledAt: null,
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
    createdAt: '2026-09-28T06:40:00.000Z',
    updatedAt: '2026-09-28T07:10:00.000Z',
    cursors: {
      KR_SWING_60M: 0,
      US_SWING_60M: 0,
      SPOT_SWING_4H: 0,
      FUTURES_SWING_60M: 0,
    },
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

test('state consumer reads only post-freeze frozen KR scope and never mutates canonical state', async () => {
  const before = state([
    observation(),
    observation({ id: 'us', market: 'US_STOCK', symbol: 'AAPL' }),
    observation({ id: 'outside', symbol: '035420' }),
    observation({ id: 'old', timestamp: '2026-09-28T06:30:00.000Z' }),
  ]);
  const snapshot = JSON.stringify(before);
  let loads = 0;
  const result = await consumeMarketHypothesisForwardState({
    state: before,
    loadCandles: async ({ symbol, timeframe }) => {
      loads += 1;
      assert.equal(symbol, '005930');
      assert.equal(timeframe, '60m');
      return candles();
    },
  });
  assert.equal(result.status, 'READY');
  assert.equal(result.sourceObservationCount, 4);
  assert.equal(result.candidateObservationCount, 1);
  assert.equal(result.untouchedObservationCount, 3);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].status, 'PENDING');
  assert.equal(loads, 1);
  assert.equal(result.sourceStateMutated, false);
  assert.equal(result.canonicalStateWriteAllowed, false);
  assert.equal(JSON.stringify(before), snapshot);
  assert.equal(result.economicSampleCredit, 0);
  assert.equal(result.executionAuthority, 'NONE');
});

test('consumer caches candle history per frozen symbol', async () => {
  let loads = 0;
  const result = await consumeMarketHypothesisForwardState({
    state: state([
      observation({ id: 'a' }),
      observation({ id: 'b', timestamp: '2026-09-28T08:00:00.000Z' }),
    ]),
    loadCandles: async () => {
      loads += 1;
      return candles();
    },
  });
  assert.equal(result.candidateObservationCount, 2);
  assert.equal(loads, 1);
  assert.equal(result.records.length, 2);
});

test('unsafe canonical Forward state is blocked before candle loading', async () => {
  const unsafe = state([observation()]);
  unsafe.safety.liveOrderAllowed = true;
  let loaded = false;
  const result = await consumeMarketHypothesisForwardState({
    state: unsafe,
    loadCandles: async () => {
      loaded = true;
      return candles();
    },
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.reason, 'CANONICAL_FORWARD_STATE_SAFETY_INVALID');
  assert.equal(loaded, false);
  assert.equal(result.economicSampleCredit, 0);
});

test('candle load failures remain blocked evidence and do not abort the read-only consumer', async () => {
  const result = await consumeMarketHypothesisForwardState({
    state: state([observation()]),
    loadCandles: async () => {
      throw new Error('provider unavailable');
    },
  });
  assert.equal(result.status, 'READY');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].status, 'BLOCKED_DATA');
  assert.equal(result.records[0].reason, 'FORWARD_FEATURE_CANDLE_LOAD_FAILED');
  assert.equal(result.summary.blockedN, 1);
  assert.equal(result.economicSampleCredit, 0);
});
