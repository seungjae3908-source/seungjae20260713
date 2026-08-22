const ENFORCEMENT_MODES = new Set(['OBSERVE_ONLY', 'REQUIRED_FOR_PARENT_GATE']);
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

export const DEFAULT_NET_ALPHA_POLICY = Object.freeze({
  version: 'MIS_NET_ALPHA_V1',
  enforcement: 'OBSERVE_ONLY',
  maxEvidenceAgeMs: 60_000,
  maxFutureSkewMs: 1_000,
  minConservativeNetAlphaBps: 1,
  attestationToleranceBps: 0.5,
});

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolvePolicy(input = {}) {
  const policy = { ...DEFAULT_NET_ALPHA_POLICY, ...(input ?? {}) };
  if (typeof policy.version !== 'string' || !policy.version.trim()) throw new Error('NET_ALPHA_POLICY_VERSION_REQUIRED');
  policy.enforcement = String(policy.enforcement ?? '').toUpperCase();
  if (!ENFORCEMENT_MODES.has(policy.enforcement)) throw new Error('NET_ALPHA_POLICY_ENFORCEMENT_INVALID');
  for (const field of ['maxEvidenceAgeMs', 'maxFutureSkewMs', 'minConservativeNetAlphaBps', 'attestationToleranceBps']) {
    const value = Number(policy[field]);
    if (!Number.isFinite(value)) throw new Error(`NET_ALPHA_POLICY_FIELD_INVALID:${field}`);
    policy[field] = value;
  }
  if (policy.maxEvidenceAgeMs <= 0 || policy.maxFutureSkewMs < 0 || policy.attestationToleranceBps < 0) {
    throw new Error('NET_ALPHA_POLICY_BOUND_INVALID');
  }
  return policy;
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
      numericalAuthority: 'CROSS_CHECK_ONLY',
      orderAllowed: false,
    },
  };
}

export function evaluateNetAlpha(raw = {}, policyInput = {}) {
  const policy = resolvePolicy(policyInput);
  const now = finite(raw.now, Date.now());
  const asOf = finite(raw.asOf);
  const expectedGrossEdgeBps = finite(raw.expectedGrossEdgeBps);
  const conformalLowerEdgeBps = finite(raw.conformalLowerEdgeBps);
  const attestedNetEdgeBps = finite(raw.attestedNetEdgeBps);
  const source = String(raw.source ?? '').trim();
  const costPolicyVersion = String(raw.costPolicyVersion ?? '').trim();
  const reasons = [];

  if (raw.evidenceReady !== true) reasons.push('AUTHORITATIVE_PROFIT_EVIDENCE_NOT_READY');
  if (!source) reasons.push('NET_ALPHA_SOURCE_REQUIRED');
  if (!costPolicyVersion) reasons.push('COST_POLICY_VERSION_REQUIRED');
  if (asOf == null) reasons.push('NET_ALPHA_AS_OF_NOT_AVAILABLE');
  else if (asOf > now + policy.maxFutureSkewMs) reasons.push('NET_ALPHA_EVIDENCE_FROM_FUTURE');
  else if (now - asOf > policy.maxEvidenceAgeMs) reasons.push('NET_ALPHA_EVIDENCE_STALE');
  if (expectedGrossEdgeBps == null) reasons.push('EXPECTED_GROSS_EDGE_NOT_AVAILABLE');
  if (conformalLowerEdgeBps == null) reasons.push('CONFORMAL_LOWER_EDGE_NOT_AVAILABLE');

  const costs = {};
  for (const field of COST_FIELDS) {
    const value = finite(raw.costs?.[field]);
    if (value == null) reasons.push(`COST_EVIDENCE_MISSING:${field}`);
    else if (value < 0) reasons.push(`COST_EVIDENCE_INVALID:${field}`);
    else costs[field] = value;
  }

  if (reasons.length) {
    return missingResult(policy, raw, reasons, {
      asOf,
      source: source || null,
      costPolicyVersion: costPolicyVersion || null,
      expectedGrossEdgeBps,
      conformalLowerEdgeBps,
      attestedNetEdgeBps,
      costs,
    });
  }

  const totalExpectedCostBps = COST_FIELDS.reduce((sum, field) => sum + costs[field], 0);
  const expectedNetEdgeBps = expectedGrossEdgeBps - totalExpectedCostBps;
  const conservativeGrossEdgeBps = Math.min(expectedGrossEdgeBps, conformalLowerEdgeBps);
  const conservativeNetAlphaBps = conservativeGrossEdgeBps - totalExpectedCostBps;
  const evidenceAgeMs = Math.max(0, now - asOf);

  if (attestedNetEdgeBps != null && Math.abs(attestedNetEdgeBps - expectedNetEdgeBps) > policy.attestationToleranceBps) {
    return missingResult(policy, raw, ['NET_EDGE_ATTESTATION_MISMATCH'], {
      asOf,
      evidenceAgeMs,
      source,
      costPolicyVersion,
      expectedGrossEdgeBps,
      conformalLowerEdgeBps,
      totalExpectedCostBps,
      expectedNetEdgeBps,
      attestedNetEdgeBps,
      attestationDifferenceBps: Math.abs(attestedNetEdgeBps - expectedNetEdgeBps),
      costs,
    });
  }

  const pass = conservativeNetAlphaBps >= policy.minConservativeNetAlphaBps;
  const vetoReasons = pass ? [] : ['CONSERVATIVE_NET_ALPHA_BELOW_MINIMUM'];
  return {
    contract: 'market-intelligence-net-alpha/v1',
    policy,
    market: String(raw.market ?? '').toUpperCase() || null,
    status: 'READY',
    decision: pass ? 'TAKE' : 'SKIP',
    reasons: vetoReasons,
    role: 'CONSERVATIVE_CROSS_CHECK_ONLY',
    asOf,
    evidenceAgeMs,
    source,
    costPolicyVersion,
    expectedGrossEdgeBps,
    conformalLowerEdgeBps,
    conservativeGrossEdgeBps,
    totalExpectedCostBps,
    expectedNetEdgeBps,
    conservativeNetAlphaBps,
    attestedNetEdgeBps,
    costs,
    autoTrading: {
      state: pass ? 'PASS' : 'VETO',
      reasons: vetoReasons,
      orderAllowed: false,
    },
    safety: {
      executionAuthority: 'NONE',
      numericalAuthority: 'CROSS_CHECK_ONLY',
      orderAllowed: false,
    },
  };
}

export { COST_FIELDS };
