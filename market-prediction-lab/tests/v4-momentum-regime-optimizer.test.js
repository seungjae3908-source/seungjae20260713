import test from "node:test";
import assert from "node:assert/strict";
import {
  RESEARCH_BACKTEST_PERIOD,
  V1_DEFAULT_PARAMETERS,
} from "../src/multi-market-backtest-engine.js";
import {
  buildV4FilterCandidates,
  evaluateV4Validation,
  runV4FilteredBacktest,
} from "../src/v4-momentum-regime-optimizer.js";

function candles(count = 320) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const timestamp = Date.UTC(2020, 0, 1) + index * 24 * 60 * 60 * 1000;
    const base = 100 + index * 0.15 + Math.sin(index / 8) * 2;
    rows.push(Object.freeze({
      symbol: "USDT-ETH",
      timestamp,
      observedAt: timestamp,
      isClosed: true,
      open: base,
      high: base + 1.2,
      low: Math.max(0.01, base - 1.2),
      close: base + Math.sin(index / 3) * 0.4,
      volume: 1000 + (index % 17) * 25,
    }));
  }
  return rows;
}

test("V4 default grid is deliberately bounded", () => {
  const candidates = buildV4FilterCandidates();
  assert.equal(candidates.length, 36);
  assert.equal(new Set(candidates.map((row) => JSON.stringify(row))).size, 36);
});

test("V4 validation never uses a scalar weighted score", () => {
  const result = evaluateV4Validation({
    baseline: {
      returnPercent: 1,
      successRatePercent: 40,
      profitFactor: 1.2,
      maximumDrawdownPercent: 5,
      trades: 20,
    },
    candidate: {
      returnPercent: 2,
      successRatePercent: 45,
      profitFactor: 1.3,
      maximumDrawdownPercent: 4,
      trades: 15,
    },
  });
  assert.equal(result.verdict, "adopt_candidate");
  assert.equal(result.weightedScoreUsed, false);
});

test("V4 rejects final-holdout selection", () => {
  assert.throws(() => runV4FilteredBacktest({
    backtestInput: {
      market: "CRYPTO_SPOT",
      symbol: "USDT-ETH",
      side: "long",
      timeframe: "1d",
      initialCapital: RESEARCH_BACKTEST_PERIOD.initialCapital,
      candles: candles(),
      fundingRates: [],
    },
    parameters: V1_DEFAULT_PARAMETERS,
    filter: {
      requireRegimeAlignment: true,
      emaSlopeAtrMin: 0.05,
      rsiDirectionalThreshold: 55,
      macdMode: "directional",
    },
    period: {
      startTime: RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime,
      endTime: RESEARCH_BACKTEST_PERIOD.defaultEndTime,
      includeFinalHoldout: true,
    },
  }), (error) => error?.code === "V4_HOLDOUT_LOCKED");
});
