import { evaluateUnifiedProfitabilityPromotion } from "./unified-profitability-promotion-gate-v1.js";

const DEFAULT_POLICY = Object.freeze({
  maximumSymbolDependencyPenaltyPoints: 10,
  minimumPositiveSymbolRatio: 1,
});

const PROMOTION_HOLD_SAFETY = Object.freeze({
  liveTradingAllowed: false,
  privateTradingApiAllowed: false,
  orderAuthority: false,
  actualOrders: 0,
  promotionReviewOnly: false,
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function standardDeviation(values) {
  if (values.length === 0) return null;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

function candidateMap(row) {
  return new Map((row?.result?.candidates ?? []).map((candidate) => [candidate.id, candidate]));
}

function commonCandidateIds(rows) {
  if (rows.length === 0) return [];
  const maps = rows.map(candidateMap);
  return [...maps[0].keys()].filter((id) => maps.every((map) => map.has(id))).sort();
}

function aggregateStatus(candidates) {
  if (candidates.some((candidate) => candidate.researchStatus === "research_hold")) return "research_hold";
  if (candidates.some((candidate) => candidate.researchStatus === "threshold_calibration_required")) return "threshold_calibration_required";
  if (candidates.every((candidate) => candidate.researchStatus === "eligible_for_final_holdout")) return "eligible_for_final_holdout";
  return "research_hold";
}

function holdPromotionAssessment(reason) {
  return Object.freeze({
    schemaVersion: 1,
    strategyFingerprint: null,
    promotionEligible: false,
    status: "RESEARCH_HOLD",
    reasons: Object.freeze([reason]),
    stages: Object.freeze({ policy: false, backtest: false, selectionBias: false, shadow: false, paper: false }),
    safety: PROMOTION_HOLD_SAFETY,
  });
}

function promotionEvidenceForCandidate(evidenceByCandidate, rankingGroup, candidateId) {
  if (!evidenceByCandidate || typeof evidenceByCandidate !== "object") return null;
  return evidenceByCandidate[`${rankingGroup}:${candidateId}`] ?? evidenceByCandidate[candidateId] ?? null;
}

function buildPromotionAssessment({ evidenceByCandidate, promotionPolicy, rankingGroup, candidateId }) {
  const evidence = promotionEvidenceForCandidate(evidenceByCandidate, rankingGroup, candidateId);
  if (!evidence || typeof evidence !== "object") return holdPromotionAssessment("promotion:unified_evidence_not_supplied");
  if (typeof evidence.strategyFingerprint !== "string" || evidence.strategyFingerprint.length === 0) {
    return holdPromotionAssessment("promotion:strategy_fingerprint_missing");
  }
  return evaluateUnifiedProfitabilityPromotion({
    strategyFingerprint: evidence.strategyFingerprint,
    backtest: evidence.backtest,
    selectionBias: evidence.selectionBias,
    shadow: evidence.shadow,
    paper: evidence.paper,
    policy: promotionPolicy,
  });
}

export function aggregateMarketGroupCandidates(results, {
  policy = DEFAULT_POLICY,
  requiredSymbolsByGroup = {},
  promotionEvidenceByCandidate = {},
  promotionPolicy = null,
} = {}) {
  if (!Array.isArray(results)) throw new TypeError("results must be an array");
  if (!(policy.maximumSymbolDependencyPenaltyPoints >= 0)) throw new RangeError("maximumSymbolDependencyPenaltyPoints must be non-negative");
  if (!(policy.minimumPositiveSymbolRatio > 0 && policy.minimumPositiveSymbolRatio <= 1)) throw new RangeError("minimumPositiveSymbolRatio must be in (0,1]");

  const groups = new Map();
  for (const row of results) {
    if (!row?.rankingGroup || !row?.result?.symbol) continue;
    const bucket = groups.get(row.rankingGroup) ?? [];
    bucket.push(row);
    groups.set(row.rankingGroup, bucket);
  }

  return Object.freeze(Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([rankingGroup, rows]) => {
    const requiredSymbols = requiredSymbolsByGroup[rankingGroup] ?? rows.map((row) => row.result.symbol).sort();
    const presentSymbols = [...new Set(rows.map((row) => row.result.symbol))].sort();
    const missingSymbols = requiredSymbols.filter((symbol) => !presentSymbols.includes(symbol));
    if (missingSymbols.length > 0) {
      return [rankingGroup, Object.freeze({
        rankingGroup,
        status: "research_hold",
        reason: "missing_required_symbol_dataset",
        requiredSymbols: Object.freeze([...requiredSymbols]),
        presentSymbols: Object.freeze(presentSymbols),
        missingSymbols: Object.freeze(missingSymbols),
        candidates: Object.freeze([]),
      })];
    }

    const ids = commonCandidateIds(rows);
    const maps = rows.map((row) => ({ row, map: candidateMap(row) }));
    const candidates = ids.map((id) => {
      const symbolCandidates = maps.map(({ row, map }) => Object.freeze({
        symbol: row.result.symbol,
        datasetId: row.datasetId,
        provider: row.provider,
        crossVenueProxy: row.crossVenueProxy === true,
        candidate: map.get(id),
      }));
      const oosReturns = symbolCandidates.map(({ candidate }) => candidate.oosMetrics.totalReturn).filter(Number.isFinite);
      const qualityScores = symbolCandidates.map(({ candidate }) => candidate.qualityScore).filter(Number.isFinite);
      const wfScores = symbolCandidates.map(({ candidate }) => candidate.walkForward?.stability?.stabilityScore).filter(Number.isFinite);
      const totalTrades = symbolCandidates.reduce((sum, { candidate }) => sum + (Number.isFinite(candidate.oosMetrics.tradeCount) ? candidate.oosMetrics.tradeCount : 0), 0);
      const positiveSymbols = symbolCandidates.filter(({ candidate }) => candidate.oosMetrics.totalReturn > 0 && candidate.oosMetrics.expectancy > 0).length;
      const positiveSymbolRatio = symbolCandidates.length ? positiveSymbols / symbolCandidates.length : 0;
      const dependencySeverity = clamp((policy.minimumPositiveSymbolRatio - positiveSymbolRatio) / policy.minimumPositiveSymbolRatio, 0, 1);
      const symbolDependencyPenaltyPoints = dependencySeverity * policy.maximumSymbolDependencyPenaltyPoints;
      const baseQuality = qualityScores.length ? Math.min(...qualityScores) : 0;
      const qualityScore = Math.max(0, baseQuality - symbolDependencyPenaltyPoints);
      const researchStatus = aggregateStatus(symbolCandidates.map(({ candidate }) => candidate));
      const flags = [];
      if (positiveSymbolRatio < policy.minimumPositiveSymbolRatio) flags.push("single_or_partial_symbol_dependency");
      if (symbolCandidates.some(({ candidate }) => candidate.overfitDiagnostics?.flags?.includes("low_oos_trade_sample"))) flags.push("low_oos_trade_sample");
      if (symbolCandidates.some(({ candidate }) => candidate.overfitDiagnostics?.flags?.includes("top_two_winner_dependency"))) flags.push("top_two_winner_dependency");
      const promotionAssessment = buildPromotionAssessment({
        evidenceByCandidate: promotionEvidenceByCandidate,
        promotionPolicy,
        rankingGroup,
        candidateId: id,
      });
      return Object.freeze({
        id,
        parameters: symbolCandidates[0].candidate.parameters,
        researchStatus,
        qualityScoreBeforeSymbolPenalty: Number(baseQuality.toFixed(6)),
        symbolDependencyPenaltyPoints: Number(symbolDependencyPenaltyPoints.toFixed(6)),
        qualityScore: Number(qualityScore.toFixed(6)),
        promotionAssessment,
        diagnostics: Object.freeze({
          symbolCount: symbolCandidates.length,
          requiredSymbolCount: requiredSymbols.length,
          positiveSymbols,
          positiveSymbolRatio,
          allRequiredSymbolsPositive: positiveSymbolRatio === 1 && symbolCandidates.length === requiredSymbols.length,
          totalOosTrades: totalTrades,
          meanOosReturn: mean(oosReturns),
          worstOosReturn: oosReturns.length ? Math.min(...oosReturns) : null,
          oosReturnDispersion: standardDeviation(oosReturns),
          meanWalkForwardStability: mean(wfScores),
          worstWalkForwardStability: wfScores.length ? Math.min(...wfScores) : null,
          flags: Object.freeze([...new Set(flags)].sort()),
        }),
        symbols: Object.freeze(symbolCandidates),
      });
    }).sort((left, right) => right.qualityScore - left.qualityScore || left.id.localeCompare(right.id));

    return [rankingGroup, Object.freeze({
      rankingGroup,
      status: candidates.length > 0 ? "evaluated" : "research_hold",
      reason: candidates.length > 0 ? null : "no_common_parameter_candidate_across_required_symbols",
      requiredSymbols: Object.freeze([...requiredSymbols]),
      presentSymbols: Object.freeze(presentSymbols),
      missingSymbols: Object.freeze([]),
      candidateCount: candidates.length,
      candidates: Object.freeze(candidates),
    })];
  })));
}

export const DEFAULT_MARKET_GROUP_POLICY = DEFAULT_POLICY;
