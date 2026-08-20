import { buildValidationFolds } from "./research-validation-layer.js";
import { researchDigest } from "./research-trial-registry.js";
import {
  appendQualityDaytradeFineTrial,
  hasExactQualityDaytradeFineTrial,
  QUALITY_DAYTRADE_FINE_REGISTRY_VERSION,
} from "./us-quality-daytrade-fine-registry-v1.js";

export const QUALITY_DAYTRADE_VALIDATION_LIFECYCLE_VERSION = "us-quality-daytrade-validation-lifecycle-v1";

const VALID_KINDS = new Set(["oos", "walk_forward", "regime_cost_stress", "final_holdout"]);

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} is required`);
  return value.trim();
}

function frozenCandidate(finePlan, candidate) {
  if (!finePlan || finePlan.contractVersion !== QUALITY_DAYTRADE_FINE_REGISTRY_VERSION || !Array.isArray(finePlan.candidates)) {
    throw new TypeError("valid frozen Fine plan is required");
  }
  const candidateId = requiredString(candidate?.candidateId, "candidate.candidateId");
  const parameterHash = requiredString(candidate?.parameterHash, "candidate.parameterHash");
  const match = finePlan.candidates.find((row) => row.candidateId === candidateId && row.parameterHash === parameterHash);
  if (!match) throw new Error("validation candidate must be frozen before OOS");
  return match;
}

function normalizeRegimes(values) {
  if (!Array.isArray(values) || values.length < 2) throw new TypeError("at least two preregistered regime labels are required");
  const rows = values.map((value, index) => requiredString(value, `regimeLabels[${index}]`).toUpperCase());
  if (new Set(rows).size !== rows.length) throw new Error("regime labels must be unique");
  return Object.freeze(rows);
}

function normalizeCostStress(values) {
  if (!Array.isArray(values) || values.length < 2) throw new TypeError("at least two cost-stress multipliers are required");
  const rows = values.map((value, index) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 1 || number > 10) throw new RangeError(`costStressMultipliers[${index}] must be between 1x and 10x`);
    return number;
  });
  if (new Set(rows).size !== rows.length) throw new Error("cost-stress multipliers must be unique");
  if (!rows.includes(1) || !rows.some((value) => value > 1)) throw new Error("cost stress must include baseline 1x and at least one stressed multiplier");
  return Object.freeze(rows.sort((left, right) => left - right));
}

function stageForKind(kind) {
  if (kind === "oos") return "oos";
  if (kind === "final_holdout") return "final_holdout";
  return "walk_forward";
}

function allSpecs(plan) {
  return Object.freeze([
    ...plan.oos,
    ...plan.walkForward,
    ...plan.regimeCostStress,
    plan.finalHoldout,
  ]);
}

function trialForSpec(registry, candidate, spec) {
  return registry.trials.find((trial) => (
    trial.candidateId === candidate.candidateId
    && trial.parameterHash === candidate.parameterHash
    && trial.stage === spec.stage
    && trial.metrics?.evaluationSliceId === spec.evaluationSliceId
  ));
}

function passed(registry, candidate, spec) {
  return trialForSpec(registry, candidate, spec)?.metrics?.passed === true;
}

function allPassed(registry, candidate, specs) {
  return specs.every((spec) => passed(registry, candidate, spec));
}

export function buildQualityDaytradeValidationLifecyclePlan({
  finePlan,
  candidate,
  records,
  foldOptions = {},
  regimeLabels,
  costStressMultipliers = [1, 1.25, 1.5, 2],
  finalHoldoutSliceId,
} = {}) {
  const frozen = frozenCandidate(finePlan, candidate);
  const regimes = normalizeRegimes(regimeLabels);
  const costs = normalizeCostStress(costStressMultipliers);
  const holdoutSlice = requiredString(finalHoldoutSliceId, "finalHoldoutSliceId");
  const folds = buildValidationFolds(records, foldOptions);
  if (!folds.length || folds.some((fold) => fold.leakFree !== true)) throw new Error("purged walk-forward folds must be leak-free");

  const oos = Object.freeze(folds.map((fold) => Object.freeze({
    kind: "oos",
    stage: "oos",
    fold: fold.fold,
    evaluationSliceId: `quality-daytrade:oos:fold-${fold.fold}`,
    recordCount: fold.outOfSample.length,
    splitDigest: researchDigest({ fold: fold.fold, report: fold.report, rows: fold.outOfSample }),
    report: fold.report,
  })));
  const walkForward = Object.freeze(folds.map((fold) => Object.freeze({
    kind: "walk_forward",
    stage: "walk_forward",
    fold: fold.fold,
    evaluationSliceId: `quality-daytrade:walk-forward:fold-${fold.fold}`,
    recordCount: fold.walkForwardTest.length,
    splitDigest: researchDigest({ fold: fold.fold, report: fold.report, rows: fold.walkForwardTest }),
    report: fold.report,
  })));
  const regimeCostStress = Object.freeze(regimes.flatMap((regime) => costs.map((costMultiplier) => Object.freeze({
    kind: "regime_cost_stress",
    stage: "walk_forward",
    regime,
    costMultiplier,
    evaluationSliceId: `quality-daytrade:regime-cost:${regime}:${costMultiplier}x`,
  }))));
  const finalHoldout = Object.freeze({
    kind: "final_holdout",
    stage: "final_holdout",
    evaluationSliceId: holdoutSlice,
  });

  const planCore = {
    fineExperimentId: finePlan.fineExperimentId,
    frozenPlanDigest: finePlan.frozenPlanDigest,
    candidateId: frozen.candidateId,
    parameterHash: frozen.parameterHash,
    oos: oos.map(({ evaluationSliceId, splitDigest }) => ({ evaluationSliceId, splitDigest })),
    walkForward: walkForward.map(({ evaluationSliceId, splitDigest }) => ({ evaluationSliceId, splitDigest })),
    regimeCostStress: regimeCostStress.map(({ evaluationSliceId, regime, costMultiplier }) => ({ evaluationSliceId, regime, costMultiplier })),
    finalHoldout,
  };

  return Object.freeze({
    contractVersion: QUALITY_DAYTRADE_VALIDATION_LIFECYCLE_VERSION,
    fineExperimentId: finePlan.fineExperimentId,
    frozenPlanDigest: finePlan.frozenPlanDigest,
    candidate: frozen,
    folds,
    oos,
    walkForward,
    regimeCostStress,
    finalHoldout,
    planDigest: researchDigest(planCore),
    candidateSelectionLockedBeforeOos: true,
    oosCanRetuneParameters: false,
    walkForwardCanRetuneParameters: false,
    regimeCostStressCanRetuneParameters: false,
    finalHoldoutCanRetuneParameters: false,
    finalHoldoutOneShot: true,
    paperCanRetuneParameters: false,
    shadowCanRetuneParameters: false,
    executionAuthority: "NONE",
    liveTradingAllowed: false,
    privateApiAllowed: false,
  });
}

function assertPlan(plan, finePlan, registry) {
  if (!plan || plan.contractVersion !== QUALITY_DAYTRADE_VALIDATION_LIFECYCLE_VERSION) throw new TypeError("valid validation lifecycle plan is required");
  if (plan.fineExperimentId !== finePlan?.fineExperimentId || plan.frozenPlanDigest !== finePlan?.frozenPlanDigest) {
    throw new Error("validation lifecycle / Fine plan identity mismatch");
  }
  if (!registry || registry.experimentId !== finePlan.fineExperimentId) throw new Error("validation lifecycle registry mismatch");
  if (registry.strategyIdentity?.familyFingerprint !== finePlan.strategyIdentity?.familyFingerprint) throw new Error("validation lifecycle strategy identity mismatch");
}

function findSpec(plan, kind, evaluationSliceId) {
  if (!VALID_KINDS.has(kind)) throw new RangeError(`unsupported validation kind: ${kind}`);
  const sliceId = requiredString(evaluationSliceId, "evaluationSliceId");
  const pool = kind === "oos"
    ? plan.oos
    : kind === "walk_forward"
      ? plan.walkForward
      : kind === "regime_cost_stress"
        ? plan.regimeCostStress
        : [plan.finalHoldout];
  const spec = pool.find((row) => row.evaluationSliceId === sliceId);
  if (!spec) throw new Error(`${kind} slice is outside the preregistered validation plan`);
  return spec;
}

function assertPrerequisites(plan, registry, kind) {
  const candidate = plan.candidate;
  if (kind !== "oos" && !allPassed(registry, candidate, plan.oos)) {
    throw new Error("all preregistered OOS slices must pass before later validation stages");
  }
  if ((kind === "regime_cost_stress" || kind === "final_holdout") && !allPassed(registry, candidate, plan.walkForward)) {
    throw new Error("all preregistered walk-forward slices must pass before regime/cost stress or Final Holdout");
  }
  if (kind === "final_holdout" && !allPassed(registry, candidate, plan.regimeCostStress)) {
    throw new Error("all preregistered regime/cost stress slices must pass before Final Holdout");
  }
  if (kind === "final_holdout" && registry.trials.some((trial) => (
    trial.candidateId === candidate.candidateId
    && trial.parameterHash === candidate.parameterHash
    && trial.stage === "final_holdout"
  ))) {
    throw new Error("Final Holdout is one-shot and has already been consumed for this frozen candidate");
  }
}

export function appendQualityDaytradeValidationEvidence({
  plan,
  finePlan,
  registry,
  kind,
  evaluationSliceId,
  returnSeries,
  passed: passedResult,
  metrics = {},
  startedAt = null,
  completedAt = null,
} = {}) {
  assertPlan(plan, finePlan, registry);
  const spec = findSpec(plan, kind, evaluationSliceId);
  if (typeof passedResult !== "boolean") throw new TypeError("passed must be an explicit boolean");
  assertPrerequisites(plan, registry, kind);
  if (hasExactQualityDaytradeFineTrial(finePlan, registry, {
    candidate: plan.candidate,
    stage: stageForKind(kind),
    evaluationSliceId: spec.evaluationSliceId,
  })) throw new Error("exact validation evidence already exists; rerun cannot create a second sample");

  const result = appendQualityDaytradeFineTrial(finePlan, registry, {
    candidate: plan.candidate,
    stage: stageForKind(kind),
    evaluationSliceId: spec.evaluationSliceId,
    returnSeries,
    selectionEligible: false,
    startedAt,
    completedAt,
    metrics: {
      ...metrics,
      passed: passedResult,
      validationKind: kind,
      validationPlanDigest: plan.planDigest,
      regime: spec.regime ?? null,
      costMultiplier: spec.costMultiplier ?? null,
      splitDigest: spec.splitDigest ?? null,
    },
  });
  return Object.freeze({
    ...result,
    lifecycle: summarizeQualityDaytradeValidationLifecycle(plan, result.registry),
  });
}

export function summarizeQualityDaytradeValidationLifecycle(plan, registry) {
  if (!plan || plan.contractVersion !== QUALITY_DAYTRADE_VALIDATION_LIFECYCLE_VERSION) throw new TypeError("valid validation lifecycle plan is required");
  if (!registry || registry.experimentId !== plan.fineExperimentId) throw new Error("validation lifecycle registry mismatch");
  const candidate = plan.candidate;
  const summarize = (specs) => Object.freeze({
    required: specs.length,
    recorded: specs.filter((spec) => trialForSpec(registry, candidate, spec)).length,
    passed: specs.filter((spec) => passed(registry, candidate, spec)).length,
    failed: specs.filter((spec) => trialForSpec(registry, candidate, spec)?.metrics?.passed === false).length,
  });
  const oos = summarize(plan.oos);
  const walkForward = summarize(plan.walkForward);
  const regimeCostStress = summarize(plan.regimeCostStress);
  const finalTrial = trialForSpec(registry, candidate, plan.finalHoldout);
  const readyForFinalHoldout = oos.passed === oos.required
    && walkForward.passed === walkForward.required
    && regimeCostStress.passed === regimeCostStress.required
    && finalTrial == null;
  return Object.freeze({
    planDigest: plan.planDigest,
    candidateId: candidate.candidateId,
    parameterHash: candidate.parameterHash,
    oos,
    walkForward,
    regimeCostStress,
    readyForFinalHoldout,
    finalHoldoutConsumed: finalTrial != null,
    finalHoldoutPassed: finalTrial?.metrics?.passed === true,
    validationComplete: finalTrial?.metrics?.passed === true,
    retuningAllowed: false,
    promotionAuthorityGranted: false,
    executionAuthority: "NONE",
  });
}
