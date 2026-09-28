import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMarketHypothesisForwardFeatureSnapshot,
} from '../src/market-hypothesis-forward-features.mjs';

const HOUR_MS = 60 * 60 * 1000;
const START = Date.parse('2026-09-10T00:00:00.000Z');
const DECISION = START + 360 * HOUR_MS;

function candles(count = 380) {
  return Array.from({ length: count }, (_, index) => {
    const base = 100 + index * 0.05 + Math.sin(index / 7) * 1.8;
    return {
      timestamp: START + index * HOUR_MS,
      open: base - 0.2,
      high: base + 0.8,
      low: base - 0.8,
      close: base + 0.15,
      volume: 1000 + (index % 20) * 25,
    };
  });
}

function observation(overrides = {}) {
  return {
    identity: {
      market: 'KR_STOCK',
      symbol: '005930',
      timeframe: '60m',
      direction: 'BUY',
      ...(overrides.identity ?? {}),
    },
    snapshot: {
      timestamp: new Date(DECISION).toISOString(),
      market: 'KR_STOCK',
      symbol: '005930',
      direction: 'BUY',
      ...(overrides.snapshot ?? {}),
    },
  };
}

test('Forward feature helper uses only completed candles available by decision time', () => {
  const rows = candles();
  rows.push({
    timestamp: DECISION,
    open: 999,
    high: 1000,
    low: 998,
    close: 999.5,
    volume: 999999,
  });
  const result = buildMarketHypothesisForwardFeatureSnapshot({
    observation: observation(),
    candles: rows,
    maxHistoryBars: 300,
  });
  assert.equal(result.status, 'READY');
  assert.equal(result.acceptedClosedCandleCount, 300);
  assert.equal(result.maxHistoryBars, 300);
  assert.equal(result.futureOrUnclosedBorrowed, false);
  assert.ok(Date.parse(result.lastAvailableAt) <= DECISION);
  assert.equal(result.snapshot.executionAuthority, 'NONE');
  assert.equal(result.snapshot.decisionAuthority, 'EVIDENCE_ONLY');
  assert.ok(['READY_FOR_SPECIALIST_RESEARCH_ONLY', 'PARTIAL_FOR_SPECIALIST_RESEARCH_ONLY'].includes(result.snapshot.status));
  assert.equal(
    result.snapshot.evidence.trend.evidence.identity.temporal.decisionTime,
    new Date(DECISION).toISOString(),
  );
  assert.equal(result.snapshot.evidence.trend.evidence.identity.symbol, '005930');
  assert.equal(result.snapshot.evidence.trend.evidence.identity.timeframe, '60m');
});

test('Forward feature helper blocks insufficient past-only history', () => {
  const result = buildMarketHypothesisForwardFeatureSnapshot({
    observation: observation(),
    candles: candles(80),
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.reason, 'INSUFFICIENT_PAST_ONLY_60M_HISTORY');
  assert.equal(result.snapshot, null);
  assert.equal(result.economicSampleCredit, 0);
});

test('Forward feature helper refuses cross-market and cross-timeframe borrowing', () => {
  assert.throws(
    () => buildMarketHypothesisForwardFeatureSnapshot({
      observation: observation({ identity: { market: 'US_STOCK' } }),
      candles: candles(),
    }),
    /KR_STOCK/,
  );
  assert.throws(
    () => buildMarketHypothesisForwardFeatureSnapshot({
      observation: observation({ identity: { timeframe: '4H' } }),
      candles: candles(),
    }),
    /60m/,
  );
});

test('Forward feature helper preserves zero execution and promotion authority', () => {
  const result = buildMarketHypothesisForwardFeatureSnapshot({
    observation: observation(),
    candles: candles(),
  });
  assert.equal(result.status, 'READY');
  assert.equal(result.economicSampleCredit, 0);
  assert.equal(result.automaticScannerAdoptionAllowed, false);
  assert.equal(result.automaticPromotionAllowed, false);
  assert.equal(result.executionAuthority, 'NONE');
});
