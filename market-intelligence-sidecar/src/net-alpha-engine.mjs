const ENFORCEMENT_MODES = new Set(['OBSERVE_ONLY', 'REQUIRED_FOR_PARENT_GATE']);
const GROSS_EDGE_SOURCE = 'forward-recommendation-profit-calibration-v2';
const GROSS_EDGE_SCHEMA = 'forward-calibration-gross-edge-v2';
const COST_FIELDS = Object.freeze([
  'commissionBps',
  'taxBps',
  'spreadBps',
  'slippageBps',
  'fundingBps',
  'latencyBps',
  'liquidityImpactBps',
  'partialFillImpactBps',
]);
const IDENTITY_FIELDS = Object.freeze([
  'strategyId',
  'strategyVersion',
  'parameterHash',
  'researchCodeSha',
  'market',
  'symbol',
  'timeframe',
  'horizon',
  'direction',
]);

export const DEFAULT_NET_ALPHA_POLICY = Object.freeze({
  version: 'MIS_NET_ALPHA_V1',
  enforcement: 'OBSERVE_ONLY',
  maxEvidenceAgeMs: 60_000,
  maxFutureSkewMs: 1_000,
  minConservativeNetAlphaBps: 1,
  attestationToleranceBps: 0.5,
});

const LOCKED_POLICY_FIELDS = Object.freeze([
  'maxEvidenceAgeMs', 'maxFutureSkewMs', 'minConservativeNetAlphaBps', 'attestationToleranceBps',
]);

function finite(value, fallback = null) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function evidenceComplete(value) {
  if (value === true) return true;
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function normalizeIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const normalized = {};
  for (const field of IDENTITY_FIELDS) {
    const raw = value[field];
    if (typeof raw !== 'string' || !raw.trim()) return null;
    normalized[field] = field === 'market' || field === 'direction'
      ? raw.trim().toUpperCase()
      : raw.trim();
  }
  if (!/^[0-9a-f]{40}$/i.test(normalized.researchCodeSha)) return null;
  return normalized;
}

function sameIdentity(a, b) {
  return Boolean(a && b && IDENTITY_FIELDS.every((field) => a[field] === b[field]));
}

function resolvePolicy(input = {}) {
  if (input == null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('NET_ALPHA_POLICY_INVALID');
  if (input.version != null && input.version !== DEFAULT_NET_ALPHA_POLICY.version) {
    throw new Error('NET_ALPHA_POLICY_VERSION_OVERRIDE_NOT_ALLOWED');
  }
  for (const field of LOCKED_POLICY_FIELDS) {
    if (Object.hasOwn(input, field) && input[field] !== DEFAULT_NET_ALPHA_POLICY[field]) {
      throw new Error(`NET_ALPHA_POLICY_OVERRIDE_NOT_ALLOWED:${field}`);
    }
  }
  const enforcement = String(input.enforcement ?? DEFAULT_NET_ALPHA_POLICY.enforcement).toUpperCase();
  if (!ENFORCEMENT_MODES.has(enforcement)) throw new Error('NET_ALPHA_POLICY_ENFORCEMENT_INVALID');
  return { ...DEFAULT_NET_ALPHA_POLICY, enforcement };
}

function missingResult(policy, raw, reasons, extra = {}) {
  const uniqueReasons = [...new Set(reasons)];
  return {
    contract: 'market-intelligence-net-alpha/v1',
    policy,
    market: String(raw.market ?? '').toUpperCase() || null,
    status: 'NOT_AVAILABLE',
    decision: 'NOT_AVAILABLE',
    reasons: uniqueReasons,
    ...extra,
    autoTrading: {
      state: 'INSUFFICIENT_EVIDENCE',
      reasons: uniqueReasons,
      orderAllowed: false,
    },
    safety: {
      executionAuthority: 'NONE',
      liveTrading: false,
      numericalAuthority: 'CROSS_CHECK_ONLY',
      aiNumericalAuthority: false,
      profitabilityClaimAllowed: false,
      orderAllowed: false,
    },
  };
}

export function evaluateNetAlpha(raw = {}, policyInput = {}) {
  const policy = resolvePolicy(policyInput);
  const now = finite(raw.now);
  const asOf = finite(raw.asOf);
  const costAsOf = finite(raw.costAsOf);
  const expectedGrossEdgeBps = finite(raw.expectedGrossEdgeBps);
  const conformalLowerEdgeBps = finite(raw.conformalLowerEdgeBps);
  const attestedNetEdgeBps = finite(raw.attestedNetEdgeBps);
  const source = String(raw.source ?? '').trim();
  const sourceSchemaVersion = String(raw.sourceSchemaVersion ?? '').trim();
  const costSource = String(raw.costSource ?? '').trim();
  const costPolicyVersion = String(raw.costPolicyVersion ?? '').trim();
  const grossIdentity = normalizeIdentity(raw.grossIdentity);
  const costIdentity = normalizeIdentity(raw.costIdentity);
  const market = String(raw.market ?? '').toUpperCase();
  const reasons = [];

  if (now == null) reasons.push('AUTHORITATIVE_CLOCK_NOT_AVAILABLE');
  if (raw.evidenceReady !== true) reasons.push('AUTHORITATIVE_PROFIT_EVIDENCE_NOT_READY');
  if (raw.forwardDataComplete !== true) reasons.push('FORWARD_DATA_INCOMPLETE');
  if (raw.fullCostReady !== true) reasons.push('FULL_COST_NOT_READY');
  if (!evidenceComplete(raw.evidenceComplete)) reasons.push('EVIDENCE_COMPLETE_NOT_READY');
  if (source !== GROSS_EDGE_SOURCE) reasons.push('CANONICAL_GROSS_EDGE_SOURCE_REQUIRED');
  if (sourceSchemaVersion !== GROSS_EDGE_SCHEMA) reasons.push('CANONICAL_GROSS_EDGE_SCHEMA_REQUIRED');
  if (!costSource) reasons.push('FULL_COST_SOURCE_REQUIRED');
  if (!costPolicyVersion) reasons.push('COST_POLICY_VERSION_REQUIRED');
  if (!grossIdentity) reasons.push('GROSS_IDENTITY_PROVENANCE_NOT_AVAILABLE');
  if (!costIdentity) reasons.push('COST_IDENTITY_PROVENANCE_NOT_AVAILABLE');
  if (grossIdentity && costIdentity && !sameIdentity(grossIdentity, costIdentity)) reasons.push('NET_ALPHA_IDENTITY_MISMATCH');
  if (grossIdentity && market && grossIdentity.market !== market) reasons.push('NET_ALPHA_MARKET_IDENTITY_MISMATCH');

  if (asOf == null) reasons.push('NET_ALPHA_AS_OF_NOT_AVAILABLE');
  else if (now != null && asOf > now + policy.maxFutureSkewMs) reasons.push('NET_ALPHA_EVIDENCE_FROM_FUTURE');
  else if (now != null && now - asOf > policy.maxEvidenceAgeMs) reasons.push('NET_ALPHA_EVIDENCE_STALE');

  if (costAsOf == null) reasons.push('COST_AS_OF_NOT_AVAILABLE');
  else if (now != null && costAsOf > now + policy.maxFutureSkewMs) reasons.push('COST_EVIDENCE_FROM_FUTURE');
  else if (now != null && now - costAsOf > policy.maxEvidenceAgeMs) reasons.push('COST_EVIDENCE_STALE');

  if (expectedGrossEdgeBps == null) reasons.push('EXPECTED_GROSS_EDGE_NOT_AVAILABLE');
  if (conformalLowerEdgeBps == null) reasons.push('CONFORMAL_LOWER_EDGE_NOT_AVAILABLE');

  const costs = {};
  for (const field of COST_FIELDS) {
    const value = finite(raw.costs?.[field]);
    if (value == null) reasons.push(`COST_EVIDENCE_MISSING:${field}`);
    else if (value < 0) reasons.push(`COST_EVIDENCE_INVALID:${field}`);
    else costs[field] = value;
  }

  const readiness = {
    forwardDataComplete: raw.forwardDataComplete === true,
    fullCostReady: raw.fullCostReady === true,
    evidenceComplete: evidenceComplete(raw.evidenceComplete),
    profitabilityProven: raw.profitabilityProven === true,
  };

  const provenance = {
    source: source || null,
    sourceSchemaVersion: sourceSchemaVersion || null,
    costSource: costSource || null,
    costPolicyVersion: costPolicyVersion || null,
    grossIdentity,
    costIdentity,
  };

  if (reasons.length) {
    return missingResult(policy, raw, reasons, {
      asOf,
      costAsOf,
      ...provenance,
      expectedGrossEdgeBps,
      conformalLowerEdgeBps,
      attestedNetEdgeBps,
      costs,
      readiness,
    });
  }

  const totalExpectedCostBps = COST_FIELDS.reduce((sum, field) => sum + costs[field], 0);
  const expectedNetEdgeBps = expectedGrossEdgeBps - totalExpectedCostBps;
  const conservativeGrossEdgeBps = Math.min(expectedGrossEdgeBps, conformalLowerEdgeBps);
  const conservativeNetAlphaBps = conservativeGrossEdgeBps - totalExpectedCostBps;
  const evidenceAgeMs = Math.max(0, now - asOf);
  const costEvidenceAgeMs = Math.max(0, now - costAsOf);

  if (attestedNetEdgeBps != null && Math.abs(attestedNetEdgeBps - expectedNetEdgeBps) > policy.attestationToleranceBps) {
    return missingResult(policy, raw, ['NET_EDGE_ATTESTATION_MISMATCH'], {
      asOf,
      costAsOf,
      evidenceAgeMs,
      costEvidenceAgeMs,
      ...provenance,
      expectedGrossEdgeBps,
      conformalLowerEdgeBps,
      totalExpectedCostBps,
      expectedNetEdgeBps,
      attestedNetEdgeBps,
      attestationDifferenceBps: Math.abs(attestedNetEdgeBps - expectedNetEdgeBps),
      costs,
      readiness,
    });
  }

  const pass = conservativeNetAlphaBps >= policy.minConservativeNetAlphaBps;
  const vetoReasons = pass ? [] : ['CONSERVATIVE_NET_ALPHA_BELOW_MINIMUM'];
  return {
    contract: 'market-intelligence-net-alpha/v1',
    policy,
    market: market || null,
    status: 'READY',
    decision: pass ? 'TAKE' : 'SKIP',
    reasons: vetoReasons,
    role: 'CONSERVATIVE_CROSS_CHECK_ONLY',
    asOf,
    costAsOf,
    evidenceAgeMs,
    costEvidenceAgeMs,
    ...provenance,
    expectedGrossEdgeBps,
    conformalLowerEdgeBps,
    conservativeGrossEdgeBps,
    totalExpectedCostBps,
    expectedNetEdgeBps,
    conservativeNetAlphaBps,
    attestedNetEdgeBps,
    costs,
    readiness,
    profitabilityClaimAllowed: false,
    autoTrading: {
      state: pass ? 'PASS' : 'VETO',
      reasons: vetoReasons,
      orderAllowed: false,
    },
    safety: {
      executionAuthority: 'NONE',
      liveTrading: false,
      numericalAuthority: 'CROSS_CHECK_ONLY',
      aiNumericalAuthority: false,
      profitabilityClaimAllowed: false,
      orderAllowed: false,
    },
  };
}

export { COST_FIELDS, GROSS_EDGE_SOURCE, GROSS_EDGE_SCHEMA };
