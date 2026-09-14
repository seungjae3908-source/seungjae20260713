import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { sha256Canonical } from "../src/research-cache-provenance.js";
import {
  buildAdaptiveMultiEvidenceE2EAcceptanceV2,
  buildAdaptiveMultiEvidencePaperRuntimeProofV2,
} from "../src/adaptive-multi-evidence-e2e-v2.js";
import { buildAdaptiveMultiEvidenceNaturalPaperCandidateV2 } from "../src/adaptive-multi-evidence-natural-paper-v2.js";
import {
  ADAPTIVE_V2_JOURNAL_EVIDENCE_FAMILIES,
  appendAdaptiveMultiEvidenceJournalRecordV2,
  attributeAdaptiveMultiEvidenceOutcomeV2,
  createAdaptiveMultiEvidenceJournalLedgerV2,
  recordAdaptiveMultiEvidenceDecisionV2,
} from "../src/adaptive-multi-evidence-journal-v2.js";
import { evaluateAdaptiveMultiEvidenceStrategyHealthV2 } from "../src/adaptive-multi-evidence-strategy-health-v2.js";
import {
  createRecurringPaperLoopState,
  restoreRecurringPaperLoopState,
  runRecurringPaperCycle,
  serializeRecurringPaperLoopState,
} from "../src/recurring-paper-loop-v1.js";
import { FOUR_MARKET_EXECUTION_PROFILES } from "../src/four-market-execution-v2.js";
import { PAPER_FORWARD_PROVIDER_AUTHORITY } from "../src/paper-public-provider-authority-v1.js";
import {
  AUTHORITATIVE_NATURAL_PAPER_TRIGGER_SETTLEMENT_EVIDENCE_VERSION,
  createNaturalPaperTriggerBoundSettlementCostProducer,
} from "../src/natural-paper-trigger-bound-settlement-cost-producer-v1.js";

const T0 = 1_800_000_000_000;
const FOUR_HOURS = 4 * 60 * 60 * 1000;
const SHA = "a".repeat(40);
const PARAMETER = "b".repeat(64);
const CID = `generated-formula-candidate:sha256:${"c".repeat(64)}`;
const DECISION_TIME = new Date(T0).toISOString();

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function portfolio() {
  const members = [{ candidateId: CID, side: "BUY" }];
  const core = { lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2", frozenAt: DECISION_TIME,
    prospectiveBoundary: DECISION_TIME, members, memberCount: 1, pairwise: [], diversificationPolicy: {} };
  const digest = sha256Canonical(core);
  return {
    schemaVersion: "adaptive-multi-evidence-strategy-portfolio-v2",
    lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2",
    status: "FROZEN_V2_STRATEGY_PORTFOLIO",
    portfolio: { ...core, portfolioId: `adaptive-v2-portfolio:${digest}`, portfolioDigest: digest,
      immutable: true, executionAuthority: "NONE" },
    frozenV1Contamination: 0,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  };
}

function positionPolicy() {
  return {
    schemaVersion: "adaptive-multi-evidence-position-policy-v2",
    lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2",
    status: "POSITION_POLICY_READY",
    identity: { strategyIdentity: CID, market: "CRYPTO_SPOT", symbol: "BTC", direction: "LONG" },
    sizing: { addedQuantity: 1, liquidityParticipation: 0.001 },
    exits: { hardStop: 95, takeProfit1: { price: 105, fraction: 0.4 },
      takeProfit2: { price: 110, fraction: 0.3 }, validatedPolicyEvidenceId: "validated-policy-v2" },
    executionSimulation: "MARKET_SIM",
    audit: { globalRiskEvidenceId: "global-risk-evidence-v2" },
    positionPolicyEvidenceId: "position-policy-evidence-v2",
    frozenV1Contamination: 0,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  };
}

function costPolicy() {
  return { version: "cost-v2", commissionRate: 0.001, taxRate: 0, spreadRate: 0,
    slippageRate: 0, latencyRate: 0, liquidityImpactRate: 0, partialFillImpactRate: 0, fundingRate: 0 };
}

function executionPolicy() {
  return { version: "execution-v2", fillModel: "TOP_OF_BOOK", sameBarPolicy: "STOP_FIRST",
    allowPartialFill: true, maxParticipationRate: 1 };
}

function execution(now, direction = "BUY") {
  const profile = FOUR_MARKET_EXECUTION_PROFILES.CRYPTO_SPOT;
  return {
    marketAdapterIdentity: profile.marketAdapter,
    costPolicy: costPolicy(),
    executionPolicy: executionPolicy(),
    dataEvidence: {
      provider: profile.provider,
      publicOnly: true,
      dataQuality: "READY",
      provenance: "deterministic-public-point-in-time-e2e",
      asOfMs: now - 1,
      maxAgeMs: 60_000,
      quoteEvidence: { available: true, bid: 99, ask: 100, asOfMs: now - 1, maxAgeMs: 60_000 },
      marketStatus: "TRADABLE",
      tickSize: 1,
      minOrderNotional: 1,
    },
    order: { type: "MARKET", direction, quantity: 1 },
    quote: { bid: 99, ask: 100, bidSize: 10, askSize: 10, asOfMs: now - 1, maxAgeMs: 60_000 },
  };
}

function naturalHandoff() {
  return buildAdaptiveMultiEvidenceNaturalPaperCandidateV2({
    positionPolicy: positionPolicy(),
    strategyFamily: "TREND_FOLLOWING",
    strategyId: "adaptive-v2-trend",
    strategyVersion: "v2",
    parameterHash: PARAMETER,
    parameterDigest: PARAMETER,
    researchCodeSha: SHA,
    signalId: "adaptive-v2-e2e-signal",
    signalTimestampMs: T0 - 2,
    evaluatedAtMs: T0,
    timeframe: "4h",
    executionStyle: "SWING",
    horizon: 4,
    referencePrice: 100,
    entryPrice: 100,
    marketRegime: "TREND_UP",
    expectedNetEvidence: { expectedNetEdge: 0.01, expectedNetReturn: 0.01,
      riskRewardRatio: 2, sampleSize: 30, evidenceId: "prospective-net-v2" },
    naturalEvidence: { provenanceClass: "NATURAL_FORWARD", synthetic: false, replay: false,
      testOnly: false, backfill: false, historical: false, duplicate: false,
      observationId: "adaptive-v2-natural-entry", source: "public-forward-e2e",
      provenance: "deterministic-public-point-in-time-e2e", observedAtMs: T0 - 1 },
    execution: execution(T0),
    executionAuthority: "NONE",
  });
}

function runtimeIdentity() {
  return { strategyId: "adaptive-v2-trend", strategyVersion: "v2", parameterHash: PARAMETER,
    researchCodeSha: SHA, costPolicyVersion: "cost-v2", executionPolicyVersion: "execution-v2" };
}

function ledger() {
  return { status: "READY", initialCapitalKrw: 1_000_000, baseCurrency: "KRW",
    knownEquityKrw: 1_000_000, totalEquityKrw: 1_000_000, simulatedOnly: true,
    liveOrderAllowed: false, privateTradingApiAllowed: false, orderSubmitted: false, exchangeRequestSent: false };
}

function harness() {
  const identity = runtimeIdentity();
  let settlementMutations = 0;
  let saves = 0;
  return {
    identity,
    state: createRecurringPaperLoopState({ identity, ledger: ledger(), createdAtMs: T0 - 10 }),
    ledgerAdapter: {
      async applyEntry({ ledger: current }) { return current; },
      async applySettlement({ ledger: current, settlement }) {
        settlementMutations += 1;
        return { ...current, knownEquityKrw: current.knownEquityKrw + settlement.netPnl,
          totalEquityKrw: current.totalEquityKrw + settlement.netPnl };
      },
    },
    learningAdapter: { async persistSignal() {}, async persistOutcome() {} },
    stateStore: { async save() { saves += 1; } },
    counts: () => ({ settlementMutations, saves }),
  };
}

function run(h, input) {
  return runRecurringPaperCycle({ ...input, ledgerAdapter: h.ledgerAdapter,
    learningAdapter: h.learningAdapter, stateStore: h.stateStore });
}

function positionIdentity(position) {
  return { positionId: position.positionId, paperSampleId: position.paperSampleId, signalId: position.signalId,
    market: position.market, symbol: position.symbol, signalTimeframe: position.sample.identity.timeframe,
    horizon: position.sample.identity.horizon, direction: position.direction, candidateId: position.candidateId,
    strategyFamily: position.strategyFamily, strategyId: position.strategyId, strategyVersion: position.strategyVersion,
    parameterHash: position.parameterHash, parameterDigest: position.parameterDigest,
    researchCodeSha: position.researchCodeSha, costPolicyVersion: position.costPolicyVersion,
    accountMode: position.accountMode };
}

function costEvidence(now) {
  const component = (name, value = 0) => ({ status: "PRESENT", valuePercent: value,
    quality: ["tax", "funding"].includes(name) ? "NOT_APPLICABLE" : name === "commission" ? "DOCUMENTED" : "OBSERVED",
    source: `canonical-${name}-source`, provenance: "deterministic-public-e2e",
    policyIdentity: { version: "cost-v2" }, observedAtMs: now - 1,
    countsAsExecutionCost: true, unavailableIsZero: false });
  return { schemaVersion: "authoritative-paper-execution-cost-sources-v1", status: "PRESENT",
    fullCostReady: true, maximumAgeMs: 60_000,
    components: { commission: component("commission", 0.1), tax: component("tax"), spread: component("spread"),
      slippage: component("slippage"), funding: component("funding"), latency: component("latency"),
      liquidityImpact: component("liquidity-impact"), partialFillImpact: component("partial-fill-impact") },
    supplementalCostInput: { costPolicyId: "cost-v2" }, costPolicyIdentity: { version: "cost-v2" },
    unknownIsZero: false, unavailableCostConvertedToZero: false };
}

function rawExitObservation(state, cycleId, now) {
  const position = state.positions[0];
  const bar = { open: 100, high: 106, low: 99, close: 105 };
  const cycleIdentity = { cycleId, identityFingerprint: state.identityFingerprint, scheduledAtMs: now, startedAtMs: now };
  cycleIdentity.identityDigest = sha256(JSON.stringify(cycleIdentity));
  const binding = state.ledger.accountBinding;
  const accountIdentity = { publisherAccountIdSha256: binding.publisherAccountIdSha256,
    sourceSha: binding.sourceSha, accountIdSha256: sha256(binding.accountId) };
  accountIdentity.identityDigest = sha256(JSON.stringify(accountIdentity));
  const risk = position.lifecycle.riskPolicyIdentity;
  const riskPolicyIdentity = { ...risk, identityDigest: sha256(JSON.stringify(risk)) };
  const authority = PAPER_FORWARD_PROVIDER_AUTHORITY.CRYPTO_SPOT;
  const sourceDigest = sha256(stableJson({ provider: authority.provider, market: position.market,
    symbol: position.symbol, timeframe: authority.timeframe, sourceObservedAtMs: now, ...bar }));
  return {
    observationId: "adaptive-v2-natural-exit",
    positionId: position.positionId,
    paperSampleId: position.paperSampleId,
    signalId: position.signalId,
    market: position.market,
    symbol: position.symbol,
    signalTimeframe: position.sample.identity.timeframe,
    horizon: position.sample.identity.horizon,
    direction: position.direction,
    candidateId: position.candidateId,
    strategyFamily: position.strategyFamily,
    strategyId: position.strategyId,
    strategyVersion: position.strategyVersion,
    parameterHash: position.parameterHash,
    parameterDigest: position.parameterDigest,
    researchCodeSha: position.researchCodeSha,
    costPolicyVersion: position.costPolicyVersion,
    accountMode: position.accountMode,
    publicOnly: true,
    source: authority.provider,
    provenance: "deterministic-public-forward-e2e",
    sourceDigest,
    timeframe: authority.timeframe,
    observedAtMs: now,
    maxAgeMs: authority.maxAgeMs,
    bar,
    closedFrame: { openAtMs: T0, closeAtMs: now, intervalMs: authority.intervalMs,
      closeOffsetMs: authority.closeOffsetMs ?? authority.intervalMs, provider: authority.provider,
      timeframe: authority.timeframe, sourceDigest },
    naturalEvidence: { provenanceClass: "NATURAL_FORWARD", synthetic: false, replay: false,
      testOnly: false, backfill: false, historical: false, duplicate: false,
      observationId: "adaptive-v2-natural-exit", source: authority.provider,
      provenance: "deterministic-public-forward-e2e", observedAtMs: now },
    cycleIdentityDigest: cycleIdentity.identityDigest,
    accountIdentityDigest: accountIdentity.identityDigest,
    entryEvidenceDigest: position.sample.entryEvidenceProvenance.evidenceSnapshotDigest,
    riskPolicyIdentityDigest: riskPolicyIdentity.identityDigest,
    costPolicyIdentity: { version: position.costPolicyVersion },
    schedulerHandoff: { schemaVersion: "paper-scheduler-position-observation-handoff-v1",
      cycleIdentity, accountIdentity, positionIdentity: { ...position.lifecycle.identity },
      entryProvenance: structuredClone(position.sample.entryEvidenceProvenance), riskPolicyIdentity,
      costPolicyIdentity: { version: position.costPolicyVersion },
      naturalSampleCreditAuthority: "IDENTITY_GATES_PASSED", executionAuthority: "NONE" },
    settlementInput: { exitExecution: { ...execution(now), order: undefined, quote: undefined },
      exitBar: { ...bar, timestampMs: now },
      exitQuote: { bid: 105, ask: 106, last: 105, bidSize: 10, askSize: 10, asOfMs: now, maxAgeMs: 60_000 },
      pathBars: [], fundingEvidence: { complete: true, payments: [], evaluatedAtMs: now } },
  };
}

function authoritativeEvidence(position, trigger, observation, evaluatedAtMs) {
  const sourceIdentity = "CANONICAL_PUBLIC_SETTLEMENT_AGGREGATOR_V2";
  const provenanceId = sha256(`settlement:${position.positionId}:${trigger.exitTriggerId}`);
  const exactPosition = positionIdentity(position);
  const exitExecution = observation.settlementInput.exitExecution;
  const exitExecutionIdentity = { exitTriggerId: trigger.exitTriggerId,
    triggerObservationId: trigger.triggerObservationId, triggeredAtMs: trigger.triggeredAtMs,
    positionId: position.positionId, paperSampleId: position.paperSampleId, entryId: position.paperSampleId,
    provider: exitExecution.dataEvidence.provider, market: position.market, symbol: position.symbol,
    timeframe: position.sample.identity.timeframe, horizon: position.sample.identity.horizon,
    direction: position.direction, candidateId: position.candidateId, strategyFamily: position.strategyFamily,
    strategyId: position.strategyId, strategyVersion: position.strategyVersion,
    parameterHash: position.parameterHash, parameterDigest: position.parameterDigest,
    researchCodeSha: position.researchCodeSha, accountMode: position.accountMode,
    costPolicyVersion: position.costPolicyVersion, sourceIdentity, provenanceId,
    exitExecutionDigest: sha256(stableJson(exitExecution)) };
  exitExecutionIdentity.exitExecutionId = sha256(stableJson(exitExecutionIdentity));
  const maximumAgeMs = 60_000;
  const observedAtMs = evaluatedAtMs - 1;
  const settlementCostEvidence = structuredClone(costEvidence(evaluatedAtMs));
  settlementCostEvidence.exitTriggerId = trigger.exitTriggerId;
  settlementCostEvidence.sourceIdentity = sourceIdentity;
  settlementCostEvidence.provenanceId = provenanceId;
  settlementCostEvidence.positionIdentity = exactPosition;
  settlementCostEvidence.exitExecutionIdentity = exitExecutionIdentity;
  settlementCostEvidence.exitExecutionId = exitExecutionIdentity.exitExecutionId;
  settlementCostEvidence.projectedFundingRealized = false;
  for (const [name, component] of Object.entries(settlementCostEvidence.components)) {
    component.sourceIdentity = `CANONICAL_${name.toUpperCase()}_SOURCE_V2`;
    component.provenanceId = sha256(`settlement:${name}:${trigger.exitTriggerId}`);
    component.positionIdentity = exactPosition;
    component.exitExecutionIdentity = exitExecutionIdentity;
    component.observedAtMs = observedAtMs;
    component.freshness = { observedAtMs, maximumAgeMs };
    if (name === "funding") { component.realized = false; component.projectedIsRealized = false; }
  }
  return { schemaVersion: AUTHORITATIVE_NATURAL_PAPER_TRIGGER_SETTLEMENT_EVIDENCE_VERSION,
    status: "PRESENT", fullCostReady: true, sourceIdentity, provenanceId,
    positionIdentity: exactPosition, exitExecutionIdentity,
    exitExecutionId: exitExecutionIdentity.exitExecutionId, freshness: { observedAtMs, maximumAgeMs },
    settlementInput: { ...structuredClone(observation.settlementInput), exitTriggerId: trigger.exitTriggerId,
      exitExecutionId: exitExecutionIdentity.exitExecutionId },
    settlementCostEvidence, unknownIsZero: false, unavailableCostConvertedToZero: false,
    synthetic: false, replay: false, backfill: false, duplicate: false, historical: false, testOnly: false,
    executionAuthority: "NONE", liveOrderAllowed: false, privateTradingApiAllowed: false,
    orderSubmitted: false, exchangeRequestSent: false };
}

function facts() {
  return ADAPTIVE_V2_JOURNAL_EVIDENCE_FAMILIES.map((family) => ({ family,
    status: "AVAILABLE", directionalStance: family === "TREND" ? "SUPPORTS" : "NEUTRAL",
    observedAtMs: T0 - 10, evidenceIds: [`evidence-${family}`] }));
}

function stagePhases(handoff, journal, outcome, health) {
  const base = { lineageId: "ADAPTIVE_MULTI_EVIDENCE_V2", frozenV1Contamination: 0,
    liveTrading: false, autoTrading: false, realOrderEnabled: false,
    privateTradingApiAllowed: false, executionAuthority: "NONE" };
  return {
    phase3MarketFeatures: { ...base, schemaVersion: "adaptive-multi-evidence-market-features-v2",
      status: "READY_FOR_SPECIALIST_RESEARCH_ONLY", decisionTime: DECISION_TIME, contentDigest: "market-features-1" },
    phase4Regime: { ...base, schemaVersion: "adaptive-multi-evidence-regime-router-v2",
      status: "READY_FOR_STRATEGY_ROUTING_RESEARCH_ONLY", decisionTime: DECISION_TIME,
      sourceContentDigest: "market-features-1" },
    phase5Events: { ...base, schemaVersion: "adaptive-multi-evidence-event-normalization-v2",
      status: "READY_FOR_DEDUP_RESEARCH_ONLY", decisionTime: DECISION_TIME },
    phase6Research: { ...base, schemaVersion: "adaptive-multi-evidence-research-ingest-v2",
      status: "READY_FOR_DEDUP_RESEARCH_ONLY", decisionTime: DECISION_TIME },
    phase7Independence: { ...base, schemaVersion: "adaptive-multi-evidence-independence-v2",
      status: "GROUPED_FOR_RESEARCH_ONLY", decisionTime: DECISION_TIME },
    phase8Tournament: { ...base, schemaVersion: "adaptive-multi-evidence-formula-tournament-v2",
      status: "READY_FOR_VALIDATION_PIPELINE", tournamentId: "tournament-1" },
    phase9Validation: { ...base, schemaVersion: "adaptive-multi-evidence-validation-v2",
      status: "VALIDATED_FINALISTS_AVAILABLE", tournamentId: "tournament-1" },
    phase10Portfolio: portfolio(),
    phase11Decision: { ...base, schemaVersion: "adaptive-multi-evidence-meta-decision-v2",
      status: "RESEARCH_DECISION_READY", strategyIdentity: CID },
    phase12CostLiquidity: { ...base, schemaVersion: "adaptive-multi-evidence-cost-liquidity-v2",
      status: "COST_LIQUIDITY_GATE_PASS", cost: { strategyIdentity: CID } },
    phase13GlobalRisk: { ...base, schemaVersion: "adaptive-multi-evidence-global-risk-v2", status: "GLOBAL_RISK_PASS" },
    phase14Position: positionPolicy(),
    phase15NaturalPaper: handoff,
    phase16DecisionJournal: journal,
    phase16OutcomeJournal: outcome,
    phase17Health: health,
  };
}

test("Phase 3 through 18 reaches one genuine V2 Paper closed loop while runtime activation stays off", async () => {
  const handoff = naturalHandoff();
  assert.equal(handoff.status, "NATURAL_PAPER_CANDIDATE_READY_INACTIVE", handoff.blockers?.join("|"));
  const h = harness();
  const openedRaw = await run(h, { state: h.state,
    cycle: { cycleId: "e2e-open", evaluatedAtMs: T0, identity: h.identity }, candidates: [handoff.candidate] });
  assert.equal(openedRaw.summary.entries, 1);
  const boundState = structuredClone(openedRaw.state);
  boundState.ledger.accountBinding = { accountId: "paper-account-v2",
    publisherAccountIdSha256: "d".repeat(64), sourceSha: SHA };
  boundState.ledger.reservations = [{ status: "OPEN", positionId: boundState.positions[0].positionId,
    paperSampleId: boundState.positions[0].paperSampleId }];
  const opened = { ...openedRaw, state: boundState };
  const restartedState = restoreRecurringPaperLoopState(serializeRecurringPaperLoopState(boundState), h.identity);
  const closeAt = T0 + FOUR_HOURS;
  const observation = rawExitObservation(restartedState, "e2e-close", closeAt);
  const producer = createNaturalPaperTriggerBoundSettlementCostProducer({
    async collectAuthoritativeEvidence({ position, exitTrigger, evaluatedAtMs }) {
      return authoritativeEvidence(position, exitTrigger, observation, evaluatedAtMs);
    },
  });
  const settled = await run(h, { state: restartedState,
    cycle: { cycleId: "e2e-close", evaluatedAtMs: closeAt, identity: h.identity },
    positionObservations: [observation], settlementCostProducer: producer });
  assert.equal(settled.summary.tradesSettled, 1,
    JSON.stringify(settled.summary.canonicalNaturalStageEvidence.reasonObservations));
  assert.equal(settled.state.settlements[0].naturalSampleCredit, 1);
  const duplicate = await run(h, { state: settled.state,
    cycle: { cycleId: "e2e-next", evaluatedAtMs: closeAt + 1, identity: h.identity },
    positionObservations: [observation], settlementCostProducer: producer });
  const runtimeProof = buildAdaptiveMultiEvidencePaperRuntimeProofV2({
    candidateId: CID, opened, restartedState, settled, duplicate,
  });
  assert.equal(runtimeProof.status, "PAPER_CLOSED_LOOP_PASS", runtimeProof.blockers.join("|"));

  const journal = recordAdaptiveMultiEvidenceDecisionV2({ action: "TAKE", decisionTimeMs: T0,
    capturedAtMs: T0 - 1, naturalPaperHandoff: handoff, facts: facts(),
    inferences: [{ statement: "trend evidence may persist", evidenceIds: ["evidence-TREND"],
      uncertainty: "future path remains unknown" }], uncertainties: ["future path remains unknown"],
    reasonCodes: ["ALL_GATES_PASS"], positionPolicyEvidenceId: "position-policy-evidence-v2",
    decisionContext: { marketRegime: "TREND_UP", higherTimeframeContext: "ALIGNED" },
    executionCostEstimate: { totalExplicitCost: 0.2, slippageCost: 0.01,
      evidenceId: "pre-decision-full-cost-v2" }, executionAuthority: "NONE" });
  assert.equal(journal.status, "PRE_DECISION_RECORDED", journal.blockers?.join("|"));
  const settlement = settled.state.settlements[0];
  const outcome = attributeAdaptiveMultiEvidenceOutcomeV2({ decisionRecord: journal,
    attributedAtMs: closeAt + 1, settlement: { ...settlement,
      signalId: handoff.candidate.signal.signalId, realizedSlippageCost: 0.01 } });
  assert.equal(outcome.status, "OUTCOME_ATTRIBUTED_RESEARCH_ONLY", outcome.blockers?.join("|"));
  const journalLedger = appendAdaptiveMultiEvidenceJournalRecordV2(
    appendAdaptiveMultiEvidenceJournalRecordV2(createAdaptiveMultiEvidenceJournalLedgerV2(), journal),
    outcome,
  );
  assert.equal(journalLedger.recordCount, 2);
  const health = evaluateAdaptiveMultiEvidenceStrategyHealthV2({ portfolio: portfolio(), candidateId: CID,
    journalEntries: [outcome], policy: { version: "health-v2", minimumSampleSize: 5,
      reducedRiskMultiplier: 0.5,
      watch: { minimumNetExpectancyPercent: 0, minimumProfitFactor: 1, maximumDrawdownPercent: 10,
        maximumCostDriftPercent: 20, maximumSlippageDriftPercent: 20, minimumFillRatePercent: 80 },
      reduceRisk: { minimumNetExpectancyPercent: -0.5, minimumProfitFactor: 0.8, maximumDrawdownPercent: 20,
        maximumCostDriftPercent: 40, maximumSlippageDriftPercent: 40, minimumFillRatePercent: 60 },
      blockNewEntry: { minimumNetExpectancyPercent: -1, minimumProfitFactor: 0.5, maximumDrawdownPercent: 30,
        maximumCostDriftPercent: 80, maximumSlippageDriftPercent: 80, minimumFillRatePercent: 30 } },
    executionAuthority: "NONE" });
  assert.equal(health.health.status, "INSUFFICIENT_EVIDENCE");
  const acceptance = buildAdaptiveMultiEvidenceE2EAcceptanceV2({
    phases: stagePhases(handoff, journal, outcome, health), paperRuntimeProof: runtimeProof,
    journalLedger, executionAuthority: "NONE",
  });
  assert.equal(acceptance.status, "FULL_E2E_PASS_INACTIVE", acceptance.blockers.join("|"));
  assert.equal(acceptance.phaseAcceptance.every((row) => row.passed), true);
  assert.equal(acceptance.paperRuntime.fullCostReady, true);
  assert.equal(acceptance.scheduleActive, false);
  assert.equal(acceptance.naturalPaperRuntimeActivated, false);
  assert.equal(acceptance.finalHumanStop, "NATURAL_PAPER_24_7_ACTIVATION_APPROVAL_REQUIRED");
  assert.equal(acceptance.frozenV1Contamination, 0);
  assert.equal(acceptance.realOrderCount, 0);
  assert.equal(acceptance.privateTradingApiCallCount, 0);
  assert.equal(acceptance.executionAuthority, "NONE");
  assert.equal(h.counts().settlementMutations, 1);
});

test("identity discontinuity, replayed settlement, and any execution authority block final acceptance", () => {
  const invalidProof = buildAdaptiveMultiEvidencePaperRuntimeProofV2({ candidateId: CID,
    opened: { summary: { entries: 0 }, state: { positions: [], samples: [] } }, restartedState: {},
    settled: {}, duplicate: {} });
  assert.equal(invalidProof.status, "BLOCKED_DATA");
  assert.ok(invalidProof.blockers.includes("V2_E2E_ENTRY_FILL_POSITION_NOT_PROVEN"));
  const blocked = buildAdaptiveMultiEvidenceE2EAcceptanceV2({ phases: {},
    paperRuntimeProof: invalidProof, executionAuthority: "LIVE" });
  assert.equal(blocked.status, "FULL_E2E_BLOCKED");
  assert.ok(blocked.blockers.includes("V2_E2E_EXECUTION_AUTHORITY_FORBIDDEN"));
  assert.equal(blocked.scheduleActive, false);
  assert.equal(blocked.realOrderCount, 0);
  assert.equal(blocked.privateTradingApiCallCount, 0);
});
