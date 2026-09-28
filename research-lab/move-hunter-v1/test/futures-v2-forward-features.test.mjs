import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFuturesV2ForwardFeatureSnapshot } from '../src/futures-v2-forward-features.mjs';

const HOUR_MS = 60 * 60 * 1000;
const DECISION = Date.parse('2026-09-29T00:00:00.000Z');
const START = DECISION - 380 * HOUR_MS;

function candles(count = 380) {
  return Array.from({ length: count }, (_, index) => {
    const base = 100 + index * 0.08 + Math.sin(index / 6) * 1.5;
    return {
      timestamp: START + index * HOUR_MS,
      open: base - 0.2,
      high: base + 0.9,
      low: base - 0.9,
      close: base + 0.2,
      volume: 1200 + (index % 24) * 25,
    };
  });
}
function observation(overrides = {}) {
  const symbol = overrides.symbol ?? 'BTCUSDT';
  const direction = overrides.direction ?? 'LONG';
  const timeframe = overrides.timeframe ?? '60m';
  return {
    identity: { market: 'CRYPTO_FUTURES', symbol, timeframe, direction },
    snapshot: {
      timestamp: new Date(DECISION).toISOString(),
      market: 'CRYPTO_FUTURES',
      symbol,
      direction,
    },
  };
}

test('Futures Forward feature builder uses only completed 60m candles before decision time', () => {
  const rows = candles();
  rows.push({
    timestamp: DECISION,
    open: 999,
    high: 1000,
    low: 998,
    close: 999.5,
    volume: 999999,
  });
  const result = buildFuturesV2ForwardFeatureSnapshot({
    observation: observation(),
    candles: rows,
    maxHistoryBars: 300,
  });
  assert.equal(result.status, 'READY');
  assert.equal(result.acceptedClosedCandleCount, 300);
  assert.equal(result.futureOrUnclosedBorrowed, false);
  assert.ok(Date.parse(result.lastAvailableAt) <= DECISION);
  assert.equal(result.snapshot.executionAuthority, 'NONE');
  assert.equal(result.snapshot.decisionAuthority, 'EVIDENCE_ONLY');
  assert.equal(result.snapshot.evidence.trend.evidence.identity.symbol, 'BTCUSDT');
  assert.equal(String(result.snapshot.evidence.trend.evidence.identity.timeframe).toUpperCase(), '60M');
});

test('Futures Forward feature builder blocks insufficient past-only history', () => {
  const result = buildFuturesV2ForwardFeatureSnapshot({
    observation: observation(),
    candles: candles(80),
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.reason, 'INSUFFICIENT_PAST_ONLY_60M_HISTORY');
  assert.equal(result.economicSampleCredit, 0);
});

test('Futures Forward feature builder rejects non-preregistered symbol and timeframe', () => {
  assert.throws(
    () => buildFuturesV2ForwardFeatureSnapshot({
      observation: observation({ symbol: 'SOLUSDT' }),
      candles: candles(),
    }),
    /preregistered scope/,
  );
  assert.throws(
    () => buildFuturesV2ForwardFeatureSnapshot({
      observation: observation({ timeframe: '4H' }),
      candles: candles(),
    }),
    /60m/,
  );
});
