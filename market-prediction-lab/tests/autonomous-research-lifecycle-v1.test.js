import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAutonomousFactoryContractFixtureTrace,
  buildAutonomousResearchActivationReadiness,
  buildAutonomousResearchFactoryStatus,
  buildCanonicalPaperHandoffIntent,
  buildCanonicalScannerLifecycleIntents,
  buildCanonicalShadowHandoffIntent,
  buildFourMarketChampionPortfolio,
  buildOneShotFinalHoldoutRequest,
  buildSettlementHealthFeedback,
  freezeAutonomousResearchCandidate,
  recordOneShotFinalHoldoutResult,
} from "../src/autonomous-research-lifecycle-v1.js";
import { researchDigest } from "../src/research-trial-registry.js";

const SHA = "1234567890abcdef1234567890abcdef12345678";

function job(overrides = {}) {
  return {
    identity: {
      candidateIdentityDigest: researchDigest({ candidate: 1 }),
      costPolicyVersion: "cost-v1",
      decisionPolicyVersion: "decision-v1",
    },
    candidate: {
      strategyId: "trend-btc-v1",
      strategyFamilyId: "trend-family",
      parameterHash: researchDigest({ lookback: 20 }),
      formulaHash: researchDigest({ formula: "momentum" }),
      parameters: { lookback: { value: 20, min: 5, max: 120 } },
    },
    researchCodeSha: SHA,
    datasetId: "btc-public-daily",
    datasetDigest: "a".repeat(64),
    market: "CRYPTO_FUTURES",
    direction: "LONG",
    strategyType: "SWING",
    rankingGroup: "CRYPTO_FUTURES_SWING_LONG",
    ...overrides,
  };
}

function eligibleResult(overrides = {}) {
  return {
    status: "FROZEN_ELIGIBLE",
    finalHoldoutOpened: false,
    resultDigest: researchDigest({ result: "eligible" }),
    evidence: {
      minimumGate: { passed: true },
      statistics: { status: "PASS" },
      oos: { status: "PASS" },
      walkForward: { status: "PASS", leakFree: true },
      costStress: { status: "PASS" },
      regime: { status: "PASS" },
    },
    ...overrides,
  };
}

function frozen() {
  return freezeAutonomousResearchCandidate(job(), eligibleResult(), { freezeTimestamp: "2026-08-21T04:00:00Z" });
}

function finalHoldoutPass(freeze = frozen()) {
  const request = buildOneShotFinalHoldoutRequest(freeze);
  const result = {
    requestId: request.requestId,
    strategyId: freeze.strategyId,
    candidateIdentityDigest: freeze.candidateIdentityDigest,
    parameterHash: freeze.parameterHash,
    status: "PASS",
    retunedAfterHoldout: false,
    metrics: { totalReturn: 0.01 },
  };
  return recordOneShotFinalHoldoutResult(request, freeze, result, { executedAt: "2026-08-21T04:10:00Z" });
}

test("freeze is immutable only after every preregistered pre-holdout gate passes", () => {
  const freeze = frozen();
  assert.equal(freeze.FROZEN_RESEARCH_CANDIDATE, true);
  assert.equal(freeze.FINAL_HOLDOUT_NOT_OPENED, true);
  assert.equal(freeze.strategyId, "trend-btc-v1");
  assert.equal(freeze.researchCodeSha, SHA);
  assert.equal(freeze.costPolicyVersion, "cost-v1");
  assert.equal(freeze.retuningAfterFreezeAllowed, false);
  const blocked = freezeAutonomousResearchCandidate(job(), eligibleResult({ evidence: { ...eligibleResult().evidence, statistics: { status: "CALIBRATION_REQUIRED" } } }), { freezeTimestamp: "2026-08-21T04:00:00Z" });
  assert.equal(blocked.FROZEN_RESEARCH_CANDIDATE, false);
  assert.ok(blocked.blockers.includes("STATISTICAL_FIREWALL_NOT_PASSED"));
});

test("Final Holdout is one-shot, identity-bound, and cannot retune", () => {
  const freeze = frozen();
  const request = buildOneShotFinalHoldoutRequest(freeze);
  assert.equal(request.consumed, false);
  assert.equal(request.activationRequested, false);
  const completed = finalHoldoutPass(freeze);
  assert.equal(completed.status, "FINAL_HOLDOUT_PASS");
  assert.equal(completed.consumed, true);
  assert.equal(completed.FINAL_HOLDOUT_NOT_OPENED, false);
  assert.throws(() => recordOneShotFinalHoldoutResult(completed, freeze, {}, { executedAt: "2026-08-21T04:20:00Z" }), /ALREADY_CONSUMED/);
  assert.throws(() => recordOneShotFinalHoldoutResult(request, freeze, {
    requestId: request.requestId,
    strategyId: freeze.strategyId,
    candidateIdentityDigest: freeze.candidateIdentityDigest,
    parameterHash: freeze.parameterHash,
    status: "PASS",
    retunedAfterHoldout: true,
  }, { executedAt: "2026-08-21T04:20:00Z" }), /forbidden/);
});

test("Shadow then Paper handoffs are adapter-only, future-only, and no-backfill", () => {
  const freeze = frozen();
  const shadow = buildCanonicalShadowHandoffIntent(freeze, finalHoldoutPass(freeze), { createdAt: "2026-08-21T04:20:00Z" });
  assert.equal(shadow.status, "ADAPTER_INTENT_READY");
  assert.equal(shadow.canonicalOwnerRef, "#419");
  assert.equal(shadow.futureOnly, true);
  assert.equal(shadow.historicalBackfillAllowed, false);
  assert.equal(shadow.ownerMutation, false);
  const paper = buildCanonicalPaperHandoffIntent(freeze, { status: "PASS", strategyId: freeze.strategyId, futureOnly: true, evidenceDigest: researchDigest({ shadow: 1 }) }, { createdAt: "2026-08-21T04:30:00Z" });
  assert.equal(paper.status, "ADAPTER_INTENT_READY");
  assert.equal(paper.canonicalOwnerRef, "#299");
  assert.equal(paper.activationRequested, false);
});

test("Settlement and Health feedback cannot mutate frozen parameters or owner files", () => {
  const freeze = frozen();
  const feedback = buildSettlementHealthFeedback(freeze, {
    settlement: { strategyId: freeze.strategyId, evidenceDigest: researchDigest({ settled: 1 }) },
    health: { strategyId: freeze.strategyId, evidenceDigest: researchDigest({ health: 1 }), status: "ACTIVE" },
  });
  assert.equal(feedback.healthOwnerRef, "#247");
  assert.equal(feedback.frozenParameterMutationAllowed, false);
  assert.equal(feedback.selectionHistoryRewriteAllowed, false);
  assert.equal(feedback.ownerMutation, false);
});

function validatedCandidate(strategyId, market, direction, qualityScore, correlationCluster = strategyId, overrides = {}) {
  return {
    strategyId,
    market,
    direction,
    qualityScore,
    correlationCluster,
    finalHoldoutStatus: "PASS",
    shadowStatus: "PASS",
    paperStatus: "PASS",
    settlementStatus: "PASS",
    healthStatus: "ACTIVE",
    ...overrides,
  };
}

test("champions are separately ranked for stocks, spot, and futures long/short", () => {
  const champion = buildFourMarketChampionPortfolio([
    validatedCandidate("kr-best", "KR_STOCK", "BUY", 80),
    validatedCandidate("us-best", "US_STOCK", "BUY", 82),
    validatedCandidate("spot-best", "CRYPTO_SPOT", "BUY", 81),
    validatedCandidate("futures-long", "CRYPTO_FUTURES", "LONG", 84),
    validatedCandidate("futures-short", "CRYPTO_FUTURES", "SHORT", 83),
    validatedCandidate("rejected-high-score", "KR_STOCK", "BUY", 999, "bad", { paperStatus: "FAIL" }),
  ], { maxPerSlot: 2, maxCorrelationClusterWeight: 0.5 });
  assert.equal(champion.KR_bestValidatedStrategy, "kr-best");
  assert.equal(champion.US_bestValidatedStrategy, "us-best");
  assert.equal(champion.SPOT_bestValidatedStrategy, "spot-best");
  assert.equal(champion.FUTURES_LONG_bestValidatedStrategy, "futures-long");
  assert.equal(champion.FUTURES_SHORT_bestValidatedStrategy, "futures-short");
  assert.equal(champion.profitabilityGuaranteed, false);
  assert.equal(champion.currentChampionPortfolio.length, 5);
});

test("Scanner promotion, demotion, and preflight are canonical intents with no live authority", () => {
  const champion = buildFourMarketChampionPortfolio([validatedCandidate("kr-best", "KR_STOCK", "BUY", 80)], { maxPerSlot: 1 });
  const intents = buildCanonicalScannerLifecycleIntents({
    championPortfolio: champion,
    canonicalPromotionDecisions: [
      { strategyId: "kr-best", status: "PASS", scannerEligible: true, autoTradingPreflightEligible: true },
      { strategyId: "old", status: "FAIL", scannerEligible: false, autoTradingPreflightEligible: false },
    ],
    canonicalHealth: [{ strategyId: "kr-best", status: "ACTIVE" }, { strategyId: "old", status: "SUSPENDED" }],
    currentlyScannerEligible: ["old"],
  });
  assert.deepEqual(intents.scannerEligibleStrategies, ["kr-best"]);
  assert.deepEqual(intents.scannerSuspendedStrategies, ["old"]);
  assert.deepEqual(intents.autoTradingPreflightEligibleStrategies, ["kr-best"]);
  assert.equal(intents.AUTO_TRADING_PREFLIGHT_ELIGIBLE, true);
  assert.equal(intents.liveTradingEligible, false);
  assert.equal(intents.ownerMutation, false);
  assert.equal(intents.safety.AUTO_TRADING, false);
});

test("Research Center status uses explicit evidence accounting and missing-evidence labels", () => {
  const status = buildAutonomousResearchFactoryStatus({
    generatedAt: "2026-08-21T05:00:00Z",
    codeComplete: true,
    dualAiReview: { status: "INCOMPLETE" },
    evidenceAccounting: { externalObservationN: 245 },
    activationReadiness: { ready: false, blockers: ["PERSISTENCE_STATE_ROOT_REQUIRED"] },
  });
  assert.equal(status.KR_bestValidatedStrategy, "NONE/INSUFFICIENT_EVIDENCE");
  assert.equal(status.FUTURES_SHORT_bestValidatedStrategy, "NONE/INSUFFICIENT_EVIDENCE");
  assert.equal(status.dualAiReviewStatus, "AI_REVIEW_INCOMPLETE");
  assert.equal(status.ai1Review, "NONE/INSUFFICIENT_EVIDENCE");
  assert.equal(status.evidenceAccounting.externalObservationN, 245);
  assert.equal(status.evidenceAccounting.externalStudyCount, 0);
  assert.equal(status.missingEvidenceRenderedAsZero, false);
  assert.equal(status.AUTONOMOUS_RESEARCH_FACTORY_ACTIVE, false);
});

test("activation readiness is separate from code completeness and requires explicit server inputs", () => {
  const blocked = buildAutonomousResearchActivationReadiness({ freeProviderCount: 0 });
  assert.equal(blocked.ready, false);
  assert.ok(blocked.blockers.includes("PERSISTENCE_STATE_ROOT_REQUIRED"));
  assert.ok(blocked.blockers.includes("EXACTLY_TWO_DISTINCT_FREE_AI_PROVIDERS_REQUIRED"));
  const readyPlan = buildAutonomousResearchActivationReadiness({
    persistenceStateRoot: "/var/lib/autonomous-research",
    freeProviderCount: 2,
    canonicalBacktestCallbacksReady: true,
    canonicalLifecycleAdaptersReady: true,
    serverCapacityValidated: true,
    immutableDecisionPolicyReady: true,
  });
  assert.equal(readyPlan.ready, true);
  assert.equal(readyPlan.requiresSeparateApproval, true);
  assert.equal(readyPlan.timerActivationRequested, false);
});

test("end-to-end trace is explicitly contract-only, never profitability evidence", () => {
  const trace = buildAutonomousFactoryContractFixtureTrace({});
  assert.equal(trace.stages.length, 13);
  assert.equal(trace.evidenceClass, "CONTRACT_FIXTURE_ONLY");
  assert.equal(trace.profitabilityEvidence, false);
  assert.equal(trace.naturalForwardEvidence, false);
  assert.equal(trace.safety.LIVE_TRADING, false);
});
