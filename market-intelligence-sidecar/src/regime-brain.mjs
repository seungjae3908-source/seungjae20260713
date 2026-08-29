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

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function immutableDigest(value) {
  const digest = String(value ?? '').trim();
  return /^[0-9a-f]{64}$/i.test(digest) ? digest.toLowerCase() : null;
}

function resolvePolicy(input = {}) {
  const policy = { ...DEFAULT_REGIME_BRAIN_POLICY, ...(input ?? {}) };
  if (typeof policy.version !== 'string' || !policy.version.trim()) throw new Error('REGIME_POLICY_VERSION_REQUIRED');
  policy.enforcement = String(policy.enforcement ?? '').toUpperCase();
  if (!ENFORCEMENT_MODES.has(policy.enforcement)) throw new Error('REGIME_POLICY_ENFORCEMENT_INVALID');

  for (const field of [
    'maxEvidenceAgeMs', 'maxFutureSkewMs', 'minReferenceSamples', 'trendThreshold',
    'highVolRatio', 'lowVolRatio', 'maxSpreadRatio', 'minDepthRatio',
    'driftMinSamples', 'driftWatchPsi', 'driftBrakePsi',
  ]) {
    const value = Number(policy[field]);
    if (!Number.isFinite(value)) throw new Error(`REGIME_POLICY_FIELD_INVALID:${field}`);
    policy[field] = value;
  }
  if (policy.maxEvidenceAgeMs <= 0 || policy.maxFutureSkewMs < 0) throw new Error('REGIME_POLICY_TIME_INVALID');
  if (policy.minReferenceSamples < 1 || policy.driftMinSamples < 1) throw new Error('REGIME_POLICY_SAMPLE_INVALID');
  if (!(policy.trendThreshold > 0 && policy.trendThreshold <= 1)) throw new Error('REGIME_POLICY_TREND_THRESHOLD_INVALID');
  if (!(policy.highVolRatio > 1 && policy.lowVolRatio > 0 && policy.lowVolRatio < 1)) throw new Error('REGIME_POLICY_VOL_RATIO_INVALID');
  if (!(policy.maxSpreadRatio > 1 && policy.minDepthRatio > 0 && policy.minDepthRatio < 1)) throw new Error('REGIME_POLICY_LIQUIDITY_RATIO_INVALID');
  if (!(policy.driftWatchPsi >= 0 && policy.driftBrakePsi > policy.driftWatchPsi)) throw new Error('REGIME_POLICY_DRIFT_THRESHOLD_INVALID');
  return policy;
}

function evidenceAge(now, asOf, policy) {
  if (asOf == null) return { valid: false, reason: 'REGIME_AS_OF_NOT_AVAILABLE', ageMs: null };
  if (asOf > now + policy.maxFutureSkewMs) return { valid: false, reason: 'REGIME_EVIDENCE_FROM_FUTURE', ageMs: null };
  const ageMs = Math.max(0, now - asOf);
  if (ageMs > policy.maxEvidenceAgeMs) return { valid: false, reason: 'REGIME_EVIDENCE_STALE', ageMs };
  return { valid: true, reason: null, ageMs };
}

function evaluateDrift(raw = {}, policy, now) {
  const evaluatedAt = finite(raw.evaluatedAt);
  const parsedSampleSize = finite(raw.sampleSize);
  const sampleSize = Number.isInteger(parsedSampleSize) && parsedSampleSize >= 0 ? parsedSampleSize : null;
  const referenceId = typeof raw.referenceId === 'string' && raw.referenceId.trim() ? raw.referenceId.trim() : null;
  const referenceDigest = immutableDigest(raw.referenceDigest);
  const referenceFrozen = raw.referenceFrozen === true;
  const featurePsi = raw.featurePsi && typeof raw.featurePsi === 'object' && !Array.isArray(raw.featurePsi)
    ? raw.featurePsi
    : null;
  const entries = featurePsi ? Object.entries(featurePsi) : [];
  const invalidPsi = entries.some(([feature, value]) => {
    const parsed = Number(value);
    return !feature.trim() || !Number.isFinite(parsed) || parsed < 0;
  });
  const rows = invalidPsi
    ? []
    : entries.map(([feature, value]) => ({ feature, psi: Number(value) }));

  if (evaluatedAt == null || parsedSampleSize == null || !entries.length) {
    return {
      status: 'NOT_AVAILABLE',
      reason: 'DRIFT_EVIDENCE_NOT_AVAILABLE',
      sampleSize,
      referenceId,
      referenceDigest,
      referenceFrozen,
      features: [],
    };
  }
  if (sampleSize == null) {
    return {
      status: 'NOT_AVAILABLE',
      reason: 'DRIFT_SAMPLE_INVALID',
      sampleSize: null,
      referenceId,
      referenceDigest,
      referenceFrozen,
      features: [],
    };
  }
  if (!referenceId || !referenceDigest || !referenceFrozen) {
    return {
      status: 'NOT_AVAILABLE',
      reason: 'DRIFT_REFERENCE_PROVENANCE_NOT_AVAILABLE',
      sampleSize,
      referenceId,
      referenceDigest,
      referenceFrozen,
      features: rows,
    };
  }
  if (invalidPsi) {
    return {
      status: 'NOT_AVAILABLE',
      reason: 'DRIFT_FEATURE_PSI_INVALID',
      sampleSize,
      referenceId,
      referenceDigest,
      referenceFrozen,
      features: [],
    };
  }

  const freshness = evidenceAge(now, evaluatedAt, policy);
  if (!freshness.valid) {
    return {
      status: 'NOT_AVAILABLE',
      reason: freshness.reason.replace('REGIME_', 'DRIFT_'),
      sampleSize,
      evidenceAgeMs: freshness.ageMs,
      referenceId,
      referenceDigest,
      referenceFrozen,
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
      referenceId,
      referenceDigest,
      referenceFrozen,
      features: rows,
    };
  }

  const maxPsi = Math.max(...rows.map((row) => row.psi));
  const meanPsi = rows.reduce((sum, row) => sum + row.psi, 0) / rows.length;
  const status = maxPsi >= policy.driftBrakePsi ? 'BRAKE' : maxPsi >= policy.driftWatchPsi ? 'WATCH' : 'STABLE';
  return {
    status,
    reason: status === 'BRAKE' ? 'FEATURE_DISTRIBUTION_DRIFT_BRAKE' : status === 'WATCH' ? 'FEATURE_DISTRIBUTION_DRIFT_WATCH' : null,
    sampleSize,
    evidenceAgeMs: freshness.ageMs,
    maxPsi,
    meanPsi,
    watchThreshold: policy.driftWatchPsi,
    brakeThreshold: policy.driftBrakePsi,
    referenceId,
    referenceDigest,
    referenceFrozen,
    features: rows.sort((a, b) => b.psi - a.psi),
  };
}

export function evaluateRegimeBrain(raw = {}, policyInput = {}) {
  const policy = resolvePolicy(policyInput);
  const now = finite(raw.now, Date.now());
  const asOf = finite(raw.asOf);
  const freshness = evidenceAge(now, asOf, policy);
  const trendScore = finite(raw.trendScore);
  const realizedVol = finite(raw.realizedVol);
  const referenceVol = finite(raw.referenceVol);
  const spreadBps = finite(raw.spreadBps);
  const referenceSpreadBps = finite(raw.referenceSpreadBps);
  const topDepthNotional = finite(raw.topDepthNotional);
  const referenceTopDepthNotional = finite(raw.referenceTopDepthNotional);
  const referenceSamples = Math.max(0, finite(raw.referenceSamples, 0));
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
  if (referenceSamples < policy.minReferenceSamples) missing.push('REGIME_REFERENCE_SAMPLE_INSUFFICIENT');

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
      safety: {
        executionAuthority: 'NONE',
        candidateDeletionAllowed: false,
        orderAllowed: false,
      },
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
    safety: {
      executionAuthority: 'NONE',
      candidateDeletionAllowed: false,
      orderAllowed: false,
    },
  };
}
