import test from "node:test";
import assert from "node:assert/strict";
import { createResearchArtifact } from "../src/research-governance.js";
import {
  alignStrictResearchSeries,
  createModelResearchRecord,
  evaluateResearchPromotionStrict,
  selectValidationCandidateAndCheckOverfit,
  summarizeTradePerformanceByDimensions,
  upsertModelResearchRecord,
} from "../src/research-governance-hardening.js";

const DAY = 24 * 60 * 60 * 1000;

test("strict alignment rejects out-of-order and open candles before normalization", () => {
  assert.throws(() => alignStrictResearchSeries({
    candles: [{ timestamp: 2_000 }, { timestamp: 1_000 }],
    asOf: 3_000,
  }), /ordered/);
  assert.throws(() => alignStrictResearchSeries({
    candles: [{ timestamp: 1_000, isClosed: false }],
    asOf: 3_000,
  }), /open candle/);
  const aligned = alignStrictResearchSeries({
    candles: [{ timestamp: 1_000, isClosed: true }, { timestamp: 2_000, isClosed: true }],
    features: { funding: [{ timestamp: 1_000, observedAt: 1_000 }, { timestamp: 2_000, observedAt: 2_000 }] },
    asOf: 3_000,
  });
  assert.equal(aligned.rows.length, 2);
});

test("performance is reported by symbol, timeframe, regime and model version", () => {
  const common = { costsIncluded: true, costs: { total: 1 }, action: "BUY" };
  const result = summarizeTradePerformanceByDimensions([
    { ...common, netPnl: 10, market: "KR_STOCK", symbol: "005930", timeframe: "1d", regime: "bull", modelVersion: "v1" },
    { ...common, netPnl: -5, market: "KR_STOCK", symbol: "005930", timeframe: "1d", regime: "bear", modelVersion: "v1" },
    { ...common, netPnl: 20, market: "US_STOCK", symbol: "AAPL", timeframe: "1h", regime: "bull", modelVersion: "v2" },
  ]);
  assert.equal(result.bySymbol["005930"].sampleCount, 2);
  assert.equal(result.byTimeframe["1h"].sampleCount, 1);
  assert.equal(result.byRegime.bull.sampleCount, 2);
  assert.equal(result.byModelVersion.v2.sampleCount, 1);
});

test("parameter selection uses validation only and flags test degradation", () => {
  const decision = selectValidationCandidateAndCheckOverfit([
    { id: "stable", validationScore: 0.60, testScore: 0.59 },
    { id: "overfit", validationScore: 0.80, testScore: 0.40 },
    { id: "middle", validationScore: 0.65, testScore: 0.61 },
  ], { maxValidationTestGap: 0.2, maxTestRankPercentile: 0.5 });
  assert.equal(decision.selectedId, "overfit");
  assert.equal(decision.selectionBasis, "validation_only");
  assert.equal(decision.testUsedForSelection, false);
  assert.equal(decision.status, "research_hold");
  assert.ok(decision.reasons.includes("validation_test_gap_exceeded"));
  assert.ok(decision.reasons.includes("validation_winner_test_rank_dropped"));
});

test("strict promotion and model ledger remain research-only", () => {
  const input = {
    sampleCount: 400,
    perSymbolSamples: { BTCUSDT: 200, ETHUSDT: 200 },
    observationMs: 35 * DAY,
    qualifiedRegimes: 3,
    costsIncluded: true,
    walkForwardValidated: true,
    overfitChecksPassed: true,
    testSetUntouched: true,
    reproducible: true,
    integrityVerified: true,
    baseline: { brier: 0.22, macroF1: 0.5 },
    candidate: { brier: 0.2, macroF1: 0.55, expectedCalibrationError: 0.05, maximumDrawdown: 12 },
    paperComparison: { expectancyDelta: -0.2 },
  };
  const promotion = evaluateResearchPromotionStrict(input, { maxDrawdown: 20, maxPaperExpectancyGap: 1 });
  assert.equal(promotion.status, "integration_review_ready");
  assert.equal(promotion.automaticOperationsAllowed, false);
  const held = evaluateResearchPromotionStrict({ ...input, overfitChecksPassed: false }, { maxDrawdown: 20, maxPaperExpectancyGap: 1 });
  assert.equal(held.status, "research_hold");
  assert.ok(held.reasons.includes("overfit_checks_not_passed"));

  const artifact = createResearchArtifact({ evaluatedAt: 1_700_000_000_000, result: { expectancy: 1.2 } });
  const record = createModelResearchRecord({
    modelVersion: "model-v1",
    strategyVersion: "strategy-v2",
    datasetHash: "a".repeat(64),
    artifact,
    promotion: held,
    evaluatedAt: 1_700_000_000_000,
  });
  const ledger = upsertModelResearchRecord({ records: [] }, record);
  assert.equal(ledger.records[0].status, "research_hold");
  assert.equal(ledger.automaticOperationsAllowed, false);
  assert.equal(upsertModelResearchRecord(ledger, record).records.length, 1);
  assert.throws(() => upsertModelResearchRecord(ledger, { ...record, status: "integration_review_ready" }), /conflict/);
});
