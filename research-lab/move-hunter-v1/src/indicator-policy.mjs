export const INDICATOR_RUNNER_STATES = Object.freeze({
  ACCELERATION: 'ACCELERATION',
  NORMAL: 'NORMAL',
  WARNING: 'WARNING',
  INVALID: 'INVALID',
});

export const INDICATOR_RUNNER_POLICY_V1 = Object.freeze({
  accelerationTrailAtr: 4.0,
  normalTrailAtr: 3.0,
  warningTrailAtr: 2.0,
  invalidTrailAtr: 1.5,
  strongAdx: 25,
  weakAdx: 18,
  strongRsiLongMin: 55,
  strongRsiShortMax: 45,
  exhaustionRsiLong: 82,
  exhaustionRsiShort: 18,
  strongRelativeVolume: 1.2,
});

function finite(value) { return Number.isFinite(value) ? value : null; }
function side(value) {
  const normalized = String(value ?? 'LONG').trim().toUpperCase();
  if (normalized === 'LONG' || normalized === 'BUY') return 'LONG';
  if (normalized === 'SHORT' || normalized === 'SELL') return 'SHORT';
  throw new TypeError('direction must be LONG/BUY or SHORT/SELL');
}
function directional(value, direction) {
  const number = finite(value);
  if (number == null) return null;
  return direction === 'LONG' ? number : -number;
}
function trendDirection(value) {
  const text = String(value ?? '').trim().toUpperCase();
  if (['UP','BULLISH','UPTREND','LONG'].includes(text)) return 1;
  if (['DOWN','BEARISH','DOWNTREND','SHORT'].includes(text)) return -1;
  return 0;
}

export function classifyCanonicalIndicatorRunnerState(snapshot, {
  direction = 'LONG',
  policy = INDICATOR_RUNNER_POLICY_V1,
} = {}) {
  const tradeSide = side(direction);
  if (!snapshot || typeof snapshot !== 'object') throw new TypeError('canonical feature snapshot is required');
  if (!['READY_FOR_SPECIALIST_RESEARCH_ONLY','PARTIAL_FOR_SPECIALIST_RESEARCH_ONLY'].includes(snapshot.status)) {
    throw new Error('CANONICAL_MARKET_FEATURES_NOT_READY');
  }
  if (snapshot.executionAuthority !== 'NONE' || snapshot.decisionAuthority !== 'EVIDENCE_ONLY') {
    throw new Error('CANONICAL_FEATURE_AUTHORITY_INVALID');
  }
  const { trend, momentum, volume, volatility, priceAction } = snapshot.features ?? {};
  if (!trend || !momentum || !volume || !volatility || !priceAction) {
    throw new Error('CANONICAL_FEATURE_FAMILIES_MISSING');
  }

  const expected = tradeSide === 'LONG' ? 1 : -1;
  const emaDir = trendDirection(trend.emaDirection);
  const adxDir = trendDirection(trend.adxDirection);
  const structureDir = trendDirection(trend.structureTrend ?? priceAction.structureTrend);
  const emaFastSlope = directional(trend.emaFastSlopePctPerBar, tradeSide);
  const emaSlowSlope = directional(trend.emaSlowSlopePctPerBar, tradeSide);
  const roc = directional(momentum.roc, tradeSide);
  const macdHistogram = directional(momentum.macdHistogramPct, tradeSide);
  const acceleration = directional(momentum.momentumAcceleration, tradeSide);
  const relativeStrength = directional(momentum.relativeStrengthRoc, tradeSide);
  const signedVolume = directional(volume.signedVolumeBalance, tradeSide);
  const adx = finite(trend.adx);
  const rsi = finite(momentum.rsi);
  const directionalRsiStrong = rsi == null ? false
    : tradeSide === 'LONG'
      ? rsi >= policy.strongRsiLongMin && rsi < policy.exhaustionRsiLong
      : rsi <= policy.strongRsiShortMax && rsi > policy.exhaustionRsiShort;
  const rsiExhausted = rsi == null ? false
    : tradeSide === 'LONG' ? rsi >= policy.exhaustionRsiLong : rsi <= policy.exhaustionRsiShort;

  const trendStrong =
    emaDir === expected
    && (emaFastSlope ?? -Infinity) > 0
    && (emaSlowSlope ?? -Infinity) >= 0
    && (adx ?? -Infinity) >= policy.strongAdx
    && adxDir === expected;

  const momentumStrong =
    (roc ?? -Infinity) > 0
    && directionalRsiStrong
    && (macdHistogram ?? -Infinity) > 0
    && (acceleration ?? -Infinity) >= 0;

  const participationSupport =
    (finite(volume.relativeVolume) ?? 0) >= policy.strongRelativeVolume
    && (signedVolume ?? -Infinity) > 0
    && volume.priceVolumeDisagreement !== true;

  const relativeStrengthSupport = relativeStrength == null ? false : relativeStrength > 0;
  const volatilityExpansion = volatility.rangeState === 'EXPANSION';
  const structureAligned = structureDir === 0 || structureDir === expected;
  const structureOpposite = structureDir === -expected;

  const warningReasons = [];
  if (emaDir === -expected) warningReasons.push('EMA_DIRECTION_OPPOSITE');
  if ((emaFastSlope ?? 0) <= 0) warningReasons.push('EMA_FAST_SLOPE_WEAK');
  if ((roc ?? 0) <= 0) warningReasons.push('ROC_WEAK');
  if ((macdHistogram ?? 0) <= 0) warningReasons.push('MACD_HISTOGRAM_WEAK');
  if ((acceleration ?? 0) < 0) warningReasons.push('MOMENTUM_DECELERATING');
  if (volume.priceVolumeDisagreement === true) warningReasons.push('PRICE_VOLUME_DISAGREEMENT');
  if (rsiExhausted) warningReasons.push('RSI_EXHAUSTION');
  if (adx != null && adx < policy.weakAdx) warningReasons.push('ADX_WEAK');

  const invalid =
    structureOpposite
    || (
      emaDir === -expected
      && adxDir === -expected
      && (roc ?? 0) < 0
      && (macdHistogram ?? 0) < 0
    );

  let state = INDICATOR_RUNNER_STATES.NORMAL;
  if (invalid) state = INDICATOR_RUNNER_STATES.INVALID;
  else if (
    trendStrong
    && momentumStrong
    && structureAligned
    && (participationSupport || relativeStrengthSupport)
    && !rsiExhausted
  ) state = INDICATOR_RUNNER_STATES.ACCELERATION;
  else if (warningReasons.length >= 2) state = INDICATOR_RUNNER_STATES.WARNING;

  const trailAtrMult = state === INDICATOR_RUNNER_STATES.ACCELERATION
    ? policy.accelerationTrailAtr
    : state === INDICATOR_RUNNER_STATES.WARNING
      ? policy.warningTrailAtr
      : state === INDICATOR_RUNNER_STATES.INVALID
        ? policy.invalidTrailAtr
        : policy.normalTrailAtr;

  return Object.freeze({
    schemaVersion: 'move-hunter-indicator-runner-policy/v1',
    state,
    direction: tradeSide,
    trailAtrMult,
    exitNextOpen: state === INDICATOR_RUNNER_STATES.INVALID,
    diagnostics: Object.freeze({
      trendStrong,
      momentumStrong,
      participationSupport,
      relativeStrengthSupport,
      volatilityExpansion,
      structureAligned,
      warningReasons: Object.freeze(warningReasons),
      adx,
      rsi,
      relativeStrengthRoc: finite(momentum.relativeStrengthRoc),
      relativeVolume: finite(volume.relativeVolume),
    }),
    sourceDecisionTime: snapshot.decisionTime ?? null,
    sourceContentDigest: snapshot.contentDigest ?? null,
    sourceAuthority: 'CANONICAL_MARKET_FEATURES_V2_EVIDENCE_ONLY',
    automaticEntryAuthority: false,
    profitabilityClaimAllowed: false,
    executionAuthority: 'NONE',
  });
}

export function buildIndicatorRunnerControlByTs({ snapshots = [], direction = 'LONG' } = {}) {
  if (!Array.isArray(snapshots)) throw new TypeError('snapshots must be an array');
  const entries = [];
  for (const item of snapshots) {
    const ts = Number(item?.ts ?? item?.timestamp ?? item?.snapshot?.decisionTime);
    if (!Number.isFinite(ts)) throw new TypeError('snapshot timestamp is required');
    const control = classifyCanonicalIndicatorRunnerState(item.snapshot ?? item, { direction });
    entries.push([String(ts), control]);
  }
  return Object.freeze(Object.fromEntries(entries.sort((a,b)=>Number(a[0])-Number(b[0]))));
}
