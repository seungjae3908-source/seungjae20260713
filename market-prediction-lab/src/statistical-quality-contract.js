const LOW_SAMPLE_REFERENCE_TRADES = 10;

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function buildStatisticalQuality(candidate) {
  if (!candidate || typeof candidate !== "object") throw new TypeError("candidate is required");
  const developmentTradeCount = finiteOrNull(candidate.developmentMetrics?.tradeCount) ?? 0;
  const oosTradeCount = finiteOrNull(candidate.oosMetrics?.tradeCount) ?? 0;
  const wfTradeCount = (candidate.walkForward?.windows ?? []).reduce(
    (sum, window) => sum + (finiteOrNull(window.tradeCount) ?? 0),
    0,
  );
  const lowSamplePenalty = clamp(1 - (oosTradeCount / LOW_SAMPLE_REFERENCE_TRADES), 0, 1);
  const topTwoWinnerShare = finiteOrNull(candidate.overfitDiagnostics?.topTwoWinnerShare);
  const profitableRegimeRatio = finiteOrNull(candidate.overfitDiagnostics?.profitableRegimeRatio);
  return Object.freeze({
    developmentTradeCount,
    oosTradeCount,
    wfTradeCount,
    // WF windows can overlap OOS and each other. Until trade-ID disjointness is
    // proven, do not double-count them as statistically independent evidence.
    totalIndependentTrades: oosTradeCount,
    totalIndependentTradesMethod: "conservative_oos_only_until_cross_window_trade_id_deduplication",
    sampleQuality: oosTradeCount < LOW_SAMPLE_REFERENCE_TRADES ? "low" : "uncalibrated_not_a_pass",
    lowSamplePenalty,
    concentrationPenalty: finiteOrNull(candidate.overfitPenaltyPoints) ?? 0,
    topTradeDependency: topTwoWinnerShare,
    symbolDependency: null,
    regimeDependency: profitableRegimeRatio == null ? null : clamp(1 - profitableRegimeRatio, 0, 1),
    statisticalPass: false,
    statisticalPassReason: oosTradeCount < LOW_SAMPLE_REFERENCE_TRADES
      ? "research_hold_low_oos_sample"
      : "gate_calibration_required_no_empirical_pass_threshold_yet",
  });
}

export function enrichPerSymbolResearchResult(result) {
  if (!result || typeof result !== "object") throw new TypeError("result is required");
  return Object.freeze({
    ...result,
    candidates: Object.freeze((result.candidates ?? []).map((candidate) => Object.freeze({
      ...candidate,
      ...buildStatisticalQuality(candidate),
    }))),
  });
}

export function markCrossSymbolPreliminary(marketGroups) {
  if (!marketGroups || typeof marketGroups !== "object") throw new TypeError("marketGroups is required");
  return Object.freeze(Object.fromEntries(Object.entries(marketGroups).map(([group, value]) => {
    const candidates = (value.candidates ?? []).map((candidate) => {
      const positiveSymbolRatio = finiteOrNull(candidate.diagnostics?.positiveSymbolRatio);
      const dependency = positiveSymbolRatio == null ? null : clamp(1 - positiveSymbolRatio, 0, 1);
      const dependencyDetected = dependency != null && dependency > 0;
      return Object.freeze({
        ...candidate,
        researchStatus: dependencyDetected ? "research_hold" : candidate.researchStatus,
        crossSymbolValidation: "preliminary",
        symbolDependency: Object.freeze({
          value: dependency,
          positiveSymbolRatio,
          requiredSymbols: Object.freeze([...(value.requiredSymbols ?? [])]),
          observedSymbols: Object.freeze([...(value.presentSymbols ?? [])]),
          penaltyPoints: finiteOrNull(candidate.symbolDependencyPenaltyPoints) ?? 0,
          researchHoldWhenDetected: true,
        }),
      });
    });
    return [group, Object.freeze({
      ...value,
      crossSymbolValidation: "preliminary",
      crossSymbolScope: "btc_eth_only_not_full_market_stability",
      finalHoldoutEligibilityFromCrossSymbolStage: false,
      expansionSupported: true,
      candidates: Object.freeze(candidates),
    })];
  })));
}

export function buildProtectedFinalHoldoutQueue(marketGroups) {
  return Object.freeze(Object.fromEntries(Object.entries(marketGroups).map(([group, value]) => [group, Object.freeze(
    value.crossSymbolValidation === "validated"
      ? (value.candidates ?? [])
        .filter((candidate) => candidate.researchStatus === "eligible_for_final_holdout" && candidate.statisticalPass === true)
        .slice(0, 10)
        .map((candidate) => Object.freeze({
          candidateId: candidate.id,
          parameters: candidate.parameters,
          qualityScore: candidate.qualityScore,
          status: "frozen_candidate_pending_one_shot_final_holdout",
          parameterRetuningAllowedAfterHoldout: false,
          candidateFamilyReentryAfterHoldoutAllowed: false,
        }))
      : [],
  )])));
}

export const STATISTICAL_QUALITY_POLICY = Object.freeze({
  lowSampleReferenceTrades: LOW_SAMPLE_REFERENCE_TRADES,
  lowSampleReferenceMeaning: "research_hold_reference_only_not_strategy_pass_threshold",
  empiricalPassThresholdCalibrated: false,
  crossSymbolValidation: "preliminary",
  finalHoldoutQueueRequiresValidatedCrossSymbolStage: true,
});
