import { calculatePearsonCorrelation } from "./portfolio-risk-analysis.js";
import { sha256Canonical } from "./research-cache-provenance.js";
import { ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID } from "./adaptive-multi-evidence-point-in-time-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_VALIDATION_V2_VERSION } from "./adaptive-multi-evidence-validation-v2.js";

export const ADAPTIVE_MULTI_EVIDENCE_STRATEGY_PORTFOLIO_V2_VERSION =
  "adaptive-multi-evidence-strategy-portfolio-v2";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function timestamp(value) {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? new Date(parsed).toISOString() : null;
}

function strings(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const normalized = value.map(text);
  return normalized.every(Boolean) ? [...new Set(normalized)].sort() : null;
}

function finiteSeries(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item))
    ? [...value]
    : null;
}

function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  const union = new Set([...a, ...b]);
  if (union.size === 0) return null;
  return [...a].filter((item) => b.has(item)).length / union.size;
}

function safety() {
  return {
    frozenV1MutationAllowed: false,
    hindsightMemberChangeAllowed: false,
    autoPromotionAllowed: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  };
}

function failure(blockers) {
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_STRATEGY_PORTFOLIO_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: "BLOCKED_DATA",
    portfolio: null,
    blockers: [...new Set(blockers)].sort(),
    profitabilityProven: false,
    economicSampleCredit: 0,
    decisionAuthority: "NONE",
    ...safety(),
  });
}

function policy(raw) {
  const normalized = {
    maximumSignalOverlap: raw?.maximumSignalOverlap,
    maximumTradeOverlap: raw?.maximumTradeOverlap,
    maximumReturnCorrelation: raw?.maximumReturnCorrelation,
    maximumDrawdownCorrelation: raw?.maximumDrawdownCorrelation,
    maximumRegimeOverlap: raw?.maximumRegimeOverlap,
    minimumCorrelationSamples: raw?.minimumCorrelationSamples,
  };
  const ratiosValid = Object.entries(normalized).every(([key, value]) => key === "minimumCorrelationSamples"
    ? Number.isSafeInteger(value) && value >= 5
    : typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1);
  if (!ratiosValid) throw new Error("V2_PORTFOLIO_DIVERSIFICATION_POLICY_INVALID");
  return normalized;
}

function member(raw, finalists) {
  const candidateId = text(raw?.candidateId);
  const finalist = finalists.find((item) => item.candidateId === candidateId);
  if (!finalist) throw new Error("V2_PORTFOLIO_MEMBER_NOT_VALIDATED_FINALIST");
  const normalized = {
    candidateId,
    formulaCandidateId: text(raw?.formulaCandidateId),
    strategyFamily: text(raw?.strategyFamily),
    market: text(raw?.market)?.toUpperCase() ?? null,
    timeframe: text(raw?.timeframe),
    side: text(raw?.side)?.toUpperCase() ?? null,
    strategyHash: text(raw?.strategyHash),
    parameterIdentity: text(raw?.parameterIdentity),
    signalKeys: strings(raw?.signalKeys),
    tradeKeys: strings(raw?.tradeKeys),
    returnSeries: finiteSeries(raw?.returnSeries),
    drawdownSeries: finiteSeries(raw?.drawdownSeries),
    regimes: strings(raw?.regimes),
    validationDigest: finalist.validationDigest,
  };
  if (Object.values(normalized).some((value) => value == null)) {
    throw new Error("V2_PORTFOLIO_MEMBER_DIVERSIFICATION_EVIDENCE_MISSING");
  }
  if (normalized.formulaCandidateId !== finalist.formulaCandidateId
      || normalized.strategyHash !== finalist.strategyHash
      || normalized.parameterIdentity !== finalist.parameterIdentity) {
    throw new Error("V2_PORTFOLIO_MEMBER_VALIDATION_IDENTITY_MISMATCH");
  }
  return normalized;
}

function pairAnalysis(left, right, diversificationPolicy) {
  let returnCorrelation;
  let drawdownCorrelation;
  try {
    returnCorrelation = calculatePearsonCorrelation(left.returnSeries, right.returnSeries, {
      minimumSamples: diversificationPolicy.minimumCorrelationSamples,
    });
    drawdownCorrelation = calculatePearsonCorrelation(left.drawdownSeries, right.drawdownSeries, {
      minimumSamples: diversificationPolicy.minimumCorrelationSamples,
    });
  } catch {
    return { status: "MISSING_EVIDENCE", reason: "V2_PORTFOLIO_CORRELATION_SERIES_INVALID" };
  }
  const signalOverlap = jaccard(left.signalKeys, right.signalKeys);
  const tradeOverlap = jaccard(left.tradeKeys, right.tradeKeys);
  const regimeOverlap = jaccard(left.regimes, right.regimes);
  if (returnCorrelation.insufficientData || drawdownCorrelation.insufficientData
      || signalOverlap == null || tradeOverlap == null || regimeOverlap == null) {
    return { status: "MISSING_EVIDENCE", reason: "V2_PORTFOLIO_DIVERSIFICATION_EVIDENCE_INSUFFICIENT" };
  }
  const breaches = [
    signalOverlap > diversificationPolicy.maximumSignalOverlap ? "SIGNAL_OVERLAP" : null,
    tradeOverlap > diversificationPolicy.maximumTradeOverlap ? "TRADE_OVERLAP" : null,
    returnCorrelation.correlation > diversificationPolicy.maximumReturnCorrelation ? "RETURN_CORRELATION" : null,
    drawdownCorrelation.correlation > diversificationPolicy.maximumDrawdownCorrelation ? "DRAWDOWN_CORRELATION" : null,
    regimeOverlap > diversificationPolicy.maximumRegimeOverlap ? "REGIME_OVERLAP" : null,
  ].filter(Boolean);
  return {
    leftCandidateId: left.candidateId,
    rightCandidateId: right.candidateId,
    signalOverlap,
    tradeOverlap,
    returnCorrelation: returnCorrelation.correlation,
    drawdownCorrelation: drawdownCorrelation.correlation,
    regimeOverlap,
    sampleCount: returnCorrelation.sampleCount,
    breaches,
    status: breaches.length === 0 ? "COMPLEMENTARY" : "DEPENDENCE_LIMIT_EXCEEDED",
  };
}

function portfolioCore({ frozenAt, prospectiveBoundary, members, pairwise, diversificationPolicy }) {
  return {
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    frozenAt,
    prospectiveBoundary,
    members,
    memberCount: members.length,
    pairwise,
    diversificationPolicy,
  };
}

export function buildAdaptiveMultiEvidenceStrategyPortfolioV2({
  validation,
  proposedMembers,
  diversificationPolicy: rawPolicy,
  frozenAt,
  prospectiveBoundary,
  executionAuthority = "NONE",
} = {}) {
  const blockers = [];
  if (validation?.schemaVersion !== ADAPTIVE_MULTI_EVIDENCE_VALIDATION_V2_VERSION
      || validation?.lineageId !== ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID
      || validation?.status !== "VALIDATED_FINALISTS_AVAILABLE"
      || validation?.executionAuthority !== "NONE") blockers.push("V2_PORTFOLIO_VALIDATION_INPUT_INVALID");
  if (!Array.isArray(proposedMembers) || proposedMembers.length === 0 || proposedMembers.length > 8) {
    blockers.push("V2_PORTFOLIO_MEMBER_COUNT_INVALID");
  }
  let diversificationPolicy;
  try { diversificationPolicy = policy(rawPolicy); } catch (error) { blockers.push(error.message); }
  const at = timestamp(frozenAt);
  const boundary = timestamp(prospectiveBoundary);
  if (!at || !boundary || at !== boundary) blockers.push("V2_PORTFOLIO_PROSPECTIVE_FREEZE_BOUNDARY_INVALID");
  if (executionAuthority !== "NONE") blockers.push("V2_PORTFOLIO_EXECUTION_AUTHORITY_FORBIDDEN");
  if (blockers.length > 0) return failure(blockers);

  let members;
  try {
    members = proposedMembers.map((item) => member(item, validation.finalists));
  } catch (error) {
    return failure([error.message]);
  }
  const ids = members.map((item) => item.candidateId);
  const strategyHashes = members.map((item) => item.strategyHash);
  if (ids.length !== new Set(ids).size || strategyHashes.length !== new Set(strategyHashes).size) {
    return failure(["V2_PORTFOLIO_DUPLICATE_MEMBER"]);
  }
  const pairwise = [];
  for (let left = 0; left < members.length; left += 1) {
    for (let right = left + 1; right < members.length; right += 1) {
      pairwise.push(pairAnalysis(members[left], members[right], diversificationPolicy));
    }
  }
  const missing = pairwise.find((item) => item.status === "MISSING_EVIDENCE");
  if (missing) return failure([missing.reason]);
  if (pairwise.some((item) => item.status !== "COMPLEMENTARY")) {
    return failure(["V2_PORTFOLIO_ORTHOGONALITY_GATE_FAILED"]);
  }

  const core = portfolioCore({ frozenAt: at, prospectiveBoundary: boundary, members, pairwise, diversificationPolicy });
  const portfolioDigest = sha256Canonical(core);
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_STRATEGY_PORTFOLIO_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: "FROZEN_V2_STRATEGY_PORTFOLIO",
    portfolio: {
      ...core,
      portfolioId: `adaptive-v2-portfolio:${portfolioDigest}`,
      portfolioDigest,
      immutable: true,
      objective: "ORTHOGONAL_COMPLEMENTARY_VALIDATED_STRATEGIES",
      singleStrategyPortfolio: members.length === 1,
      profitabilityProven: false,
      executionAuthority: "NONE",
    },
    frozenV1Contamination: 0,
    blockers: [],
    profitabilityProven: false,
    economicSampleCredit: 0,
    decisionAuthority: "FROZEN_RESEARCH_PORTFOLIO_ONLY",
    ...safety(),
  });
}

export function verifyAdaptiveMultiEvidenceStrategyPortfolioV2(result) {
  if (result?.schemaVersion !== ADAPTIVE_MULTI_EVIDENCE_STRATEGY_PORTFOLIO_V2_VERSION
      || result?.lineageId !== ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID
      || result?.status !== "FROZEN_V2_STRATEGY_PORTFOLIO"
      || result?.frozenV1Contamination !== 0
      || result?.executionAuthority !== "NONE") return false;
  const portfolio = result.portfolio;
  if (!portfolio?.immutable || portfolio?.executionAuthority !== "NONE") return false;
  if (!Array.isArray(portfolio.members) || !Array.isArray(portfolio.pairwise)
      || portfolio.memberCount !== portfolio.members.length
      || portfolio.pairwise.length !== (portfolio.memberCount * (portfolio.memberCount - 1)) / 2) return false;
  const core = portfolioCore(portfolio);
  return portfolio.portfolioDigest === sha256Canonical(core)
    && portfolio.portfolioId === `adaptive-v2-portfolio:${portfolio.portfolioDigest}`;
}
