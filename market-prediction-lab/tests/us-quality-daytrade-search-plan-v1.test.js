import test from "node:test";
import assert from "node:assert/strict";
import {
  appendQualityDaytradeTrial,
  buildQualityDaytradeExperimentPlan,
} from "../src/us-quality-daytrade-trial-registry-v1.js";
import { buildQualityDaytradeCoarseNarrowFinePlan } from "../src/us-quality-daytrade-search-plan-v1.js";

const RESEARCH_SHA = "0123456789abcdef0123456789abcdef01234567";

function experimentPlan() {
  return buildQualityDaytradeExperimentPlan({
    experimentId: "quality-daytrade-search-test",
    researchCodeSha: RESEARCH_SHA,
    datasetSnapshotHash: "dataset-snapshot-2026-08-20",
    timeframe: "5m",
    qualityTier: "A",
    catalystDay: false,
    session: "REGULAR",
  });
}

function policy(overrides = {}) {
  return {
    policyVersion: "quality-search-test-v1",
    minSlicesPerStage: 1,
    minTotalTrades: 40,
    minCostAdjustedNetExpectancy: 0,
    minProfitFactor: 1.05,
    maxDrawdownPct: 15,
    maxTailLossPct: 5,
    narrowLimit: 3,
    fineTakeProfitStepPct: 0.25,
    fineStopStepPct: 0.2,
    fineRadiusSteps: 1,
    maxFineCandidates: 20,
    ...overrides,
  };
}

function metrics(overrides = {}) {
  return {
    costAdjustedNetExpectancy: 0.003,
    profitFactor: 1.4,
    maxDrawdownPct: 8,
    tailLossPct: 2.5,
    tradeCount: 30,
    ...overrides,
  };
}

function appendSlice(registry, candidate, stage, slice, metricOverrides = {}, selectionEligible = true) {
  return appendQualityDaytradeTrial(registry, {
    candidate,
    stage,
    evaluationSliceId: slice,
    returnSeries: [0.01, -0.005, 0.008, 0.002],
    metrics: metrics(metricOverrides),
    selectionEligible,
  }).registry;
}

function appendDevelopmentValidation(registry, candidate, metricOverrides = {}) {
  let next = appendSlice(registry, candidate, "development", `${candidate.candidateId}:dev`, metricOverrides);
  next = appendSlice(next, candidate, "validation", `${candidate.candidateId}:val`, metricOverrides);
  return next;
}

test("coarse-to-narrow search fails closed when no development/validation evidence exists", () => {
  const plan = experimentPlan();
  const result = buildQualityDaytradeCoarseNarrowFinePlan({
    experimentPlan: plan,
    registry: plan.registry,
    policy: policy(),
  });
  assert.equal(result.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(result.coarseCandidateCount, 432);
  assert.equal(result.evaluatedCandidateCount, 0);
  assert.equal(result.narrowCandidateCount, 0);
  assert.equal(result.fineCandidateCount, 0);
  assert.equal(result.paperEvidenceCanTuneSearch, false);
  assert.equal(result.finalHoldoutEvidenceCanTuneSearch, false);
  assert.equal(result.executionAuthority, "NONE");
});

test("narrowing prefers cost-adjusted robust evidence and rejects gross-looking but cost-negative candidates", () => {
  const plan = experimentPlan();
  const good = plan.candidates.find((candidate) => candidate.params.takeProfitPct === 3 && candidate.params.fixedStopPct === 1.2 && candidate.params.timeStopMinutes === 30 && candidate.params.exitMode === "FIXED");
  const costNegative = plan.candidates.find((candidate) => candidate.params.takeProfitPct === 5 && candidate.params.fixedStopPct === 2 && candidate.params.timeStopMinutes === 30 && candidate.params.exitMode === "FIXED");
  assert.ok(good);
  assert.ok(costNegative);

  let registry = appendDevelopmentValidation(plan.registry, good, {
    costAdjustedNetExpectancy: 0.004,
    profitFactor: 1.5,
    maxDrawdownPct: 7,
    tailLossPct: 2,
  });
  registry = appendDevelopmentValidation(registry, costNegative, {
    costAdjustedNetExpectancy: -0.001,
    profitFactor: 1.8,
    maxDrawdownPct: 6,
    tailLossPct: 1.8,
  });

  const result = buildQualityDaytradeCoarseNarrowFinePlan({ experimentPlan: plan, registry, policy: policy() });
  assert.equal(result.status, "READY_FOR_FINE");
  assert.equal(result.narrowCandidates[0].candidate.candidateId, good.candidateId);
  const rejected = result.rejectedCandidates.find((row) => row.candidate.candidateId === costNegative.candidateId);
  assert.ok(rejected);
  assert.ok(rejected.blockers.includes("COST_ADJUSTED_EXPECTANCY_BELOW_POLICY"));
});

test("OOS or walk-forward evidence cannot tune coarse/narrow search", () => {
  const plan = experimentPlan();
  const candidate = plan.candidates[0];
  const registry = appendSlice(plan.registry, candidate, "oos", "oos-001", {}, true);
  assert.throws(
    () => buildQualityDaytradeCoarseNarrowFinePlan({ experimentPlan: plan, registry, policy: policy() }),
    /oos evidence cannot tune coarse\/narrow search/,
  );
});

test("fine search expands only around narrow winners, stays bounded, and never duplicates coarse parameters", () => {
  const plan = experimentPlan();
  const seed = plan.candidates.find((candidate) => candidate.params.takeProfitPct === 3 && candidate.params.fixedStopPct === 2 && candidate.params.timeStopMinutes === 60 && candidate.params.exitMode === "VWAP_OR_FIXED");
  assert.ok(seed);
  const registry = appendDevelopmentValidation(plan.registry, seed);
  const result = buildQualityDaytradeCoarseNarrowFinePlan({
    experimentPlan: plan,
    registry,
    policy: policy({ narrowLimit: 1, maxFineCandidates: 8 }),
  });

  assert.equal(result.narrowCandidateCount, 1);
  assert.ok(result.fineCandidateCount > 0);
  assert.ok(result.fineCandidateCount <= 8);
  const coarseHashes = new Set(plan.candidates.map((candidate) => candidate.parameterHash));
  const fineHashes = new Set(result.fineCandidates.map((candidate) => candidate.parameterHash));
  assert.equal(fineHashes.size, result.fineCandidateCount);
  for (const candidate of result.fineCandidates) {
    assert.equal(coarseHashes.has(candidate.parameterHash), false);
    assert.equal(candidate.seedCandidateId, seed.candidateId);
    assert.ok(candidate.params.takeProfitPct >= 1 && candidate.params.takeProfitPct <= 5);
    assert.ok(candidate.params.fixedStopPct >= 0.8 && candidate.params.fixedStopPct <= 4);
  }
});

test("insufficient sample, drawdown, PF, and tail-loss blockers remain explicit", () => {
  const plan = experimentPlan();
  const candidate = plan.candidates[1];
  const registry = appendDevelopmentValidation(plan.registry, candidate, {
    tradeCount: 5,
    profitFactor: 0.9,
    maxDrawdownPct: 20,
    tailLossPct: 7,
  });
  const result = buildQualityDaytradeCoarseNarrowFinePlan({ experimentPlan: plan, registry, policy: policy() });
  const rejected = result.rejectedCandidates.find((row) => row.candidate.candidateId === candidate.candidateId);
  assert.ok(rejected);
  assert.ok(rejected.blockers.includes("INSUFFICIENT_TRADES"));
  assert.ok(rejected.blockers.includes("PROFIT_FACTOR_BELOW_POLICY"));
  assert.ok(rejected.blockers.includes("DRAWDOWN_ABOVE_POLICY"));
  assert.ok(rejected.blockers.includes("TAIL_LOSS_ABOVE_POLICY"));
  assert.equal(result.status, "INSUFFICIENT_EVIDENCE");
});
