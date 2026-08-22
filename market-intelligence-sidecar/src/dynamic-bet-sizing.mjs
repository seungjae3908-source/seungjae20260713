const ENFORCEMENT_MODES = new Set(['OBSERVE_ONLY', 'REQUIRED_FOR_PARENT_GATE']);

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

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function resolvePolicy(input = {}) {
  const policy = { ...DEFAULT_DYNAMIC_SIZING_POLICY, ...(input ?? {}) };
  if (typeof policy.version !== 'string' || !policy.version.trim()) throw new Error('DYNAMIC_SIZING_POLICY_VERSION_REQUIRED');
  policy.enforcement = String(policy.enforcement ?? '').toUpperCase();
  if (!ENFORCEMENT_MODES.has(policy.enforcement)) throw new Error('DYNAMIC_SIZING_POLICY_ENFORCEMENT_INVALID');
  const multiplierFields = [
    'minimumActiveMultiplier', 'highVolMultiplier', 'lowVolRangeMultiplier', 'rangeMultiplier',
    'lowLiquidityMultiplier', 'counterTrendMultiplier', 'driftWatchMultiplier',
  ];
  const numericFields = [
    'fullSizeNetAlphaBps', ...multiplierFields, 'drawdownScaleStartPct', 'drawdownStopPct',
  ];
  for (const field of numericFields) {
    const value = Number(policy[field]);
    if (!Number.isFinite(value)) throw new Error(`DYNAMIC_SIZING_POLICY_FIELD_INVALID:${field}`);
    policy[field] = value;
  }
  if (policy.fullSizeNetAlphaBps <= 0) throw new Error('DYNAMIC_SIZING_FULL_ALPHA_INVALID');
  for (const field of multiplierFields) {
    if (policy[field] < 0 || policy[field] > 1) throw new Error(`DYNAMIC_SIZING_MULTIPLIER_INVALID:${field}`);
  }
  if (policy.drawdownScaleStartPct < 0 || policy.drawdownStopPct <= policy.drawdownScaleStartPct) {
    throw new Error('DYNAMIC_SIZING_DRAWDOWN_POLICY_INVALID');
  }
  return policy;
}

function gateState(result) {
  return String(result?.autoTrading?.state ?? 'INSUFFICIENT_EVIDENCE').toUpperCase();
}

function gateReasons(result) {
  return Array.isArray(result?.autoTrading?.reasons) ? result.autoTrading.reasons : [];
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
  const incomplete = gates.filter(([, result]) => gateState(result) !== 'PASS' && gateState(result) !== 'VETO');

  const conservativeNetAlphaBps = finite(netAlpha?.conservativeNetAlphaBps);
  const alphaFactor = conservativeNetAlphaBps == null
    ? null
    : clamp(conservativeNetAlphaBps / policy.fullSizeNetAlphaBps, policy.minimumActiveMultiplier, 1);
  const regimeSizeFactor = gateState(regimeBrain) === 'PASS' ? regimeFactor(regimeBrain, raw.direction, policy) : null;
  const ddFactor = drawdownFactor(currentDrawdownPct, policy);

  const knownFactors = [alphaFactor, regimeSizeFactor, ddFactor].filter((value) => value != null);
  const advisoryMultiplier = knownFactors.length ? clamp(Math.min(...knownFactors), 0, 1) : null;

  const vetoReasons = vetoes.flatMap(([name, result]) => {
    const reasons = gateReasons(result);
    return reasons.length ? reasons : [`${name}_GATE_VETO`];
  });
  if (ddFactor === 0 && currentDrawdownPct != null) vetoReasons.push('DRAWDOWN_BRAKE');

  let state;
  let reasons;
  let recommendedMultiplier;
  if (vetoReasons.length) {
    state = 'VETO';
    reasons = [...new Set(vetoReasons)];
    recommendedMultiplier = 0;
  } else if (incomplete.length || alphaFactor == null || regimeSizeFactor == null || ddFactor == null) {
    state = 'INSUFFICIENT_EVIDENCE';
    reasons = [
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

  const suggestedRiskFraction = parentBaseRiskFraction != null && parentBaseRiskFraction >= 0 && recommendedMultiplier != null
    ? Math.min(parentBaseRiskFraction, parentBaseRiskFraction * recommendedMultiplier)
    : null;
  const suggestedNotional = parentBaseNotional != null && parentBaseNotional >= 0 && recommendedMultiplier != null
    ? Math.min(parentBaseNotional, parentBaseNotional * recommendedMultiplier)
    : null;

  return {
    contract: 'market-intelligence-dynamic-bet-sizing/v1',
    policy,
    market: String(raw.market ?? '').toUpperCase() || null,
    direction: String(raw.direction ?? '').toUpperCase() || null,
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
      orderAllowed: false,
      canIncreaseParentExposure: false,
      maximumMultiplier: 1,
      reductionOnly: true,
    },
  };
}
