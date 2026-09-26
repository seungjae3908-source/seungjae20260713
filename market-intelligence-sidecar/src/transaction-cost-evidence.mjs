export const TRANSACTION_COST_COMPONENTS = Object.freeze([
  'commissionBps',
  'taxBps',
  'spreadBps',
  'slippageBps',
  'fundingBps',
  'latencyBps',
  'liquidityImpactBps',
  'partialFillImpactBps',
]);

const MARKETS = new Set(['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES']);
const SOURCE_TYPES = new Set([
  'REALIZED_EXECUTION',
  'OBSERVED_MARKET',
  'CALIBRATED_MODEL',
  'STATIC_POLICY',
  'NOT_APPLICABLE',
]);

export const DEFAULT_TRANSACTION_COST_EVIDENCE_POLICY = Object.freeze({
  version: 'MIS_TRANSACTION_COST_EVIDENCE_V1',
  maxFutureSkewMs: 1_000,
  observedMaxAgeMs: 2 * 60_000,
  realizedMaxAgeMs: 24 * 60 * 60 * 1_000,
  calibratedMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
  staticPolicyMaxAgeMs: 365 * 24 * 60 * 60 * 1_000,
  minCalibratedSamples: 500,
});

function finite(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestamp(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function resolvePolicy(input = {}) {
  const policy = { ...DEFAULT_TRANSACTION_COST_EVIDENCE_POLICY, ...(input ?? {}) };
  if (typeof policy.version !== 'string' || !policy.version.trim()) throw new Error('TRANSACTION_COST_POLICY_VERSION_REQUIRED');
  for (const field of [
    'maxFutureSkewMs',
    'observedMaxAgeMs',
    'realizedMaxAgeMs',
    'calibratedMaxAgeMs',
    'staticPolicyMaxAgeMs',
    'minCalibratedSamples',
  ]) {
    const value = Number(policy[field]);
    if (!Number.isFinite(value)) throw new Error(`TRANSACTION_COST_POLICY_FIELD_INVALID:${field}`);
    policy[field] = value;
  }
  if (policy.maxFutureSkewMs < 0
    || policy.observedMaxAgeMs <= 0
    || policy.realizedMaxAgeMs <= 0
    || policy.calibratedMaxAgeMs <= 0
    || policy.staticPolicyMaxAgeMs <= 0
    || !Number.isInteger(policy.minCalibratedSamples)
    || policy.minCalibratedSamples <= 0) {
    throw new Error('TRANSACTION_COST_POLICY_BOUNDS_INVALID');
  }
  return policy;
}

function maxAgeForSource(sourceType, policy) {
  if (sourceType === 'OBSERVED_MARKET') return policy.observedMaxAgeMs;
  if (sourceType === 'REALIZED_EXECUTION') return policy.realizedMaxAgeMs;
  if (sourceType === 'CALIBRATED_MODEL') return policy.calibratedMaxAgeMs;
  if (sourceType === 'STATIC_POLICY') return policy.staticPolicyMaxAgeMs;
  return null;
}

function notAvailable(component, reasons, raw = {}) {
  return {
    component,
    status: 'NOT_AVAILABLE',
    reasons: [...new Set(reasons)],
    sourceType: raw?.sourceType ? String(raw.sourceType).toUpperCase() : null,
    source: raw?.source ? String(raw.source) : null,
    valueBps: finite(raw?.valueBps),
    conservativeBps: null,
    asOf: timestamp(raw?.asOf),
    sampleSize: finite(raw?.sampleSize),
    policyVersion: raw?.policyVersion ? String(raw.policyVersion) : null,
    modelId: raw?.modelId ? String(raw.modelId) : null,
    notApplicableReason: raw?.notApplicableReason ? String(raw.notApplicableReason) : null,
  };
}

function normalizeComponent({ component, market, raw, now, policy }) {
  if (raw == null || typeof raw !== 'object') return notAvailable(component, ['COST_COMPONENT_EVIDENCE_MISSING']);
  const sourceType = String(raw.sourceType ?? '').toUpperCase();
  if (!SOURCE_TYPES.has(sourceType)) return notAvailable(component, ['COST_SOURCE_TYPE_INVALID'], raw);

  if (sourceType === 'NOT_APPLICABLE') {
    const allowed = component === 'fundingBps' && market !== 'CRYPTO_FUTURES';
    const reason = String(raw.notApplicableReason ?? '').trim();
    const reasons = [];
    if (!allowed) reasons.push('COST_NOT_APPLICABLE_NOT_ALLOWED');
    if (!reason) reasons.push('COST_NOT_APPLICABLE_REASON_REQUIRED');
    if (reasons.length) return notAvailable(component, reasons, raw);
    return {
      component,
      status: 'READY',
      reasons: [],
      sourceType,
      source: 'STRUCTURAL_MARKET_RULE',
      valueBps: 0,
      conservativeBps: 0,
      asOf: null,
      ageMs: null,
      sampleSize: null,
      policyVersion: null,
      modelId: null,
      notApplicableReason: reason,
    };
  }

  const reasons = [];
  const source = String(raw.source ?? '').trim();
  const valueBps = finite(raw.valueBps);
  const asOf = timestamp(raw.asOf);
  const maxAgeMs = maxAgeForSource(sourceType, policy);
  const ageMs = asOf == null ? null : Math.max(0, now - asOf);
  if (!source) reasons.push('COST_SOURCE_REQUIRED');
  if (valueBps == null || valueBps < 0) reasons.push('COST_VALUE_INVALID');
  if (asOf == null) reasons.push('COST_AS_OF_REQUIRED');
  else if (asOf > now + policy.maxFutureSkewMs) reasons.push('COST_EVIDENCE_FROM_FUTURE');
  else if (maxAgeMs != null && now - asOf > maxAgeMs) reasons.push('COST_EVIDENCE_STALE');

  let conservativeBps = valueBps;
  let sampleSize = finite(raw.sampleSize);
  let modelId = raw.modelId == null ? null : String(raw.modelId).trim();
  let policyVersion = raw.policyVersion == null ? null : String(raw.policyVersion).trim();

  if (sourceType === 'CALIBRATED_MODEL') {
    const upperBps = finite(raw.conservativeUpperBps);
    if (!modelId) reasons.push('COST_MODEL_ID_REQUIRED');
    if (!Number.isInteger(sampleSize) || sampleSize < policy.minCalibratedSamples) reasons.push('COST_MODEL_SAMPLE_INSUFFICIENT');
    if (upperBps == null || upperBps < 0 || (valueBps != null && upperBps < valueBps)) {
      reasons.push('COST_MODEL_CONSERVATIVE_UPPER_BOUND_INVALID');
    } else {
      conservativeBps = upperBps;
    }
  } else if (sourceType === 'STATIC_POLICY') {
    if (!policyVersion) reasons.push('COST_STATIC_POLICY_VERSION_REQUIRED');
    sampleSize = null;
    modelId = null;
  } else {
    modelId = null;
    policyVersion = null;
    if (sampleSize != null && (!Number.isInteger(sampleSize) || sampleSize < 1)) reasons.push('COST_OBSERVED_SAMPLE_INVALID');
  }

  if (reasons.length) return notAvailable(component, reasons, raw);
  return {
    component,
    status: 'READY',
    reasons: [],
    sourceType,
    source,
    valueBps,
    conservativeBps,
    asOf,
    ageMs,
    sampleSize,
    policyVersion,
    modelId,
    notApplicableReason: null,
  };
}

export function evaluateTransactionCostEvidence(raw = {}, policyInput = {}) {
  const policy = resolvePolicy(policyInput);
  const market = String(raw.market ?? '').toUpperCase();
  if (!MARKETS.has(market)) throw new Error(`TRANSACTION_COST_MARKET_UNSUPPORTED:${market}`);
  const evidenceSetVersion = String(raw.evidenceSetVersion ?? '').trim();
  if (!evidenceSetVersion) throw new Error('TRANSACTION_COST_EVIDENCE_SET_VERSION_REQUIRED');
  const now = finite(raw.now) ?? Date.now();
  const components = {};
  const pointCosts = {};
  const conservativeCosts = {};
  const reasons = [];
  const timestamps = [];

  for (const component of TRANSACTION_COST_COMPONENTS) {
    const result = normalizeComponent({
      component,
      market,
      raw: raw.components?.[component],
      now,
      policy,
    });
    components[component] = result;
    pointCosts[component] = result.status === 'READY' ? result.valueBps : null;
    conservativeCosts[component] = result.status === 'READY' ? result.conservativeBps : null;
    if (result.status !== 'READY') {
      reasons.push(...result.reasons.map((reason) => `${component}:${reason}`));
    }
    if (result.status === 'READY' && result.asOf != null) timestamps.push(result.asOf);
  }

  const ready = reasons.length === 0;
  const totalPointCostBps = ready
    ? TRANSACTION_COST_COMPONENTS.reduce((sum, component) => sum + pointCosts[component], 0)
    : null;
  const totalConservativeCostBps = ready
    ? TRANSACTION_COST_COMPONENTS.reduce((sum, component) => sum + conservativeCosts[component], 0)
    : null;

  return {
    contract: 'market-intelligence-transaction-cost-evidence/v1',
    policy,
    market,
    evidenceSetVersion,
    status: ready ? 'READY' : 'NOT_AVAILABLE',
    reasons: [...new Set(reasons)],
    components,
    pointCosts,
    conservativeCosts,
    totalPointCostBps,
    totalConservativeCostBps,
    oldestEvidenceAt: timestamps.length ? Math.min(...timestamps) : null,
    newestEvidenceAt: timestamps.length ? Math.max(...timestamps) : null,
    readyForNetAlpha: ready,
    safety: {
      executionAuthority: 'NONE',
      numericalAuthority: 'EVIDENCE_NORMALIZATION_ONLY',
      promotionAuthority: false,
      liveTradingAuthority: false,
      orderAllowed: false,
      privateTradingApiAllowed: false,
    },
  };
}
