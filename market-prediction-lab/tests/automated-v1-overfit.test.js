import test from "node:test";
import assert from "node:assert/strict";
import { runAutomatedV1Research } from "../src/automated-v1-research.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function candles() {
  const rows = [];
  let index = 0;
  for (let timestamp = Date.UTC(2019, 8, 1); timestamp <= Date.UTC(2025, 11, 31); timestamp += DAY_MS, index += 1) {
    const trend = 100 + index * 0.03;
    const wave = Math.sin(index / 3.5) * 4 + Math.sin(index / 15) * 2;
    const open = trend + wave;
    const close = open + Math.sin(index / 2.3) * 1.1;
    rows.push(Object.freeze({
      symbol: "USDT-BTC",
      timestamp,
      observedAt: timestamp,
      isClosed: true,
      open,
      high: Math.max(open, close) + 1.5,
      low: Math.min(open, close) - 1.5,
      close,
      volume: 1000 + (index % 29) * 20,
    }));
  }
  return Object.freeze(rows);
}

const BOUNDS = Object.freeze({
  fastPeriod: Object.freeze({ min: 8, max: 12, coarse: Object.freeze([8, 10, 12]), fineStep: 1 }),
  slowPeriod: Object.freeze({ min: 30, max: 50, coarse: Object.freeze([30, 40, 50]), fineStep: 2 }),
  atrPeriod: Object.freeze({ min: 10, max: 16, coarse: Object.freeze([10, 14, 16]), fineStep: 1 }),
  pullbackTolerancePct: Object.freeze({ min: 0.5, max: 1.5, coarse: Object.freeze([0.5, 1, 1.5]), fineStep: 0.25 }),
  stopAtrMultiple: Object.freeze({ min: 1, max: 2, coarse: Object.freeze([1, 1.5, 2]), fineStep: 0.25 }),
  targetRiskMultiple: Object.freeze({ min: 1.5, max: 3, coarse: Object.freeze([1.5, 2, 3]), fineStep: 0.25 }),
});

function run(overfitPolicy) {
  return runAutomatedV1Research({
    backtestInput: {
      market: "CRYPTO_SPOT",
      symbol: "USDT-BTC",
      side: "long",
      timeframe: "1d",
      initialCapital: 1_000_000,
      candles: candles(),
      fundingRates: [],
      costModel: { entryFeeRate: 0.001, exitFeeRate: 0.001, taxRate: 0, slippageRate: 0.0002, spreadRate: 0.0002, latencyBars: 0, latencyDriftRate: 0 },
      riskModel: { riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 },
      dataCoverage: { sufficient: true, ratio: 1 },
    },
    parameterBounds: BOUNDS,
    maxCoarseCandidates: 10,
    maxFineCandidates: 10,
    developmentSeeds: 3,
    oosCandidates: 3,
    maxWalkForwardWindows: 2,
    walkForwardOptions: { trainSize: 600, validationSize: 180, testSize: 180, stepSize: 180, embargoMs: DAY_MS },
    overfitPolicy,
  });
}

test("every automated candidate exposes low-sample, degradation, walk-forward, concentration and regime diagnostics", () => {
  const result = run();
  assert.ok(result.candidates.length > 0);
  for (const candidate of result.candidates) {
    assert.ok(Array.isArray(candidate.overfitDiagnostics.flags));
    assert.ok("tuningToOosTradeRatio" in candidate.overfitDiagnostics);
    assert.ok("developmentToOosReturnRetention" in candidate.overfitDiagnostics);
    assert.ok("profitableWalkForwardWindowsRatio" in candidate.overfitDiagnostics);
    assert.ok("topTwoWinnerShare" in candidate.overfitDiagnostics);
    assert.ok("profitableRegimeRatio" in candidate.overfitDiagnostics);
    assert.ok(Number.isFinite(candidate.qualityScoreBeforeOverfitPenalty));
    assert.ok(Number.isFinite(candidate.overfitPenaltyPoints));
    assert.ok(candidate.qualityScore <= candidate.qualityScoreBeforeOverfitPenalty);
    assert.ok(candidate.oosMetrics.tradeConcentration);
    assert.ok(candidate.oosMetrics.regimePerformance);
  }
});

test("winner concentration can only lower quality and never promote a held candidate", () => {
  const result = run({
    topTwoWinnerShareSoftLimit: 0,
    maximumTradeConcentrationPenaltyPoints: 10,
    profitableWalkForwardWindowReference: 0.5,
    lowSampleReferenceTrades: 10,
  });
  const concentrated = result.candidates.filter((candidate) => Number.isFinite(candidate.overfitDiagnostics.topTwoWinnerShare) && candidate.overfitDiagnostics.topTwoWinnerShare > 0);
  assert.ok(concentrated.length > 0);
  assert.ok(concentrated.every((candidate) => candidate.overfitPenaltyPoints > 0));
  assert.ok(concentrated.every((candidate) => candidate.qualityScore < candidate.qualityScoreBeforeOverfitPenalty));
  assert.ok(concentrated.every((candidate) => candidate.researchStatus !== "holdout_passed"));
});
