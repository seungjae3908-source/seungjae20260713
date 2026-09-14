import assert from "node:assert/strict";
import test from "node:test";
import {
  ADAPTIVE_V2_JOURNAL_EVIDENCE_FAMILIES,
  appendAdaptiveMultiEvidenceJournalRecordV2,
  attributeAdaptiveMultiEvidenceOutcomeV2,
  createAdaptiveMultiEvidenceJournalLedgerV2,
  recordAdaptiveMultiEvidenceDecisionV2,
} from "../src/adaptive-multi-evidence-journal-v2.js";

const T0 = 1_800_000_000_000;
const CID = `generated-formula-candidate:sha256:${"c".repeat(64)}`;

function identity() {
  return {
    candidateId: CID,
    signalId: "signal-1",
    strategyId: "adaptive-v2-trend",
    strategyVersion: "v2",
    strategyFamily: "TREND_FOLLOWING",
    parameterDigest: "b".repeat(64),
    researchCodeSha: "a".repeat(40),
    market: "US_STOCK",
    symbol: "AAPL",
    timeframe: "1h",
    side: "BUY",
  };
}

function handoff() {
  const id = identity();
  return {
    schemaVersion: "adaptive-multi-evidence-natural-paper-v2",
    lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2",
    status: "NATURAL_PAPER_CANDIDATE_READY_INACTIVE",
    handoffDigest: "handoff-1",
    candidate: {
      candidateId: CID,
      signal: {
        signalId: id.signalId,
        market: id.market,
        symbol: id.symbol,
        timeframe: id.timeframe,
        direction: id.side,
        strategyIdentity: id,
      },
      order: { type: "LIMIT", quantity: 10, direction: "BUY", limitPrice: 101 },
    },
    executionAuthority: "NONE",
    frozenV1Contamination: 0,
  };
}

function facts() {
  return ADAPTIVE_V2_JOURNAL_EVIDENCE_FAMILIES.map((family, index) => ({
    family,
    status: index < 8 ? "AVAILABLE" : "NOT_APPLICABLE",
    directionalStance: index % 3 === 0 ? "SUPPORTS" : "NEUTRAL",
    observedAtMs: T0 - 10,
    evidenceIds: index < 8 ? [`evidence-${family}`] : [],
  }));
}

function takeInput(overrides = {}) {
  return {
    action: "TAKE",
    decisionTimeMs: T0,
    capturedAtMs: T0 - 1,
    naturalPaperHandoff: handoff(),
    facts: facts(),
    inferences: [{ statement: "trend may persist", evidenceIds: ["evidence-TREND"], uncertainty: "regime can change" }],
    uncertainties: ["future path unknown"],
    reasonCodes: ["ALL_GATES_PASS"],
    decisionContext: { marketRegime: "TREND_UP", higherTimeframeContext: "ALIGNED" },
    positionPolicyEvidenceId: "position-policy-1",
    executionAuthority: "NONE",
    ...overrides,
  };
}

test("pre-decision journal separates fact, inference, uncertainty, decision, execution, and outcome", () => {
  const result = recordAdaptiveMultiEvidenceDecisionV2(takeInput());
  assert.equal(result.status, "PRE_DECISION_RECORDED");
  assert.equal(result.record.fact.length, ADAPTIVE_V2_JOURNAL_EVIDENCE_FAMILIES.length);
  assert.equal(result.record.inference[0].statement, "trend may persist");
  assert.deepEqual(result.record.uncertainty, ["future path unknown"]);
  assert.equal(result.record.decision.action, "TAKE");
  assert.equal(result.record.execution.status, "PAPER_PLAN_READY_INACTIVE");
  assert.equal(result.record.outcome, null);
  assert.equal(result.hindsightDecisionRewriteAllowed, false);
});

test("NO_TRADE is durable with reasons and receives zero economic credit", () => {
  const result = recordAdaptiveMultiEvidenceDecisionV2({
    ...takeInput(),
    action: "NO_TRADE",
    naturalPaperHandoff: undefined,
    identity: identity(),
    reasonCodes: ["HIGH_SPREAD", "NEGATIVE_COST_ADJUSTED_EV"],
  });
  assert.equal(result.status, "PRE_DECISION_RECORDED");
  assert.equal(result.record.execution.status, "NOT_REQUESTED");
  assert.equal(result.counterfactualObservationAllowed, true);
  assert.equal(result.economicSampleCredit, 0);
  assert.equal(result.counterfactualEconomicCreditAllowed, false);
});

test("settled full-cost outcome is appended without rewriting pre-decision state", () => {
  const decision = recordAdaptiveMultiEvidenceDecisionV2(takeInput());
  const outcome = attributeAdaptiveMultiEvidenceOutcomeV2({
    decisionRecord: decision,
    attributedAtMs: T0 + 200,
    settlement: {
      candidateId: CID,
      signalId: "signal-1",
      paperSampleId: "paper-1",
      settlementId: "settlement-1",
      settledAtMs: T0 + 100,
      grossPnl: 120,
      totalExplicitCost: 20,
      netPnl: 100,
      netReturnPercent: 1,
      exitReason: "TAKE_PROFIT",
      estimatedExplicitCost: 18,
      estimatedSlippageCost: 4,
      realizedSlippageCost: 5,
    },
  });
  assert.equal(outcome.status, "OUTCOME_ATTRIBUTED_RESEARCH_ONLY");
  assert.equal(outcome.preDecisionStateRewritten, false);
  assert.equal(outcome.immutablePreDecisionDigest, decision.record.immutablePreDecisionDigest);
  assert.equal(outcome.record.outcome.costEstimateError, 2);
  assert.equal(outcome.record.outcome.slippageEstimateError, 1);
  assert.equal(outcome.record.outcome.causalAttributionProven, false);
  assert.equal(outcome.record.outcome.singleTradeWeightRewriteAllowed, false);
  assert.equal(outcome.economicSampleCredit, 0);
});

test("future evidence, mismatched outcome, and incomplete costs fail closed", () => {
  const future = facts();
  future[0].observedAtMs = T0 + 1;
  const decision = recordAdaptiveMultiEvidenceDecisionV2(takeInput({ facts: future }));
  assert.equal(decision.status, "BLOCKED_DATA");
  assert.ok(decision.blockers.includes("V2_JOURNAL_FACT_SNAPSHOT_INCOMPLETE_OR_FUTURE"));

  const valid = recordAdaptiveMultiEvidenceDecisionV2(takeInput());
  const badOutcome = attributeAdaptiveMultiEvidenceOutcomeV2({
    decisionRecord: valid,
    attributedAtMs: T0 + 200,
    settlement: { candidateId: "wrong", signalId: "signal-1", paperSampleId: "paper-1",
      settlementId: "settlement-1", settledAtMs: T0 + 100, grossPnl: 120, totalExplicitCost: null, netPnl: 100 },
  });
  assert.equal(badOutcome.status, "BLOCKED_DATA");
  assert.ok(badOutcome.blockers.includes("V2_OUTCOME_SETTLEMENT_IDENTITY_MISMATCH"));
  assert.ok(badOutcome.blockers.includes("V2_OUTCOME_FULL_COST_EVIDENCE_INVALID"));
});

test("append-only ledger is idempotent and detects same-decision conflicts", () => {
  const decision = recordAdaptiveMultiEvidenceDecisionV2(takeInput());
  const empty = createAdaptiveMultiEvidenceJournalLedgerV2();
  const once = appendAdaptiveMultiEvidenceJournalRecordV2(empty, decision);
  const replay = appendAdaptiveMultiEvidenceJournalRecordV2(once, decision);
  assert.equal(replay, once);
  assert.equal(replay.recordCount, 1);
  const changed = { ...decision, record: { ...decision.record, uncertainty: ["rewritten after outcome"] } };
  assert.throws(() => appendAdaptiveMultiEvidenceJournalRecordV2(once, changed), /V2_JOURNAL_RECORD_CONFLICT/);
  assert.equal(replay.realOrderEnabled, false);
  assert.equal(replay.privateTradingApiAllowed, false);
  assert.equal(replay.executionAuthority, "NONE");
  assert.equal(replay.frozenV1Contamination, 0);
});
