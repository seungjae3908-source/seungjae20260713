import test from "node:test";
import assert from "node:assert/strict";
import { calibrateEmpiricalPromotionPolicy } from "../src/empirical-promotion-policy.js";
import { calibrateEmpiricalLifecyclePolicy, evaluateStrategyLifecycle } from "../src/strategy-lifecycle.js";
import { evaluateChampionChallenger } from "../src/champion-challenger.js";
import { evaluateResearchCapitalAllocation } from "../src/capital-allocation-risk.js";
import { estimateEmpiricalExecutionCapacity } from "../src/capacity-impact.js";
import { evaluateRealityCheckAndSpa } from "../src/spa-reality-check.js";

function promotionCalibrationRow(index, pass) {
  return {
    cohortId: "cohort-v1",
    calibrationRole: "PROMOTION_POLICY_CALIBRATION",
    frozenBeforeOutcome: true,
    usedForCandidateTuning: false,
    outcome: pass ? "PASS" : "FAIL",
    selectionBias: {
      trialCount: pass ? 80 + index : 15 + index,
      pbo: pass ? 0.15 + index * 0.002 : 0.65 + index * 0.002,
      dsrProbability: pass ? 0.9 - index * 0.002 : 0.3 - index * 0.002,
    },
    backtest: {
      oosTrades: pass ? 120 + index : 20 + index,
      walkForwardWindows: pass ? 12 + index : 3 + index,
    },
    shadow: {
      settled: pass ? 100 + index : 10 + index,
      elapsedMs: pass ? 30_000 + index : 2_000 + index,
    },
    paper: {
      settledTrades: pass ? 90 + index : 8 + index,
      profitFactor: pass ? 1.7 + index * 0.01 : 0.8 + index * 0.01,
      expectancyCiLower: pass ? 0.002 + index * 0.0001 : -0.01 + index * 0.0001,
      maximumDrawdown: pass ? 0.08 + index * 0.001 : 0.35 + index * 0.001,
    },
  };
}

test("empirical promotion policy learns all unified gate thresholds from a labeled calibration cohort", () => {
  const rows = [
    ...Array.from({ length: 8 }, (_, i) => promotionCalibrationRow(i, true)),
    ...Array.from({ length: 8 }, (_, i) => promotionCalibrationRow(i, false)),
  ];
  const policy = calibrateEmpiricalPromotionPolicy(rows, {
    cohortId: "cohort-v1",
    minimumPositiveStrategies: 5,
    minimumNegativeStrategies: 5,
  });
  assert.equal(policy.status, "empirically_calibrated");
  for (const key of [
    "minTrials", "maxPbo", "minDsrProbability", "minOosTrades", "minWalkForwardWindows",
    "minShadowSettled", "minShadowElapsedMs", "minPaperSettled", "minPaperProfitFactor",
    "minPaperExpectancyCiLower", "maxPaperMdd",
  ]) assert.equal(Number.isFinite(policy[key]), true, key);
  assert.ok(policy.maxPbo < 0.65);
  assert.ok(policy.minDsrProbability > 0.3);
  assert.equal(policy.safety.currentCandidateForwardEvidenceUsed, false);
});

function lifecycleEpisode(index, healthy) {
  return {
    cohortId: "life-v1",
    calibrationRole: "LIFECYCLE_POLICY_CALIBRATION",
    frozenBeforeOutcome: true,
    usedForCandidateTuning: false,
    outcome: healthy ? "HEALTHY" : "DEGRADED",
    expectancyRatio: healthy ? 0.95 + index * 0.01 : 0.3 + index * 0.01,
    profitFactorRatio: healthy ? 0.9 + index * 0.01 : 0.35 + index * 0.01,
    drawdownRatio: healthy ? 1.05 + index * 0.01 : 2.0 + index * 0.05,
    directionalQualityRatio: healthy ? 0.9 + index * 0.01 : 0.4 + index * 0.01,
    ksStatistic: healthy ? 0.08 + index * 0.005 : 0.45 + index * 0.01,
    degradedRunLength: healthy ? index % 2 : 3 + index,
  };
}

test("strategy decay policy is empirical and demotes a degraded champion without live authority", () => {
  const episodes = [
    ...Array.from({ length: 6 }, (_, i) => lifecycleEpisode(i, true)),
    ...Array.from({ length: 6 }, (_, i) => lifecycleEpisode(i, false)),
  ];
  const policy = calibrateEmpiricalLifecyclePolicy(episodes, {
    cohortId: "life-v1",
    minimumHealthyEpisodes: 4,
    minimumDegradedEpisodes: 4,
    minimumRecentReturnSamples: 5,
  });
  assert.equal(policy.status, "empirically_calibrated");
  const result = evaluateStrategyLifecycle({
    strategyFingerprint: "champion-v1",
    baseline: { paperExpectancy: 0.01, paperProfitFactor: 1.8, paperMaximumDrawdown: 0.08, shadowDirectionalQuality: 0.6 },
    current: { paperExpectancy: 0.003, paperProfitFactor: 0.9, paperMaximumDrawdown: 0.2, shadowDirectionalQuality: 0.25, neutralCollapse: false, lineageValid: true },
    baselineReturnSamples: [0.01, 0.02, 0.015, 0.01, 0.018, 0.013],
    recentReturnSamples: [-0.02, -0.015, 0, -0.01, -0.03, -0.005],
    consecutiveDegradedWindows: 1,
    previousState: "CHAMPION",
    policy,
  });
  assert.equal(result.state, "WATCH");
  assert.equal(result.action, "DEMOTE_TO_WATCH");
  assert.equal(result.safety.automaticReplacementAllowed, false);
});

test("champion-challenger requires promotion readiness and positive paired superiority CI", () => {
  const policy = { status: "empirically_calibrated", minimumPairedSamples: 20, superiorityConfidence: 0.95, bootstrapIterations: 500, blockLength: 4, seed: 42 };
  const championReturns = Array.from({ length: 40 }, (_, i) => 0.005 + (i % 3) * 0.0005);
  const challengerReturns = championReturns.map((value) => value + 0.004);
  const result = evaluateChampionChallenger({
    champion: { strategyFingerprint: "champion", netReturnSamples: championReturns, lifecycleAssessment: { state: "WATCH" } },
    challengers: [{ strategyFingerprint: "challenger", netReturnSamples: challengerReturns, promotionAssessment: { status: "PROMOTION_REVIEW_READY", strategyFingerprint: "challenger" } }],
    policy,
  });
  assert.equal(result.decision, "SWAP_REVIEW_READY");
  assert.equal(result.recommendedChallengerFingerprint, "challenger");
  assert.equal(result.safety.automaticSwapAllowed, false);
});

test("capital allocator keeps explicit cash and caps ruin risk using research-only return evidence", () => {
  const policy = { status: "empirically_calibrated", maxStrategyWeight: 0.7, expectedShortfallAlpha: 0.2, maxRuinProbability: 0.05, ruinThreshold: 0.7, paths: 300, horizon: 50, blockLength: 3, seed: 7 };
  const returnsA = Array.from({ length: 60 }, (_, i) => 0.004 + (i % 5 === 0 ? -0.003 : 0.001));
  const returnsB = Array.from({ length: 60 }, (_, i) => 0.003 + (i % 7 === 0 ? -0.002 : 0.0005));
  const promoted = (id, samples) => ({ strategyFingerprint: id, netReturnSamples: samples, promotionAssessment: { status: "PROMOTION_REVIEW_READY" }, lifecycleAssessment: { state: "CHAMPION" } });
  const result = evaluateResearchCapitalAllocation({ strategies: [promoted("a", returnsA), promoted("b", returnsB)], policy });
  assert.equal(result.status, "ALLOCATION_REVIEW_READY");
  assert.ok(result.grossExposure > 0 && result.grossExposure <= 1);
  assert.ok(result.cashWeight >= 0);
  assert.equal(result.safety.capitalMutationAllowed, false);
});

test("capital allocator never renormalizes past a per-strategy cap and leaves the remainder in cash", () => {
  const policy = { status: "empirically_calibrated", maxStrategyWeight: 0.4, expectedShortfallAlpha: 0.2, maxRuinProbability: 0.05, ruinThreshold: 0.7, paths: 300, horizon: 50, blockLength: 3, seed: 13 };
  const returnsA = Array.from({ length: 60 }, (_, i) => 0.004 + (i % 5 === 0 ? -0.003 : 0.001));
  const returnsB = Array.from({ length: 60 }, (_, i) => 0.003 + (i % 7 === 0 ? -0.002 : 0.0005));
  const promoted = (id, samples) => ({ strategyFingerprint: id, netReturnSamples: samples, promotionAssessment: { status: "PROMOTION_REVIEW_READY" }, lifecycleAssessment: { state: "CHAMPION" } });
  const result = evaluateResearchCapitalAllocation({ strategies: [promoted("a", returnsA), promoted("b", returnsB)], policy });
  assert.equal(result.status, "ALLOCATION_REVIEW_READY");
  assert.ok(Object.values(result.weights).every((value) => value <= 0.4 + 1e-12));
  assert.ok(result.baseGrossExposure <= 0.8 + 1e-12);
  assert.ok(result.grossExposure <= result.baseGrossExposure + 1e-12);
  assert.ok(result.cashWeight >= 0.2 - 1e-12);
});

test("capacity model refuses public/simulated book data and only fits real execution impact", () => {
  const policy = { status: "empirically_calibrated", minimumRealExecutions: 20, minimumParticipationBuckets: 4, participationBucketCount: 5, edgeSafetyMarginBps: 2, minimumRSquared: 0.7 };
  const notReady = estimateEmpiricalExecutionCapacity({
    observations: Array.from({ length: 30 }, (_, i) => ({ realExecutionObserved: false, preOrderSnapshotFrozen: true, postTradeMeasurementComplete: true, participationRate: 0.001 + i * 0.001, implementationShortfallBps: 1 })),
    expectedNetEdgeBps: 20, advNotional: 1_000_000, policy,
  });
  assert.equal(notReady.status, "NOT_READY");
  assert.equal(notReady.permanentImpactAvailable, false);
  const observations = Array.from({ length: 40 }, (_, i) => {
    const participationRate = 0.001 + i * 0.002;
    return { realExecutionObserved: true, preOrderSnapshotFrozen: true, postTradeMeasurementComplete: true, usedForModelTuning: false, participationRate, implementationShortfallBps: 1 + 30 * Math.sqrt(participationRate) };
  });
  const ready = estimateEmpiricalExecutionCapacity({ observations, expectedNetEdgeBps: 20, advNotional: 1_000_000, policy });
  assert.equal(ready.status, "CAPACITY_REVIEW_READY");
  assert.ok(ready.maxNotional > 0);
  assert.equal(ready.model.extrapolationAllowed, false);
});

test("Reality Check and SPA reject the no-superior-strategy null for a persistent edge", () => {
  const policy = { status: "empirically_calibrated", bootstrapIterations: 500, blockLength: 4, seed: 11, alpha: 0.05 };
  const n = 80;
  const strong = Array.from({ length: n }, (_, i) => 0.01 + (i % 4) * 0.0003);
  const noise = Array.from({ length: n }, (_, i) => (i % 2 ? 0.0002 : -0.0002));
  const result = evaluateRealityCheckAndSpa({ strategyReturns: { strong, noise }, benchmarkReturns: Array(n).fill(0), policy });
  assert.equal(result.status, "EVIDENCE_READY");
  assert.equal(result.realityCheck.rejectsNoSuperiorStrategyNull, true);
  assert.equal(result.spa.rejectsNoSuperiorStrategyNull, true);
  assert.equal(result.safety.promotionAuthority, false);
});
