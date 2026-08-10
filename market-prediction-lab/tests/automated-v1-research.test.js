import test from "node:test";
import assert from "node:assert/strict";
import {
  RESEARCH_BACKTEST_PERIOD,
} from "../src/multi-market-backtest-engine.js";
import {
  runAutomatedV1Research,
} from "../src/automated-v1-research.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function candles(symbol, start = Date.UTC(2019, 8, 1), end = Date.UTC(2025, 11, 31)) {
  const rows = [];
  let index = 0;
  for (let timestamp = start; timestamp <= end; timestamp += DAY_MS, index += 1) {
    const trend = 100 + index * 0.025;
    const wave = Math.sin(index / 4) * 3 + Math.sin(index / 17) * 1.5;
    const open = trend + wave;
    const close = open + Math.sin(index / 2.7) * 0.9;
    rows.push(Object.freeze({
      symbol,
      timestamp,
      observedAt: timestamp,
      isClosed: true,
      open,
      high: Math.max(open, close) + 1.25,
      low: Math.min(open, close) - 1.25,
      close,
      volume: 1_000 + (index % 31) * 10,
    }));
  }
  return Object.freeze(rows);
}

const SMALL_BOUNDS = Object.freeze({
  fastPeriod: Object.freeze({ min: 5, max: 10, coarse: Object.freeze([5, 8, 10]), fineStep: 1 }),
  slowPeriod: Object.freeze({ min: 20, max: 40, coarse: Object.freeze([20, 30, 40]), fineStep: 2 }),
  atrPeriod: Object.freeze({ min: 7, max: 14, coarse: Object.freeze([7, 14]), fineStep: 1 }),
  pullbackTolerancePct: Object.freeze({ min: 0.5, max: 1.5, coarse: Object.freeze([0.5, 1, 1.5]), fineStep: 0.25 }),
  stopAtrMultiple: Object.freeze({ min: 1, max: 2, coarse: Object.freeze([1, 1.5, 2]), fineStep: 0.25 }),
  targetRiskMultiple: Object.freeze({ min: 1.5, max: 3, coarse: Object.freeze([1.5, 2, 3]), fineStep: 0.25 }),
});

function spotInput() {
  return {
    market: "CRYPTO_SPOT",
    symbol: "USDT-BTC",
    side: "long",
    timeframe: "1d",
    initialCapital: 1_000_000,
    candles: candles("USDT-BTC"),
    fundingRates: [],
    costModel: {
      entryFeeRate: 0.001,
      exitFeeRate: 0.001,
      taxRate: 0,
      slippageRate: 0.0002,
      spreadRate: 0.0002,
      latencyBars: 0,
      latencyDriftRate: 0,
    },
    riskModel: { riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 },
    dataCoverage: { sufficient: true, ratio: 1 },
  };
}

function run(input = spotInput(), overrides = {}) {
  return runAutomatedV1Research({
    backtestInput: input,
    parameterBounds: SMALL_BOUNDS,
    maxCoarseCandidates: 12,
    maxFineCandidates: 12,
    developmentSeeds: 3,
    oosCandidates: 3,
    maxWalkForwardWindows: 2,
    walkForwardOptions: {
      trainSize: 600,
      validationSize: 180,
      testSize: 180,
      stepSize: 180,
      embargoMs: DAY_MS,
    },
    ...overrides,
  });
}

test("automated V1 research is deterministic and keeps final holdout fully locked", () => {
  const first = run();
  const second = run();
  assert.deepEqual(first, second);
  assert.equal(first.period.developmentStart, RESEARCH_BACKTEST_PERIOD.startTime);
  assert.equal(first.period.developmentEnd, RESEARCH_BACKTEST_PERIOD.developmentEndTime);
  assert.equal(first.period.oosStart, RESEARCH_BACKTEST_PERIOD.validationStartTime);
  assert.equal(first.period.oosEnd, RESEARCH_BACKTEST_PERIOD.validationEndTime);
  assert.equal(first.period.finalHoldoutStart, RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime);
  assert.ok(first.period.oosEnd < first.period.finalHoldoutStart);
  assert.equal(first.finalHoldoutStatus, "locked_pending_frozen_candidate_one_shot");
  assert.equal(first.selectionUsesFinalHoldout, false);
  assert.equal(first.finalHoldoutRetuningAllowed, false);
  assert.equal(first.liveOrderAllowed, false);
  assert.equal(first.privateAccountRequestAllowed, false);
  assert.equal(first.orderSubmitted, false);
  assert.equal(first.branchWrite, false);
});

test("candidate exploration stays bounded and produces development/OOS/WF records without holdout promotion", () => {
  const result = run();
  assert.ok(result.candidateCounts.coarse > 0 && result.candidateCounts.coarse <= 12);
  assert.ok(result.candidateCounts.fine >= 0 && result.candidateCounts.fine <= 12);
  assert.ok(result.candidateCounts.development >= result.candidateCounts.oos);
  assert.ok(result.candidateCounts.oos > 0 && result.candidateCounts.oos <= 3);
  for (const candidate of result.candidates) {
    assert.ok(Number.isFinite(candidate.qualityScore));
    assert.ok(candidate.walkForward.windows.length > 0 && candidate.walkForward.windows.length <= 2);
    assert.ok(candidate.walkForward.windows.every((window) => window.leakFree === true));
    assert.ok(candidate.walkForward.windows.every((window) => window.endTime < RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime));
    assert.notEqual(candidate.researchStatus, "holdout_passed");
    assert.ok(candidate.oosMetrics.costImpact >= 0);
  }
});

test("unconfigured empirical numeric gates fail closed as threshold calibration required or research hold", () => {
  const result = run();
  assert.ok(result.candidates.every((candidate) => ["threshold_calibration_required", "research_hold"].includes(candidate.gate.status)));
  const positive = result.candidates.find((candidate) => candidate.gate.status === "threshold_calibration_required");
  if (positive) {
    assert.ok(positive.gate.unconfiguredThresholds.includes("minProfitFactor"));
    assert.ok(positive.gate.unconfiguredThresholds.includes("maxMaximumDrawdown"));
    assert.ok(positive.gate.unconfiguredThresholds.includes("minTradeCount"));
  }
});

test("caller cannot inject a period that could expose final holdout to automated selection", () => {
  const input = spotInput();
  input.period = { startTime: RESEARCH_BACKTEST_PERIOD.startTime, endTime: RESEARCH_BACKTEST_PERIOD.defaultEndTime, includeFinalHoldout: true };
  assert.throws(() => run(input), /caller period is not allowed/);
});

test("missing real historical candles are rejected instead of synthesized", () => {
  const input = spotInput();
  input.candles = [];
  assert.throws(() => run(input), /real historical candles are required/);
});

test("crypto futures short research reuses the same engine without private account/order access", () => {
  const input = {
    ...spotInput(),
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    side: "short",
    candles: candles("BTCUSDT"),
    costModel: {
      entryFeeRate: 0.0006,
      exitFeeRate: 0.0006,
      taxRate: 0,
      slippageRate: 0.0002,
      spreadRate: 0.0002,
      latencyBars: 0,
      latencyDriftRate: 0,
    },
  };
  const result = run(input, { oosCandidates: 2, maxWalkForwardWindows: 1 });
  assert.equal(result.market, "CRYPTO_FUTURES");
  assert.equal(result.side, "short");
  assert.equal(result.liveOrderAllowed, false);
  assert.equal(result.privateAccountRequestAllowed, false);
  assert.equal(result.orderSubmitted, false);
  assert.ok(result.candidates.length > 0);
});
