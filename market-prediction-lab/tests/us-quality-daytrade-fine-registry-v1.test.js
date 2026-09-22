import test from "node:test";
import assert from "node:assert/strict";
import {
  appendQualityDaytradeTrial,
  buildQualityDaytradeExperimentPlan,
} from "../src/us-quality-daytrade-trial-registry-v1.js";
import { buildQualityDaytradeCoarseNarrowFinePlan } from "../src/us-quality-daytrade-search-plan-v1.js";
import {
  appendQualityDaytradeFineTrial,
  buildQualityDaytradeFineExperimentPlan,
  hasExactQualityDaytradeFineTrial,
} from "../src/us-quality-daytrade-fine-registry-v1.js";

const RESEARCH_SHA = "0123456789abcdef0123456789abcdef01234567";

function coarsePlan() {
  return buildQualityDaytradeExperimentPlan({
    experimentId: "quality-fine-registry-test",
    researchCodeSha: RESEARCH_SHA,
    datasetSnapshotHash: "dataset-snapshot-frozen-v1",
    timeframe: "5m",
    qualityTier: "B",
    catalystDay: false,
    session: "REGULAR",
  });
}

function searchPolicy() {
  return {
    policyVersion: "fine-registry-search-v1",
    minSlicesPerStage: 1,
    minTotalTrades: 20,
    minCostAdjustedNetExpectancy: 0,
    minProfitFactor: 1.05,
    maxDrawdownPct: 20,
    maxTailLossPct: 8,
    narrowLimit: 1,
    fineTakeProfitStepPct: 0.25,
    fineStopStepPct: 0.25,
    fineRadiusSteps: 1,
    maxFineCandidates: 8,
  };
}

function appendSelectionSlice(registry, candidate, stage) {
  return appendQualityDaytradeTrial(registry, {
    candidate,
    stage,
    evaluationSliceId: `${candidate.candidateId}:${stage}`,
    returnSeries: [0.01, -0.004, 0.008, 0.003],
    metrics: {
      costAdjustedNetExpectancy: 0.004,
      profitFactor: 1.5,
      maxDrawdownPct: 7,
      tailLossPct: 2.5,
      tradeCount: 25,
    },
    selectionEligible: true,
  }).registry;
}

function readyFinePlan() {
  const experimentPlan = coarsePlan();
  const seed = experimentPlan.candidates.find((candidate) => candidate.params.takeProfitPct === 3 && candidate.params.fixedStopPct === 2 && candidate.params.timeStopMinutes === 60 && candidate.params.exitMode === "VWAP_OR_FIXED");
  assert.ok(seed);
  let coarseRegistry = appendSelectionSlice(experimentPlan.registry, seed, "development");
  coarseRegistry = appendSelectionSlice(coarseRegistry, seed, "validation");
  const searchPlan = buildQualityDaytradeCoarseNarrowFinePlan({ experimentPlan, registry: coarseRegistry, policy: searchPolicy() });
  assert.equal(searchPlan.status, "READY_FOR_FINE");
  return { experimentPlan, coarseRegistry, searchPlan };
}

test("fine plan freezes search output into the canonical registry with the same strategy family identity", () => {
  const { experimentPlan, coarseRegistry, searchPlan } = readyFinePlan();
  const finePlan = buildQualityDaytradeFineExperimentPlan({ experimentPlan, coarseRegistry, searchPlan });
  assert.equal(finePlan.strategyIdentity.familyFingerprint, coarseRegistry.strategyIdentity.familyFingerprint);
  assert.equal(finePlan.fineCandidateCount, searchPlan.fineCandidateCount);
  assert.equal(finePlan.parentSearchPlanDigest, searchPlan.planDigest);
  assert.equal(finePlan.oosCanRetuneFineParameters, false);
  assert.equal(finePlan.walkForwardCanRetuneFineParameters, false);
  assert.equal(finePlan.finalHoldoutCanRetuneFineParameters, false);
  assert.equal(finePlan.executionAuthority, "NONE");
});

test("fine plan is deterministic for the same immutable coarse registry and search plan", () => {
  const inputs = readyFinePlan();
  const left = buildQualityDaytradeFineExperimentPlan(inputs);
  const right = buildQualityDaytradeFineExperimentPlan(inputs);
  assert.equal(left.fineExperimentId, right.fineExperimentId);
  assert.equal(left.candidateManifestDigest, right.candidateManifestDigest);
  assert.equal(left.frozenPlanDigest, right.frozenPlanDigest);
});

test("fine registry records exact trials once and rejects duplicate reruns", () => {
  const inputs = readyFinePlan();
  const finePlan = buildQualityDaytradeFineExperimentPlan(inputs);
  const candidate = finePlan.candidates[0];
  const payload = {
    candidate,
    stage: "development",
    evaluationSliceId: "fine-dev-001",
    returnSeries: [0.01, -0.003, 0.007],
    metrics: { tradeCount: 20 },
    selectionEligible: true,
  };
  const recorded = appendQualityDaytradeFineTrial(finePlan, finePlan.registry, payload);
  assert.equal(hasExactQualityDaytradeFineTrial(finePlan, recorded.registry, payload), true);
  assert.throws(() => appendQualityDaytradeFineTrial(finePlan, recorded.registry, payload), /duplicate trialId/);
});

test("candidate outside the frozen fine manifest is rejected", () => {
  const inputs = readyFinePlan();
  const finePlan = buildQualityDaytradeFineExperimentPlan(inputs);
  assert.throws(() => appendQualityDaytradeFineTrial(finePlan, finePlan.registry, {
    candidate: { candidateId: "invented", parameterHash: "invented" },
    stage: "development",
    evaluationSliceId: "invented-dev",
    returnSeries: [0.01, -0.01],
    selectionEligible: true,
  }), /outside the frozen fine manifest/);
});

test("OOS, walk-forward, final holdout, shadow and Paper may be recorded for evidence but cannot retune frozen fine parameters", () => {
  const inputs = readyFinePlan();
  const finePlan = buildQualityDaytradeFineExperimentPlan(inputs);
  const candidate = finePlan.candidates[0];
  for (const stage of ["oos", "walk_forward", "final_holdout", "shadow", "paper"]) {
    assert.throws(() => appendQualityDaytradeFineTrial(finePlan, finePlan.registry, {
      candidate,
      stage,
      evaluationSliceId: `${stage}-select`,
      returnSeries: [0.01, -0.004],
      selectionEligible: true,
    }), /cannot retune frozen fine parameters/);
  }

  const recorded = appendQualityDaytradeFineTrial(finePlan, finePlan.registry, {
    candidate,
    stage: "oos",
    evaluationSliceId: "oos-audit-001",
    returnSeries: [0.01, -0.004, 0.006],
    metrics: { tradeCount: 30, costAdjustedNetExpectancy: 0.002 },
    selectionEligible: false,
  });
  assert.equal(recorded.trial.stage, "oos");
  assert.equal(recorded.trial.selectionEligible, false);
});
