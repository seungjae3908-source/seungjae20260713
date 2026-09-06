const ENFORCEMENT_MODES = new Set(['OBSERVE_ONLY', 'REQUIRED_FOR_PARENT_GATE']);
const LONG_ONLY_MARKETS = new Set(['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT']);
const FUTURES_DIRECTIONS = new Set(['LONG', 'SHORT']);

export const DEFAULT_DYNAMIC_SIZING_POLICY = Object.freeze({
  version: 'MIS_DYNAMIC_BET_SIZING_V1',
  enforcement: 'OBSERVE_ONLY',
  fullSizeNetAlphaBps: 10,
  minimumActiveMultiplier: 0.25,
  highVolMultiplier: 0.60,
  lowVolRangeMultiplier: 0.85,
  rangeMultiplier: 0.90,
  lowLiquidityMultiplier: 0.25,
  counterTrendMultiplier: 0.50,
  driftWatchMultiplier: 0.50,
  drawdownScaleStartPct: 5,
  drawdownStopPct: 15,
});

const LOCKED_POLICY_FIELDS = Object.freeze([
  'fullSizeNetAlphaBps',
  'minimumActiveMultiplier',
  'highVolMultiplier',
  'lowVolRangeMultiplier',
  'rangeMultiplier',
  'lowLiquidityMultiplier',
  'counterTrendMultiplier',
  'driftWatchMultiplier',
  'drawdownScaleStartPct',
  'drawdownStopPct',
]);

function finite(value, fallback = null) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function resolvePolicy(input = {}) {
  if (input == null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('DYNAMIC_SIZING_POLICY_INVALID');
  if (input.version != null && input.version !== DEFAULT_DYNAMIC_SIZING_POLICY.version) {
    throw new Error('DYNAMIC_SIZING_POLICY_VERSION_OVERRIDE_NOT_ALLOWED');
  }
  for (const field of LOCKED_POLICY_FIELDS) {
    if (Object.hasOwn(input, field) && input[field] !== DEFAULT_DYNAMIC_SIZING_POLICY[field]) {
      throw new Error(`DYNAMIC_SIZING_POLICY_OVERRIDE_NOT_ALLOWED:${field}`);
    }
  }
  const enforcement = String(input.enforcement ?? DEFAULT_DYNAMIC_SIZING_POLICY.enforcement).toUpperCase();
  if (!ENFORCEMENT_MODES.has(enforcement)) throw new Error('DYNAMIC_SIZING_POLICY_ENFORCEMENT_INVALID');
  return { ...DEFAULT_DYNAMIC_SIZING_POLICY, enforcement };
}

function gateState(result) {
  return String(result?.autoTrading?.state ?? 'INSUFFICIENT_EVIDENCE').toUpperCase();
}

function gateReasons(result) {
  return Array.isArray(result?.autoTrading?.reasons) ? result.autoTrading.reasons : [];
}

function usableStatus(value) {
  const status = String(value ?? '').toUpperCase();
  return status && status !== 'NOT_AVAILABLE';
}

function gateEvidenceComplete(name, result) {
  if (!result || typeof result !== 'object') return false;
  if (name === 'REGIME') {
    return result.status === 'READY'
      && usableStatus(result.drift?.status)
      && result.safety?.executionAuthority === 'NONE'
      && result.safety?.liveTrading !== true;
  }
  if (name === 'NET_ALPHA') {
    return result.status === 'READY'
      && result.role === 'CONSERVATIVE_CROSS_CHECK_ONLY'
      && result.readiness?.forwardDataComplete === true
      && result.readiness?.fullCostReady === true
      && result.readiness?.evidenceComplete === true
      && result.readiness?.profitabilityProven === true
      && result.safety?.executionAuthority === 'NONE'
      && result.safety?.aiNumericalAuthority === false
      && result.safety?.profitabilityClaimAllowed === false
      && result.safety?.liveTrading !== true;
  }
  if (name === 'ADVANCED') {
    return usableStatus(result.uncertainty?.status)
      && usableStatus(result.metaLabel?.status)
      && usableStatus(result.eventRisk?.status);
  }
  if (name === 'EXECUTION') {
    return usableStatus(result.bookWalk?.status) && usableStatus(result.fillModel?.status);
  }
  if (name === 'PORTFOLIO') {
    return usableStatus(result.portfolio?.status)
      && usableStatus(result.expectedShortfall?.status)
      && usableStatus(result.signalFreshness?.status);
  }
  return false;
}

function directionGate(marketInput, directionInput) {
  const market = String(marketInput ?? '').toUpperCase();
  const direction = String(directionInput ?? '').toUpperCase();
  if (!market) return { state: 'INSUFFICIENT_EVIDENCE', reason: 'MARKET_EVIDENCE_MISSING' };
  if (!direction) return { state: 'INSUFFICIENT_EVIDENCE', reason: 'DIRECTION_EVIDENCE_MISSING' };
  if (direction === 'NO_TRADE') return { state: 'VETO', reason: 'UPSTREAM_NO_TRADE' };
  if (direction === 'SIGNAL_CONFLICT') return { state: 'VETO', reason: 'UPSTREAM_SIGNAL_CONFLICT' };
  if (LONG_ONLY_MARKETS.has(market)) {
    return direction === 'BUY'
      ? { state: 'PASS', reason: null }
      : { state: 'VETO', reason: 'DIRECTION_NOT_ALLOWED_FOR_MARKET' };
  }
  if (market === 'CRYPTO_FUTURES') {
    return FUTURES_DIRECTIONS.has(direction)
      ? { state: 'PASS', reason: null }
      : { state: 'VETO', reason: 'DIRECTION_NOT_ALLOWED_FOR_MARKET' };
  }
  return { state: 'INSUFFICIENT_EVIDENCE', reason: 'MARKET_NOT_SUPPORTED_FOR_SIZING' };
}

function regimeFactor(regimeBrain, direction, policy) {
  const label = String(regimeBrain?.regime?.label ?? '').toUpperCase();
  let factor = 1;
  if (label === 'HIGH_VOL') factor = policy.highVolMultiplier;
  else if (label === 'LOW_VOL_RANGE') factor = policy.lowVolRangeMultiplier;
  else if (label === 'RANGE') factor = policy.rangeMultiplier;
  else if (label === 'LOW_LIQUIDITY') factor = policy.lowLiquidityMultiplier;

  const dir = String(direction ?? '').toUpperCase();
  const bullish = dir === 'BUY' || dir === 'LONG';
  const bearish = dir === 'SHORT';
  if ((bullish && label === 'TREND_DOWN') || (bearish && label === 'TREND_UP')) {
    factor = Math.min(factor, policy.counterTrendMultiplier);
  }
  if (regimeBrain?.drift?.status === 'WATCH') factor = Math.min(factor, policy.driftWatchMultiplier);
  if (regimeBrain?.drift?.status === 'BRAKE') factor = 0;
  return clamp(factor, 0, 1);
}

function drawdownFactor(currentDrawdownPct, policy) {
  if (currentDrawdownPct == null) return null;
  const drawdown = Math.abs(currentDrawdownPct);
  if (drawdown >= policy.drawdownStopPct) return 0;
  if (drawdown <= policy.drawdownScaleStartPct) return 1;
  const span = policy.drawdownStopPct - policy.drawdownScaleStartPct;
  return clamp((policy.drawdownStopPct - drawdown) / span, 0, 1);
}

export function evaluateDynamicBetSizing(raw = {}, policyInput = {}) {
  const policy = resolvePolicy(policyInput);
  const market = String(raw.market ?? '').toUpperCase() || null;
  const direction = String(raw.direction ?? '').toUpperCase() || null;
  const canonicalDirection = directionGate(market, direction);
  const regimeBrain = raw.regimeBrain;
  const netAlpha = raw.netAlpha;
  const advancedGates = raw.advancedGates;
  const executionQuality = raw.executionQuality;
  const portfolioSafety = raw.portfolioSafety;
  const currentDrawdownPct = finite(raw.currentDrawdownPct);
  const parentBaseRiskFraction = finite(raw.parentBaseRiskFraction);
  const parentBaseNotional = finite(raw.parentBaseNotional);

  const gates = [
    ['REGIME', regimeBrain],
    ['NET_ALPHA', netAlpha],
    ['ADVANCED', advancedGates],
    ['EXECUTION', executionQuality],
    ['PORTFOLIO', portfolioSafety],
  ];
  const vetoes = gates.filter(([, result]) => gateState(result) === 'VETO');
  const incomplete = gates.filter(([name, result]) => {
    const state = gateState(result);
    return (state !== 'PASS' && state !== 'VETO') || !gateEvidenceComplete(name, result);
  });

  const conservativeNetAlphaBps = finite(netAlpha?.conservativeNetAlphaBps);
  const alphaFactor = conservativeNetAlphaBps == null
    ? null
    : clamp(conservativeNetAlphaBps / policy.fullSizeNetAlphaBps, policy.minimumActiveMultiplier, 1);
  const regimeSizeFactor = gateState(regimeBrain) === 'PASS' && gateEvidenceComplete('REGIME', regimeBrain)
    ? regimeFactor(regimeBrain, direction, policy)
    : null;
  const ddFactor = drawdownFactor(currentDrawdownPct, policy);

  const vetoReasons = vetoes.flatMap(([name, result]) => {
    const reasons = gateReasons(result);
    return reasons.length ? reasons : [`${name}_GATE_VETO`];
  });
  if (canonicalDirection.state === 'VETO') vetoReasons.push(canonicalDirection.reason);
  if (ddFactor === 0 && currentDrawdownPct != null) vetoReasons.push('DRAWDOWN_BRAKE');

  let state;
  let reasons;
  let recommendedMultiplier;
  if (vetoReasons.length) {
    state = 'VETO';
    reasons = [...new Set(vetoReasons)];
    recommendedMultiplier = 0;
  } else if (canonicalDirection.state !== 'PASS' || incomplete.length || alphaFactor == null || regimeSizeFactor == null || ddFactor == null) {
    state = 'INSUFFICIENT_EVIDENCE';
    reasons = [
      ...(canonicalDirection.reason ? [canonicalDirection.reason] : []),
      ...incomplete.map(([name]) => `${name}_EVIDENCE_INCOMPLETE`),
      ...(alphaFactor == null ? ['NET_ALPHA_SIZING_EVIDENCE_MISSING'] : []),
      ...(regimeSizeFactor == null ? ['REGIME_SIZING_EVIDENCE_MISSING'] : []),
      ...(ddFactor == null ? ['DRAWDOWN_EVIDENCE_MISSING'] : []),
    ];
    recommendedMultiplier = null;
  } else {
    state = 'PASS';
    reasons = [];
    recommendedMultiplier = clamp(Math.min(alphaFactor, regimeSizeFactor, ddFactor), 0, 1);
  }

  const advisoryMultiplier = state === 'VETO'
    ? 0
    : state === 'PASS'
      ? recommendedMultiplier
      : null;

  const suggestedRiskFraction = parentBaseRiskFraction != null && parentBaseRiskFraction >= 0 && recommendedMultiplier != null
    ? Math.min(parentBaseRiskFraction, parentBaseRiskFraction * recommendedMultiplier)
    : null;
  const suggestedNotional = parentBaseNotional != null && parentBaseNotional >= 0 && recommendedMultiplier != null
    ? Math.min(parentBaseNotional, parentBaseNotional * recommendedMultiplier)
    : null;

  return {
    contract: 'market-intelligence-dynamic-bet-sizing/v1',
    policy,
    market,
    direction,
    directionGate: canonicalDirection,
    state,
    reasons: [...new Set(reasons)],
    factors: {
      alpha: alphaFactor,
      regime: regimeSizeFactor,
      drawdown: ddFactor,
    },
    currentDrawdownPct,
    advisoryMultiplier,
    recommendedMultiplier,
    parentBaseRiskFraction,
    suggestedRiskFraction,
    parentBaseNotional,
    suggestedNotional,
    autoTrading: {
      state,
      reasons: [...new Set(reasons)],
      orderAllowed: false,
    },
    safety: {
      executionAuthority: 'NONE',
      liveTrading: false,
      aiNumericalAuthority: false,
      userMultiplierAuthority: false,
      orderAllowed: false,
      canIncreaseParentExposure: false,
      maximumMultiplier: 1,
      reductionOnly: true,
    },
  };
}
