export const FORWARD_TARGET_TIMEFRAME_AUDITED_MAIN_SHA_V1 =
  'd88f114f3cc7a0223adeb446850398485d4c3144';

export const FORWARD_TARGET_TIMEFRAME_OWNER_FILE_SHA_V1 =
  '6287a3aed94896b7c22c03be33cb1b2885c3b1e3';

export const FORWARD_TARGET_TIMEFRAME_BY_MARKET_V1 = Object.freeze({
  KR_STOCK: '60M',
  US_STOCK: '60M',
  CRYPTO_SPOT: '4H',
  CRYPTO_FUTURES: '60M',
});

export const MARKET_SPECIFIC_HYPOTHESIS_POLICY_V1 = Object.freeze({
  maximumMddExpansionVsBaseline: 0.10,
  minimumTradeCount: 20,
  minimumTotalReturnExclusive: 0,
  minimumProfitFactorExclusive: 1,
  requirePositiveReturn: true,
  minimumProfitFactor: 1.0,
  requireReturnAboveBaseline: true,
  requireReturnAboveFull: true,
  requireProfitFactorNotBelowBaseline: true,
  requireProfitFactorNotBelowFull: true,
});

const ABLATION_VARIANTS = Object.freeze([
  'NO_TREND',
  'NO_MOMENTUM',
  'NO_STRUCTURE',
  'NO_VOLUME',
  'NO_VOLATILITY',
]);

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function compareCandidate(left, right) {
  const leftReturn = finite(left.metrics.totalReturn) ?? -Infinity;
  const rightReturn = finite(right.metrics.totalReturn) ?? -Infinity;
  if (leftReturn !== rightReturn) return rightReturn - leftReturn;
  const leftMdd = finite(left.metrics.maximumDrawdown) ?? Infinity;
  const rightMdd = finite(right.metrics.maximumDrawdown) ?? Infinity;
  if (leftMdd !== rightMdd) return leftMdd - rightMdd;
  const leftPf = finite(left.metrics.profitFactor) ?? -Infinity;
  const rightPf = finite(right.metrics.profitFactor) ?? -Infinity;
  return rightPf - leftPf;
}

function gateCandidate({ candidate, baseline, full, policy }) {
  const reasons = [];
  if (!Number.isFinite(candidate.totalReturn)) reasons.push('CANDIDATE_RETURN_UNAVAILABLE');
  else if (!(candidate.totalReturn > policy.minimumTotalReturnExclusive)) reasons.push('NON_POSITIVE_TOTAL_RETURN');
  if (!Number.isFinite(candidate.maximumDrawdown)) reasons.push('CANDIDATE_MDD_UNAVAILABLE');
  if (!Number.isFinite(candidate.profitFactor)) reasons.push('PROFIT_FACTOR_NOT_COMPARABLE');
  else if (!(candidate.profitFactor > policy.minimumProfitFactorExclusive)) reasons.push('PROFIT_FACTOR_NOT_ABOVE_ONE');
  if (!Number.isFinite(candidate.tradeCount) || candidate.tradeCount < policy.minimumTradeCount) {
    reasons.push('MINIMUM_TRADE_COUNT_NOT_MET');
  }
  if (policy.requirePositiveReturn
      && Number.isFinite(candidate.totalReturn)
      && candidate.totalReturn <= 0) {
    reasons.push('CANDIDATE_RETURN_NOT_POSITIVE');
  }
  if (Number.isFinite(candidate.profitFactor)
      && Number.isFinite(policy.minimumProfitFactor)
      && candidate.profitFactor < policy.minimumProfitFactor) {
    reasons.push('PROFIT_FACTOR_BELOW_MINIMUM');
  }
  if (policy.requireReturnAboveBaseline
      && Number.isFinite(candidate.totalReturn)
      && Number.isFinite(baseline?.totalReturn)
      && candidate.totalReturn <= baseline.totalReturn) {
    reasons.push('RETURN_NOT_ABOVE_BASELINE');
  }
  if (policy.requireReturnAboveFull
      && Number.isFinite(candidate.totalReturn)
      && Number.isFinite(full?.totalReturn)
      && candidate.totalReturn <= full.totalReturn) {
    reasons.push('RETURN_NOT_ABOVE_FULL');
  }
  if (Number.isFinite(candidate.maximumDrawdown) && Number.isFinite(baseline?.maximumDrawdown)) {
    const limit = baseline.maximumDrawdown * (1 + policy.maximumMddExpansionVsBaseline);
    if (candidate.maximumDrawdown > limit) reasons.push('MDD_EXPANSION_LIMIT_EXCEEDED');
  }
  if (policy.requireProfitFactorNotBelowBaseline
      && Number.isFinite(candidate.profitFactor)
      && Number.isFinite(baseline?.profitFactor)
      && candidate.profitFactor < baseline.profitFactor) {
    reasons.push('PROFIT_FACTOR_BELOW_BASELINE');
  }
  if (policy.requireProfitFactorNotBelowFull
      && Number.isFinite(candidate.profitFactor)
      && Number.isFinite(full?.profitFactor)
      && candidate.profitFactor < full.profitFactor) {
    reasons.push('PROFIT_FACTOR_BELOW_FULL');
  }
  return freeze([...new Set(reasons)].sort());
}

export function freezeMarketSpecificHypotheses(ablation, {
  policy = MARKET_SPECIFIC_HYPOTHESIS_POLICY_V1,
  forwardTargetTimeframes = FORWARD_TARGET_TIMEFRAME_BY_MARKET_V1,
  forwardTargetTimeframeOwnerSha = FORWARD_TARGET_TIMEFRAME_AUDITED_MAIN_SHA_V1,
  forwardTargetTimeframeOwnerFileSha = FORWARD_TARGET_TIMEFRAME_OWNER_FILE_SHA_V1,
} = {}) {
  if (!ablation || ablation.schemaVersion !== 'move-hunter-one-year-factor-ablation/v1') {
    throw new TypeError('one-year factor ablation result is required');
  }
  if (!ablation.markets || typeof ablation.markets !== 'object') {
    throw new TypeError('ablation markets are required');
  }

  const markets = {};
  for (const [market, row] of Object.entries(ablation.markets)) {
    const baseline = row?.variants?.BASELINE;
    const full = row?.variants?.FULL;
    if (!baseline || !full) throw new TypeError('baseline and full variants are required for ' + market);
    const ranked = ABLATION_VARIANTS
      .map((id) => ({ id, metrics: row.variants?.[id] }))
      .filter((item) => item.metrics)
      .sort(compareCandidate);
    const best = ranked[0] ?? null;
    if (!best) throw new TypeError('factor ablation variants are required for ' + market);

    const evaluated = ranked.map((item) => freeze({
      id: item.id,
      metrics: item.metrics,
      reasons: gateCandidate({
        candidate: item.metrics,
        baseline,
        full,
        policy,
      }),
    }));
    const eligibleCandidates = evaluated
      .filter((item) => item.reasons.length === 0)
      .sort(compareCandidate);
    const selected = eligibleCandidates[0] ?? null;
    const eligible = selected != null;
    const reasons = eligible
      ? []
      : evaluated.find((item) => item.id === best.id)?.reasons ?? freeze(['NO_ELIGIBLE_CANDIDATE']);
    const sourceTimeframes = Array.isArray(row.sourceTimeframes)
      ? [...new Set(row.sourceTimeframes.map((value) => String(value).toUpperCase()))].sort()
      : [];
    const targetForwardTimeframe = String(forwardTargetTimeframes?.[market] ?? '').toUpperCase() || null;
    const exactSourceTimeframe = sourceTimeframes.length === 1 ? sourceTimeframes[0] : null;
    const forwardTimeframeMatch = exactSourceTimeframe != null
      && targetForwardTimeframe != null
      && exactSourceTimeframe === targetForwardTimeframe;
    const forwardAdmissionReasons = [];
    if (sourceTimeframes.length !== 1) forwardAdmissionReasons.push('SOURCE_TIMEFRAME_IDENTITY_NOT_EXACT');
    if (!targetForwardTimeframe) forwardAdmissionReasons.push('FORWARD_TARGET_TIMEFRAME_UNKNOWN');
    if (sourceTimeframes.length === 1 && targetForwardTimeframe && !forwardTimeframeMatch) {
      forwardAdmissionReasons.push('SOURCE_FORWARD_TIMEFRAME_MISMATCH');
    }

    markets[market] = freeze({
      market,
      status: eligible ? 'FROZEN_HYPOTHESIS' : 'RESEARCH_HOLD',
      descriptiveBestVariant: best.id,
      selectedVariant: selected?.id ?? null,
      eligibleCandidateCount: eligibleCandidates.length,
      candidateDiagnostics: freeze(evaluated.map((item) => freeze({
        id: item.id,
        reasons: item.reasons,
      }))),
      reasons,
      sourceTimeframes: freeze(sourceTimeframes),
      targetForwardTimeframe,
      forwardTargetTimeframeOwnerSha,
      forwardTargetTimeframeOwnerFileSha,
      baseline: freeze({
        totalReturn: baseline.totalReturn,
        maximumDrawdown: baseline.maximumDrawdown,
        profitFactor: baseline.profitFactor,
        tradeCount: baseline.tradeCount,
      }),
      full: freeze({
        totalReturn: full.totalReturn,
        maximumDrawdown: full.maximumDrawdown,
        profitFactor: full.profitFactor,
        tradeCount: full.tradeCount,
      }),
      descriptiveBest: freeze({
        totalReturn: best.metrics.totalReturn,
        maximumDrawdown: best.metrics.maximumDrawdown,
        profitFactor: best.metrics.profitFactor,
        tradeCount: best.metrics.tradeCount,
      }),
      selectedCandidate: selected ? freeze({
        id: selected.id,
        totalReturn: selected.metrics.totalReturn,
        maximumDrawdown: selected.metrics.maximumDrawdown,
        profitFactor: selected.metrics.profitFactor,
        tradeCount: selected.metrics.tradeCount,
      }) : null,
      futureValidation: freeze({
        candidateFrozen: eligible,
        sourceTimeframe: exactSourceTimeframe,
        targetForwardTimeframe,
        timeframeMatch: forwardTimeframeMatch,
        forwardAdmissionStatus: eligible && forwardTimeframeMatch
          ? 'ELIGIBLE_FOR_UNUSED_FORWARD_OBSERVATION'
          : eligible
            ? 'BLOCKED_TIMEFRAME_IDENTITY'
            : 'NONE',
        forwardAdmissionReasons: freeze([...new Set(forwardAdmissionReasons)].sort()),
        allowedUse: eligible
          ? forwardTimeframeMatch
            ? 'UNUSED_OOS_OR_FORWARD_ONLY'
            : 'UNUSED_MATCHING_TIMEFRAME_OOS_ONLY'
          : 'NONE',
        observedHistoryMayCountAsOos: false,
        observedHistoryMayCountAsForward: false,
        crossTimeframeCreditAllowed: false,
        automaticScannerAdoptionAllowed: false,
        automaticPromotionAllowed: false,
        economicSampleCredit: 0,
        profitabilityClaimAllowed: false,
        executionAuthority: 'NONE',
      }),
    });
  }

  return freeze({
    schemaVersion: 'move-hunter-market-specific-hypothesis/v1',
    sourceSchemaVersion: ablation.schemaVersion,
    policy: freeze({ ...policy }),
    forwardTargetTimeframeOwnerSha,
    forwardTargetTimeframeOwnerFileSha,
    forwardTargetTimeframes: freeze({ ...forwardTargetTimeframes }),
    markets: freeze(markets),
    safety: freeze({
      selectedFromObservedHistory: true,
      sameWindowSelectionBiasAcknowledged: true,
      observedHistoryMayCountAsOos: false,
      observedHistoryMayCountAsForward: false,
      crossTimeframeCreditAllowed: false,
      automaticScannerAdoptionAllowed: false,
      automaticPromotionAllowed: false,
      economicSampleCredit: 0,
      profitabilityClaimAllowed: false,
      executionAuthority: 'NONE',
      liveTrading: false,
      realOrder: false,
      privateApi: false,
    }),
  });
}
