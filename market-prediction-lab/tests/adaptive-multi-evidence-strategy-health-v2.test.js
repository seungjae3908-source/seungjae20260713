import assert from "node:assert/strict";
import test from "node:test";
import { sha256Canonical } from "../src/research-cache-provenance.js";
import { evaluateAdaptiveMultiEvidenceStrategyHealthV2 } from "../src/adaptive-multi-evidence-strategy-health-v2.js";

const CID = `generated-formula-candidate:sha256:${"c".repeat(64)}`;

function portfolio() {
  const members = [{ candidateId: CID, side: "BUY" }];
  const core = { lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2", frozenAt: "2026-09-14T06:00:00.000Z",
    prospectiveBoundary: "2026-09-14T06:00:00.000Z", members, memberCount: 1, pairwise: [], diversificationPolicy: {} };
  const digest = sha256Canonical(core);
  return { schemaVersion: "adaptive-multi-evidence-strategy-portfolio-v2", lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2",
    status: "FROZEN_V2_STRATEGY_PORTFOLIO", portfolio: { ...core, portfolioId: `adaptive-v2-portfolio:${digest}`,
      portfolioDigest: digest, immutable: true, executionAuthority: "NONE" }, frozenV1Contamination: 0,
    executionAuthority: "NONE" };
}

function entry(index, netReturnPercent = null, overrides = {}) {
  const outcome = netReturnPercent == null ? null : {
    netReturnPercent,
    totalExplicitCost: 10,
    estimatedExplicitCost: 10,
    realizedSlippageCost: 2,
    estimatedSlippageCost: 2,
  };
  return {
    schemaVersion: "adaptive-multi-evidence-journal-v2",
    status: outcome ? "OUTCOME_ATTRIBUTED_RESEARCH_ONLY" : "PRE_DECISION_RECORDED",
    record: {
      decisionRecordId: `decision-${index}`,
      identity: { candidateId: CID },
      decision: { action: "TAKE" },
      decisionContext: { marketRegime: index % 2 ? "TREND_UP" : "RANGE" },
      outcome,
    },
    frozenV1Contamination: 0,
    executionAuthority: "NONE",
    ...overrides,
  };
}

const policy = {
  version: "health-v2",
  minimumSampleSize: 5,
  reducedRiskMultiplier: 0.5,
  watch: { minimumNetExpectancyPercent: 0.1, minimumProfitFactor: 1.1, maximumDrawdownPercent: 12,
    maximumCostDriftPercent: 20, maximumSlippageDriftPercent: 20, minimumFillRatePercent: 80 },
  reduceRisk: { minimumNetExpectancyPercent: -0.25, minimumProfitFactor: 0.8, maximumDrawdownPercent: 20,
    maximumCostDriftPercent: 40, maximumSlippageDriftPercent: 40, minimumFillRatePercent: 60 },
  blockNewEntry: { minimumNetExpectancyPercent: -0.75, minimumProfitFactor: 0.5, maximumDrawdownPercent: 35,
    maximumCostDriftPercent: 80, maximumSlippageDriftPercent: 80, minimumFillRatePercent: 30 },
};

function evaluate(journalEntries, overrides = {}) {
  return evaluateAdaptiveMultiEvidenceStrategyHealthV2({ portfolio: portfolio(), candidateId: CID,
    journalEntries, policy, executionAuthority: "NONE", ...overrides });
}

test("small prospective N stays insufficient without declaring the frozen strategy broken", () => {
  const result = evaluate([entry(1, 1), entry(2, -0.5)]);
  assert.equal(result.status, "STRATEGY_HEALTH_EVALUATED");
  assert.equal(result.health.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(result.health.smallNDoesNotImplyBroken, true);
  assert.equal(result.health.entryDirective, "KEEP_CURRENT_FROZEN_UNCHANGED");
  assert.equal(result.challengerFeedback, null);
});

test("healthy accumulated outcomes produce NORMAL with regime-specific performance", () => {
  const result = evaluate([entry(1, 1), entry(2, -0.2), entry(3, 1.2), entry(4, -0.2), entry(5, 1)]);
  assert.equal(result.health.status, "NORMAL");
  assert.equal(result.health.metrics.sampleSize, 5);
  assert.equal(result.health.metrics.winRatePercent, 60);
  assert.equal(result.health.metrics.regimePerformance.length, 2);
  assert.equal(result.currentFrozenPortfolioUnchanged, true);
});

test("degradation reduces risk and creates only a prospective challenger research request", () => {
  const result = evaluate([entry(1, 0.4), entry(2, -0.5), entry(3, -0.4), entry(4, 0.3), entry(5, -0.4)], {
    nextChallengerVersion: "v2.1",
  });
  assert.equal(result.health.status, "REDUCE_RISK");
  assert.equal(result.health.riskMultiplier, 0.5);
  assert.equal(result.challengerFeedback.status, "CHALLENGER_RESEARCH_REQUESTED");
  assert.equal(result.challengerFeedback.challengerVersion, "v2.1");
  assert.equal(result.challengerFeedback.automaticPromotionAllowed, false);
  assert.ok(result.challengerFeedback.requiredPipeline.includes("OOS"));
  assert.ok(result.challengerFeedback.requiredPipeline.includes("HUMAN_PROMOTION_DECISION"));
});

test("severe accumulated evidence blocks new entry but never mutates or promotes", () => {
  const result = evaluate([entry(1, -2), entry(2, -2), entry(3, -2), entry(4, -2), entry(5, 0.1)], {
    nextChallengerVersion: "v2.2",
  });
  assert.equal(result.health.status, "BLOCK_NEW_ENTRY");
  assert.equal(result.health.riskMultiplier, 0);
  assert.equal(result.currentFrozenPortfolioUnchanged, true);
  assert.equal(result.currentFrozenPortfolioMutationAllowed, false);
  assert.equal(result.onlineHindsightTuningAllowed, false);
  assert.equal(result.automaticChallengerPromotionAllowed, false);
  assert.equal(result.promotionAuthority, false);
});

test("missing metrics, duplicates, foreign lineage, and authority fail closed", () => {
  const missing = evaluate([entry(1, null), entry(2, null), entry(3, null), entry(4, null), entry(5, null)]);
  assert.equal(missing.health.status, "INSUFFICIENT_EVIDENCE");
  assert.ok(missing.health.reasons.includes("CORE_HEALTH_METRICS_UNAVAILABLE"));
  const duplicate = evaluate([entry(1, 1), entry(1, 1)]);
  assert.equal(duplicate.status, "BLOCKED_DATA");
  assert.ok(duplicate.blockers.includes("V2_STRATEGY_HEALTH_DUPLICATE_DECISION_RECORD"));
  const forbidden = evaluate([], { executionAuthority: "PAPER" });
  assert.equal(forbidden.status, "BLOCKED_DATA");
  assert.equal(forbidden.frozenV1Contamination, 0);
  assert.equal(forbidden.realOrderEnabled, false);
  assert.equal(forbidden.privateTradingApiAllowed, false);
  assert.equal(forbidden.executionAuthority, "NONE");
});
