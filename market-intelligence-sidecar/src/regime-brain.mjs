const ENFORCEMENT_MODES = new Set(['OBSERVE_ONLY', 'REQUIRED_FOR_PARENT_GATE']);

export const DEFAULT_REGIME_BRAIN_POLICY = Object.freeze({
  version: 'MIS_REGIME_BRAIN_V1',
  enforcement: 'OBSERVE_ONLY',
  maxEvidenceAgeMs: 60_000,
  maxFutureSkewMs: 1_000,
  minReferenceSamples: 100,
  trendThreshold: 0.60,
  highVolRatio: 1.75,
  lowVolRatio: 0.65,
  maxSpreadRatio: 2.00,
  minDepthRatio: 0.35,
  driftMinSamples: 200,
  driftWatchPsi: 0.10,
  driftBrakePsi: 0.25,
});

const LOCKED_POLICY_FIELDS = Object.freeze([
  'maxEvidenceAgeMs', 'maxFutureSkewMs', 'minReferenceSamples', 'trendThreshold',
  'highVolRatio', 'lowVolRatio', 'maxSpreadRatio', 'minDepthRatio',
  'driftMinSamples', 'driftWatchPsi', 'driftBrakePsi',
]);

function finite(value, fallback = null) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function immutableDigest(value) {
  const digest = String(value ?? '').trim();
  return /^[0-9a-f]{64}$/i.test(digest) ? digest.toLowerCase() : null;
}

function resolvePolicy(input = {}) {
  if (input == null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('REGIME_POLICY_INVALID');
  if (input.version != null && input.version !== DEFAULT_REGIME_BRAIN_POLICY.version) {
    throw new Error('REGIME_POLICY_VERSION_OVERRIDE_NOT_ALLOWED');
  }
  for (const field of LOCKED_POLICY_FIELDS) {
    if (Object.hasOwn(input, field) && input[field] !== DEFAULT_REGIME_BRAIN_POLICY[field]) {
      throw new Error(`REGIME_POLICY_OVERRIDE_NOT_ALLOWED:${field}`);
    }
  }
  const enforcement = String(input.enforcement ?? DEFAULT_REGIME_BRAIN_POLICY.enforcement).toUpperCase();
  if (!ENFORCEMENT_MODES.has(enforcement)) throw new Error('REGIME_POLICY_ENFORCEMENT_INVALID');
  return { ...DEFAULT_REGIME_BRAIN_POLICY, enforcement };
}

function evidenceAge(now, asOf, policy, prefix = 'REGIME') {
  if (now == null) return { valid: false, reason: `${prefix}_CLOCK_NOT_AVAILABLE`, ageMs: null };
  if (asOf == null) return { valid: false, reason: `${prefix}_AS_OF_NOT_AVAILABLE`, ageMs: null };
  if (asOf > now + policy.maxFutureSkewMs) return { valid: false, reason: `${prefix}_EVIDENCE_FROM_FUTURE`, ageMs: null };
  const ageMs = Math.max(0, now - asOf);
  if (ageMs > policy.maxEvidenceAgeMs) return { valid: false, reason: `${prefix}_EVIDENCE_STALE`, ageMs };
  return { valid: true, reason: null, ageMs };
}

function evaluateDrift(raw = {}, policy, now) {
  const evaluatedAt = finite(raw.evaluatedAt);
  const parsedSampleSize = finite(raw.sampleSize);
  const sampleSize = Number.isInteger(parsedSampleSize) && parsedSampleSize >= 0 ? parsedSampleSize : null;
  const referenceId = typeof raw.referenceId === 'string' && raw.referenceId.trim() ? raw.referenceId.trim() : null;
  const referenceDigest = immutableDigest(raw.referenceDigest);
  const referenceFrozen = raw.referenceFrozen === true;
  const referenceValidatedAt = finite(raw.referenceValidatedAt);
  const parsedReferenceSampleSize = finite(raw.referenceSampleSize);
  const referenceSampleSize = Number.isInteger(parsedReferenceSampleSize) && parsedReferenceSampleSize >= 0
    ? parsedReferenceSampleSize
    : null;
  const referenceComputable = raw.referenceComputable === true;
  const zeroVarianceFeatures = Array.isArray(raw.zeroVarianceFeatures)
    && raw.zeroVarianceFeatures.every((feature) => typeof feature === 'string' && feature.trim())
    ? raw.zeroVarianceFeatures.map((feature) => feature.trim())
    : null;

  const featurePsi = raw.featurePsi && typeof raw.featurePsi === 'object' && !Array.isArray(raw.featurePsi)
    ? raw.featurePsi
    : null;
  const entries = featurePsi ? Object.entries(featurePsi) : [];
  const invalidPsi = entries.some(([feature, value]) => (
    !feature.trim() || typeof value !== 'number' || !Number.isFinite(value) || value < 0
  ));
  const rows = invalidPsi
    ? []
    : entries.map(([feature, value]) => ({ feature, psi: value }));

  const provenance = {
    referenceId,
    referenceDigest,
    referenceFrozen,
    referenceValidatedAt,
    referenceSampleSize,
    referenceComputable,
    zeroVarianceFeatures,
  };

  if (evaluatedAt == null || parsedSampleSize == null || !entries.length) {
    return {
      status: 'NOT_AVAILABLE',
      reason: 'DRIFT_EVIDENCE_NOT_AVAILABLE',
      sampleSize,
      ...provenance,
      features: [],
    };
  }
  if (sampleSize == null) {
    return {
      status: 'NOT_AVAILABLE',
      reason: 'DRIFT_SAMPLE_INVALID',
      sampleSize: null,
      ...provenance,
      features: [],
    };
  }
  if (!referenceId || !referenceDigest || !referenceFrozen
      || referenceValidatedAt == null || referenceSampleSize == null || zeroVarianceFeatures == null) {
    return {
      status: 'NOT_AVAILABLE',
      reason: 'DRIFT_REFERENCE_PROVENANCE_NOT_AVAILABLE',
      sampleSize,
      ...provenance,
      features: rows,
    };
  }
  if (invalidPsi) {
    return {
      status: 'NOT_AVAILABLE',
      reason: 'DRIFT_FEATURE_PSI_INVALID',
      sampleSize,
      ...provenance,
      features: [],
    };
  }

  const freshness = evidenceAge(now, evaluatedAt, policy, 'DRIFT');
  if (!freshness.valid) {
    return {
      status: 'NOT_AVAILABLE',
      reason: freshness.reason,
      sampleSize,
      evidenceAgeMs: freshness.ageMs,
      ...provenance,
      features: rows,
    };
  }

  const referenceFreshness = evidenceAge(now, referenceValidatedAt, policy, 'DRIFT_REFERENCE_VALIDATION');
  if (!referenceFreshness.valid) {
    return {
      status: 'NOT_AVAILABLE',
      reason: referenceFreshness.reason,
      sampleSize,
      evidenceAgeMs: freshness.ageMs,
      referenceValidationAgeMs: referenceFreshness.ageMs,
      ...provenance,
      features: rows,
    };
  }
  if (sampleSize < policy.driftMinSamples) {
    return {
      status: 'NOT_AVAILABLE',
      reason: 'DRIFT_SAMPLE_INSUFFICIENT',
      sampleSize,
      minimumSamples: policy.driftMinSamples,
      evidenceAgeMs: freshness.ageMs,
      referenceValidationAgeMs: referenceFreshness.ageMs,
      ...provenance,
      features: rows,
    };
  }
  if (referenceSampleSize < policy.driftMinSamples) {
    return {
      status: 'NOT_AVAILABLE',
      reason: 'DRIFT_REFERENCE_SAMPLE_INSUFFICIENT',
      sampleSize,
      minimumReferenceSamples: policy.driftMinSamples,
      evidenceAgeMs: freshness.ageMs,
      referenceValidationAgeMs: referenceFreshness.ageMs,
      ...provenance,
      features: rows,
    };
  }
  if (!referenceComputable || zeroVarianceFeatures.length > 0) {
    return {
      status: 'NOT_AVAILABLE',
      reason: 'DRIFT_REFERENCE_NOT_COMPUTABLE',
      sampleSize,
      evidenceAgeMs: freshness.ageMs,
      referenceValidationAgeMs: referenceFreshness.ageMs,
      ...provenance,
      features: rows,
    };
  }

  const maxPsi = Math.max(...rows.map((row) => row.psi));
  const meanPsi = rows.reduce((sum, row) => sum + row.psi, 0) / rows.length;
  const status = maxPsi >= policy.driftBrakePsi ? 'BRAKE' : maxPsi >= policy.driftWatchPsi ? 'WATCH' : 'STABLE';
  return {
    status,
    reason: status === 'BRAKE'
      ? 'FEATURE_DISTRIBUTION_DRIFT_BRAKE'
      : status === 'WATCH'
        ? 'FEATURE_DISTRIBUTION_DRIFT_WATCH'
        : null,
    sampleSize,
    evidenceAgeMs: freshness.ageMs,
    referenceValidationAgeMs: referenceFreshness.ageMs,
    maxPsi,
    meanPsi,
    watchThreshold: policy.driftWatchPsi,
    brakeThreshold: policy.driftBrakePsi,
    ...provenance,
    features: rows.sort((a, b) => b.psi - a.psi),
  };
}

export function evaluateRegimeBrain(raw = {}, policyInput = {}) {
  const policy = resolvePolicy(policyInput);
  const now = finite(raw.now);
  const asOf = finite(raw.asOf);
  const freshness = evidenceAge(now, asOf, policy);
  const trendScore = finite(raw.trendScore);
  const realizedVol = finite(raw.realizedVol);
  const referenceVol = finite(raw.referenceVol);
  const spreadBps = finite(raw.spreadBps);
  const referenceSpreadBps = finite(raw.referenceSpreadBps);
  const topDepthNotional = finite(raw.topDepthNotional);
  const referenceTopDepthNotional = finite(raw.referenceTopDepthNotional);
  const rawReferenceSamples = finite(raw.referenceSamples);
  const referenceSamples = Number.isInteger(rawReferenceSamples) && rawReferenceSamples >= 0 ? rawReferenceSamples : null;
  const drift = evaluateDrift(raw.drift, policy, now);

  const missing = [];
  if (!freshness.valid) missing.push(freshness.reason);
  if (trendScore == null || trendScore < -1 || trendScore > 1) missing.push('TREND_SCORE_NOT_AVAILABLE');
  if (!(realizedVol > 0)) missing.push('REALIZED_VOL_NOT_AVAILABLE');
  if (!(referenceVol > 0)) missing.push('REFERENCE_VOL_NOT_AVAILABLE');
  if (!(spreadBps >= 0)) missing.push('SPREAD_NOT_AVAILABLE');
  if (!(referenceSpreadBps > 0)) missing.push('REFERENCE_SPREAD_NOT_AVAILABLE');
  if (!(topDepthNotional > 0)) missing.push('TOP_DEPTH_NOT_AVAILABLE');
  if (!(referenceTopDepthNotional > 0)) missing.push('REFERENCE_TOP_DEPTH_NOT_AVAILABLE');
  if (referenceSamples == null || referenceSamples < policy.minReferenceSamples) {
    missing.push('REGIME_REFERENCE_SAMPLE_INSUFFICIENT');
  }

  const safety = {
    executionAuthority: 'NONE',
    liveTrading: false,
    aiNumericalAuthority: false,
    candidateDeletionAllowed: false,
    orderAllowed: false,
  };

  if (missing.length) {
    return {
      contract: 'market-intelligence-regime-brain/v1',
      policy,
      market: String(raw.market ?? '').toUpperCase() || null,
      status: 'NOT_AVAILABLE',
      regime: null,
      drift,
      reasons: [...new Set(missing)],
      autoTrading: {
        state: 'INSUFFICIENT_EVIDENCE',
        reasons: [...new Set(missing)],
        orderAllowed: false,
      },
      safety,
    };
  }

  const volRatio = realizedVol / referenceVol;
  const spreadRatio = spreadBps / referenceSpreadBps;
  const depthRatio = topDepthNotional / referenceTopDepthNotional;
  let label = 'RANGE';
  if (spreadRatio >= policy.maxSpreadRatio || depthRatio <= policy.minDepthRatio) label = 'LOW_LIQUIDITY';
  else if (volRatio >= policy.highVolRatio) label = 'HIGH_VOL';
  else if (trendScore >= policy.trendThreshold) label = 'TREND_UP';
  else if (trendScore <= -policy.trendThreshold) label = 'TREND_DOWN';
  else if (volRatio <= policy.lowVolRatio) label = 'LOW_VOL_RANGE';

  const vetoReasons = [];
  if (label === 'LOW_LIQUIDITY') vetoReasons.push('REGIME_LOW_LIQUIDITY');
  if (drift.status === 'BRAKE') vetoReasons.push('FEATURE_DISTRIBUTION_DRIFT_BRAKE');
  const incompleteReasons = drift.status === 'NOT_AVAILABLE' ? [drift.reason] : [];
  const state = vetoReasons.length ? 'VETO' : incompleteReasons.length ? 'INSUFFICIENT_EVIDENCE' : 'PASS';

  return {
    contract: 'market-intelligence-regime-brain/v1',
    policy,
    market: String(raw.market ?? '').toUpperCase() || null,
    status: 'READY',
    asOf,
    evidenceAgeMs: freshness.ageMs,
    referenceSamples,
    regime: {
      label,
      trendScore: clamp(trendScore, -1, 1),
      realizedVol,
      referenceVol,
      volRatio,
      spreadBps,
      referenceSpreadBps,
      spreadRatio,
      topDepthNotional,
      referenceTopDepthNotional,
      depthRatio,
    },
    drift,
    autoTrading: {
      state,
      reasons: vetoReasons.length ? vetoReasons : incompleteReasons,
      orderAllowed: false,
    },
    scanner: {
      candidateDeletionAllowed: false,
      warnings: [
        ...(label === 'LOW_LIQUIDITY' ? ['REGIME_LOW_LIQUIDITY'] : []),
        ...(label === 'HIGH_VOL' ? ['REGIME_HIGH_VOL'] : []),
        ...(drift.status === 'WATCH' ? ['FEATURE_DISTRIBUTION_DRIFT_WATCH'] : []),
        ...(drift.status === 'BRAKE' ? ['FEATURE_DISTRIBUTION_DRIFT_BRAKE'] : []),
      ],
    },
    safety,
  };
}
