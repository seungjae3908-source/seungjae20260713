import assert from "node:assert/strict";
import test from "node:test";
import { RESEARCH_TOURNAMENT_STAGES } from "../src/research-tournament-engine-v1.js";
import {
  ADAPTIVE_MULTI_EVIDENCE_VALIDATION_V2_VERSION,
  buildAdaptiveMultiEvidenceValidationV2,
} from "../src/adaptive-multi-evidence-validation-v2.js";

function formulaTournament(overrides = {}) {
  return {
    schemaVersion: "adaptive-multi-evidence-formula-tournament-v2",
    lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2",
    status: "READY_FOR_VALIDATION_PIPELINE",
    tournamentId: "tournament-1",
    totalTrialCount: 8,
    globalCandidateFamilySize: 8,
    executionAuthority: "NONE",
    ...overrides,
  };
}

function evidence(stage) {
  if (stage === "OOS") return { trainDatasetIdentity: "train", oosDatasetIdentity: "oos" };
  if (stage === "PURGED_OOS") return { status: "PASS", purgedOosDatasetIdentity: "purged-oos" };
  if (stage === "WALK_FORWARD") return { windows: [{ id: 1 }], analysis: { status: "PASS" } };
  if (stage === "COST_STRESS") return { scenarios: [{ id: "BASE" }], analysis: { status: "PASS" } };
  if (stage === "REGIME_STRESS") return { regimes: { BULL: {} }, analysis: { status: "PASS" } };
  if (stage === "STATISTICAL_FIREWALL") return {
    firewall: {
      canonicalOwner: "#547",
      candidateFamilySize: 8,
      multipleTesting: { passed: true, adjustedAlpha: 0.00625 },
      dsr: { passed: true, value: 0.9 },
      pbo: { passed: true, value: 0.1 },
      minimumN: { passed: true },
      parameterStability: { passed: true },
      walkForwardStability: { passed: true },
      regimeStability: { passed: true },
    },
    neighborhood: { passed: true, needleOptimum: false },
    analysis: { status: "PASS" },
  };
  if (stage === "FINAL_HOLDOUT") return {
    evaluationCount: 1,
    capabilityId: "capability-1",
    datasetIdentity: "final-holdout",
    selectionAllowed: false,
    parameterTuningAllowed: false,
  };
  if (stage === "RESEARCH_SURVIVOR") return {
    survivor: true,
    profitable: false,
    provisionalChampion: false,
    validatedChampion: false,
    tradingAuthority: false,
  };
  return {};
}

function candidate(overrides = {}) {
  return {
    generatedCandidateId: "generated-1",
    formulaCandidateId: "formula-1",
    strategyHash: "a".repeat(64),
    parameterIdentity: "b".repeat(64),
    stageRecords: RESEARCH_TOURNAMENT_STAGES.map((stage) => ({
      stage,
      status: "PASS",
      evidenceId: `evidence-${stage}`,
      evidence: evidence(stage),
    })),
    failure: null,
    researchSurvivor: true,
    ...overrides,
  };
}

function ownerResult(candidates = [candidate()], overrides = {}) {
  return {
    tournament: {
      tournamentId: "tournament-1",
      candidates,
      profitable: false,
      champion: null,
    },
    safety: { executionAuthority: "NONE" },
    ...overrides,
  };
}

test("full ordered owner progression produces a validated but unfrozen finalist", () => {
  const result = buildAdaptiveMultiEvidenceValidationV2({
    formulaTournament: formulaTournament(),
    tournamentResult: ownerResult(),
  });
  assert.equal(result.schemaVersion, ADAPTIVE_MULTI_EVIDENCE_VALIDATION_V2_VERSION);
  assert.equal(result.status, "VALIDATED_FINALISTS_AVAILABLE");
  assert.equal(result.finalistCount, 1);
  assert.deepEqual(result.finalists[0].completedStages, RESEARCH_TOURNAMENT_STAGES);
  assert.equal(result.finalists[0].status, "VALIDATED_FINALIST_NOT_FROZEN");
  assert.equal(result.finalists[0].finalHoldoutEvaluationCount, 1);
});

test("DSR, PBO, multiple testing, and neighborhood stability are mandatory", () => {
  const broken = candidate();
  const statistical = broken.stageRecords.find((record) => record.stage === "STATISTICAL_FIREWALL");
  const tampered = {
    ...broken,
    stageRecords: broken.stageRecords.map((record) => record === statistical
      ? { ...record, evidence: { ...record.evidence, firewall: { ...record.evidence.firewall, dsr: { passed: false, value: 0.9 } } } }
      : record),
  };
  const result = buildAdaptiveMultiEvidenceValidationV2({
    formulaTournament: formulaTournament(),
    tournamentResult: ownerResult([tampered]),
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("OWNER_RESEARCH_SURVIVOR_VALIDATION_CONTRACT_INVALID"));
});

test("Final Holdout is one-shot, frozen, and cannot tune or select", () => {
  const broken = candidate();
  const tampered = {
    ...broken,
    stageRecords: broken.stageRecords.map((record) => record.stage === "FINAL_HOLDOUT"
      ? { ...record, evidence: { ...record.evidence, evaluationCount: 2 } }
      : record),
  };
  const result = buildAdaptiveMultiEvidenceValidationV2({
    formulaTournament: formulaTournament(),
    tournamentResult: ownerResult([tampered]),
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.finalHoldoutReuseAllowed, false);
  assert.equal(result.failureFeedbackToSearchAllowed, false);
});

test("honest elimination yields no finalist instead of fake success", () => {
  const eliminated = candidate({
    failure: { code: "OOS_FAILED", failedStage: "OOS" },
    researchSurvivor: false,
    stageRecords: candidate().stageRecords.slice(0, 4),
  });
  const result = buildAdaptiveMultiEvidenceValidationV2({
    formulaTournament: formulaTournament(),
    tournamentResult: ownerResult([eliminated]),
  });
  assert.equal(result.status, "NO_VALIDATED_FINALIST_EVIDENCE");
  assert.equal(result.finalistCount, 0);
  assert.equal(result.rejected[0].reasons[0], "OOS_FAILED");
  assert.equal(result.profitabilityProven, false);
});

test("foreign lineage and execution authority fail closed", () => {
  const result = buildAdaptiveMultiEvidenceValidationV2({
    formulaTournament: formulaTournament({ lineageId: "FROZEN_CHALLENGER_V1" }),
    tournamentResult: ownerResult(),
    executionAuthority: "PAPER",
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("V2_FORMULA_TOURNAMENT_INPUT_INVALID"));
  assert.ok(result.blockers.includes("V2_VALIDATION_EXECUTION_AUTHORITY_FORBIDDEN"));
  assert.equal(result.liveTrading, false);
  assert.equal(result.autoTrading, false);
  assert.equal(result.realOrderEnabled, false);
  assert.equal(result.privateTradingApiAllowed, false);
  assert.equal(result.executionAuthority, "NONE");
});
