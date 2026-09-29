import assert from "node:assert/strict";
import test from "node:test";

import {
  PRE_HOLDOUT_COST_POLICY_VERSION,
  PRE_HOLDOUT_DECISION_POLICY_VERSION,
  createPreHoldoutCostEvidence,
  createPreHoldoutDecisionPolicy,
  redactFinalHoldoutRows,
  runPreHoldoutProfitabilityGate,
} from "../src/pre-holdout-profitability-gate-v1.js";

function months(start, end) {
  const result = [];
  let current = start;
  while (current <= end) {
    result.push(current);
    const year = Number(current.slice(0, 4));
    const month = Number(current.slice(4, 6));
    current = month === 12 ? `${year + 1}01` : `${year}${String(month + 1).padStart(2, "0")}`;
  }
  return result;
}

function fixtureData(holdoutShiftPct = 0) {
  const periods = months("199011", "202112");
  const rows = periods.map((period, index) => {
    const smallLoser = -0.8 + (1.4 * Math.sin(index / 7));
    const smallWinner = smallLoser + 0.75 + (1.0 * Math.cos(index / 5));
    const bigLoser = -0.5 + (1.2 * Math.cos(index / 11));
    const bigWinner = bigLoser + 0.35 + (0.9 * Math.sin(index / 9));
    const holdoutShift = period >= "202101" ? holdoutShiftPct : 0;
    const wml = 0.5 * ((smallWinner - smallLoser) + (bigWinner - bigLoser)) + holdoutShift;
    return { period, smallLoser, smallWinner: smallWinner + holdoutShift, bigLoser, bigWinner: bigWinner + holdoutShift, wml };
  });
  return {
    momentumCsvText: [
      "This file was created using the 202606 Bloomberg database.",
      "",
      ",WML",
      ...rows.map((row) => `${row.period},${row.wml.toFixed(4)}`),
    ].join("\n"),
    sixPortfolioCsvText: [
      "This file was created using the 202606 Bloomberg database.",
      "",
      "Average Value Weighted Returns -- Monthly",
      ",SMALL LoPRIOR,ME1 PRIOR2,SMALL HiPRIOR,BIG LoPRIOR,ME2 PRIOR2,BIG HiPRIOR",
      ...rows.map((row) => [
        row.period,
        row.smallLoser.toFixed(4),
        "0.0000",
        row.smallWinner.toFixed(4),
        row.bigLoser.toFixed(4),
        "0.0000",
        row.bigWinner.toFixed(4),
      ].join(",")),
      "Average Equal Weighted Returns -- Monthly",
    ].join("\n"),
  };
}

const researchCodeSha = "0123456789abcdef0123456789abcdef01234567";

test("records a partial empirical cost proxy without fabricating an all-in cost", () => {
  const evidence = createPreHoldoutCostEvidence();
  assert.equal(evidence.policyVersion, PRE_HOLDOUT_COST_POLICY_VERSION);
  assert.equal(evidence.empiricalProxy.appliedAnnualCostPct, 2.70);
  assert.equal(evidence.empiricalProxy.observedRangeAnnualPct.lowerGlobalUmdPct, 2.45);
  assert.equal(evidence.empiricalProxy.observedRangeAnnualPct.upperNonOptimizedUmdExamplePct, 4.78);
  assert.equal(evidence.allInCostComplete, false);
  assert.equal(evidence.admissionGrade, false);
  assert.equal(evidence.dimensions.liquidityImpact.appliedToProxyNetMetrics, true);
  assert.equal(evidence.dimensions.commission.appliedToProxyNetMetrics, false);
  assert.equal(evidence.dimensions.tax.appliedToProxyNetMetrics, false);
  assert.equal(evidence.dimensions.fx.appliedToProxyNetMetrics, false);
  assert.equal(evidence.dimensions.borrow.appliedToProxyNetMetrics, false);
  assert.ok(evidence.unresolvedAllInDimensions.includes("borrow"));
  assert.match(evidence.costEvidenceDigest, /^[0-9a-f]{64}$/);
});

test("preregisters every requested policy threshold before final holdout", () => {
  const policy = createPreHoldoutDecisionPolicy();
  assert.equal(policy.policyVersion, PRE_HOLDOUT_DECISION_POLICY_VERSION);
  assert.equal(policy.registeredBeforeFinalHoldout, true);
  assert.equal(policy.thresholds.minimumOosSample.value, 60);
  assert.equal(policy.thresholds.netExpectancy.value, 0);
  assert.equal(policy.thresholds.profitFactor.value, 1.10);
  assert.equal(policy.thresholds.maximumDrawdown.value, -25);
  assert.equal(policy.thresholds.minimumRiskAdjustedPerformance.value, 0.50);
  assert.equal(policy.thresholds.walkForwardStability.positiveNetExpectancyWindows.value, 4);
  assert.equal(policy.thresholds.dsr.value, 0.95);
  assert.equal(policy.thresholds.pbo.value, 0.20);
  assert.equal(policy.thresholds.realityCheckAndSpa.value, 0.05);
  assert.equal(policy.thresholds.parameterStability.parameterRefits, 0);
  assert.equal(policy.thresholds.regimeRobustness.minimumRegimes, 3);
  assert.equal(policy.thresholds.costStressSurvivability.requiredMultiplier, 2);
  assert.equal(policy.antiTuning.finalHoldoutMayCalibratePolicy, false);
  assert.match(policy.decisionPolicyDigest, /^[0-9a-f]{64}$/);
});

test("redacts 2021+ observations before numeric parsing", () => {
  const fixture = fixtureData(9999);
  const redacted = redactFinalHoldoutRows(fixture.momentumCsvText, "MOMENTUM");
  assert.equal(redacted.redactedObservationRows, 12);
  assert.equal(redacted.holdoutValuesParsed, 0);
  assert.doesNotMatch(redacted.preHoldoutCsvText, /^\s*2021\d{2}\s*,/m);
  assert.doesNotMatch(redacted.preHoldoutCsvText, /9999/);
});

test("runs 1x through 2x proxy cost stress without retuning the fixed rule", () => {
  const result = runPreHoldoutProfitabilityGate({ ...fixtureData(), researchCodeSha });
  assert.deepEqual(result.costStress.map((stress) => stress.multiplier), [1, 1.25, 1.5, 2]);
  assert.deepEqual(result.costStress.map((stress) => stress.annualProxyCostPct), [2.7, 3.375, 4.05, 5.4]);
  for (const stress of result.costStress) {
    assert.equal(stress.grossMetrics.sampleN, 99);
    assert.equal(stress.netMetrics.sampleN, 99);
    assert.ok(stress.netMetrics.expectedValueMonthlyPct < stress.grossMetrics.expectedValueMonthlyPct);
    assert.equal(stress.status, "COMPLETED_PARTIAL_EMPIRICAL_PROXY_NOT_ALL_IN");
  }
  assert.equal(result.walkForwardAfterCosts.scenarios.length, 4);
  assert.equal(result.walkForwardAfterCosts.scenarios.every((scenario) => scenario.windowCount === 6), true);
  assert.equal(result.walkForwardAfterCosts.scenarios.every((scenario) => scenario.parameterRefits === 0), true);
  assert.equal(result.oosAfterCosts.parameterRefits, 0);
  assert.equal(result.oosAfterCosts.optimizationTrials, 0);
});

test("cleans sample accounting so observations cannot be interpreted as studies", () => {
  const result = runPreHoldoutProfitabilityGate({ ...fixtureData(), researchCodeSha });
  assert.deepEqual(result.sampleAccounting, {
    externalStudyCount: 3,
    effectiveIndependentStudyCount: 1,
    externalObservationN: 245,
    externalDatasetObservationN: 245,
    ourReplicationN: 245,
    ourOosN: 99,
    ourWalkForwardN: 99,
    ourHoldoutN: 0,
    ourShadowN: 0,
    ourPaperN: 0,
    ourSettledN: 0,
    observationCountsAreNeverStudyCounts: true,
  });
  assert.equal(Object.hasOwn(result.sampleAccounting, "externalN"), false);
  assert.equal(Object.hasOwn(result.sampleAccounting, "studyN"), false);
});

test("fails the freeze gate while all-in costs and regime evidence require calibration", () => {
  const result = runPreHoldoutProfitabilityGate({ ...fixtureData(), researchCodeSha });
  assert.equal(result.policyEvaluation.status, "PRE_HOLDOUT_GATE_FAILED");
  assert.equal(result.policyEvaluation.gates.regimeRobustness.status, "CALIBRATION_REQUIRED");
  assert.equal(result.policyEvaluation.gates.allInCostPolicyComplete.status, "CALIBRATION_REQUIRED");
  assert.equal(result.frozenResearchCandidate, false);
  assert.equal(result.freezeRecord, null);
  assert.equal(result.finalHoldoutProtection.oneShotFinalHoldoutReady, false);
});

test("2021+ value changes cannot alter any pre-holdout result", () => {
  const normal = runPreHoldoutProfitabilityGate({ ...fixtureData(0), researchCodeSha });
  const poisonedHoldout = runPreHoldoutProfitabilityGate({ ...fixtureData(9999), researchCodeSha });
  assert.deepEqual(poisonedHoldout, normal);
  assert.equal(normal.finalHoldoutProtection.finalHoldoutNotOpened, true);
  assert.equal(normal.finalHoldoutProtection.numericHoldoutValuesParsed, 0);
  assert.equal(normal.finalHoldoutProtection.holdoutUsedForSelection, false);
  assert.equal(normal.finalHoldoutProtection.holdoutUsedForTuning, false);
  assert.equal(normal.finalHoldoutProtection.holdoutUsedForCalibration, false);
  assert.equal(normal.finalHoldoutProtection.ourHoldoutN, 0);
});

test("prepares only a restart-safe #226 job specification and performs no activation", () => {
  const result = runPreHoldoutProfitabilityGate({ ...fixtureData(), researchCodeSha });
  const plan = result.researchProductionPlan;
  assert.equal(plan.status, "SPEC_ONLY_NOT_ACTIVATED");
  assert.equal(plan.reusedOwner, "#226");
  assert.equal(plan.jobSpec.finalHoldoutMounted, false);
  assert.equal(plan.experimentDedup.duplicateExecutionPolicy, "RETURN_EXISTING_IMMUTABLE_RESULT");
  assert.equal(plan.restartSafeCheckpoint.resumeOnlyWhenAllFingerprintsMatch, true);
  assert.equal(plan.actualServerChanges, 0);
  assert.equal(plan.actualJobsSubmitted, 0);
  assert.equal(plan.actualProcessesRestarted, 0);
  assert.equal(plan.actualTimersActivated, 0);
  assert.equal(result.safety.liveTrading, false);
  assert.equal(result.safety.autoTrading, false);
  assert.equal(result.safety.realOrderEnabled, false);
  assert.equal(result.safety.privateTradingApiAllowed, false);
  assert.equal(result.safety.actualOrders, 0);
});
