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
  assert.equal(result.interpretation.candidatePrefilterFrozenAcrossVariants, true);
  assert.equal(result.interpretation.ablationScope, 'FINAL_DECISION_LAYER_ONLY');
  assert.equal(result.interpretation.automaticMarketSpecificAdoptionAllowed, false);
  assert.equal(result.interpretation.regimeAttributionAuthority, 'DIAGNOSTIC_ONLY');
  assert.equal(result.interpretation.returnAttributionAuthority, 'DIAGNOSTIC_ONLY');
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
    assert.equal(result.markets[market].sourceTimeframeIdentityExact, true);
    assert.deepEqual(result.markets[market].sourceTimeframes, ['1D']);
    assert.equal(result.markets[market].stability.midpoint, result.midpoint);
    assert.ok(Array.isArray(result.markets[market].stability.lanes));
    assert.ok(result.markets[market].stability.variantRobustness.BASELINE);
    assert.ok(result.markets[market].stability.variantRobustness.FULL);
    const baselineLane = result.markets[market].stability.lanes.find((row) => row.variant === 'BASELINE');
    assert.ok(baselineLane);
    assert.equal(typeof baselineLane.regimes, 'object');
  }
  assert.equal(result.markets.KR_STOCK.stability.variantRobustness.BASELINE.laneCount, 1);
  assert.equal(result.markets.CRYPTO_FUTURES.stability.variantRobustness.BASELINE.laneCount, 2);
});


test('lane-aligned ablation may use a bounded past-only feature window without changing safety authority', () => {
  const result = runFourMarketOneYearAblation({
    datasets: [
      dataset('KR_STOCK', '005930'),
      dataset('US_STOCK', 'AAPL'),
      dataset('CRYPTO_SPOT', 'BTC'),
      dataset('CRYPTO_FUTURES', 'BTCUSDT'),
    ],
    featureHistoryBars: 150,
  });
  assert.equal(result.interpretation.featureHistoryBars, 150);
  assert.equal(result.interpretation.executionAuthority, 'NONE');
  assert.equal(result.interpretation.economicSampleCredit, 0);
  assert.equal(result.markets.KR_STOCK.variants.FULL.sampleCount, 1);
});


test('stability decomposition preserves symbol, side, and half-period metrics without authority', () => {
  const result = runFourMarketOneYearAblation({
    datasets: [
      dataset('KR_STOCK', '005930'),
      dataset('KR_STOCK', '000660'),
      dataset('CRYPTO_FUTURES', 'BTCUSDT'),
      dataset('CRYPTO_FUTURES', 'ETHUSDT'),
    ],
    featureHistoryBars: 150,
  });
  const kr = result.markets.KR_STOCK.stability;
  const futures = result.markets.CRYPTO_FUTURES.stability;
  assert.equal(kr.lanes.filter((row) => row.variant === 'BASELINE').length, 2);
  assert.equal(futures.lanes.filter((row) => row.variant === 'BASELINE').length, 4);
  assert.deepEqual(
    [...new Set(futures.lanes.filter((row) => row.variant === 'BASELINE').map((row) => row.side))].sort(),
    ['LONG', 'SHORT'],
  );
  for (const row of [...kr.lanes, ...futures.lanes]) {
    assert.equal(Number.isFinite(row.overall.totalReturn), true);
    assert.equal(Number.isFinite(row.firstHalf.totalReturn), true);
    assert.equal(Number.isFinite(row.secondHalf.totalReturn), true);
    if (row.overall.tradeCount > 0) {
      assert.ok(Object.keys(row.regimes).length > 0);
      assert.ok(Object.keys(row.directionalRegimes).length > 0);
      assert.ok(Object.keys(row.volatilityRegimes).length > 0);
    }
    assert.equal(row.attribution.tradeCount, row.overall.tradeCount);
    assert.equal(
      Number.isFinite(row.attribution.grossAccountReturnSum),
      true,
    );
    assert.equal(
      Number.isFinite(row.attribution.tradingCostAccountDragSum),
      true,
    );
    assert.equal(
      Number.isFinite(row.attribution.fundingAccountImpactSum),
      true,
    );
    assert.equal(row.attribution.accountingNote, 'ARITHMETIC_DIAGNOSTIC_NOT_COMPOUNDED_EQUITY_RETURN');
  }
  assert.equal(result.interpretation.economicSampleCredit, 0);
  assert.equal(result.interpretation.profitabilityClaimAllowed, false);
  assert.equal(result.interpretation.executionAuthority, 'NONE');
});
