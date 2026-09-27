export const MOMENTUM_GUARD_FORWARD_V1 = Object.freeze({
  contract: 'move-hunter-momentum-guard-forward/v1',
  rocMinimumExclusive: 0,
  macdHistogramMinimumExclusive: 0,
  rsiMinimumInclusive: 50,
  rsiMaximumExclusive: 82,
  parameterGrid: false,
  thresholdRelaxationAllowed: false,
  riskIncreaseAllowed: false,
  leverageIncreaseAllowed: false,
  observedHistoryMayCountAsOos: false,
});

export function evaluateMomentumGuardForwardV1(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new TypeError('canonical feature snapshot is required');
  if (!['READY_FOR_SPECIALIST_RESEARCH_ONLY','PARTIAL_FOR_SPECIALIST_RESEARCH_ONLY'].includes(snapshot.status)) {
    return Object.freeze({
      status: 'BLOCKED_DATA',
      eligible: false,
      reason: 'CANONICAL_MARKET_FEATURES_NOT_READY',
      executionAuthority: 'NONE',
      economicSampleCredit: 0,
    });
  }
  if (snapshot.decisionAuthority !== 'EVIDENCE_ONLY' || snapshot.executionAuthority !== 'NONE') {
    throw new Error('CANONICAL_FEATURE_AUTHORITY_INVALID');
  }
  const momentum = snapshot.features?.momentum;
  if (!momentum) {
    return Object.freeze({
      status: 'BLOCKED_DATA',
      eligible: false,
      reason: 'MOMENTUM_FEATURES_MISSING',
      executionAuthority: 'NONE',
      economicSampleCredit: 0,
    });
  }

  const roc = Number(momentum.roc);
  const rsi = Number(momentum.rsi);
  const macdHistogramPct = Number(momentum.macdHistogramPct);
  if (![roc,rsi,macdHistogramPct].every(Number.isFinite)) {
    return Object.freeze({
      status: 'BLOCKED_DATA',
      eligible: false,
      reason: 'MOMENTUM_FEATURES_NONFINITE',
      executionAuthority: 'NONE',
      economicSampleCredit: 0,
    });
  }

  const checks = Object.freeze({
    rocPositive: roc > MOMENTUM_GUARD_FORWARD_V1.rocMinimumExclusive,
    macdHistogramPositive: macdHistogramPct > MOMENTUM_GUARD_FORWARD_V1.macdHistogramMinimumExclusive,
    rsiInRange:
      rsi >= MOMENTUM_GUARD_FORWARD_V1.rsiMinimumInclusive
      && rsi < MOMENTUM_GUARD_FORWARD_V1.rsiMaximumExclusive,
  });
  const eligible = Object.values(checks).every(Boolean);

  return Object.freeze({
    schemaVersion: MOMENTUM_GUARD_FORWARD_V1.contract,
    status: 'RESEARCH_EVIDENCE_ONLY',
    eligible,
    checks,
    observed: Object.freeze({ roc, rsi, macdHistogramPct }),
    sourceDecisionTime: snapshot.decisionTime ?? null,
    sourceContentDigest: snapshot.contentDigest ?? null,
    automaticEntryAuthority: false,
    automaticPromotionAuthority: false,
    profitabilityClaimAllowed: false,
    observedHistoryMayCountAsOos: false,
    economicSampleCredit: 0,
    executionAuthority: 'NONE',
  });
}
