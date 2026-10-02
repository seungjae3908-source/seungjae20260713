import { sha256Canonical } from "./research-cache-provenance.js";
import { ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID } from "./adaptive-multi-evidence-point-in-time-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_NATURAL_PAPER_V2_VERSION } from "./adaptive-multi-evidence-natural-paper-v2.js";

export const ADAPTIVE_MULTI_EVIDENCE_JOURNAL_V2_VERSION =
  "adaptive-multi-evidence-journal-v2";

export const ADAPTIVE_V2_JOURNAL_EVIDENCE_FAMILIES = Object.freeze([
  "PRICE_STRUCTURE", "CANDLE_PATTERN", "TREND", "MOMENTUM", "VOLUME", "VOLATILITY",
  "REGIME", "HIGHER_TIMEFRAME", "NEWS", "DISCLOSURE", "DERIVATIVES", "COST", "LIQUIDITY", "RISK",
]);

const ACTIONS = new Set(["TAKE", "NO_TRADE", "BLOCKED"]);
const FACT_STATES = new Set(["AVAILABLE", "NOT_AVAILABLE", "UNKNOWN", "NOT_APPLICABLE"]);
const STANCES = new Set(["SUPPORTS", "OPPOSES", "NEUTRAL", "UNKNOWN"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function time(value) {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function safety() {
  return {
    appendOnly: true,
    hindsightDecisionRewriteAllowed: false,
    counterfactualEconomicCreditAllowed: false,
    singleOutcomeCanRewriteWeights: false,
    promotionAuthority: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  };
}

function strings(value) {
  if (!Array.isArray(value)) return null;
  const normalized = value.map(text);
  return normalized.every(Boolean) ? [...new Set(normalized)].sort() : null;
}

function facts(raw, decisionTimeMs) {
  if (!Array.isArray(raw) || raw.length !== ADAPTIVE_V2_JOURNAL_EVIDENCE_FAMILIES.length) return null;
  const rows = raw.map((item) => {
    const family = text(item?.family)?.toUpperCase();
    const status = text(item?.status)?.toUpperCase();
    const stance = text(item?.directionalStance)?.toUpperCase();
    const observedAtMs = time(item?.observedAtMs);
    const evidenceIds = strings(item?.evidenceIds);
    if (!ADAPTIVE_V2_JOURNAL_EVIDENCE_FAMILIES.includes(family)
        || !FACT_STATES.has(status) || !STANCES.has(stance) || !observedAtMs
        || observedAtMs > decisionTimeMs || evidenceIds == null
        || (status === "AVAILABLE" && evidenceIds.length === 0)
        || (status !== "AVAILABLE" && evidenceIds.length !== 0)) return null;
    return { family, status, directionalStance: stance, observedAtMs, evidenceIds };
  });
  if (rows.some((row) => row == null)) return null;
  const families = rows.map((row) => row.family);
  if (new Set(families).size !== ADAPTIVE_V2_JOURNAL_EVIDENCE_FAMILIES.length) return null;
  return rows.sort((left, right) => left.family.localeCompare(right.family));
}

function inferences(raw) {
  if (!Array.isArray(raw)) return null;
  const rows = raw.map((item) => ({
    statement: text(item?.statement),
    evidenceIds: strings(item?.evidenceIds),
    uncertainty: text(item?.uncertainty),
  }));
  return rows.every((row) => row.statement && row.evidenceIds?.length > 0 && row.uncertainty) ? rows : null;
}

function identity(input, handoff) {
  if (handoff) {
    const candidate = handoff.candidate;
    return {
      candidateId: candidate?.candidateId,
      signalId: candidate?.signal?.signalId,
      strategyId: candidate?.signal?.strategyIdentity?.strategyId,
      strategyVersion: candidate?.signal?.strategyIdentity?.strategyVersion,
      strategyFamily: candidate?.signal?.strategyIdentity?.strategyFamily,
      parameterDigest: candidate?.signal?.strategyIdentity?.parameterDigest,
      researchCodeSha: candidate?.signal?.strategyIdentity?.researchCodeSha,
      market: candidate?.signal?.market,
      symbol: candidate?.signal?.symbol,
      timeframe: candidate?.signal?.timeframe,
      side: candidate?.signal?.direction,
    };
  }
  return { ...input.identity };
}

function validIdentity(value) {
  return value && ["candidateId", "signalId", "strategyId", "strategyVersion", "strategyFamily",
    "parameterDigest", "researchCodeSha", "market", "symbol", "timeframe", "side"]
    .every((key) => text(value[key]));
}

export function recordAdaptiveMultiEvidenceDecisionV2(input = {}) {
  const blockers = [];
  const action = text(input.action)?.toUpperCase();
  const decisionTimeMs = time(input.decisionTimeMs);
  const capturedAtMs = time(input.capturedAtMs);
  const handoff = input.naturalPaperHandoff;
  if (!ACTIONS.has(action)) blockers.push("V2_JOURNAL_ACTION_INVALID");
  if (!decisionTimeMs || !capturedAtMs || capturedAtMs > decisionTimeMs) {
    blockers.push("V2_JOURNAL_PRE_DECISION_CAPTURE_REQUIRED");
  }
  if (action === "TAKE" && (handoff?.schemaVersion !== ADAPTIVE_MULTI_EVIDENCE_NATURAL_PAPER_V2_VERSION
      || handoff?.status !== "NATURAL_PAPER_CANDIDATE_READY_INACTIVE"
      || handoff?.executionAuthority !== "NONE" || handoff?.frozenV1Contamination !== 0)) {
    blockers.push("V2_JOURNAL_NATURAL_PAPER_HANDOFF_INVALID");
  }
  if (action !== "TAKE" && handoff != null) blockers.push("V2_JOURNAL_REJECTED_DECISION_CANNOT_HAVE_ENTRY_HANDOFF");
  const resolvedIdentity = identity(input, action === "TAKE" ? handoff : null);
  if (!validIdentity(resolvedIdentity)) blockers.push("V2_JOURNAL_IDENTITY_INCOMPLETE");
  const resolvedFacts = facts(input.facts, decisionTimeMs);
  const resolvedInferences = inferences(input.inferences);
  const uncertainties = strings(input.uncertainties);
  const reasonCodes = strings(input.reasonCodes);
  const decisionContext = {
    marketRegime: text(input.decisionContext?.marketRegime),
    higherTimeframeContext: text(input.decisionContext?.higherTimeframeContext),
  };
  const executionCostEstimate = action === "TAKE" ? {
    totalExplicitCost: finite(input.executionCostEstimate?.totalExplicitCost),
    slippageCost: finite(input.executionCostEstimate?.slippageCost),
    evidenceId: text(input.executionCostEstimate?.evidenceId),
  } : null;
  if (!resolvedFacts) blockers.push("V2_JOURNAL_FACT_SNAPSHOT_INCOMPLETE_OR_FUTURE");
  if (!resolvedInferences) blockers.push("V2_JOURNAL_INFERENCE_SNAPSHOT_INVALID");
  if (!uncertainties) blockers.push("V2_JOURNAL_UNCERTAINTY_SNAPSHOT_INVALID");
  if (!reasonCodes || ((action === "NO_TRADE" || action === "BLOCKED") && reasonCodes.length === 0)) {
    blockers.push("V2_JOURNAL_REASON_CODES_REQUIRED");
  }
  if (!decisionContext.marketRegime || !decisionContext.higherTimeframeContext) {
    blockers.push("V2_JOURNAL_DECISION_CONTEXT_INCOMPLETE");
  }
  if (action === "TAKE" && (executionCostEstimate.totalExplicitCost == null
      || executionCostEstimate.totalExplicitCost < 0 || executionCostEstimate.slippageCost == null
      || executionCostEstimate.slippageCost < 0 || !executionCostEstimate.evidenceId)) {
    blockers.push("V2_JOURNAL_PRE_DECISION_COST_ESTIMATE_REQUIRED");
  }
  if (input.executionAuthority != null && input.executionAuthority !== "NONE") {
    blockers.push("V2_JOURNAL_EXECUTION_AUTHORITY_FORBIDDEN");
  }
  if (blockers.length > 0) return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_JOURNAL_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: "BLOCKED_DATA",
    blockers: [...new Set(blockers)].sort(),
    record: null,
    economicSampleCredit: 0,
    frozenV1Contamination: 0,
    ...safety(),
  });
  const recordCore = {
    identity: resolvedIdentity,
    capturedAtMs,
    decisionTimeMs,
    fact: resolvedFacts,
    inference: resolvedInferences,
    uncertainty: uncertainties,
    decisionContext,
    decision: { action, reasonCodes },
    execution: action === "TAKE"
      ? {
        status: "PAPER_PLAN_READY_INACTIVE",
        simulatedOrder: handoff.candidate.order,
        positionPolicyEvidenceId: input.positionPolicyEvidenceId,
        naturalPaperHandoffDigest: handoff.handoffDigest,
        costEstimate: executionCostEstimate,
      }
      : { status: "NOT_REQUESTED", simulatedOrder: null, positionPolicyEvidenceId: null,
        naturalPaperHandoffDigest: null, costEstimate: null },
    outcome: null,
  };
  const decisionRecordId = `adaptive-v2-decision:${sha256Canonical(recordCore)}`;
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_JOURNAL_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: "PRE_DECISION_RECORDED",
    record: { ...recordCore, decisionRecordId, immutablePreDecisionDigest: sha256Canonical(recordCore) },
    counterfactualObservationAllowed: action !== "TAKE",
    economicSampleCredit: 0,
    profitabilityProven: false,
    frozenV1Contamination: 0,
    blockers: [],
    ...safety(),
  });
}

function association(stance, profitable) {
  if (stance === "UNKNOWN" || stance === "NEUTRAL") return "UNRESOLVED";
  return (stance === "SUPPORTS") === profitable ? "ALIGNED_WITH_OUTCOME" : "CONTRADICTED_BY_OUTCOME";
}

export function attributeAdaptiveMultiEvidenceOutcomeV2({ decisionRecord, settlement, attributedAtMs } = {}) {
  const blockers = [];
  const record = decisionRecord?.record;
  if (decisionRecord?.schemaVersion !== ADAPTIVE_MULTI_EVIDENCE_JOURNAL_V2_VERSION
      || decisionRecord?.status !== "PRE_DECISION_RECORDED" || decisionRecord?.executionAuthority !== "NONE"
      || record?.outcome !== null) blockers.push("V2_OUTCOME_DECISION_RECORD_INVALID");
  const at = time(attributedAtMs);
  const settledAtMs = time(settlement?.settledAtMs);
  if (!at || !settledAtMs || settledAtMs <= record?.decisionTimeMs || at < settledAtMs) {
    blockers.push("V2_OUTCOME_TIME_ORDER_INVALID");
  }
  if (record?.decision?.action !== "TAKE" || settlement?.candidateId !== record?.identity?.candidateId
      || settlement?.signalId !== record?.identity?.signalId
      || !text(settlement?.paperSampleId) || !text(settlement?.settlementId)) {
    blockers.push("V2_OUTCOME_SETTLEMENT_IDENTITY_MISMATCH");
  }
  const grossPnl = finite(settlement?.grossPnl);
  const totalExplicitCost = finite(settlement?.totalExplicitCost);
  const netPnl = finite(settlement?.netPnl);
  if (grossPnl == null || totalExplicitCost == null || totalExplicitCost < 0 || netPnl == null
      || Math.abs((grossPnl - totalExplicitCost) - netPnl) > 1e-8) {
    blockers.push("V2_OUTCOME_FULL_COST_EVIDENCE_INVALID");
  }
  if (blockers.length > 0) return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_JOURNAL_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: "BLOCKED_DATA",
    blockers: [...new Set(blockers)].sort(),
    record: null,
    economicSampleCredit: 0,
    frozenV1Contamination: 0,
    ...safety(),
  });
  const profitable = netPnl > 0;
  const familyAttribution = record.fact.map((item) => ({
    family: item.family,
    evidenceStatus: item.status,
    directionalStance: item.directionalStance,
    association: item.status === "AVAILABLE" ? association(item.directionalStance, profitable) : "UNRESOLVED",
    causalClaim: false,
  }));
  const estimatedCost = finite(record?.execution?.costEstimate?.totalExplicitCost);
  const estimatedSlippage = finite(record?.execution?.costEstimate?.slippageCost);
  const realizedSlippage = finite(settlement?.realizedSlippageCost);
  const outcome = {
    settlementId: settlement.settlementId,
    paperSampleId: settlement.paperSampleId,
    settledAtMs,
    attributedAtMs: at,
    grossPnl,
    totalExplicitCost,
    netPnl,
    netReturnPercent: finite(settlement.netReturnPercent),
    exitReason: text(settlement.exitReason) ?? "UNKNOWN",
    estimatedExplicitCost: estimatedCost,
    estimatedSlippageCost: estimatedSlippage,
    realizedSlippageCost: realizedSlippage,
    costEstimateError: estimatedCost == null ? null : totalExplicitCost - estimatedCost,
    slippageEstimateError: estimatedSlippage == null || realizedSlippage == null
      ? null : realizedSlippage - estimatedSlippage,
    familyAttribution,
    singleTradeWeightRewriteAllowed: false,
    causalAttributionProven: false,
  };
  const completed = { ...record, outcome };
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_JOURNAL_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: "OUTCOME_ATTRIBUTED_RESEARCH_ONLY",
    record: completed,
    outcomeDigest: sha256Canonical(outcome),
    immutablePreDecisionDigest: record.immutablePreDecisionDigest,
    preDecisionStateRewritten: false,
    economicSampleCredit: 0,
    profitabilityProven: false,
    frozenV1Contamination: 0,
    blockers: [],
    ...safety(),
  });
}

export function createAdaptiveMultiEvidenceJournalLedgerV2() {
  const records = [];
  return deepFreeze({
    schemaVersion: "adaptive-multi-evidence-journal-ledger-v2",
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    records,
    recordCount: 0,
    ledgerDigest: sha256Canonical(records),
    frozenV1Contamination: 0,
    ...safety(),
  });
}

export function appendAdaptiveMultiEvidenceJournalRecordV2(ledger, entry) {
  if (ledger?.schemaVersion !== "adaptive-multi-evidence-journal-ledger-v2"
      || ledger?.ledgerDigest !== sha256Canonical(ledger.records)
      || ledger?.recordCount !== ledger.records.length || ledger?.executionAuthority !== "NONE") {
    throw new Error("V2_JOURNAL_LEDGER_INVALID");
  }
  if (!entry?.record || !["PRE_DECISION_RECORDED", "OUTCOME_ATTRIBUTED_RESEARCH_ONLY"].includes(entry.status)) {
    throw new Error("V2_JOURNAL_ENTRY_INVALID");
  }
  const key = entry.record.decisionRecordId;
  const matching = ledger.records.filter((item) => item.decisionRecordId === key);
  if (matching.some((item) => sha256Canonical(item) === sha256Canonical(entry.record))) return ledger;
  if (entry.status === "PRE_DECISION_RECORDED") {
    if (matching.length > 0) throw new Error("V2_JOURNAL_RECORD_CONFLICT");
  } else {
    const original = matching.find((item) => item.outcome === null);
    if (!original) throw new Error("V2_JOURNAL_PRE_DECISION_MISSING");
    if (matching.some((item) => item.outcome !== null)) throw new Error("V2_JOURNAL_OUTCOME_CONFLICT");
    const { outcome: ignoredOutcome, ...completedPreDecision } = entry.record;
    const { outcome: ignoredOriginalOutcome, ...originalPreDecision } = original;
    if (sha256Canonical(completedPreDecision) !== sha256Canonical(originalPreDecision)) {
      throw new Error("V2_JOURNAL_PRE_DECISION_REWRITE_DETECTED");
    }
  }
  const records = [...ledger.records, entry.record];
  return deepFreeze({ ...ledger, records, recordCount: records.length, ledgerDigest: sha256Canonical(records) });
}
