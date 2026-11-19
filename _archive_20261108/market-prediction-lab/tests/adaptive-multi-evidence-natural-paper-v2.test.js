import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAdaptiveMultiEvidenceNaturalPaperCandidateV2,
  isAdaptiveMultiEvidenceV2FrozenCandidateId,
} from "../src/adaptive-multi-evidence-natural-paper-v2.js";
import {
  createRecurringPaperLoopState,
  restoreRecurringPaperLoopState,
  runRecurringPaperCycle,
  serializeRecurringPaperLoopState,
} from "../src/recurring-paper-loop-v1.js";
import { FOUR_MARKET_EXECUTION_PROFILES } from "../src/four-market-execution-v2.js";

const T0 = 1_800_000_000_000;
const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);
const CANDIDATE_ID = `generated-formula-candidate:sha256:${"c".repeat(64)}`;

function positionPolicy(overrides = {}) {
  return {
    schemaVersion: "adaptive-multi-evidence-position-policy-v2",
    lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2",
    status: "POSITION_POLICY_READY",
    identity: {
      strategyIdentity: CANDIDATE_ID,
      market: "US_STOCK",
      symbol: "AAPL",
      direction: "LONG",
    },
    sizing: { addedQuantity: 10, liquidityParticipation: 0.001 },
    exits: {
      hardStop: 95,
      takeProfit1: { price: 110, fraction: 0.4 },
      takeProfit2: { price: 120, fraction: 0.3 },
      validatedPolicyEvidenceId: "validated-policy-1",
    },
    executionSimulation: "LIMIT_SIM",
    audit: { globalRiskEvidenceId: "risk-evidence-1" },
    frozenV1Contamination: 0,
    executionAuthority: "NONE",
    ...overrides,
  };
}

function input(overrides = {}) {
  const asOfMs = T0 - 1;
  return {
    positionPolicy: positionPolicy(),
    strategyFamily: "TREND_FOLLOWING",
    strategyId: "adaptive-v2-trend",
    strategyVersion: "v2",
    parameterHash: DIGEST,
    parameterDigest: DIGEST,
    researchCodeSha: SHA,
    signalId: "adaptive-v2-signal-1",
    signalTimestampMs: T0 - 2,
    evaluatedAtMs: T0,
    timeframe: "1h",
    executionStyle: "SWING",
    horizon: 24,
    referencePrice: 100,
    entryPrice: 100,
    marketRegime: "TREND_UP",
    expectedNetEvidence: {
      expectedNetEdge: 0.01,
      expectedNetReturn: 0.01,
      riskRewardRatio: 2,
      sampleSize: 30,
      evidenceId: "prospective-net-1",
    },
    naturalEvidence: {
      provenanceClass: "NATURAL_FORWARD",
      synthetic: false,
      replay: false,
      testOnly: false,
      backfill: false,
      historical: false,
      duplicate: false,
      observationId: "natural-adaptive-v2-1",
      source: "adaptive-multi-evidence-natural-paper-v2.test",
      observedAtMs: asOfMs,
    },
    execution: {
      marketAdapterIdentity: FOUR_MARKET_EXECUTION_PROFILES.US_STOCK.marketAdapter,
      costPolicy: {
        version: "cost-v2",
        commissionRate: 0.001,
        taxRate: 0,
        spreadRate: 0,
        slippageRate: 0,
        latencyRate: 0,
        liquidityImpactRate: 0,
        partialFillImpactRate: 0,
        fundingRate: 0,
      },
      executionPolicy: {
        version: "execution-v2",
        fillModel: "TOP_OF_BOOK",
        sameBarPolicy: "STOP_FIRST",
        allowPartialFill: true,
        maxParticipationRate: 1,
      },
      dataEvidence: {
        provider: FOUR_MARKET_EXECUTION_PROFILES.US_STOCK.provider,
        publicOnly: true,
        dataQuality: "READY",
        provenance: "public-point-in-time-fixture",
        asOfMs,
        maxAgeMs: 60_000,
        tickSize: 0.01,
        taxPolicyKnown: true,
        session: { version: "us-v1", status: "OPEN", kind: "REGULAR" },
      },
      order: { type: "LIMIT", direction: "BUY", quantity: 10, limitPrice: 101 },
      quote: { bid: 99, ask: 100, bidSize: 100, askSize: 100, asOfMs, maxAgeMs: 60_000 },
    },
    executionAuthority: "NONE",
    ...overrides,
  };
}

function ledger() {
  return {
    status: "READY",
    initialCapitalKrw: 1_000_000,
    baseCurrency: "KRW",
    knownEquityKrw: 1_000_000,
    totalEquityKrw: 1_000_000,
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

function harness() {
  const identity = {
    strategyId: "adaptive-v2-trend",
    strategyVersion: "v2",
    parameterHash: DIGEST,
    researchCodeSha: SHA,
    costPolicyVersion: "cost-v2",
    executionPolicyVersion: "execution-v2",
  };
  let entries = 0;
  let saves = 0;
  return {
    identity,
    state: createRecurringPaperLoopState({ identity, ledger: ledger(), createdAtMs: T0 - 10 }),
    ledgerAdapter: {
      async applyEntry({ ledger: current }) { entries += 1; return current; },
      async applySettlement({ ledger: current }) { return current; },
    },
    learningAdapter: {
      async persistSignal() {},
      async persistOutcome() {},
    },
    stateStore: { async save() { saves += 1; } },
    counts: () => ({ entries, saves }),
  };
}

test("V2 frozen candidate is handed to the existing Natural Paper owners without changing identity", async () => {
  const handoff = buildAdaptiveMultiEvidenceNaturalPaperCandidateV2(input());
  assert.equal(handoff.status, "NATURAL_PAPER_CANDIDATE_READY_INACTIVE", handoff.blockers.join("|"));
  assert.equal(isAdaptiveMultiEvidenceV2FrozenCandidateId(CANDIDATE_ID), true);
  assert.equal(handoff.candidate.candidateId, CANDIDATE_ID);
  assert.equal(handoff.candidate.signal.strategyIdentity.candidateId, CANDIDATE_ID);
  assert.equal(handoff.cycleContract.recurringOwner, "recurring-paper-loop-v1");
  assert.equal(handoff.scheduleActive, false);

  const h = harness();
  const cycle = { cycleId: "adaptive-v2-cycle-1", evaluatedAtMs: T0, identity: h.identity };
  const opened = await runRecurringPaperCycle({
    state: h.state,
    cycle,
    candidates: [handoff.candidate],
    ledgerAdapter: h.ledgerAdapter,
    learningAdapter: h.learningAdapter,
    stateStore: h.stateStore,
  });
  assert.equal(opened.summary.entries, 1, JSON.stringify({ summary: opened.summary, samples: opened.state.samples }));
  assert.equal(opened.state.samples[0].identity.candidateId, CANDIDATE_ID);
  assert.equal(opened.state.positions[0].candidateId, CANDIDATE_ID);
  assert.equal(opened.state.positions[0].lifecycle.strategyIdentity.candidateId, CANDIDATE_ID);
  assert.deepEqual(h.counts(), { entries: 1, saves: 1 });
});

test("same cycle replay, restart restore, and duplicate entry are non-mutating", async () => {
  const handoff = buildAdaptiveMultiEvidenceNaturalPaperCandidateV2(input());
  assert.equal(handoff.status, "NATURAL_PAPER_CANDIDATE_READY_INACTIVE", handoff.blockers.join("|"));
  const h = harness();
  const cycle = { cycleId: "adaptive-v2-cycle-1", evaluatedAtMs: T0, identity: h.identity };
  const opened = await runRecurringPaperCycle({
    state: h.state, cycle, candidates: [handoff.candidate], ledgerAdapter: h.ledgerAdapter,
    learningAdapter: h.learningAdapter, stateStore: h.stateStore,
  });
  const restored = restoreRecurringPaperLoopState(serializeRecurringPaperLoopState(opened.state), h.identity);
  assert.equal(restored.positions.length, 1, JSON.stringify({ summary: opened.summary, samples: opened.state.samples }));
  const replayed = await runRecurringPaperCycle({
    state: restored, cycle, candidates: [handoff.candidate], ledgerAdapter: h.ledgerAdapter,
    learningAdapter: h.learningAdapter, stateStore: h.stateStore,
  });
  assert.equal(replayed.summary.replayed, true);
  assert.equal(replayed.summary.entries, 0);
  assert.equal(replayed.state.positions.length, 1);
  assert.deepEqual(h.counts(), { entries: 1, saves: 1 });
});

test("quantity and immutable candidate identity mismatch fail before the recurring owner", () => {
  const wrongQuantity = input();
  wrongQuantity.execution.order.quantity = 11;
  const quantityResult = buildAdaptiveMultiEvidenceNaturalPaperCandidateV2(wrongQuantity);
  assert.equal(quantityResult.status, "BLOCKED_DATA");
  assert.ok(quantityResult.blockers.includes("V2_NATURAL_PAPER_SIMULATED_ORDER_INVALID"));

  const foreign = positionPolicy({ identity: { ...positionPolicy().identity, strategyIdentity: "strategy-1" } });
  const identityResult = buildAdaptiveMultiEvidenceNaturalPaperCandidateV2(input({ positionPolicy: foreign }));
  assert.equal(identityResult.status, "BLOCKED_DATA");
  assert.ok(identityResult.blockers.includes("V2_NATURAL_PAPER_STRATEGY_IDENTITY_INVALID"));
});

test("synthetic, backfill, replay, private, and authority-bearing inputs fail closed", () => {
  for (const flag of ["synthetic", "backfill", "replay", "duplicate"]) {
    const base = input();
    base.naturalEvidence[flag] = true;
    const result = buildAdaptiveMultiEvidenceNaturalPaperCandidateV2(base);
    assert.equal(result.status, "BLOCKED_DATA", flag);
    assert.ok(result.blockers.includes("V2_NATURAL_PAPER_GENUINE_FORWARD_EVIDENCE_REQUIRED"));
  }
  const privateInput = input();
  privateInput.execution.dataEvidence.publicOnly = false;
  const privateResult = buildAdaptiveMultiEvidenceNaturalPaperCandidateV2(privateInput);
  assert.ok(privateResult.blockers.includes("V2_NATURAL_PAPER_PUBLIC_EVIDENCE_INVALID"));
  const authority = buildAdaptiveMultiEvidenceNaturalPaperCandidateV2(input({ executionAuthority: "PAPER" }));
  assert.equal(authority.status, "BLOCKED_DATA");
  assert.equal(authority.scheduleActive, false);
  assert.equal(authority.runtimeActivated, false);
  assert.equal(authority.realOrderEnabled, false);
  assert.equal(authority.privateTradingApiAllowed, false);
  assert.equal(authority.executionAuthority, "NONE");
  assert.equal(authority.frozenV1Contamination, 0);
});
