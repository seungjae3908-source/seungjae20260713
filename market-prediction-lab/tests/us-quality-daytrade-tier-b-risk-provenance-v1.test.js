import test from "node:test";
import assert from "node:assert/strict";
import { evaluateUsQualityDaytradeTierBRiskProvenance } from "../src/us-quality-daytrade-tier-b-risk-provenance-v1.js";

const SOURCE_IDS = Object.freeze({
  recentReverseSplit: "exchange-corporate-actions",
  listingRisk: "exchange-listing-status",
  manipulationRisk: "market-surveillance-public",
  dilutionRisk: "sec-filings-dilution-screen",
  recentOffering: "sec-offering-filings",
  goingConcernRisk: "sec-going-concern-screen",
});

function baseInput() {
  return {
    asOfMs: 20_000,
    instrument: {
      recentReverseSplit: false,
      listingRisk: false,
      manipulationRisk: false,
      dilutionRisk: false,
      recentOffering: false,
      goingConcernRisk: false,
    },
    riskEvidence: {
      pointInTime: true,
      publicReadOnly: true,
      privateApiUsed: false,
      coverageComplete: true,
      checkedAtMs: 19_000,
      windowStartMs: 1,
      windowEndMs: 18_000,
      validUntilMs: 30_000,
      riskFlags: {
        recentReverseSplit: false,
        listingRisk: false,
        manipulationRisk: false,
        dilutionRisk: false,
        recentOffering: false,
        goingConcernRisk: false,
      },
      sourceIds: { ...SOURCE_IDS },
    },
  };
}

test("Tier B point-in-time risk screen passes only with complete source-backed negative evidence", () => {
  const result = evaluateUsQualityDaytradeTierBRiskProvenance(baseInput());
  assert.equal(result.status, "PASS");
  assert.equal(result.reason, "TIER_B_POINT_IN_TIME_RISK_SCREEN_VERIFIED");
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.liveTradingAllowed, false);
  assert.equal(result.privateApiAllowed, false);
  assert.deepEqual(result.riskFlags, baseInput().riskEvidence.riskFlags);
});

test("Tier B risk screen fails closed when evidence is missing", () => {
  const input = baseInput();
  delete input.riskEvidence;
  const result = evaluateUsQualityDaytradeTierBRiskProvenance(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "TIER_B_RISK_EVIDENCE_REQUIRED");
});

test("Tier B risk screen rejects future or stale evidence", () => {
  const future = baseInput();
  future.riskEvidence.checkedAtMs = 21_000;
  assert.equal(evaluateUsQualityDaytradeTierBRiskProvenance(future).reason, "TIER_B_RISK_EVIDENCE_FROM_FUTURE");

  const stale = baseInput();
  stale.riskEvidence.validUntilMs = 19_999;
  assert.equal(evaluateUsQualityDaytradeTierBRiskProvenance(stale).reason, "TIER_B_RISK_EVIDENCE_STALE");
});

test("Tier B risk screen rejects incomplete or private evidence", () => {
  const incomplete = baseInput();
  incomplete.riskEvidence.coverageComplete = false;
  assert.equal(evaluateUsQualityDaytradeTierBRiskProvenance(incomplete).reason, "TIER_B_RISK_COVERAGE_INCOMPLETE");

  const privateEvidence = baseInput();
  privateEvidence.riskEvidence.privateApiUsed = true;
  assert.equal(evaluateUsQualityDaytradeTierBRiskProvenance(privateEvidence).reason, "TIER_B_RISK_PUBLIC_READ_ONLY_REQUIRED");
});

test("Tier B risk screen rejects unsourced or mismatched risk flags", () => {
  const missingSource = baseInput();
  missingSource.riskEvidence.sourceIds.recentOffering = "";
  assert.equal(evaluateUsQualityDaytradeTierBRiskProvenance(missingSource).reason, "TIER_B_RECENT_OFFERING_SOURCE_REQUIRED");

  const mismatch = baseInput();
  mismatch.riskEvidence.riskFlags.dilutionRisk = true;
  assert.equal(evaluateUsQualityDaytradeTierBRiskProvenance(mismatch).reason, "TIER_B_DILUTION_RISK_FLAG_MISMATCH");
});

test("verified Tier B disqualifying risk is never promoted", () => {
  const input = baseInput();
  input.instrument.goingConcernRisk = true;
  input.riskEvidence.riskFlags.goingConcernRisk = true;
  const result = evaluateUsQualityDaytradeTierBRiskProvenance(input);
  assert.equal(result.status, "ABSTAIN");
  assert.equal(result.reason, "TIER_B_GOING_CONCERN_RISK");
});
