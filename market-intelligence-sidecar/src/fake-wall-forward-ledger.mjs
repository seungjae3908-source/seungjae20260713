import { createHash } from 'node:crypto';

export const FAKE_WALL_FORWARD_LEDGER_CONTRACT = 'market-intelligence-fake-wall-forward-ledger/v1';
export const FAKE_WALL_FORWARD_HORIZON_POLICY = Object.freeze({
  version: 'fake-wall-forward-horizons/v1',
  horizons: Object.freeze([
    Object.freeze({ key: '5m', horizonMs: 5 * 60_000, maxSettlementLagMs: 2 * 60_000 }),
    Object.freeze({ key: '15m', horizonMs: 15 * 60_000, maxSettlementLagMs: 2 * 60_000 }),
    Object.freeze({ key: '60m', horizonMs: 60 * 60_000, maxSettlementLagMs: 5 * 60_000 }),
  ]),
});

const SAFETY = Object.freeze({
  artifactOnly: true,
  publicDataOnly: true,
  executionAuthority: 'NONE',
  scannerRankingImpact: 'NONE',
  tradingEligibilityImpact: 'NONE',
  financialMutationAllowed: false,
  liveOrderAllowed: false,
  privateTradingApiAllowed: false,
  profitabilityClaimAllowed: false,
});

function finite(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTimestamp(value) {
  const parsed = finite(value);
  if (parsed != null) return parsed;
  const date = Date.parse(String(value ?? ''));
  return Number.isFinite(date) ? date : null;
}

function normalizeString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return createHash('sha256').update(input).digest('hex');
}

function assertSha(value, code = 'INVALID_RESEARCH_SHA') {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(normalized)) throw new Error(code);
  return normalized;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeMarket(value) {
  return normalizeString(value)?.toUpperCase() ?? null;
}

function normalizeSymbol(value) {
  return normalizeString(value)?.toUpperCase() ?? null;
}

function normalizeVenue(value) {
  return normalizeString(value)?.toUpperCase() ?? null;
}

function normalizedHorizonPolicy(policy = FAKE_WALL_FORWARD_HORIZON_POLICY) {
  if (policy?.version !== FAKE_WALL_FORWARD_HORIZON_POLICY.version) throw new Error('UNSUPPORTED_HORIZON_POLICY');
  const horizons = Array.isArray(policy.horizons) ? policy.horizons : [];
  if (!horizons.length) throw new Error('EMPTY_HORIZON_POLICY');
  const seen = new Set();
  return {
    version: policy.version,
    horizons: horizons.map((item) => {
      const key = normalizeString(item?.key);
      const horizonMs = finite(item?.horizonMs);
      const maxSettlementLagMs = finite(item?.maxSettlementLagMs);
      if (!key || seen.has(key) || !(horizonMs > 0) || !(maxSettlementLagMs >= 0)) {
        throw new Error('INVALID_HORIZON_POLICY');
      }
      seen.add(key);
      return { key, horizonMs, maxSettlementLagMs };
    }),
  };
}

export function createEmptyLedger({ researchCodeSha, horizonPolicy } = {}) {
  return {
    schemaVersion: 1,
    kind: 'fake-wall-forward-evidence-ledger',
    contract: FAKE_WALL_FORWARD_LEDGER_CONTRACT,
    researchCodeSha: assertSha(researchCodeSha),
    horizonPolicy: normalizedHorizonPolicy(horizonPolicy),
    observations: [],
    safety: { ...SAFETY },
  };
}

function candidateEvidenceProjection(candidate) {
  return {
    contract: candidate?.contract ?? null,
    state: candidate?.state ?? null,
    direction: candidate?.direction ?? null,
    evidenceScore: finite(candidate?.evidenceScore),
    evidence: candidate?.evidence ?? null,
    confounders: Array.isArray(candidate?.confounders) ? [...candidate.confounders].sort() : [],
    missingEvidence: Array.isArray(candidate?.missingEvidence) ? [...candidate.missingEvidence].sort() : [],
    mode: candidate?.mode ?? null,
    scannerHardBlockAllowed: candidate?.scannerHardBlockAllowed ?? null,
    parentGateImpact: candidate?.parentGateImpact ?? null,
    orderAllowed: candidate?.orderAllowed ?? null,
    executionAuthority: candidate?.executionAuthority ?? null,
  };
}

export function buildCandidateObservation(context = {}, candidate = {}, horizonPolicy = FAKE_WALL_FORWARD_HORIZON_POLICY) {
  if (!['CANDIDATE', 'INSUFFICIENT_EVIDENCE'].includes(candidate?.state)) return null;
  const market = normalizeMarket(context.market);
  const symbol = normalizeSymbol(context.symbol);
  const venue = normalizeVenue(context.venue ?? context.provider);
  const producerSha = assertSha(context.producerSha ?? context.researchCodeSha, 'INVALID_PRODUCER_SHA');
  const detectedAt = normalizeTimestamp(context.detectedAt ?? context.asOf);
  const referencePrice = finite(context.referencePrice);
  if (!market || !symbol || !venue || detectedAt == null || !(referencePrice > 0)) {
    throw new Error('FAKE_WALL_OBSERVATION_IDENTITY_INCOMPLETE');
  }
  const policy = normalizedHorizonPolicy(horizonPolicy);
  const evidence = candidateEvidenceProjection(candidate);
  const evidenceFingerprint = sha256(canonicalJson(evidence));
  const identity = {
    contract: FAKE_WALL_FORWARD_LEDGER_CONTRACT,
    horizonPolicyVersion: policy.version,
    market,
    symbol,
    venue,
    producerSha,
    detectedAt,
    evidenceFingerprint,
  };
  const candidateId = `fw-${sha256(canonicalJson(identity))}`;
  return {
    candidateId,
    market,
    symbol,
    venue,
    producerSha,
    detectedAt,
    referencePrice,
    evidenceFingerprint,
    evidence,
    provenance: context.provenance ?? null,
    freshness: context.freshness ?? null,
    qualityFlags: Array.isArray(context.qualityFlags) ? [...new Set(context.qualityFlags.map(String))].sort() : [],
    status: 'PENDING',
    horizons: policy.horizons.map((item) => ({
      key: item.key,
      horizonMs: item.horizonMs,
      maxSettlementLagMs: item.maxSettlementLagMs,
      targetAt: detectedAt + item.horizonMs,
      status: 'PENDING',
      observedAt: null,
      observedReferencePrice: null,
      returnBps: null,
      direction: null,
      mfeBps: null,
      maeBps: null,
      pathEvidence: 'NOT_EVALUATED',
      reason: null,
    })),
  };
}

function validateSafety(value) {
  for (const [key, expected] of Object.entries(SAFETY)) {
    if (value?.[key] !== expected) throw new Error('LEDGER_SAFETY_CONTRACT_INVALID');
  }
}

export function validateLedgerState(state, { researchCodeSha } = {}) {
  if (!state || state.schemaVersion !== 1 || state.kind !== 'fake-wall-forward-evidence-ledger' || state.contract !== FAKE_WALL_FORWARD_LEDGER_CONTRACT) {
    throw new Error('UNSUPPORTED_FAKE_WALL_LEDGER');
  }
  const expectedSha = assertSha(researchCodeSha ?? state.researchCodeSha);
  if (state.researchCodeSha !== expectedSha) throw new Error('FAKE_WALL_RESEARCH_SHA_MIXING_FORBIDDEN');
  normalizedHorizonPolicy(state.horizonPolicy);
  validateSafety(state.safety);
  if (!Array.isArray(state.observations)) throw new Error('FAKE_WALL_LEDGER_OBSERVATIONS_INVALID');
  const ids = new Set();
  for (const observation of state.observations) {
    if (!observation?.candidateId || ids.has(observation.candidateId)) throw new Error('FAKE_WALL_LEDGER_DUPLICATE_CANDIDATE');
    ids.add(observation.candidateId);
    if (observation.producerSha !== expectedSha) throw new Error('FAKE_WALL_OBSERVATION_SHA_MISMATCH');
    if (!Array.isArray(observation.horizons)) throw new Error('FAKE_WALL_HORIZON_STATE_INVALID');
  }
  return state;
}

export function verifyPredecessorBundle({ manifest, state, summary, researchCodeSha }) {
  try {
    validateLedgerState(state, { researchCodeSha });
    if (!manifest || manifest.schemaVersion !== 1 || manifest.kind !== 'fake-wall-forward-evidence-ledger-manifest') {
      throw new Error('PREDECESSOR_MANIFEST_INVALID');
    }
    if (manifest.researchCodeSha !== assertSha(researchCodeSha)) throw new Error('PREDECESSOR_RESEARCH_SHA_MISMATCH');
    validateSafety(manifest.safety);
    if (manifest.stateSha256 !== sha256(`${canonicalJson(state)}\n`)) throw new Error('PREDECESSOR_STATE_DIGEST_MISMATCH');
    if (manifest.summarySha256 !== sha256(`${canonicalJson(summary)}\n`)) throw new Error('PREDECESSOR_SUMMARY_DIGEST_MISMATCH');
    const expectedContentDigest = sha256(canonicalJson({
      schemaVersion: manifest.schemaVersion,
      kind: manifest.kind,
      researchCodeSha: manifest.researchCodeSha,
      horizonPolicyVersion: manifest.horizonPolicyVersion,
      predecessorArtifactId: manifest.predecessorArtifactId ?? null,
      predecessorArtifactDigest: manifest.predecessorArtifactDigest ?? null,
      stateSha256: manifest.stateSha256,
      summarySha256: manifest.summarySha256,
      safety: manifest.safety,
    }));
    if (manifest.artifactContentDigest !== expectedContentDigest) throw new Error('PREDECESSOR_ARTIFACT_DIGEST_MISMATCH');
    return true;
  } catch (error) {
    const wrapped = new Error('ARTIFACT_CHAIN_BROKEN');
    wrapped.cause = error;
    throw wrapped;
  }
}

function normalizeMark(mark) {
  const market = normalizeMarket(mark?.market);
  const symbol = normalizeSymbol(mark?.symbol);
  const venue = normalizeVenue(mark?.venue ?? mark?.provider);
  const observedAt = normalizeTimestamp(mark?.observedAt ?? mark?.asOf);
  const referencePrice = finite(mark?.referencePrice ?? mark?.price);
  if (!market || !symbol || !venue || observedAt == null || !(referencePrice > 0)) return null;
  return { market, symbol, venue, observedAt, referencePrice };
}

function sameIdentity(mark, observation) {
  return mark.market === observation.market && mark.symbol === observation.symbol && mark.venue === observation.venue;
}

function settleObservation(observation, marks, now) {
  const relevant = marks.filter((mark) => sameIdentity(mark, observation)).sort((a, b) => a.observedAt - b.observedAt);
  const next = clone(observation);
  for (const horizon of next.horizons) {
    if (horizon.status !== 'PENDING') continue;
    if (now < horizon.targetAt) continue;
    const latestAllowed = horizon.targetAt + horizon.maxSettlementLagMs;
    const settlementMark = relevant.find((mark) => mark.observedAt >= horizon.targetAt && mark.observedAt <= latestAllowed);
    if (!settlementMark) {
      if (now > latestAllowed) {
        horizon.status = 'INVALIDATED';
        horizon.reason = 'HORIZON_MARK_MISSING';
        horizon.pathEvidence = 'MISSING';
      }
      continue;
    }
    const returnBps = ((settlementMark.referencePrice - next.referencePrice) / next.referencePrice) * 10_000;
    const pathMarks = relevant.filter((mark) => mark.observedAt >= next.detectedAt && mark.observedAt <= settlementMark.observedAt);
    const pathReturns = pathMarks.map((mark) => ((mark.referencePrice - next.referencePrice) / next.referencePrice) * 10_000);
    horizon.status = 'SETTLED';
    horizon.observedAt = settlementMark.observedAt;
    horizon.observedReferencePrice = settlementMark.referencePrice;
    horizon.returnBps = returnBps;
    horizon.direction = returnBps > 0 ? 'UP' : returnBps < 0 ? 'DOWN' : 'FLAT';
    horizon.mfeBps = pathReturns.length ? Math.max(...pathReturns) : null;
    horizon.maeBps = pathReturns.length ? Math.min(...pathReturns) : null;
    horizon.pathEvidence = pathReturns.length >= 2 ? 'PARTIAL_PUBLIC_MARKS' : 'SETTLEMENT_MARK_ONLY';
    horizon.reason = null;
  }
  const statuses = next.horizons.map((item) => item.status);
  next.status = statuses.every((value) => value === 'SETTLED')
    ? 'SETTLED'
    : statuses.every((value) => value !== 'PENDING')
      ? statuses.some((value) => value === 'SETTLED') ? 'PARTIALLY_SETTLED' : 'INVALIDATED'
      : statuses.some((value) => value === 'SETTLED') ? 'PARTIALLY_SETTLED' : 'PENDING';
  return next;
}

export function advanceLedger({ previousState, researchCodeSha, observations = [], marks = [], now }) {
  const timestamp = normalizeTimestamp(now);
  if (timestamp == null) throw new Error('LEDGER_NOW_REQUIRED');
  const state = previousState ? clone(previousState) : createEmptyLedger({ researchCodeSha });
  validateLedgerState(state, { researchCodeSha });
  const byId = new Map(state.observations.map((item) => [item.candidateId, item]));
  let deduped = 0;
  for (const observation of observations.filter(Boolean)) {
    if (observation.producerSha !== state.researchCodeSha) throw new Error('FAKE_WALL_OBSERVATION_SHA_MISMATCH');
    if (byId.has(observation.candidateId)) {
      if (canonicalJson(byId.get(observation.candidateId)) !== canonicalJson(observation)) {
        throw new Error('FAKE_WALL_CANDIDATE_ID_COLLISION');
      }
      deduped += 1;
      continue;
    }
    byId.set(observation.candidateId, clone(observation));
  }
  const cleanMarks = marks.map(normalizeMark).filter(Boolean);
  const nextObservations = [...byId.values()]
    .map((item) => settleObservation(item, cleanMarks, timestamp))
    .sort((a, b) => a.detectedAt - b.detectedAt || a.candidateId.localeCompare(b.candidateId));
  return {
    state: { ...state, observations: nextObservations },
    stats: {
      observations: nextObservations.length,
      added: Math.max(0, nextObservations.length - state.observations.length),
      deduped,
      pending: nextObservations.filter((item) => item.status === 'PENDING' || item.status === 'PARTIALLY_SETTLED').length,
      fullySettled: nextObservations.filter((item) => item.status === 'SETTLED').length,
      invalidated: nextObservations.filter((item) => item.status === 'INVALIDATED').length,
    },
  };
}

export function buildArtifactBundle(state, {
  predecessorRunId = null,
  predecessorArtifactId = null,
  predecessorArtifactDigest = null,
  harnessSha = null,
} = {}) {
  validateLedgerState(state, { researchCodeSha: state.researchCodeSha });
  const summary = {
    schemaVersion: 1,
    kind: 'fake-wall-forward-evidence-ledger-summary',
    contract: FAKE_WALL_FORWARD_LEDGER_CONTRACT,
    researchCodeSha: state.researchCodeSha,
    horizonPolicyVersion: state.horizonPolicy.version,
    observations: state.observations.length,
    candidateStates: state.observations.reduce((acc, item) => {
      acc[item.status] = (acc[item.status] ?? 0) + 1;
      return acc;
    }, {}),
    horizons: state.observations.flatMap((item) => item.horizons).reduce((acc, item) => {
      acc[item.status] = (acc[item.status] ?? 0) + 1;
      return acc;
    }, {}),
    profitabilityMetrics: 'N/A',
    scannerRankingImpact: 'NONE',
    tradingEligibilityImpact: 'NONE',
    safety: { ...SAFETY },
  };
  const stateText = `${canonicalJson(state)}\n`;
  const summaryText = `${canonicalJson(summary)}\n`;
  const manifestBase = {
    schemaVersion: 1,
    kind: 'fake-wall-forward-evidence-ledger-manifest',
    researchCodeSha: state.researchCodeSha,
    horizonPolicyVersion: state.horizonPolicy.version,
    harnessSha: harnessSha ? assertSha(harnessSha, 'INVALID_HARNESS_SHA') : null,
    predecessorRunId,
    predecessorArtifactId,
    predecessorArtifactDigest,
    stateSha256: sha256(stateText),
    summarySha256: sha256(summaryText),
    safety: { ...SAFETY },
  };
  const artifactContentDigest = sha256(canonicalJson({
    schemaVersion: manifestBase.schemaVersion,
    kind: manifestBase.kind,
    researchCodeSha: manifestBase.researchCodeSha,
    horizonPolicyVersion: manifestBase.horizonPolicyVersion,
    predecessorArtifactId: manifestBase.predecessorArtifactId,
    predecessorArtifactDigest: manifestBase.predecessorArtifactDigest,
    stateSha256: manifestBase.stateSha256,
    summarySha256: manifestBase.summarySha256,
    safety: manifestBase.safety,
  }));
  const manifest = { ...manifestBase, artifactContentDigest };
  return { state, summary, manifest, stateText, summaryText, manifestText: `${canonicalJson(manifest)}\n` };
}

export const FAKE_WALL_FORWARD_LEDGER_SAFETY = SAFETY;
