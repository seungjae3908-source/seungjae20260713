import test from "node:test";
import assert from "node:assert/strict";
import { ETH_TURTLE_SYSTEM2_FUTURE_HYPOTHESIS_V1 as H } from "../src/eth-turtle-system2-future-hypothesis-v1.js";

test("ETH Turtle future-only hypothesis freezes the exact source recipe", () => {
  assert.equal(H.status, "PREREGISTERED_FUTURE_ONLY");
  assert.equal(H.market, "CRYPTO_FUTURES");
  assert.equal(H.symbol, "ETHUSDT");
  assert.equal(H.timeframe, "1d");
  assert.deepEqual(H.fixedRules, {
    entryLookback: 55,
    exitLookback: 20,
    nPeriod: 20,
    initialStopN: 2,
    addEveryN: 0.5,
    maxUnits: 4,
    unitRiskNEquityFraction: 0.01,
  });
  assert.equal(H.sourceResearch.exactHead, "3f7120250cff2bbe564e2fb3990be848536d8f83");
  assert.equal(H.freezeBoundary.declarationCommitSha, "e7474cf8c5d878cb0d48fef4c27b8278ea8dc3ed");
  assert.equal(H.freezeBoundary.declarationCommittedAt, "2026-09-29T23:51:00.000Z");
});

test("observed history can never bootstrap future evidence", () => {
  assert.equal(H.selectionDisclosure.selectedAfterObservedHistory, true);
  assert.equal(H.selectionDisclosure.observedHistoryMayCountAsOos, false);
  assert.equal(H.selectionDisclosure.observedHistoryMayCountAsForward, false);
  assert.equal(H.selectionDisclosure.observedHistoryMayCountAsEconomicSample, false);
  assert.equal(H.selectionDisclosure.observedHistoryMayCountAsProfitabilityProof, false);
  assert.equal(H.futureEvidencePolicy.historicalBackfillCreditAllowed, false);
  assert.equal(H.futureEvidencePolicy.sameObservedWindowCrossCreditAllowed, false);
  assert.equal(H.freezeBoundary.evidenceDecisionTimestampMustBeStrictlyAfterDeclaration, true);
});

test("future evidence cannot retune or gain trading authority", () => {
  assert.equal(H.futureEvidencePolicy.parameterRetuningAllowed, false);
  assert.equal(H.futureEvidencePolicy.symbolSubstitutionAllowed, false);
  assert.equal(H.futureEvidencePolicy.leverageIncreaseAllowed, false);
  assert.equal(H.futureEvidencePolicy.riskIncreaseAllowed, false);
  assert.equal(H.futureEvidencePolicy.automaticPromotionAllowed, false);
  assert.equal(H.futureEvidencePolicy.economicSampleCredit, 0);
  assert.equal(H.futureEvidencePolicy.profitabilityClaimAllowed, false);
  assert.equal(H.futureEvidencePolicy.executionAuthority, "NONE");
  assert.equal(H.safety.liveExecutionAllowed, false);
  assert.equal(H.safety.orderSubmissionAllowed, false);
});
