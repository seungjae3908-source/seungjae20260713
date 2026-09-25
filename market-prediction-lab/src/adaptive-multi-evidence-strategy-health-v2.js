import { sha256Canonical } from "./research-cache-provenance.js";
import { ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID } from "./adaptive-multi-evidence-point-in-time-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_JOURNAL_V2_VERSION } from "./adaptive-multi-evidence-journal-v2.js";
import {
  ADAPTIVE_MULTI_EVIDENCE_STRATEGY_PORTFOLIO_V2_VERSION,
  verifyAdaptiveMultiEvidenceStrategyPortfolioV2,
} from "./adaptive-multi-evidence-strategy-portfolio-v2.js";

export const ADAPTIVE_MULTI_EVIDENCE_STRATEGY_HEALTH_V2_VERSION =
  "adaptive-multi-evidence-strategy-health-v2";

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

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function safety() {
  return {
    currentFrozenPortfolioMutationAllowed: false,
    onlineHindsightTuningAllowed: false,
    automaticChallengerPromotionAllowed: false,
    sameEvidenceSelectionAndPromotionAllowed: false,
    promotionAuthority: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  };
}

function failure(blockers) {
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_STRATEGY_HEALTH_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: "BLOCKED_DATA",
    blockers: [...new Set(blockers)].sort(),
    health: null,
    challengerFeedback: null,
    economicSampleCredit: 0,
    profitabilityProven: false,
    frozenV1Contamination: 0,
    ...safety(),
  });
}

function threshold(raw, prefix) {
  const value = {
    minimumNetExpectancyPercent: finite(raw?.minimumNetExpectancyPercent),
    minimumProfitFactor: finite(raw?.minimumProfitFactor),
    maximumDrawdownPercent: finite(raw?.maximumDrawdownPercent),
    maximumCostDriftPercent: finite(raw?.maximumCostDriftPercent),
    maximumSlippageDriftPercent: finite(raw?.maximumSlippageDriftPercent),
    minimumFillRatePercent: finite(raw?.minimumFillRatePercent),
  };
  if (Object.values(value).some((item) => item == null)
      || value.minimumProfitFactor < 0 || value.maximumDrawdownPercent < 0
      || value.maximumCostDriftPercent < 0 || value.maximumSlippageDriftPercent < 0
      || value.minimumFillRatePercent < 0 || value.minimumFillRatePercent > 100) {
    throw new Error(`${prefix}_THRESHOLD_INVALID`);
  }
  return value;
}

function policy(raw) {
  if (!text(raw?.version) || !Number.isSafeInteger(raw?.minimumSampleSize) || raw.minimumSampleSize <= 0
      || !(finite(raw?.reducedRiskMultiplier) > 0) || raw.reducedRiskMultiplier >= 1) {
    throw new Error("V2_STRATEGY_HEALTH_POLICY_INVALID");
  }
  return {
    version: raw.version,
    minimumSampleSize: raw.minimumSampleSize,
    reducedRiskMultiplier: raw.reducedRiskMultiplier,
    watch: threshold(raw.watch, "WATCH"),
    reduceRisk: threshold(raw.reduceRisk, "REDUCE_RISK"),
    blockNewEntry: threshold(raw.blockNewEntry, "BLOCK_NEW_ENTRY"),
  };
}

function drawdown(returns) {
  let equity = 1;
  let peak = 1;
  let maximum = 0;
  for (const value of returns) {
    equity *= 1 + value / 100;
    peak = Math.max(peak, equity);
    maximum = Math.max(maximum, peak > 0 ? (peak - equity) / peak * 100 : 0);
  }
  return maximum;
}

function drift(actual, estimated) {
  if (actual == null || estimated == null || !(estimated > 0)) return null;
  return Math.abs(actual - estimated) / estimated * 100;
}

function metrics(decisions, outcomes) {
  const returns = outcomes.map((entry) => finite(entry.record.outcome.netReturnPercent));
  const validReturns = returns.filter((value) => value != null);
  const wins = validReturns.filter((value) => value > 0);
  const losses = validReturns.filter((value) => value < 0);
  const grossWin = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const costDrifts = outcomes.map((entry) => drift(
    finite(entry.record.outcome.totalExplicitCost),
    finite(entry.record.outcome.estimatedExplicitCost),
  )).filter((value) => value != null);
  const slippageDrifts = outcomes.map((entry) => drift(
    finite(entry.record.outcome.realizedSlippageCost),
    finite(entry.record.outcome.estimatedSlippageCost),
  )).filter((value) => value != null);
  const takeCount = decisions.filter((entry) => entry.record.decision.action === "TAKE").length;
  const regimes = new Map();
  for (const entry of outcomes) {
    const regime = entry.record.decisionContext.marketRegime;
    const values = regimes.get(regime) ?? [];
    values.push(entry.record.outcome.netReturnPercent);
    regimes.set(regime, values);
  }
  return {
    sampleSize: outcomes.length,
    netExpectancyPercent: validReturns.length === outcomes.length ? mean(validReturns) : null,
    profitFactor: validReturns.length === outcomes.length && grossLoss > 0 ? grossWin / grossLoss : null,
    winRatePercent: validReturns.length === outcomes.length && outcomes.length ? wins.length / outcomes.length * 100 : null,
    averageWinPercent: wins.length ? mean(wins) : null,
    averageLossPercent: losses.length ? mean(losses) : null,
    maximumDrawdownPercent: validReturns.length === outcomes.length ? drawdown(validReturns) : null,
    costDriftPercent: costDrifts.length === outcomes.length ? mean(costDrifts) : null,
    slippageDriftPercent: slippageDrifts.length === outcomes.length ? mean(slippageDrifts) : null,
    fillRatePercent: takeCount ? outcomes.length / takeCount * 100 : null,
    regimePerformance: [...regimes.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([regime, values]) => ({ regime, sampleSize: values.length, netExpectancyPercent: mean(values) })),
  };
}

function reasonsFor(value, thresholdValue) {
  const reasons = [];
  if (value.netExpectancyPercent < thresholdValue.minimumNetExpectancyPercent) reasons.push("NET_EXPECTANCY_BELOW_POLICY");
  if (value.profitFactor < thresholdValue.minimumProfitFactor) reasons.push("PROFIT_FACTOR_BELOW_POLICY");
  if (value.maximumDrawdownPercent >= thresholdValue.maximumDrawdownPercent) reasons.push("DRAWDOWN_AT_OR_ABOVE_POLICY");
  if (value.costDriftPercent >= thresholdValue.maximumCostDriftPercent) reasons.push("COST_DRIFT_AT_OR_ABOVE_POLICY");
  if (value.slippageDriftPercent >= thresholdValue.maximumSlippageDriftPercent) reasons.push("SLIPPAGE_DRIFT_AT_OR_ABOVE_POLICY");
  if (value.fillRatePercent < thresholdValue.minimumFillRatePercent) reasons.push("FILL_RATE_BELOW_POLICY");
  return reasons;
}

function healthStatus(value, resolvedPolicy) {
  const coreAvailable = [value.netExpectancyPercent, value.profitFactor, value.maximumDrawdownPercent,
    value.costDriftPercent, value.slippageDriftPercent, value.fillRatePercent].every((item) => finite(item) != null);
  if (value.sampleSize < resolvedPolicy.minimumSampleSize || !coreAvailable) {
    return { status: "INSUFFICIENT_EVIDENCE", reasons: [
      value.sampleSize < resolvedPolicy.minimumSampleSize ? "INSUFFICIENT_PROSPECTIVE_SAMPLE" : null,
      !coreAvailable ? "CORE_HEALTH_METRICS_UNAVAILABLE" : null,
    ].filter(Boolean) };
  }
  for (const [status, band] of [
    ["BLOCK_NEW_ENTRY", resolvedPolicy.blockNewEntry],
    ["REDUCE_RISK", resolvedPolicy.reduceRisk],
    ["WATCH", resolvedPolicy.watch],
  ]) {
    const reasons = reasonsFor(value, band);
    if (reasons.length) return { status, reasons };
  }
  return { status: "NORMAL", reasons: [] };
}

function challengerFeedback(status, reasons, candidateId, version) {
  if (status === "NORMAL" || status === "INSUFFICIENT_EVIDENCE") return null;
  if (!/^v2\.[1-9][0-9]*$/u.test(version ?? "")) throw new Error("V2_CHALLENGER_VERSION_INVALID");
  return {
    status: "CHALLENGER_RESEARCH_REQUESTED",
    challengerVersion: version,
    sourceCandidateId: candidateId,
    hypotheses: reasons.map((reason) => ({
      reason,
      action: "GENERATE_AND_TEST_CHALLENGER_PROSPECTIVELY",
      currentFrozenStrategyMutable: false,
    })),
    requiredPipeline: Object.freeze([
      "RESEARCH_CANDIDATE", "BACKTEST", "VALIDATION", "OOS", "STATISTICAL_FIREWALL",
      "FINAL_HOLDOUT", "SHADOW", "NATURAL_PAPER", "FULL_COST", "HUMAN_PROMOTION_DECISION",
    ]),
    selectionEvidenceReusableForPromotion: false,
    automaticPromotionAllowed: false,
    executionAuthority: "NONE",
  };
}

export function evaluateAdaptiveMultiEvidenceStrategyHealthV2(input = {}) {
  const blockers = [];
  if (input.portfolio?.schemaVersion !== ADAPTIVE_MULTI_EVIDENCE_STRATEGY_PORTFOLIO_V2_VERSION
      || !verifyAdaptiveMultiEvidenceStrategyPortfolioV2(input.portfolio)
      || input.portfolio?.frozenV1Contamination !== 0 || input.portfolio?.executionAuthority !== "NONE") {
    blockers.push("V2_STRATEGY_HEALTH_PORTFOLIO_INVALID");
  }
  const candidateId = text(input.candidateId);
  const member = input.portfolio?.portfolio?.members?.find((item) => item.candidateId === candidateId);
  if (!candidateId || !member) blockers.push("V2_STRATEGY_HEALTH_CANDIDATE_NOT_FROZEN_MEMBER");
  let resolvedPolicy;
  try { resolvedPolicy = policy(input.policy); } catch (error) { blockers.push(error.message); }
  if (!Array.isArray(input.journalEntries)) blockers.push("V2_STRATEGY_HEALTH_JOURNAL_REQUIRED");
  if (input.executionAuthority != null && input.executionAuthority !== "NONE") {
    blockers.push("V2_STRATEGY_HEALTH_EXECUTION_AUTHORITY_FORBIDDEN");
  }
  if (blockers.length > 0) return failure(blockers);
  const relevant = input.journalEntries.filter((entry) => entry?.record?.identity?.candidateId === candidateId);
  if (relevant.some((entry) => entry?.schemaVersion !== ADAPTIVE_MULTI_EVIDENCE_JOURNAL_V2_VERSION
      || !["PRE_DECISION_RECORDED", "OUTCOME_ATTRIBUTED_RESEARCH_ONLY"].includes(entry.status)
      || entry?.executionAuthority !== "NONE" || entry?.frozenV1Contamination !== 0)) {
    return failure(["V2_STRATEGY_HEALTH_JOURNAL_ENTRY_INVALID"]);
  }
  const ids = relevant.map((entry) => entry.record.decisionRecordId);
  if (ids.length !== new Set(ids).size) return failure(["V2_STRATEGY_HEALTH_DUPLICATE_DECISION_RECORD"]);
  const outcomes = relevant.filter((entry) => entry.status === "OUTCOME_ATTRIBUTED_RESEARCH_ONLY");
  const value = metrics(relevant, outcomes);
  const verdict = healthStatus(value, resolvedPolicy);
  let feedback;
  try { feedback = challengerFeedback(verdict.status, verdict.reasons, candidateId, input.nextChallengerVersion); }
  catch (error) { return failure([error.message]); }
  const riskMultiplier = verdict.status === "REDUCE_RISK" ? resolvedPolicy.reducedRiskMultiplier
    : verdict.status === "BLOCK_NEW_ENTRY" ? 0 : 1;
  const health = {
    candidateId,
    portfolioId: input.portfolio.portfolio.portfolioId,
    policyVersion: resolvedPolicy.version,
    status: verdict.status,
    reasons: verdict.reasons,
    metrics: value,
    entryDirective: verdict.status === "BLOCK_NEW_ENTRY" ? "BLOCK_NEW_ENTRY"
      : verdict.status === "REDUCE_RISK" ? "REDUCE_RISK"
        : "KEEP_CURRENT_FROZEN_UNCHANGED",
    riskMultiplier,
    smallNDoesNotImplyBroken: verdict.status === "INSUFFICIENT_EVIDENCE",
  };
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_STRATEGY_HEALTH_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: "STRATEGY_HEALTH_EVALUATED",
    health,
    healthEvidenceId: `adaptive-v2-health:${sha256Canonical(health)}`,
    challengerFeedback: feedback,
    currentFrozenPortfolioUnchanged: true,
    economicSampleCredit: 0,
    profitabilityProven: false,
    frozenV1Contamination: 0,
    blockers: [],
    ...safety(),
  });
}
