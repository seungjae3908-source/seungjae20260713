import { sha256Canonical } from "./research-cache-provenance.js";
import { ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID } from "./adaptive-multi-evidence-point-in-time-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_REGIME_ROUTER_V2_VERSION } from "./adaptive-multi-evidence-regime-router-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_INDEPENDENCE_V2_VERSION } from "./adaptive-multi-evidence-independence-v2.js";
import {
  ADAPTIVE_MULTI_EVIDENCE_STRATEGY_PORTFOLIO_V2_VERSION,
  verifyAdaptiveMultiEvidenceStrategyPortfolioV2,
} from "./adaptive-multi-evidence-strategy-portfolio-v2.js";

export const ADAPTIVE_MULTI_EVIDENCE_META_DECISION_V2_VERSION =
  "adaptive-multi-evidence-meta-decision-v2";

const HARD_GATE_NAMES = Object.freeze([
  "DATA_QUALITY",
  "IDENTITY",
  "FRESHNESS",
  "REGIME",
  "EVENT_RISK",
  "LIQUIDITY",
  "COST",
  "GLOBAL_RISK",
  "STRATEGY_HEALTH",
]);
const GATE_STATES = new Set(["PASS", "FAIL", "UNKNOWN"]);
const ENTRY_DECISIONS = new Set(["BUY", "LONG", "SHORT"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function safety() {
  return {
    hardVetoOverridableBySoftEvidence: false,
    forcedPredictionAllowed: false,
    uncalibratedProbabilityAllowed: false,
    frozenV1Contamination: 0,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  };
}

function baseResult({ status, decision, reasons, hardGates, probability, evidenceSummary, decisionDigest = null }) {
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_META_DECISION_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status,
    decision,
    reasons: unique(reasons),
    hardGates,
    hardVetoApplied: status === "BLOCKED" || decision === "NO_TRADE",
    probability,
    evidenceSummary,
    decisionDigest,
    economicSampleCredit: 0,
    profitabilityProven: false,
    decisionAuthority: "RESEARCH_DECISION_ONLY",
    ...safety(),
  });
}

function blocked(reasons) {
  return baseResult({
    status: "BLOCKED",
    decision: "BLOCKED",
    reasons,
    hardGates: null,
    probability: { status: "UNAVAILABLE", value: null, reason: "INPUT_CONTRACT_BLOCKED" },
    evidenceSummary: null,
  });
}

function gates(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || Object.keys(raw).sort().join("|") !== [...HARD_GATE_NAMES].sort().join("|")) {
    throw new Error("V2_META_HARD_GATES_EXACT_SET_REQUIRED");
  }
  return Object.fromEntries(HARD_GATE_NAMES.map((name) => {
    const gate = raw[name];
    const state = text(gate?.state)?.toUpperCase();
    const evidenceId = text(gate?.evidenceId);
    const reason = text(gate?.reason);
    if (!GATE_STATES.has(state)) throw new Error(`V2_META_HARD_GATE_${name}_STATE_INVALID`);
    if (state === "PASS" && !evidenceId) throw new Error(`V2_META_HARD_GATE_${name}_PASS_EVIDENCE_REQUIRED`);
    if (state !== "PASS" && !reason) throw new Error(`V2_META_HARD_GATE_${name}_REASON_REQUIRED`);
    return [name, { state, evidenceId, reason }];
  }));
}

function allowedDecision(market, requested, currentPositionSide, validatedDirections) {
  if (["KR_STOCK", "US_STOCK", "CRYPTO_SPOT"].includes(market)) {
    if (["HOLD", "NO_TRADE"].includes(requested)) return true;
    if (requested === "BUY") return true;
    return requested === "EXIT" && currentPositionSide === "LONG";
  }
  if (market === "CRYPTO_FUTURES") {
    if (["HOLD", "NO_TRADE"].includes(requested)) return true;
    if (requested === "EXIT") return currentPositionSide === "LONG" || currentPositionSide === "SHORT";
    return ["LONG", "SHORT"].includes(requested) && validatedDirections.has(requested);
  }
  return false;
}

function empiricalProbability(raw, context) {
  if (raw == null) return { status: "UNAVAILABLE", value: null, reason: "CALIBRATED_EMPIRICAL_EVIDENCE_NOT_SUPPLIED" };
  const valid = raw.market === context.market
    && raw.symbol === context.symbol
    && raw.timeframe === context.timeframe
    && raw.side === context.side
    && raw.strategyIdentity === context.strategyIdentity
    && raw.prospectiveOrOos === true
    && Number.isSafeInteger(raw.sampleSize)
    && raw.sampleSize >= raw.minimumSampleSize
    && Number.isSafeInteger(raw.minimumSampleSize)
    && raw.minimumSampleSize > 0
    && typeof raw.value === "number" && Number.isFinite(raw.value) && raw.value >= 0 && raw.value <= 1
    && typeof raw.brierScore === "number" && Number.isFinite(raw.brierScore) && raw.brierScore >= 0 && raw.brierScore <= 1
    && typeof raw.calibrationError === "number" && Number.isFinite(raw.calibrationError) && raw.calibrationError >= 0
    && Array.isArray(raw.calibrationCurve) && raw.calibrationCurve.length > 0
    && text(raw.evidenceId);
  return valid
    ? { status: "AVAILABLE_CALIBRATED_EMPIRICAL_ONLY", value: raw.value, evidenceId: raw.evidenceId,
      sampleSize: raw.sampleSize, brierScore: raw.brierScore, calibrationError: raw.calibrationError,
      calibrationCurve: raw.calibrationCurve }
    : { status: "UNAVAILABLE", value: null, reason: "CALIBRATION_EVIDENCE_INVALID_OR_MISMATCHED" };
}

function summarizeEvidence(rows, independence) {
  if (!Array.isArray(rows)) throw new Error("V2_META_SPECIALIST_EVIDENCE_ARRAY_REQUIRED");
  const canonicalIds = new Set(independence.canonicalEvidence.map((item) => item.evidenceId));
  const groupByEvidence = new Map(independence.groups.flatMap((group) => group.evidenceIds
    .map((evidenceId) => [evidenceId, group.groupId])));
  const seenGroups = new Set();
  const supportGroups = [];
  const opposeGroups = [];
  const neutralGroups = [];
  for (const row of rows) {
    if (!canonicalIds.has(row?.evidenceId) || !["SUPPORT", "OPPOSE", "NEUTRAL"].includes(row?.stance)) {
      throw new Error("V2_META_SPECIALIST_EVIDENCE_INVALID");
    }
    const actualGroup = groupByEvidence.get(row.evidenceId);
    if (row.independenceGroupId !== actualGroup) throw new Error("V2_META_INDEPENDENCE_GROUP_BINDING_INVALID");
    if (seenGroups.has(actualGroup)) continue;
    seenGroups.add(actualGroup);
    if (row.stance === "SUPPORT") supportGroups.push(actualGroup);
    else if (row.stance === "OPPOSE") opposeGroups.push(actualGroup);
    else neutralGroups.push(actualGroup);
  }
  return {
    consideredIndependenceGroups: [...seenGroups].sort(),
    supportGroups: supportGroups.sort(),
    opposeGroups: opposeGroups.sort(),
    neutralGroups: neutralGroups.sort(),
    duplicateGroupVotesDiscarded: rows.length - seenGroups.size,
    numericSoftScore: null,
  };
}

export function buildAdaptiveMultiEvidenceMetaDecisionV2(input = {}) {
  const blockers = [];
  if (input.portfolio?.schemaVersion !== ADAPTIVE_MULTI_EVIDENCE_STRATEGY_PORTFOLIO_V2_VERSION
      || !verifyAdaptiveMultiEvidenceStrategyPortfolioV2(input.portfolio)) blockers.push("V2_META_PORTFOLIO_INVALID");
  if (input.regimeRouter?.schemaVersion !== ADAPTIVE_MULTI_EVIDENCE_REGIME_ROUTER_V2_VERSION
      || input.regimeRouter?.lineageId !== ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID
      || input.regimeRouter?.executionAuthority !== "NONE") blockers.push("V2_META_REGIME_ROUTER_INVALID");
  if (input.independence?.schemaVersion !== ADAPTIVE_MULTI_EVIDENCE_INDEPENDENCE_V2_VERSION
      || input.independence?.lineageId !== ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID
      || input.independence?.status !== "GROUPED_FOR_RESEARCH_ONLY"
      || input.independence?.executionAuthority !== "NONE") blockers.push("V2_META_INDEPENDENCE_INPUT_INVALID");
  if (input.executionAuthority != null && input.executionAuthority !== "NONE") blockers.push("V2_META_EXECUTION_AUTHORITY_FORBIDDEN");
  if (blockers.length > 0) return blocked(blockers);

  let hardGates;
  let evidenceSummary;
  try {
    hardGates = gates(input.hardGates);
    evidenceSummary = summarizeEvidence(input.specialistEvidence, input.independence);
  } catch (error) {
    return blocked([error.message]);
  }
  const market = text(input.market)?.toUpperCase();
  const symbol = text(input.symbol)?.toUpperCase();
  const timeframe = text(input.timeframe);
  const requestedDecision = text(input.requestedDecision)?.toUpperCase();
  const currentPositionSide = text(input.currentPositionSide)?.toUpperCase() ?? "NONE";
  const strategyIdentity = text(input.strategyIdentity);
  const portfolioMembers = input.portfolio.portfolio.members;
  const selectedMember = portfolioMembers.find((member) => member.candidateId === strategyIdentity);
  if (!market || !symbol || !timeframe || !requestedDecision || !strategyIdentity || !selectedMember) {
    return blocked(["V2_META_DECISION_IDENTITY_INCOMPLETE"]);
  }
  const validatedDirections = new Set(portfolioMembers.map((member) => member.side));
  if (!allowedDecision(market, requestedDecision, currentPositionSide, validatedDirections)) {
    return baseResult({
      status: "ABSTAINED",
      decision: "NO_TRADE",
      reasons: ["MARKET_DIRECTION_POLICY_FORBIDS_REQUESTED_DECISION"],
      hardGates,
      probability: { status: "UNAVAILABLE", value: null, reason: "DIRECTION_FORBIDDEN" },
      evidenceSummary,
    });
  }
  if (ENTRY_DECISIONS.has(requestedDecision)
      && ["UNKNOWN", "PANIC_DISLOCATION"].includes(input.regimeRouter.regime)) {
    hardGates.REGIME = {
      state: "FAIL",
      evidenceId: null,
      reason: `REGIME_${input.regimeRouter.regime}_ENTRY_VETO`,
    };
  }
  const failed = Object.entries(hardGates).filter(([, gate]) => gate.state === "FAIL");
  const unknown = Object.entries(hardGates).filter(([, gate]) => gate.state === "UNKNOWN");
  const probability = empiricalProbability(input.probabilityEvidence, {
    market,
    symbol,
    timeframe,
    side: requestedDecision,
    strategyIdentity,
  });
  if (failed.length > 0 || unknown.length > 0) {
    const identityFailure = failed.some(([name]) => ["DATA_QUALITY", "IDENTITY"].includes(name));
    return baseResult({
      status: identityFailure ? "BLOCKED" : "ABSTAINED",
      decision: identityFailure ? "BLOCKED" : "NO_TRADE",
      reasons: [
        ...failed.map(([name, gate]) => `${name}:${gate.reason}`),
        ...unknown.map(([name, gate]) => `${name}:${gate.reason}`),
      ],
      hardGates,
      probability,
      evidenceSummary,
    });
  }
  if (evidenceSummary.supportGroups.length > 0 && evidenceSummary.opposeGroups.length > 0) {
    return baseResult({
      status: "ABSTAINED",
      decision: "NO_TRADE",
      reasons: ["CONFLICTING_SPECIALIST_EVIDENCE"],
      hardGates,
      probability,
      evidenceSummary,
    });
  }
  const core = {
    portfolioDigest: input.portfolio.portfolio.portfolioDigest,
    regimeDigest: input.regimeRouter.regimeDigest,
    strategyIdentity,
    market,
    symbol,
    timeframe,
    requestedDecision,
    hardGates,
    evidenceSummary,
    probabilityEvidenceId: probability.evidenceId ?? null,
  };
  return baseResult({
    status: requestedDecision === "NO_TRADE" ? "ABSTAINED" : "RESEARCH_DECISION_READY",
    decision: requestedDecision,
    reasons: requestedDecision === "NO_TRADE" ? ["STRATEGY_ABSTAINED"] : ["ALL_HARD_GATES_PASSED"],
    hardGates,
    probability,
    evidenceSummary,
    decisionDigest: sha256Canonical(core),
  });
}
