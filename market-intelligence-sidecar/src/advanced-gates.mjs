const ENFORCEMENT_MODES = new Set(['OBSERVE_ONLY', 'REQUIRED_FOR_PARENT_GATE']);
const BLOCKING_EVENT_SEVERITIES = new Set(['HIGH', 'CRITICAL']);

export const DEFAULT_ADVANCED_GATE_POLICY = Object.freeze({
  version: 'MIS_ADVANCED_GATES_V1',
  enforcement: 'OBSERVE_ONLY',
  conformalAlpha: 0.10,
  conformalMinCalibrationSamples: 100,
  conformalMinDirectionalEdgeBps: 0,
  conformalMaxIntervalWidthBps: 50,
  metaMinEvaluationSamples: 300,
  metaTakeProbabilityThreshold: 0.55,
  metaMaxBrierScore: 0.25,
  metaMaxCalibrationError: 0.10,
  metaMaxEvidenceAgeMs: 7 * 24 * 60 * 60 * 1000,
  eventDefaultLeadMs: 30 * 60 * 1000,
  eventDefaultCooldownMs: 15 * 60 * 1000,
  eventMaxLeadMs: 24 * 60 * 60 * 1000,
  eventMaxCooldownMs: 24 * 60 * 60 * 1000,
});

function finite(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function resolvePolicy(policy = {}) {
  const merged = { ...DEFAULT_ADVANCED_GATE_POLICY, ...(policy ?? {}) };
  if (typeof merged.version !== 'string' || !merged.version.trim()) throw new Error('ADVANCED_POLICY_VERSION_REQUIRED');
  merged.enforcement = String(merged.enforcement ?? '').toUpperCase();
  if (!ENFORCEMENT_MODES.has(merged.enforcement)) throw new Error('ADVANCED_POLICY_ENFORCEMENT_INVALID');

  const numericFields = [
    'conformalAlpha',
    'conformalMinCalibrationSamples',
    'conformalMinDirectionalEdgeBps',
    'conformalMaxIntervalWidthBps',
    'metaMinEvaluationSamples',
    'metaTakeProbabilityThreshold',
    'metaMaxBrierScore',
    'metaMaxCalibrationError',
    'metaMaxEvidenceAgeMs',
    'eventDefaultLeadMs',
    'eventDefaultCooldownMs',
    'eventMaxLeadMs',
    'eventMaxCooldownMs',
  ];
  for (const field of numericFields) {
    const value = Number(merged[field]);
    if (!Number.isFinite(value)) throw new Error(`ADVANCED_POLICY_FIELD_INVALID:${field}`);
    merged[field] = value;
  }
  if (!(merged.conformalAlpha > 0 && merged.conformalAlpha < 1)) throw new Error('CONFORMAL_ALPHA_INVALID');
  if (merged.conformalMinCalibrationSamples < 1 || merged.metaMinEvaluationSamples < 1) throw new Error('ADVANCED_MIN_SAMPLE_INVALID');
  if (!(merged.metaTakeProbabilityThreshold >= 0 && merged.metaTakeProbabilityThreshold <= 1)) throw new Error('META_THRESHOLD_INVALID');
  if (!(merged.metaMaxBrierScore >= 0 && merged.metaMaxBrierScore <= 1)) throw new Error('META_BRIER_LIMIT_INVALID');
  if (!(merged.metaMaxCalibrationError >= 0 && merged.metaMaxCalibrationError <= 1)) throw new Error('META_CALIBRATION_LIMIT_INVALID');
  return merged;
}

function conformalQuantile(scores, alpha) {
  const sorted = scores.map((value) => finite(value)).filter((value) => value != null && value >= 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((sorted.length + 1) * (1 - alpha)) - 1));
  return { value: sorted[rank], rank: rank + 1, sampleSize: sorted.length };
}

export function evaluateConformalUncertainty(raw = {}, policyInput = {}) {
  const policy = resolvePolicy(policyInput);
  const pointEstimateBps = finite(raw.expectedDirectionalEdgeBps);
  const scores = Array.isArray(raw.calibrationNonconformityBps) ? raw.calibrationNonconformityBps : [];
  const quantile = conformalQuantile(scores, finite(raw.alpha, policy.conformalAlpha));

  if (pointEstimateBps == null) {
    return {
      status: 'NOT_AVAILABLE',
      reason: 'EXPECTED_DIRECTIONAL_EDGE_NOT_AVAILABLE',
      assumption: 'SPLIT_CONFORMAL_EXCHANGEABILITY_REQUIRED',
    };
  }
  if (!quantile || quantile.sampleSize < policy.conformalMinCalibrationSamples) {
    return {
      status: 'NOT_AVAILABLE',
      reason: 'CONFORMAL_CALIBRATION_SAMPLE_INSUFFICIENT',
      pointEstimateBps,
      calibrationSamples: quantile?.sampleSize ?? 0,
      minimumCalibrationSamples: policy.conformalMinCalibrationSamples,
      assumption: 'SPLIT_CONFORMAL_EXCHANGEABILITY_REQUIRED',
    };
  }

  const lowerBps = pointEstimateBps - quantile.value;
  const upperBps = pointEstimateBps + quantile.value;
  const widthBps = upperBps - lowerBps;
  const reasons = [];
  if (lowerBps <= policy.conformalMinDirectionalEdgeBps) reasons.push('CONFORMAL_LOWER_BOUND_NON_POSITIVE');
  if (widthBps > policy.conformalMaxIntervalWidthBps) reasons.push('CONFORMAL_INTERVAL_TOO_WIDE');

  return {
    status: reasons.length ? 'VETO' : 'PASS',
    reasons,
    pointEstimateBps,
    lowerBps,
    upperBps,
    widthBps,
    nonconformityQuantileBps: quantile.value,
    quantileRank: quantile.rank,
    calibrationSamples: quantile.sampleSize,
    alpha: finite(raw.alpha, policy.conformalAlpha),
    nominalCoverage: 1 - finite(raw.alpha, policy.conformalAlpha),
    assumption: 'SPLIT_CONFORMAL_EXCHANGEABILITY_REQUIRED',
  };
}

export function evaluateMetaLabelGate(raw = {}, policyInput = {}, nowInput = Date.now()) {
  const policy = resolvePolicy(policyInput);
  const takeProbability = finite(raw.takeProbability);
  const evaluationSamples = Math.max(0, finite(raw.evaluationSamples, 0));
  const brierScore = finite(raw.brierScore);
  const calibrationError = finite(raw.calibrationError);
  const evaluatedAt = finite(raw.evaluatedAt);
  const now = finite(nowInput, Date.now());
  const evidenceAgeMs = evaluatedAt == null ? null : Math.max(0, now - evaluatedAt);
  const modelId = String(raw.modelId ?? '').trim();

  const missing = [];
  if (!modelId) missing.push('MODEL_ID');
  if (takeProbability == null) missing.push('TAKE_PROBABILITY');
  if (brierScore == null) missing.push('BRIER_SCORE');
  if (calibrationError == null) missing.push('CALIBRATION_ERROR');
  if (evaluatedAt == null) missing.push('EVALUATED_AT');
  if (missing.length) {
    return { status: 'NOT_AVAILABLE', reason: `META_EVIDENCE_MISSING:${missing.join(',')}` };
  }
  if (evaluationSamples < policy.metaMinEvaluationSamples) {
    return {
      status: 'NOT_AVAILABLE',
      reason: 'META_EVALUATION_SAMPLE_INSUFFICIENT',
      evaluationSamples,
      minimumEvaluationSamples: policy.metaMinEvaluationSamples,
      modelId,
    };
  }
  if (evidenceAgeMs > policy.metaMaxEvidenceAgeMs) {
    return { status: 'NOT_AVAILABLE', reason: 'META_EVIDENCE_STALE', evidenceAgeMs, modelId };
  }
  if (brierScore > policy.metaMaxBrierScore || calibrationError > policy.metaMaxCalibrationError) {
    return {
      status: 'NOT_AVAILABLE',
      reason: 'META_MODEL_CALIBRATION_QUALITY_INSUFFICIENT',
      brierScore,
      calibrationError,
      modelId,
    };
  }

  return {
    status: takeProbability >= policy.metaTakeProbabilityThreshold ? 'PASS' : 'VETO',
    reason: takeProbability >= policy.metaTakeProbabilityThreshold ? null : 'META_LABEL_TAKE_PROBABILITY_TOO_LOW',
    takeProbability,
    threshold: policy.metaTakeProbabilityThreshold,
    evaluationSamples,
    brierScore,
    calibrationError,
    evaluatedAt,
    evidenceAgeMs,
    modelId,
    role: 'SECONDARY_TAKE_OR_SKIP_ONLY',
  };
}

function normalizeEvent(event, policy) {
  const startsAt = finite(event?.startsAt);
  if (startsAt == null) return null;
  const endsAt = finite(event?.endsAt, startsAt);
  const leadMs = clamp(Math.max(0, finite(event?.leadMs, policy.eventDefaultLeadMs)), 0, policy.eventMaxLeadMs);
  const cooldownMs = clamp(Math.max(0, finite(event?.cooldownMs, policy.eventDefaultCooldownMs)), 0, policy.eventMaxCooldownMs);
  return {
    id: String(event?.id ?? event?.type ?? 'EVENT').trim() || 'EVENT',
    type: String(event?.type ?? 'UNKNOWN').trim().toUpperCase(),
    severity: String(event?.severity ?? 'UNKNOWN').trim().toUpperCase(),
    verified: event?.verified === true,
    source: String(event?.source ?? '').trim() || null,
    markets: Array.isArray(event?.markets) ? event.markets.map((value) => String(value).toUpperCase()) : [],
    startsAt,
    endsAt: Math.max(startsAt, endsAt),
    leadMs,
    cooldownMs,
  };
}

export function evaluateEventRiskGate(raw = {}, policyInput = {}, nowInput = Date.now()) {
  const policy = resolvePolicy(policyInput);
  const now = finite(nowInput, Date.now());
  const market = String(raw.market ?? '').toUpperCase();
  const events = (Array.isArray(raw.events) ? raw.events : [])
    .map((event) => normalizeEvent(event, policy))
    .filter(Boolean)
    .filter((event) => event.markets.length === 0 || event.markets.includes(market));

  const activeVerified = [];
  const watch = [];
  for (const event of events) {
    const inWindow = now >= event.startsAt - event.leadMs && now <= event.endsAt + event.cooldownMs;
    if (!inWindow) continue;
    if (event.verified && BLOCKING_EVENT_SEVERITIES.has(event.severity)) activeVerified.push(event);
    else watch.push(event);
  }

  if (activeVerified.length) {
    return {
      status: 'VETO',
      reason: 'VERIFIED_HIGH_IMPACT_EVENT_WINDOW',
      blockingEvents: activeVerified,
      watchEvents: watch,
    };
  }
  if (watch.length) {
    return { status: 'WATCH', reason: 'EVENT_WINDOW_NOT_BLOCKING', blockingEvents: [], watchEvents: watch };
  }
  return { status: 'PASS', reason: null, blockingEvents: [], watchEvents: [] };
}

export function evaluateAdvancedGates(raw = {}, policyInput = {}) {
  const policy = resolvePolicy(policyInput);
  const now = finite(raw.now, Date.now());
  const uncertainty = evaluateConformalUncertainty(raw.uncertainty ?? {}, policy);
  const metaLabel = evaluateMetaLabelGate(raw.metaLabel ?? {}, policy, now);
  const eventRisk = evaluateEventRiskGate({ market: raw.market, events: raw.events }, policy, now);

  const vetoReasons = [];
  if (uncertainty.status === 'VETO') vetoReasons.push(...(uncertainty.reasons ?? ['UNCERTAINTY_VETO']));
  if (metaLabel.status === 'VETO') vetoReasons.push(metaLabel.reason ?? 'META_LABEL_VETO');
  if (eventRisk.status === 'VETO') vetoReasons.push(eventRisk.reason ?? 'EVENT_RISK_VETO');

  const requiredStatuses = [uncertainty.status, metaLabel.status, eventRisk.status];
  const insufficientEvidence = policy.enforcement === 'REQUIRED_FOR_PARENT_GATE'
    && requiredStatuses.some((status) => status === 'NOT_AVAILABLE');
  const state = vetoReasons.length
    ? 'VETO'
    : insufficientEvidence
      ? 'INSUFFICIENT_EVIDENCE'
      : 'PASS';

  const warnings = [];
  if (uncertainty.status === 'NOT_AVAILABLE') warnings.push('UNCERTAINTY_GATE_NOT_AVAILABLE');
  if (metaLabel.status === 'NOT_AVAILABLE') warnings.push('META_LABEL_GATE_NOT_AVAILABLE');
  if (eventRisk.status === 'WATCH') warnings.push('EVENT_RISK_WATCH');
  if (insufficientEvidence) warnings.push('ADVANCED_GATE_EVIDENCE_REQUIRED');
  if (vetoReasons.length) warnings.push(...vetoReasons);

  return {
    contract: 'market-intelligence-advanced-gates/v1',
    policy,
    uncertainty,
    metaLabel,
    eventRisk,
    scanner: {
      mode: 'SOFT_OBSERVE_ONLY',
      candidateDeletionAllowed: false,
      vetoVisible: vetoReasons.length > 0,
      warnings,
    },
    autoTrading: {
      state,
      reasons: vetoReasons,
      insufficientEvidence,
      parentGateStillRequired: true,
      orderAllowed: false,
      executionAuthority: 'NONE',
    },
    safety: {
      executionAuthority: 'NONE',
      privateTradingApiAllowed: false,
      realOrderAllowed: false,
      orderSubmissionAllowed: false,
    },
  };
}
