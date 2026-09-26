import test from "node:test";
import assert from "node:assert/strict";
import { evaluateUsStockResearchPromotion } from "../src/us-stock-research-promotion-gate.js";
import {
  US_STOCK_FORWARD_CANDIDATE,
  US_STOCK_FORWARD_CANDIDATE_SHA256,
} from "../src/us-stock-forward-candidate.js";

function bias(pass = true) {
  return pass ? {
    status: "point_in_time_bias_gate_passed",
    gates: {
      pointInTimeMembershipsPresent: true,
      removedNamesPresent: true,
      membershipHistoryCoveragePassed: true,
      removedNameHistoryCoveragePassed: true,
    },
  } : {
    status: "research_hold",
    gates: {
      pointInTimeMembershipsPresent: false,
      removedNamesPresent: false,
      membershipHistoryCoveragePassed: false,
      removedNameHistoryCoveragePassed: false,
    },
  };
}

function signal(pass = true) {
  return {
    candidateId: US_STOCK_FORWARD_CANDIDATE.id,
    candidateManifestSha256: US_STOCK_FORWARD_CANDIDATE_SHA256,
    signalShadowStatus: pass ? "forward_signal_evidence_ready" : "shadow_continue",
    settledSignals: pass ? 30 : 0,
    symbolCount: pass ? 6 : 0,
    regimes: pass ? ["trend", "range"] : [],
  };
}

function pnl(pass = true) {
  return {
    candidateId: US_STOCK_FORWARD_CANDIDATE.id,
    candidateManifestSha256: US_STOCK_FORWARD_CANDIDATE_SHA256,
    pnlShadowStatus: pass ? "prospective_pnl_evidence_ready" : "shadow_continue",
    gates: {
      samplePassed: pass,
      symbolPassed: pass,
      regimePassed: pass,
      elapsedPassed: pass,
      basePerformancePassed: pass,
      stressPerformancePassed: pass,
    },
  };
}

test("historical success alone never becomes an execution candidate", () => {
  const result = evaluateUsStockResearchPromotion({ biasAudit: bias(false), signalShadow: signal(false), pnlShadow: pnl(false) });
  assert.equal(result.status, "historical_cross_symbol_candidate");
  assert.equal(result.gates.historicalPassed, true);
  assert.equal(result.gates.pointInTimeBiasPassed, false);
  assert.equal(result.gates.signalShadowPassed, false);
  assert.equal(result.gates.pnlShadowPassed, false);
  assert.equal(result.safeguards.executionPromotionAllowed, false);
  assert.equal(result.safeguards.actualOrders, 0);
});

test("signal evidence cannot skip the independent cost-aware PnL gate", () => {
  const result = evaluateUsStockResearchPromotion({ biasAudit: bias(true), signalShadow: signal(true), pnlShadow: pnl(false) });
  assert.equal(result.status, "prospective_signal_candidate");
  assert.equal(result.gates.signalShadowPassed, true);
  assert.equal(result.gates.pnlShadowPassed, false);
  assert.ok(result.blockers.includes("prospective_cost_aware_pnl_shadow_incomplete"));
});

test("all machine evidence reaches manual review only and still cannot authorize execution", () => {
  const result = evaluateUsStockResearchPromotion({ biasAudit: bias(true), signalShadow: signal(true), pnlShadow: pnl(true) });
  assert.equal(result.status, "manual_research_review_candidate");
  assert.equal(result.evidenceComplete, true);
  assert.deepEqual(result.gates, {
    historicalPassed: true,
    pointInTimeBiasPassed: true,
    signalShadowPassed: true,
    pnlShadowPassed: true,
    manualResearchReviewPassed: false,
  });
  assert.equal(result.safeguards.executionPromotionAllowed, false);
  assert.equal(result.safeguards.liveOrderAllowed, false);
  assert.ok(result.blockers.includes("manual_research_review_required"));
});

test("candidate-manifest mismatch fails closed", () => {
  assert.throws(() => evaluateUsStockResearchPromotion({
    biasAudit: bias(true),
    signalShadow: { ...signal(true), candidateManifestSha256: "0".repeat(64) },
    pnlShadow: pnl(true),
  }), /candidate manifest mismatch/);
});
