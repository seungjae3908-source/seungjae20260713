import test from "node:test";
import assert from "node:assert/strict";
import { FABER_GTAA_10M_FUTURE_HYPOTHESIS_V1 as H } from "../src/faber-gtaa10m-future-hypothesis-v1.js";

test("Faber GTAA future-only hypothesis freezes the exact source identity", () => {
  assert.equal(H.status, "PREREGISTERED_FUTURE_ONLY");
  assert.equal(H.sourceRecipeId, "FABER_GTAA_10M_SMA_V1");
  assert.equal(H.sourceResearch.pr, 1506);
  assert.equal(H.sourceResearch.exactHead, "603815e9a4568be6f80cb732640536237dcf5025");
  assert.equal(H.sourceResearch.workflowRun, 36652435588);
  assert.equal(H.sourceResearch.artifactId, 11071565000);
  assert.equal(H.sourceResearch.observedHistoryThrough, "2026-08");
  assert.equal(H.sourceResearch.promotionStatus, "REFERENCE_CANDIDATE_REQUIRES_FUTURE_OOS");
});

test("Faber GTAA future-only hypothesis freezes the 10M five-sleeve rule", () => {
  assert.equal(H.fixedRules.rebalanceFrequency, "MONTHLY");
  assert.equal(H.fixedRules.signalTiming, "COMPLETED_MONTH_END");
  assert.equal(H.fixedRules.movingAverageMonths, 10);
  assert.equal(H.fixedRules.executionTiming, "NEXT_MONTH_FIRST_TRADING_DAY_OPEN");
  assert.equal(H.fixedRules.cashProxy, "FRED_TB3MS_ANNUAL_DISCOUNT_BASIS_DIV_1200");
  assert.equal(H.fixedRules.perSideResearchCostFraction, 0.0015);
  assert.equal(H.fixedRules.stressCostMultiplier, 1.5);
  assert.deepEqual(H.fixedRules.sleeves, [
    { symbol: "SPY", targetWeight: 0.20 },
    { symbol: "EFA", targetWeight: 0.20 },
    { symbol: "IEF", targetWeight: 0.20 },
    { symbol: "VNQ", targetWeight: 0.20 },
    { symbol: "DBC", targetWeight: 0.20 },
  ]);
  assert.equal(H.fixedRules.sleeves.reduce((sum, sleeve) => sum + sleeve.targetWeight, 0), 1);
});

test("observed history cannot bootstrap Faber future evidence", () => {
  assert.equal(H.selectionDisclosure.selectedAfterObservedHistory, true);
  assert.equal(H.selectionDisclosure.observedHistoryMayCountAsOos, false);
  assert.equal(H.selectionDisclosure.observedHistoryMayCountAsForward, false);
  assert.equal(H.selectionDisclosure.observedHistoryMayCountAsEconomicSample, false);
  assert.equal(H.selectionDisclosure.observedHistoryMayCountAsProfitabilityProof, false);
  assert.equal(H.freezeBoundary.declarationCommitSha, "1b541e27e32332af63fe0255d257aac152f46dbf");
  assert.equal(H.freezeBoundary.observedHistoryThrough, "2026-08");
  assert.equal(H.freezeBoundary.firstEligibleSignalMonth, "2026-09");
  assert.equal(H.freezeBoundary.evidenceSignalMonthMustBeAfterObservedHistory, true);
  assert.equal(H.freezeBoundary.evidenceCodeMustDescendFromDeclarationCommit, true);
  assert.equal(H.futureEvidencePolicy.historicalBackfillCreditAllowed, false);
  assert.equal(H.futureEvidencePolicy.sameObservedWindowCrossCreditAllowed, false);
});

test("future evidence cannot retune Faber or gain execution authority", () => {
  assert.equal(H.futureEvidencePolicy.parameterRetuningAllowed, false);
  assert.equal(H.futureEvidencePolicy.assetReplacementAllowed, false);
  assert.equal(H.futureEvidencePolicy.sleeveWeightRetuningAllowed, false);
  assert.equal(H.futureEvidencePolicy.cashProxyPolicyChangeAllowed, false);
  assert.equal(H.futureEvidencePolicy.executionTimingChangeAllowed, false);
  assert.equal(H.futureEvidencePolicy.futureObservationMustUseFrozenRuleIdentity, true);
  assert.equal(H.futureEvidencePolicy.automaticPromotionAllowed, false);
  assert.equal(H.futureEvidencePolicy.economicSampleCredit, 0);
  assert.equal(H.futureEvidencePolicy.profitabilityClaimAllowed, false);
  assert.equal(H.futureEvidencePolicy.executionAuthority, "NONE");
  assert.equal(H.safety.liveExecutionAllowed, false);
  assert.equal(H.safety.orderSubmissionAllowed, false);
  assert.equal(H.safety.productionMutationAllowed, false);
});
