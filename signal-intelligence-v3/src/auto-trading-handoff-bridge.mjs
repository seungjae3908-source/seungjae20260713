const MARKETS = new Set(['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES']);
const CASH_MARKETS = new Set(['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT']);
const LIST_NAMES = Object.freeze(['krBuy', 'usBuy', 'spotBuy', 'futuresLong', 'futuresShort']);
const MAX_SIGNAL_SNAPSHOT_AGE_MS = 30 * 60_000;

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function directionForCard(card, market) {
  const action = String(card?.action ?? '').toUpperCase();
  const direction = String(card?.direction ?? '').toUpperCase();
  if (CASH_MARKETS.has(market)) return action === 'BUY' || direction === 'LONG' ? 'BUY' : null;
  return ['LONG', 'SHORT'].includes(action) ? action : ['LONG', 'SHORT'].includes(direction) ? direction : null;
}

function marketForCard(card) {
  const assetClass = String(card?.assetClass ?? '').toLowerCase();
  const market = String(card?.market ?? '').toUpperCase();
  if (assetClass === 'stock' && market === 'KR') return 'KR_STOCK';
  if (assetClass === 'stock' && market === 'US') return 'US_STOCK';
  if (assetClass === 'coin_spot') return 'CRYPTO_SPOT';
  if (assetClass === 'coin_futures') return 'CRYPTO_FUTURES';
  return null;
}

function entryMatchesCard(entry, card, timeframe) {
  const market = marketForCard(card);
  const direction = market ? directionForCard(card, market) : null;
  return Boolean(market && direction
    && entry?.identity?.signalId === card?.signalId
    && entry.identity.market === market
    && String(entry.identity.symbol).toUpperCase() === String(card?.symbol ?? '').toUpperCase()
    && entry.identity.timeframe === timeframe
    && entry.identity.direction === direction
    && entry.identity.executionAuthority === 'NONE');
}

function percent(rate) {
  return finite(rate) && rate >= 0 ? rate * 100 : null;
}

/** Convert the canonical handoff's decimal execution rates to the adapter's
 * explicitly-percent contract. No default cost or missing component is made up.
 */
export function explicitAdapterCostPolicy(entry) {
  const policy = entry?.execution?.costPolicy;
  const identity = entry?.identity;
  if (!policy || !identity || policy.version !== identity.costPolicyVersion) return null;
  const converted = {
    id: policy.version,
    market: identity.market,
    source: 'EXPLICIT_RUNTIME_POLICY',
    commissionPercent: percent(policy.commissionRate),
    taxPercent: percent(policy.taxRate),
    spreadPercent: percent(policy.spreadRate),
    slippagePercent: percent(policy.slippageRate),
    fundingPercent: percent(policy.fundingRate),
    latencyPercent: percent(policy.latencyRate),
    liquidityImpactPercent: percent(policy.liquidityImpactRate),
    partialFillImpactPercent: percent(policy.partialFillImpactRate),
  };
  return Object.values(converted).some((value) => value == null) ? null : Object.freeze(converted);
}

function aiCommitteeInput(card, entry) {
  const validation = card?.aiValidation;
  if (validation?.status === 'VETO') {
    return Object.freeze({
      riskCritic: Object.freeze({ veto: true, reasons: Object.freeze([...(validation.risks ?? ['CANONICAL_AI_VETO'])]) }),
      contradiction: Object.freeze({
        conflict: Array.isArray(validation.counterEvidence) && validation.counterEvidence.length > 0,
        reasons: Object.freeze([...(validation.counterEvidence ?? [])]),
      }),
    });
  }
  // A canonical upstream PASS remains provenance only. Signal V3 AI has veto
  // authority, never candidate-promotion authority, so absence/PASS both map to
  // a neutral committee input here.
  return entry?.aiReviewEvidence?.decision === 'PASS'
    ? Object.freeze({ canonicalPassEvidenceDigest: entry.aiReviewEvidence.evidenceDigest })
    : Object.freeze({});
}

function blockedAdapterInput(card, timeframe) {
  return Object.freeze({ card, timeframe });
}

export function canonicalAdapterInputForCard(card, timeframe, handoff) {
  if (!card || !nonEmpty(timeframe) || handoff?.status !== 'READY' || !Array.isArray(handoff.entries)) {
    return blockedAdapterInput(card, timeframe);
  }
  const matches = handoff.entries.filter((entry) => entryMatchesCard(entry, card, timeframe));
  if (matches.length !== 1) return blockedAdapterInput(card, timeframe);
  const entry = matches[0];
  const costPolicy = explicitAdapterCostPolicy(entry);
  if (!costPolicy) return blockedAdapterInput(card, timeframe);
  return Object.freeze({
    card,
    timeframe,
    paperIdentity: entry.identity,
    profitEvidence: entry.profitEvidence,
    costPolicy,
    ai: aiCommitteeInput(card, entry),
    validationTier: 'FORWARD_VALIDATED',
  });
}

export function canonicalAdapterInputsForCards(cards, timeframe, handoff) {
  const inputs = (Array.isArray(cards) ? cards : []).map((card) => canonicalAdapterInputForCard(card, timeframe, handoff));
  const joined = inputs.filter((input) => input.paperIdentity).length;
  return Object.freeze({
    inputs: Object.freeze(inputs),
    diagnostics: Object.freeze({
      scanned: inputs.length,
      joined,
      blocked: inputs.length - joined,
      handoffStatus: handoff?.status ?? 'MISSING',
    }),
  });
}

function candidateRows(snapshot) {
  if (!snapshot?.lists || typeof snapshot.lists !== 'object') return [];
  return LIST_NAMES.flatMap((name) => Array.isArray(snapshot.lists[name]) ? snapshot.lists[name] : []);
}

function rowMatchesEntry(row, entry) {
  const identity = row?.provenance?.paperIdentity;
  return row?.state === 'CANDIDATE'
    && identity?.signalId === entry?.identity?.signalId
    && row.market === entry.identity.market
    && row.symbol === String(entry.identity.symbol).toUpperCase()
    && row.timeframe === entry.identity.timeframe
    && row.direction === entry.identity.direction
    && row.strategy === String(entry.identity.strategyId).toUpperCase()
    && identity.strategyVersion === entry.identity.strategyVersion
    && identity.parameterHash === entry.identity.parameterHash
    && identity.researchCodeSha === entry.identity.researchCodeSha
    && identity.costPolicyVersion === entry.identity.costPolicyVersion;
}

function snapshotBlockers(snapshot, nowMs, maximumAgeMs, expectedServiceSha) {
  const blockers = [];
  if (!nonEmpty(expectedServiceSha) || !/^[0-9a-f]{40}$/u.test(expectedServiceSha)) {
    blockers.push('SIGNAL_EXPECTED_SERVICE_SHA_INVALID');
  } else if (snapshot?.serviceSha !== expectedServiceSha) {
    blockers.push('SIGNAL_SERVICE_SHA_MISMATCH');
  }
  if (snapshot?.policyVersion !== 'signal-intelligence-v3.1') blockers.push('SIGNAL_POLICY_VERSION_INVALID');
  if (snapshot?.publicDataOnly !== true || snapshot?.rosterBindingVersion !== 1) {
    blockers.push('SIGNAL_PUBLIC_ROSTER_BINDING_INVALID');
  }
  if (snapshot?.safety?.executionAuthority !== 'NONE'
    || snapshot?.safety?.privateTradingApiAllowed !== false
    || snapshot?.safety?.realOrderAllowed !== false) blockers.push('SIGNAL_SAFETY_ENVELOPE_INVALID');
  const generatedAtMs = Date.parse(String(snapshot?.generatedAt ?? ''));
  if (!finite(generatedAtMs) || generatedAtMs > nowMs || nowMs - generatedAtMs > maximumAgeMs) {
    blockers.push('SIGNAL_SNAPSHOT_STALE_OR_FUTURE');
  }
  if (!snapshot?.lists || LIST_NAMES.some((name) => !Array.isArray(snapshot.lists[name]))) {
    blockers.push('SIGNAL_LISTS_INVALID');
  }
  return blockers;
}

/**
 * Select already-validated canonical handoff entries. This function never
 * rebuilds or re-digests the handoff and therefore cannot create execution
 * evidence. The background worker validates the original handoff first.
 */
export function selectSignalAdmittedHandoffEntries({
  handoff,
  snapshot,
  nowMs = Date.now(),
  maximumAgeMs = MAX_SIGNAL_SNAPSHOT_AGE_MS,
  expectedServiceSha,
} = {}) {
  const blockers = [];
  if (!finite(nowMs) || !finite(maximumAgeMs) || maximumAgeMs <= 0) blockers.push('SIGNAL_BRIDGE_CLOCK_INVALID');
  if (handoff?.status !== 'READY' || !Array.isArray(handoff?.entries)) blockers.push('CANONICAL_HANDOFF_NOT_READY');
  blockers.push(...snapshotBlockers(snapshot, nowMs, maximumAgeMs, expectedServiceSha));
  if (blockers.length) {
    return Object.freeze({ status: 'BLOCKED_DATA', entries: Object.freeze([]), blockers: Object.freeze([...new Set(blockers)]) });
  }

  const rows = candidateRows(snapshot);
  const entries = handoff.entries.filter((entry) => rows.some((row) => rowMatchesEntry(row, entry)));
  return Object.freeze({
    status: 'READY',
    entries: Object.freeze(entries),
    blockers: Object.freeze([]),
    candidateCount: rows.length,
    admittedCount: entries.length,
    rejectedCount: handoff.entries.length - entries.length,
  });
}
