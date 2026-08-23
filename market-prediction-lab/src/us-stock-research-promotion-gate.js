import { PredictionInputError } from "./contracts.js";
import {
  US_STOCK_FORWARD_CANDIDATE,
  US_STOCK_FORWARD_CANDIDATE_SHA256,
} from "./us-stock-forward-candidate.js";

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PredictionInputError(`${label} must be an object`);
  }
  return value;
}

function assertCandidateEvidence(value, label) {
  const evidence = object(value, label);
  if (evidence.candidateId != null && evidence.candidateId !== US_STOCK_FORWARD_CANDIDATE.id) {
    throw new PredictionInputError(`${label} candidate id mismatch`);
  }
  if (evidence.candidateManifestSha256 != null && evidence.candidateManifestSha256 !== US_STOCK_FORWARD_CANDIDATE_SHA256) {
    throw new PredictionInputError(`${label} candidate manifest mismatch`);
  }
  return evidence;
}

export function evaluateUsStockResearchPromotion(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PredictionInputError("US stock promotion input must be an object");
  }

  const bias = object(raw.biasAudit, "biasAudit");
  const signal = assertCandidateEvidence(raw.signalShadow, "signalShadow");
  const pnl = assertCandidateEvidence(raw.pnlShadow, "pnlShadow");
  const historical = US_STOCK_FORWARD_CANDIDATE.selectionEvidence;

  const historicalPassed = Object.values(historical).every((value) => value === true);
  const pointInTimeBiasPassed = bias.status === "point_in_time_bias_gate_passed"
    && bias.gates?.pointInTimeMembershipsPresent === true
    && bias.gates?.removedNamesPresent === true
    && bias.gates?.membershipHistoryCoveragePassed === true
    && bias.gates?.removedNameHistoryCoveragePassed === true;
  const signalShadowPassed = signal.signalShadowStatus === "forward_signal_evidence_ready"
    && Number(signal.settledSignals) >= 30
    && Number(signal.symbolCount) >= 6
    && Array.isArray(signal.regimes)
    && signal.regimes.includes("trend")
    && signal.regimes.includes("range");
  const pnlGates = pnl.gates ?? {};
  const pnlShadowPassed = pnl.pnlShadowStatus === "prospective_pnl_evidence_ready"
    && pnlGates.samplePassed === true
    && pnlGates.symbolPassed === true
    && pnlGates.regimePassed === true
    && pnlGates.elapsedPassed === true
    && pnlGates.basePerformancePassed === true
    && pnlGates.stressPerformancePassed === true;

  const blockers = [];
  if (!historicalPassed) blockers.push("historical_validation_incomplete");
  if (!pointInTimeBiasPassed) blockers.push("point_in_time_survivorship_bias_gate_incomplete");
  if (!signalShadowPassed) blockers.push("prospective_signal_shadow_incomplete");
  if (!pnlShadowPassed) blockers.push("prospective_cost_aware_pnl_shadow_incomplete");
  blockers.push("manual_research_review_required");
  blockers.push("live_execution_outside_research_lane");

  const evidenceComplete = historicalPassed && pointInTimeBiasPassed && signalShadowPassed && pnlShadowPassed;
  let status = "research_hold";
  if (historicalPassed) status = "historical_cross_symbol_candidate";
  if (historicalPassed && signalShadowPassed) status = "prospective_signal_candidate";
  if (historicalPassed && signalShadowPassed && pnlShadowPassed) status = "prospective_pnl_candidate";
  if (evidenceComplete) status = "manual_research_review_candidate";

  return Object.freeze({
    schemaVersion: 1,
    market: "US_STOCK",
    candidateId: US_STOCK_FORWARD_CANDIDATE.id,
    candidateManifestSha256: US_STOCK_FORWARD_CANDIDATE_SHA256,
    status,
    evidenceComplete,
    gates: Object.freeze({
      historicalPassed,
      pointInTimeBiasPassed,
      signalShadowPassed,
      pnlShadowPassed,
      manualResearchReviewPassed: false,
    }),
    blockers: Object.freeze(blockers),
    safeguards: Object.freeze({
      historicalPassDoesNotAuthorizeExecution: true,
      signalShadowPassDoesNotAuthorizeExecution: true,
      pnlShadowPassDoesNotAuthorizeExecution: true,
      pointInTimeBiasPassDoesNotAuthorizeExecution: true,
      manualResearchReviewRequired: true,
      executionPromotionAllowed: false,
      liveOrderAllowed: false,
      privateAccountRequestAllowed: false,
      actualOrders: 0,
    }),
  });
}
