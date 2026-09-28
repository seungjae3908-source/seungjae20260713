import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFeatureSnapshotAt,
  improvedSignalDecision,
  runFourMarketOneYearAblation,
  runFourMarketOneYearBenchmark,
} from '../src/one-year-benchmark.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function candles(count = 560) {
  const start = Date.parse('2025-03-01T00:00:00.000Z');
  return Array.from({ length: count }, (_, index) => {
    const trend = 100 + index * 0.18;
    const wave = Math.sin(index / 5) * 2.8 + Math.sin(index / 17) * 1.4;
    const close = trend + wave;
    const open = close - Math.sin(index / 3) * 0.7;
    const high = Math.max(open, close) + 1.1;
    const low = Math.min(open, close) - 1.1;
    return {
      timestamp: start + index * DAY_MS,
      open,
      high,
      low,
      close,
      volume: 1000 + (index % 20) * 40,
    };
  });
}

function dataset(market, symbol) {
  return {
    market,
    symbol,
    timeframe: '1d',
    source: 'synthetic-test-fixture-only',
    candles: candles(),
    fundingRates: [],
  };
}

test('canonical feature snapshot uses only closed bars available by next-bar decision time', () => {
  const data = dataset('US_STOCK', 'TEST');
  const snapshot = buildFeatureSnapshotAt(data, 100, 'LONG');
  assert.ok(['READY_FOR_SPECIALIST_RESEARCH_ONLY', 'PARTIAL_FOR_SPECIALIST_RESEARCH_ONLY'].includes(snapshot.status));
  assert.equal(snapshot.acceptedClosedCandleCount, 101);
  assert.equal(snapshot.decisionTime, new Date(data.candles[101].timestamp).toISOString());
  assert.equal(snapshot.executionAuthority, 'NONE');
  const decision = improvedSignalDecision(snapshot, 'LONG');
  assert.equal(typeof decision.matched, 'boolean');
  assert.ok(decision.score >= 0 && decision.score <= 8);
  assert.equal(decision.maximumScore, 8);
  assert.equal(decision.threshold, 6);
  assert.ok(Array.isArray(decision.wave.swingSequence));

  const noMomentum = improvedSignalDecision(snapshot, 'LONG', { disabledFamilies: ['MOMENTUM'] });
  assert.equal(noMomentum.maximumScore, 5);
  assert.equal(noMomentum.threshold, 4);
  assert.deepEqual(noMomentum.disabledFamilies, ['MOMENTUM']);
});

test('four-market benchmark remains research-only and produces bounded A/B rows', () => {
  const result = runFourMarketOneYearBenchmark({
    datasets: [
      dataset('KR_STOCK', '005930'),
      dataset('US_STOCK', 'AAPL'),
      dataset('CRYPTO_SPOT', 'BTC'),
      dataset('CRYPTO_FUTURES', 'BTCUSDT'),
    ],
  });
  assert.equal(result.status, 'BOUNDED_FOUR_MARKET_RESULT');
  assert.equal(result.evidenceBoundary.executionAuthority, 'NONE');
  assert.equal(result.evidenceBoundary.profitabilityClaimAllowed, false);
  assert.equal(result.evidenceBoundary.oosCredit, 0);
  for (const market of ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES']) {
    assert.ok(result.markets[market].baseline.sampleCount > 0);
    assert.ok(result.markets[market].improved.sampleCount > 0);
    assert.equal(Number.isFinite(result.markets[market].baseline.totalReturn), true);
    assert.equal(Number.isFinite(result.markets[market].improved.totalReturn), true);
  }
});


test('factor ablation keeps all five family-removal variants research-only', () => {
  const result = runFourMarketOneYearAblation({
    datasets: [
      dataset('KR_STOCK', '005930'),
      dataset('US_STOCK', 'AAPL'),
      dataset('CRYPTO_SPOT', 'BTC'),
      dataset('CRYPTO_FUTURES', 'BTCUSDT'),
    ],
  });
  assert.equal(result.interpretation.automaticMarketSpecificAdoptionAllowed, false);
  assert.equal(result.interpretation.economicSampleCredit, 0);
  assert.equal(result.interpretation.executionAuthority, 'NONE');
  for (const market of ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES']) {
    const variants = result.markets[market].variants;
    for (const id of ['BASELINE', 'FULL', 'NO_TREND', 'NO_MOMENTUM', 'NO_STRUCTURE', 'NO_VOLUME', 'NO_VOLATILITY']) {
      assert.ok(Object.hasOwn(variants, id));
      assert.ok(variants[id].sampleCount > 0);
      assert.equal(Number.isFinite(variants[id].totalReturn), true);
    }
    for (const id of ['NO_TREND', 'NO_MOMENTUM', 'NO_STRUCTURE', 'NO_VOLUME', 'NO_VOLATILITY']) {
      assert.ok(Object.hasOwn(result.markets[market].deltas, id));
    }
  }
});
