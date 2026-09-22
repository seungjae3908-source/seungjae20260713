import test from "node:test";
import assert from "node:assert/strict";
import {
  appendQualityDaytradeTrial,
  buildQualityDaytradeExperimentPlan,
  hasExactQualityDaytradeTrial,
} from "../src/us-quality-daytrade-trial-registry-v1.js";

const SHA = "1234567890abcdef1234567890abcdef12345678";

function plan(overrides = {}) {
  return buildQualityDaytradeExperimentPlan({
    experimentId: "quality-daytrade-regression",
    researchCodeSha: SHA,
    datasetSnapshotHash: "dataset-snapshot-2026-08-20",
    timeframe: "5m",
    qualityTier: "A",
    catalystDay: false,
    session: "REGULAR",
    ...overrides,
  });
}

const RETURNS = Object.freeze([0.01, -0.005, 0.012, -0.003]);

test("coarse plan assigns 432 unique immutable candidate and parameter identities", () => {
  const result = plan();
  assert.equal(result.coarseCombinationCount, 432);
  assert.equal(new Set(result.candidates.map((row) => row.candidateId)).size, 432);
  assert.equal(new Set(result.candidates.map((row) => row.parameterHash)).size, 432);
  assert.equal(result.registry.strategyIdentity.market, "US_STOCK");
  assert.equal(result.registry.strategyIdentity.direction, "LONG");
  assert.equal(result.registry.safety.forwardEvidenceCanSelectCandidate, false);
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.liveTradingAllowed, false);
  assert.equal(result.privateApiAllowed, false);
});

test("tier, catalyst profile, and session are part of experiment identity instead of being silently mixed", () => {
  const regularA = plan();
  const premarketA = plan({ session: "PREMARKET" });
  const regularB = plan({ qualityTier: "B" });
  const catalystA = plan({ catalystDay: true });
  assert.notEqual(regularA.candidates[0].candidateId, premarketA.candidates[0].candidateId);
  assert.notEqual(regularA.candidates[0].candidateId, regularB.candidates[0].candidateId);
  assert.notEqual(regularA.candidates[0].candidateId, catalystA.candidates[0].candidateId);
  assert.notEqual(regularA.registry.strategyIdentity.familyFingerprint, regularB.registry.strategyIdentity.familyFingerprint);
});

test("same exact candidate stage and evaluation slice cannot be counted twice", () => {
  const initial = plan();
  const candidate = initial.candidates[0];
  const first = appendQualityDaytradeTrial(initial.registry, {
    candidate,
    stage: "development",
    evaluationSliceId: "coarse-2021-2024",
    returnSeries: RETURNS,
    metrics: { netExpectancy: 0.0035 },
    selectionEligible: true,
  });
  assert.equal(hasExactQualityDaytradeTrial(first.registry, {
    candidate,
    stage: "development",
    evaluationSliceId: "coarse-2021-2024",
  }), true);
  assert.throws(() => appendQualityDaytradeTrial(first.registry, {
    candidate,
    stage: "development",
    evaluationSliceId: "coarse-2021-2024",
    returnSeries: RETURNS,
    selectionEligible: true,
  }), /duplicate trialId/);
});

test("same candidate may progress to a distinct OOS or walk-forward slice without identity collision", () => {
  const initial = plan();
  const candidate = initial.candidates[0];
  const development = appendQualityDaytradeTrial(initial.registry, {
    candidate,
    stage: "development",
    evaluationSliceId: "coarse-2021-2023",
    returnSeries: RETURNS,
    selectionEligible: true,
  });
  const oos = appendQualityDaytradeTrial(development.registry, {
    candidate,
    stage: "oos",
    evaluationSliceId: "oos-2024",
    returnSeries: RETURNS,
    selectionEligible: true,
  });
  const walkForward = appendQualityDaytradeTrial(oos.registry, {
    candidate,
    stage: "walk_forward",
    evaluationSliceId: "wf-fold-1",
    returnSeries: RETURNS,
    selectionEligible: true,
  });
  assert.equal(walkForward.registry.trials.length, 3);
  assert.equal(walkForward.summary.selectionTrials, 3);
  assert.equal(walkForward.summary.selectionContamination, false);
});

test("final holdout, shadow, and paper evidence cannot select a candidate", () => {
  const initial = plan();
  const candidate = initial.candidates[0];
  for (const stage of ["final_holdout", "shadow", "paper"]) {
    assert.throws(() => appendQualityDaytradeTrial(initial.registry, {
      candidate,
      stage,
      evaluationSliceId: `${stage}-slice`,
      returnSeries: RETURNS,
      selectionEligible: true,
    }), /evidence cannot be used for candidate selection/);
  }
});

test("paper evidence can be recorded for audit when it is explicitly non-selecting", () => {
  const initial = plan();
  const candidate = initial.candidates[0];
  const paper = appendQualityDaytradeTrial(initial.registry, {
    candidate,
    stage: "paper",
    evaluationSliceId: "natural-forward-2026-08-20T14:30Z",
    returnSeries: RETURNS,
    metrics: { settled: true },
    selectionEligible: false,
  });
  assert.equal(paper.registry.trials.length, 1);
  assert.equal(paper.summary.selectionTrials, 0);
  assert.equal(paper.trial.stage, "paper");
  assert.equal(paper.trial.selectionEligible, false);
});

test("invalid mutable research code identity fails closed", () => {
  assert.throws(() => plan({ researchCodeSha: "main" }), /immutable 40-char SHA/);
});
