import test from "node:test";
import assert from "node:assert/strict";
import { createResearchTrialRegistry } from "../src/research-trial-registry.js";
import { QUALITY_DAYTRADE_FINE_REGISTRY_VERSION } from "../src/us-quality-daytrade-fine-registry-v1.js";
import {
  appendQualityDaytradeValidationEvidence,
  buildQualityDaytradeValidationLifecyclePlan,
  summarizeQualityDaytradeValidationLifecycle,
} from "../src/us-quality-daytrade-validation-lifecycle-v1.js";

function fixture() {
  const registry = createResearchTrialRegistry({
    experimentId: "quality-us:fine:test",
    identity: {
      strategyId: "US_QUALITY_DAYTRADE",
      strategyVersion: "v2",
      researchCodeSha: "a".repeat(40),
      datasetSnapshotHash: "dataset-pit-v1",
      market: "US_STOCK",
      timeframe: "5m",
      direction: "BUY",
    },
  });
  const candidate = Object.freeze({
    candidateId: "fine-A-normal-001",
    parameterHash: "param-hash-001",
    seedCandidateId: "coarse-A-normal-001",
    params: Object.freeze({ takeProfitPct: 3, fixedStopPct: 1.2, timeStopMinutes: 30, exitMode: "VWAP_OR_FIXED" }),
  });
  const finePlan = Object.freeze({
    contractVersion: QUALITY_DAYTRADE_FINE_REGISTRY_VERSION,
    fineExperimentId: registry.experimentId,
    frozenPlanDigest: "frozen-plan-digest-v1",
    strategyIdentity: registry.strategyIdentity,
    candidates: Object.freeze([candidate]),
  });
  const records = Object.freeze(Array.from({ length: 60 }, (_, index) => Object.freeze({
    id: `obs-${index + 1}`,
    anchorTimestamp: 1_000 + index * 100,
    futureEndTimestamp: 1_010 + index * 100,
  })));
  const plan = buildQualityDaytradeValidationLifecyclePlan({
    finePlan,
    candidate,
    records,
    foldOptions: { trainSize: 18, validationSize: 6, testSize: 6, stepSize: 6, embargoMs: 5 },
    regimeLabels: ["TREND", "CHOP"],
    costStressMultipliers: [1, 1.25, 1.5, 2],
    sensitivitySpecs: [
      { label: "TP_MINUS_10PCT", parameterOverrides: { takeProfitPct: 2.7 } },
      { label: "TP_PLUS_10PCT", parameterOverrides: { takeProfitPct: 3.3 } },
      { label: "STOP_MINUS_10PCT", parameterOverrides: { fixedStopPct: 1.08 } },
      { label: "STOP_PLUS_10PCT", parameterOverrides: { fixedStopPct: 1.32 } },
    ],
    finalHoldoutSliceId: "quality-daytrade:final-holdout:2026-v1",
  });
  return { registry, candidate, finePlan, plan, records };
}

function appendEvidence(state, kind, evaluationSliceId, passed = true) {
  return appendQualityDaytradeValidationEvidence({
    plan: state.plan,
    finePlan: state.finePlan,
    registry: state.registry,
    kind,
    evaluationSliceId,
    returnSeries: [0.01, -0.004, 0.012],
    passed,
    metrics: { expectancy: 0.006, profitFactor: 1.3, maximumDrawdown: 0.04 },
    startedAt: 1,
    completedAt: 2,
  });
}

function passAll(state, kind, specs) {
  let registry = state.registry;
  for (const spec of specs) {
    const result = appendEvidence({ ...state, registry }, kind, spec.evaluationSliceId, true);
    registry = result.registry;
  }
  return registry;
}

test("validation lifecycle freezes one Fine candidate before purged OOS and forbids retuning", () => {
  const { plan } = fixture();
  assert.ok(plan.folds.length > 0);
  assert.ok(plan.folds.every((fold) => fold.leakFree === true));
  assert.equal(plan.candidateSelectionLockedBeforeOos, true);
  assert.equal(plan.oosCanRetuneParameters, false);
  assert.equal(plan.walkForwardCanRetuneParameters, false);
  assert.equal(plan.regimeCostStressCanRetuneParameters, false);
  assert.equal(plan.sensitivityCanRetuneParameters, false);
  assert.equal(plan.sensitivityCanSelectParameters, false);
  assert.equal(plan.finalHoldoutCanRetuneParameters, false);
  assert.equal(plan.finalHoldoutOneShot, true);
  assert.equal(plan.regimeCostStress.length, 8);
  assert.equal(plan.sensitivityAnalysis.length, 4);
  assert.deepEqual([...new Set(plan.regimeCostStress.map((row) => row.costMultiplier))], [1, 1.25, 1.5, 2]);
  assert.deepEqual(plan.sensitivityAnalysis.map((row) => row.label), [
    "TP_MINUS_10PCT",
    "TP_PLUS_10PCT",
    "STOP_MINUS_10PCT",
    "STOP_PLUS_10PCT",
  ]);
  assert.equal(plan.executionAuthority, "NONE");
  assert.equal(plan.liveTradingAllowed, false);
});

test("walk-forward cannot run before every preregistered OOS slice passes", () => {
  const state = fixture();
  assert.throws(
    () => appendEvidence(state, "walk_forward", state.plan.walkForward[0].evaluationSliceId, true),
    /OOS slices must pass/,
  );
  const failed = appendEvidence(state, "oos", state.plan.oos[0].evaluationSliceId, false);
  assert.throws(
    () => appendEvidence({ ...state, registry: failed.registry }, "walk_forward", state.plan.walkForward[0].evaluationSliceId, true),
    /OOS slices must pass/,
  );
});

test("Final Holdout opens only after OOS, walk-forward, regime/cost stress and sensitivity all pass", () => {
  const state = fixture();
  let registry = passAll(state, "oos", state.plan.oos);
  registry = passAll({ ...state, registry }, "walk_forward", state.plan.walkForward);

  assert.throws(
    () => appendEvidence({ ...state, registry }, "final_holdout", state.plan.finalHoldout.evaluationSliceId, true),
    /regime\/cost stress slices must pass/,
  );

  registry = passAll({ ...state, registry }, "regime_cost_stress", state.plan.regimeCostStress);
  assert.throws(
    () => appendEvidence({ ...state, registry }, "final_holdout", state.plan.finalHoldout.evaluationSliceId, true),
    /sensitivity analysis slices must pass/,
  );

  registry = passAll({ ...state, registry }, "sensitivity_analysis", state.plan.sensitivityAnalysis);
  const before = summarizeQualityDaytradeValidationLifecycle(state.plan, registry);
  assert.equal(before.sensitivityAnalysis.passed, state.plan.sensitivityAnalysis.length);
  assert.equal(before.readyForFinalHoldout, true);
  assert.equal(before.finalHoldoutConsumed, false);

  const holdout = appendEvidence({ ...state, registry }, "final_holdout", state.plan.finalHoldout.evaluationSliceId, true);
  assert.equal(holdout.trial.stage, "final_holdout");
  assert.equal(holdout.trial.selectionEligible, false);
  assert.equal(holdout.trial.metrics.validationKind, "final_holdout");
  assert.equal(holdout.lifecycle.validationComplete, true);
  assert.equal(holdout.lifecycle.promotionAuthorityGranted, false);
  assert.equal(holdout.lifecycle.executionAuthority, "NONE");

  assert.throws(
    () => appendEvidence({ ...state, registry: holdout.registry }, "final_holdout", state.plan.finalHoldout.evaluationSliceId, true),
    /one-shot/,
  );
});

test("regime/cost stress requires every walk-forward slice and cannot tune Fine parameters", () => {
  const state = fixture();
  let registry = passAll(state, "oos", state.plan.oos);
  const firstWalk = appendEvidence({ ...state, registry }, "walk_forward", state.plan.walkForward[0].evaluationSliceId, true);
  registry = firstWalk.registry;
  assert.throws(
    () => appendEvidence({ ...state, registry }, "regime_cost_stress", state.plan.regimeCostStress[0].evaluationSliceId, true),
    /walk-forward slices must pass/,
  );

  registry = passAll({ ...state, registry }, "walk_forward", state.plan.walkForward.slice(1));
  const stress = appendEvidence({ ...state, registry }, "regime_cost_stress", state.plan.regimeCostStress[0].evaluationSliceId, true);
  assert.equal(stress.trial.stage, "walk_forward");
  assert.equal(stress.trial.selectionEligible, false);
  assert.equal(stress.trial.metrics.validationKind, "regime_cost_stress");
  assert.equal(stress.trial.metrics.costMultiplier, 1);
  assert.equal(stress.lifecycle.retuningAllowed, false);
});

test("sensitivity analysis is preregistered, one-factor-at-a-time, and cannot tune/select parameters", () => {
  const state = fixture();
  let registry = passAll(state, "oos", state.plan.oos);
  assert.throws(
    () => appendEvidence({ ...state, registry }, "sensitivity_analysis", state.plan.sensitivityAnalysis[0].evaluationSliceId, true),
    /walk-forward slices must pass/,
  );
  registry = passAll({ ...state, registry }, "walk_forward", state.plan.walkForward);
  const sensitivity = appendEvidence({ ...state, registry }, "sensitivity_analysis", state.plan.sensitivityAnalysis[0].evaluationSliceId, true);
  assert.equal(sensitivity.trial.stage, "walk_forward");
  assert.equal(sensitivity.trial.selectionEligible, false);
  assert.equal(sensitivity.trial.metrics.validationKind, "sensitivity_analysis");
  assert.equal(sensitivity.trial.metrics.sensitivityLabel, "TP_MINUS_10PCT");
  assert.deepEqual(sensitivity.trial.metrics.sensitivityParameterOverrides, { takeProfitPct: 2.7 });
  assert.equal(sensitivity.lifecycle.retuningAllowed, false);
});

test("sensitivity plan rejects post-hoc or invalid perturbation definitions", () => {
  const state = fixture();
  const base = {
    finePlan: state.finePlan,
    candidate: state.candidate,
    records: state.records,
    foldOptions: { trainSize: 18, validationSize: 6, testSize: 6, stepSize: 6, embargoMs: 5 },
    regimeLabels: ["TREND", "CHOP"],
    finalHoldoutSliceId: "quality-daytrade:final-holdout:2026-v1",
  };
  assert.throws(
    () => buildQualityDaytradeValidationLifecyclePlan({
      ...base,
      sensitivitySpecs: [
        { label: "NO_CHANGE", parameterOverrides: { takeProfitPct: 3 } },
        { label: "TP_PLUS", parameterOverrides: { takeProfitPct: 3.3 } },
      ],
    }),
    /must differ from the frozen baseline/,
  );
  assert.throws(
    () => buildQualityDaytradeValidationLifecyclePlan({
      ...base,
      sensitivitySpecs: [
        { label: "UNKNOWN", parameterOverrides: { unknownParam: 1 } },
        { label: "TP_PLUS", parameterOverrides: { takeProfitPct: 3.3 } },
      ],
    }),
    /outside the frozen candidate/,
  );
  assert.throws(
    () => buildQualityDaytradeValidationLifecyclePlan({
      ...base,
      sensitivitySpecs: [
        { label: "MULTI", parameterOverrides: { takeProfitPct: 2.7, fixedStopPct: 1.08 } },
        { label: "TP_PLUS", parameterOverrides: { takeProfitPct: 3.3 } },
      ],
    }),
    /exactly one frozen numeric parameter/,
  );
});
