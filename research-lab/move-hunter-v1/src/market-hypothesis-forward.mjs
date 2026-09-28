export const KR_NO_STRUCTURE_60M_FORWARD_HYPOTHESIS_V1 = Object.freeze({
  schemaVersion: 'move-hunter-frozen-forward-hypothesis/v1',
  hypothesisId: 'MOVE_HUNTER_KR_STOCK_60M_NO_STRUCTURE_V1',
  market: 'KR_STOCK',
  timeframe: '60M',
  directionGroup: 'LONG',
  symbols: Object.freeze(['000660', '005930']),
  selectedVariant: 'NO_STRUCTURE',
  disabledFamilies: Object.freeze(['STRUCTURE']),
  candidatePrefilter: 'EMA20_50_DIRECTION_AND_ROC12_DIRECTION',
  decisionContract: Object.freeze({
    version: 'KR_NO_STRUCTURE_60M_DECISION_V1',
    disabledFamilies: Object.freeze(['STRUCTURE']),
    enabledComponents: Object.freeze(['ema', 'adx', 'roc', 'macd', 'rsi', 'volume', 'volatility']),
    requiredPassCount: 6,
    hardRequirements: Object.freeze(['ema', 'roc']),
    rsiLongMinInclusive: 45,
    rsiLongMaxExclusive: 78,
    adxMinInclusive: 18,
    relativeVolumeMinInclusive: 0.8,
    forbidPriceVolumeDisagreement: true,
    forbidAbnormalVolatility: true,
  }),
  sourceWindow: Object.freeze({
    startTime: '2025-09-28T00:00:00.000Z',
    endTime: '2026-09-27T23:59:59.999Z',
  }),
  sourceMetrics: Object.freeze({
    totalReturn: 0.25905540529089643,
    tradeCount: 113,
    maximumDrawdown: 0.038100354746464116,
    profitFactor: 2.4188267258082874,
  }),
  sourceBaseline: Object.freeze({
    totalReturn: 0.1732266656421908,
    tradeCount: 85,
    maximumDrawdown: 0.07900623533740092,
    profitFactor: 1.9980002760260895,
  }),
  sourceFull: Object.freeze({
    totalReturn: 0.12933654447654197,
    tradeCount: 135,
    maximumDrawdown: 0.07670066173899404,
    profitFactor: 1.511869276820836,
  }),
  sourceEvidence: Object.freeze({
    researchHead: '97d77c2c390d688b27f776c434b4a9661651dcba',
    runId: 36386681250,
    artifactId: 10954408040,
    artifactZipSha256: 'd84dc17fc3046df0699f0debd51064abd125add5d04e6fa803aeb02e96e8dac0',
  }),
  frozenAt: '2026-09-28T06:34:15.000Z',
  historicalSelectionOnly: true,
  observedHistoryMayCountAsOos: false,
  observedHistoryMayCountAsForward: false,
  automaticScannerAdoptionAllowed: false,
  automaticPromotionAllowed: false,
  economicSampleCredit: 0,
  profitabilityClaimAllowed: false,
  executionAuthority: 'NONE',
});

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}
function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
function directionGroup(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === 'BUY' || normalized === 'LONG') return 'LONG';
  if (normalized === 'SELL' || normalized === 'SHORT') return 'SHORT';
  return null;
}
function timeframe(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === '1H') return '60M';
  return normalized;
}
function blocked(reason, details = {}) {
  return freeze({
    schemaVersion: 'move-hunter-market-hypothesis-forward-record/v1',
    status: 'BLOCKED_DATA',
    reason,
    details: freeze(details),
    prospectiveOnly: true,
    observedHistoryMayCountAsOos: false,
    observedHistoryMayCountAsForward: false,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    automaticPromotionAuthority: false,
    executionAuthority: 'NONE',
  });
}
function canonicalFeatureIdentity(snapshot) {
  for (const family of ['trend', 'momentum', 'volume', 'volatility']) {
    const identity = snapshot?.evidence?.[family]?.evidence?.identity;
    if (identity && typeof identity === 'object') return identity;
  }
  return null;
}
function observationSafetyValid(observation) {
  return observation?.schemaVersion === 'forward-recommendation-observation-v2'
    && observation.source === 'LIVE_RECOMMENDATION'
    && observation.publicDataOnly === true
    && observation.simulatedOnly === true
    && observation.executionAuthority === 'NONE'
    && observation.financialMutationAllowed === false
    && observation.liveOrderAllowed === false
    && observation.privateTradingApiAllowed === false
    && observation.orderSubmitted === false
    && observation.exchangeRequestSent === false
    && observation.profitabilityClaimAllowed === false;
}
function fixedCandidatePrefilter(snapshot, direction) {
  const trend = snapshot?.features?.trend;
  const momentum = snapshot?.features?.momentum;
  if (!trend || !momentum) return false;
  const expected = direction === 'LONG' ? 'UP' : 'DOWN';
  const roc = Number(momentum.roc);
  if (!Number.isFinite(roc)) return false;
  const directionalRoc = direction === 'LONG' ? roc : -roc;
  return trend.emaDirection === expected && directionalRoc > 0;
}


export function evaluateFrozenKrNoStructureCandidateV1(snapshot, direction = 'LONG') {
  const side = directionGroup(direction);
  if (side !== 'LONG') {
    return freeze({
      schemaVersion: 'move-hunter-kr-no-structure-candidate/v1',
      prefilterEligible: false,
      hypothesisEligible: false,
      reason: 'FROZEN_KR_V1_LONG_ONLY',
      decision: evaluateFrozenKrNoStructureDecisionV1(snapshot, direction),
      economicSampleCredit: 0,
      executionAuthority: 'NONE',
    });
  }
  const prefilterEligible = fixedCandidatePrefilter(snapshot, side);
  const decision = evaluateFrozenKrNoStructureDecisionV1(snapshot, side);
  return freeze({
    schemaVersion: 'move-hunter-kr-no-structure-candidate/v1',
    prefilterEligible,
    hypothesisEligible: prefilterEligible && decision.matched,
    reason: prefilterEligible ? null : 'FROZEN_CANDIDATE_PREFILTER_NOT_MET',
    decision,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    automaticScannerAdoptionAllowed: false,
    automaticPromotionAllowed: false,
    executionAuthority: 'NONE',
  });
}

export function evaluateFrozenKrNoStructureDecisionV1(snapshot, direction = 'LONG') {
  const trend = snapshot?.features?.trend;
  const momentum = snapshot?.features?.momentum;
  const volume = snapshot?.features?.volume;
  const volatility = snapshot?.features?.volatility;
  const priceAction = snapshot?.features?.priceAction;
  if (!trend || !momentum || !volume || !volatility || !priceAction) {
    return freeze({
      matched: false,
      score: 0,
      maximumScore: 7,
      threshold: 6,
      reason: 'FROZEN_DECISION_FEATURE_FAMILIES_MISSING',
      components: freeze({}),
      structureTransition: priceAction?.structureTransition ?? null,
    });
  }
  const side = directionGroup(direction);
  if (side !== 'LONG') {
    return freeze({
      matched: false,
      score: 0,
      maximumScore: 7,
      threshold: 6,
      reason: 'FROZEN_KR_V1_LONG_ONLY',
      components: freeze({}),
      structureTransition: priceAction.structureTransition ?? null,
    });
  }
  const roc = Number(momentum.roc);
  const macd = Number(momentum.macdHistogramPct);
  const rsi = Number(momentum.rsi);
  const adx = Number(trend.adx);
  const relativeVolume = Number(volume.relativeVolume);
  const components = freeze({
    ema: trend.emaDirection === 'UP',
    adx: Number.isFinite(adx) && adx >= 18 && trend.adxDirection === 'UP',
    roc: Number.isFinite(roc) && roc > 0,
    macd: Number.isFinite(macd) && macd > 0,
    rsi: Number.isFinite(rsi) && rsi >= 45 && rsi < 78,
    volume: Number.isFinite(relativeVolume)
      && relativeVolume >= 0.8
      && volume.priceVolumeDisagreement !== true,
    volatility: volatility.abnormalVolatility !== true,
  });
  const score = Object.values(components).filter(Boolean).length;
  const threshold = 6;
  const matched = components.ema && components.roc && score >= threshold;
  return freeze({
    schemaVersion: 'move-hunter-kr-no-structure-decision/v1',
    matched,
    score,
    maximumScore: 7,
    threshold,
    components,
    disabledFamilies: freeze(['STRUCTURE']),
    structureTransition: priceAction.structureTransition ?? 'NONE',
    automaticScannerAdoptionAllowed: false,
    automaticPromotionAllowed: false,
    economicSampleCredit: 0,
    executionAuthority: 'NONE',
  });
}

export function buildMarketHypothesisForwardRecord({
  observation,
  featureSnapshot,
  hypothesis = KR_NO_STRUCTURE_60M_FORWARD_HYPOTHESIS_V1,
} = {}) {
  if (!hypothesis || hypothesis.schemaVersion !== 'move-hunter-frozen-forward-hypothesis/v1') {
    return blocked('FROZEN_HYPOTHESIS_REQUIRED');
  }
  if (hypothesis.executionAuthority !== 'NONE'
      || hypothesis.automaticScannerAdoptionAllowed !== false
      || hypothesis.automaticPromotionAllowed !== false
      || hypothesis.economicSampleCredit !== 0) {
    return blocked('FROZEN_HYPOTHESIS_SAFETY_INVALID');
  }
  if (!observation || typeof observation !== 'object') return blocked('FORWARD_OBSERVATION_REQUIRED');
  if (!observationSafetyValid(observation)) return blocked('FORWARD_OBSERVATION_SAFETY_ENVELOPE_INVALID');

  const identity = observation.identity;
  const signal = observation.snapshot;
  if (!identity || !signal) return blocked('FORWARD_IDENTITY_OR_SNAPSHOT_MISSING');

  const signalTime = Date.parse(signal.timestamp);
  const frozenAt = Date.parse(hypothesis.frozenAt);
  if (!Number.isFinite(signalTime) || !Number.isFinite(frozenAt)) return blocked('PROSPECTIVE_TIME_IDENTITY_INVALID');
  if (!(signalTime > frozenAt)) {
    return blocked('OBSERVATION_NOT_POST_FREEZE', {
      signalTimestamp: signal.timestamp,
      frozenAt: hypothesis.frozenAt,
    });
  }

  if (identity.market !== hypothesis.market) {
    return blocked('HYPOTHESIS_MARKET_MISMATCH', { actual: identity.market, expected: hypothesis.market });
  }
  if (!hypothesis.symbols.includes(identity.symbol)) {
    return blocked('HYPOTHESIS_SYMBOL_OUT_OF_FROZEN_SCOPE', { symbol: identity.symbol });
  }
  if (timeframe(identity.timeframe) !== timeframe(hypothesis.timeframe)) {
    return blocked('HYPOTHESIS_TIMEFRAME_MISMATCH', {
      actual: identity.timeframe,
      expected: hypothesis.timeframe,
    });
  }
  const side = directionGroup(identity.direction);
  if (side !== hypothesis.directionGroup) {
    return blocked('HYPOTHESIS_DIRECTION_MISMATCH', { actual: identity.direction, expected: hypothesis.directionGroup });
  }

  const evidenceIdentity = canonicalFeatureIdentity(featureSnapshot);
  if (!evidenceIdentity) return blocked('CANONICAL_MARKET_FEATURE_IDENTITY_MISSING');
  if (featureSnapshot?.executionAuthority !== 'NONE'
      || featureSnapshot?.decisionAuthority !== 'EVIDENCE_ONLY') {
    return blocked('CANONICAL_MARKET_FEATURE_AUTHORITY_INVALID');
  }

  const mismatches = [];
  if (evidenceIdentity.market !== identity.market) mismatches.push('MARKET');
  if (evidenceIdentity.symbol !== identity.symbol) mismatches.push('SYMBOL');
  if (timeframe(evidenceIdentity.timeframe) !== timeframe(identity.timeframe)) mismatches.push('TIMEFRAME');
  if (directionGroup(evidenceIdentity.side) !== side) mismatches.push('DIRECTION');
  if (evidenceIdentity.temporal?.decisionTime !== signal.timestamp) mismatches.push('DECISION_TIME');
  if (signal.market !== identity.market) mismatches.push('SNAPSHOT_MARKET');
  if (signal.symbol !== identity.symbol) mismatches.push('SNAPSHOT_SYMBOL');
  if (directionGroup(signal.direction) !== side) mismatches.push('SNAPSHOT_DIRECTION');
  if (mismatches.length) return blocked('FORWARD_FEATURE_IDENTITY_MISMATCH', { mismatches: freeze(mismatches) });

  const candidate = evaluateFrozenKrNoStructureCandidateV1(featureSnapshot, side);
  const prefilterEligible = candidate.prefilterEligible;
  const decision = candidate.decision;
  const hypothesisEligible = candidate.hypothesisEligible;

  const settled = observation.status === 'SETTLED' && observation.outcome != null;
  const pending = observation.status === 'PENDING' && observation.outcome == null;
  if (!settled && !pending) return blocked('FORWARD_SETTLEMENT_STATE_INVALID');

  const outcome = observation.outcome;
  return freeze({
    schemaVersion: 'move-hunter-market-hypothesis-forward-record/v1',
    status: settled ? 'SETTLED' : 'PENDING',
    hypothesisId: hypothesis.hypothesisId,
    selectedVariant: hypothesis.selectedVariant,
    disabledFamilies: freeze([...hypothesis.disabledFamilies]),
    observationId: observation.observationId,
    identity: freeze({
      strategyId: identity.strategyId,
      strategyVersion: identity.strategyVersion,
      parameterHash: identity.parameterHash,
      researchCodeSha: identity.researchCodeSha,
      market: identity.market,
      symbol: identity.symbol,
      timeframe: identity.timeframe,
      horizon: identity.horizon,
      direction: identity.direction,
    }),
    signalTimestamp: signal.timestamp,
    dataTimestamp: observation.dataTimestamp,
    settledAt: observation.settledAt,
    prefilterEligible,
    hypothesisEligible,
    decision: freeze({
      matched: decision.matched,
      score: decision.score,
      maximumScore: decision.maximumScore,
      threshold: decision.threshold,
      components: decision.components,
      structureTransition: decision.structureTransition,
    }),
    outcome: settled ? freeze({
      classification: outcome.outcome,
      returnPercent: finiteOrNull(outcome.returnPercent),
      mfePercent: finiteOrNull(outcome.mfePercent),
      maePercent: finiteOrNull(outcome.maePercent),
      target1Hit: outcome.target1Hit === true,
      target2Hit: outcome.target2Hit === true,
      stopLossHit: outcome.stopLossHit === true,
      timeToTargetMs: finiteOrNull(outcome.timeToTargetMs),
      timeToStopMs: finiteOrNull(outcome.timeToStopMs),
      conservativeIntrabarConflict: outcome.conservativeIntrabarConflict === true,
    }) : null,
    prospectiveOnly: true,
    postFreezeRequired: true,
    historicalBackfillAllowed: false,
    frozenSymbolScopeExpanded: false,
    observedHistoryMayCountAsOos: false,
    observedHistoryMayCountAsForward: false,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    automaticScannerAdoptionAllowed: false,
    automaticPromotionAuthority: false,
    executionAuthority: 'NONE',
  });
}

export function summarizeMarketHypothesisForwardRecords(records = []) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  const accepted = records.filter((row) =>
    row?.schemaVersion === 'move-hunter-market-hypothesis-forward-record/v1'
    && (row.status === 'PENDING' || row.status === 'SETTLED'));
  const settled = accepted.filter((row) => row.status === 'SETTLED' && row.outcome);
  const summarize = (rows) => {
    const returns = rows.map((row) => row.outcome.returnPercent).filter(Number.isFinite);
    const mfe = rows.map((row) => row.outcome.mfePercent).filter(Number.isFinite);
    const mae = rows.map((row) => row.outcome.maePercent).filter(Number.isFinite);
    return freeze({
      n: rows.length,
      averageReturnPercent: mean(returns),
      averageMfePercent: mean(mfe),
      averageMaePercent: mean(mae),
      winCount: rows.filter((row) => row.outcome.classification === 'WIN').length,
      lossCount: rows.filter((row) => row.outcome.classification === 'LOSS').length,
      expiredCount: rows.filter((row) => row.outcome.classification === 'EXPIRED').length,
      target1HitCount: rows.filter((row) => row.outcome.target1Hit).length,
      stopHitCount: rows.filter((row) => row.outcome.stopLossHit).length,
    });
  };
  return freeze({
    schemaVersion: 'move-hunter-market-hypothesis-forward-summary/v1',
    hypothesisId: accepted[0]?.hypothesisId ?? null,
    acceptedN: accepted.length,
    settledN: settled.length,
    pendingN: accepted.filter((row) => row.status === 'PENDING').length,
    hypothesisEligible: summarize(settled.filter((row) => row.hypothesisEligible === true)),
    hypothesisIneligible: summarize(settled.filter((row) => row.hypothesisEligible === false)),
    blockedN: records.length - accepted.length,
    minimumPromotionSampleInvented: false,
    automaticPromotionAuthority: false,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    executionAuthority: 'NONE',
  });
}
