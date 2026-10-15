const SHA = /^[0-9a-f]{40}$/u;

function cardsFrom(lanes) {
  return (Array.isArray(lanes) ? lanes : []).flatMap((lane) =>
    (Array.isArray(lane?.cards) ? lane.cards : []).map((card) => ({ lane, card })));
}

function approvedRisk(value) {
  return value?.status === 'APPROVED'
    && value?.source === 'TRADING_RISK_ENGINE'
    && value?.allowed === true
    && value?.simulatedOnly === true
    && value?.executionAuthority === 'NONE'
    && Array.isArray(value?.blockCodes)
    && value.blockCodes.length === 0;
}

function connectedHandoff(value) {
  return value?.schemaVersion === 'member-auto-trading-paper-handoff-v1'
    && value?.status === 'READY'
    && Array.isArray(value?.entries)
    && Array.isArray(value?.blockers)
    && value.blockers.length === 0
    && Number.isInteger(value?.entryCount)
    && value.entryCount === value.entries.length;
}

function handoffIdentityMatches(resolution, entry) {
  const signal = resolution?.paperCandidate?.signal;
  const strategy = signal?.strategyIdentity;
  const identity = entry?.identity;
  if (!signal || !strategy || !identity) return false;
  return identity.signalId === signal.signalId
    && identity.candidateId === strategy.candidateId
    && identity.market === signal.market
    && identity.symbol === signal.symbol
    && identity.timeframe === signal.timeframe
    && identity.horizon === signal.horizon
    && identity.direction === signal.direction
    && identity.strategyId === strategy.strategyId
    && identity.strategyVersion === strategy.strategyVersion
    && identity.parameterHash === strategy.parameterHash
    && String(identity.researchCodeSha ?? '').toLowerCase() === String(strategy.researchCodeSha ?? '').toLowerCase()
    && identity.costPolicyVersion === strategy.costPolicyVersion;
}

function countReasons(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.freeze(Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right))));
}

export function diagnoseCanonicalHandoffJoin({
  lanes = [],
  canonicalBySignalId = {},
  riskBySignalId = {},
  handoff = null,
  serviceSha = null,
  expectedServiceSha = null,
  workerResult = null,
} = {}) {
  const rows = cardsFrom(lanes);
  const sGrade = rows.filter(({ card }) => card?.signalGrade === 'S' && card?.strongSignalEligible === true);
  const dataComplete = sGrade.filter(({ card }) => card?.dataState === 'complete'
    && card?.dataQuality?.state !== 'DATA_UNTRUSTED'
    && (!card?.dataQuality || card.dataQuality.strongSignalAllowed === true));
  const canonicalReady = dataComplete.filter(({ card }) => canonicalBySignalId[card.signalId]?.paperCandidate);
  const riskReady = canonicalReady.filter(({ card }) => approvedRisk(riskBySignalId[card.signalId]));
  const handoffReady = connectedHandoff(handoff);
  const handoffBySignal = new Map(handoffReady
    ? handoff.entries.map((entry) => [entry?.identity?.signalId, entry]).filter(([signalId]) => Boolean(signalId))
    : []);
  const handoffIdentityReady = riskReady.filter(({ card }) => handoffIdentityMatches(
    canonicalBySignalId[card.signalId], handoffBySignal.get(card.signalId),
  ));
  const shaPresent = SHA.test(String(serviceSha ?? ''));
  const expectedShaPresent = SHA.test(String(expectedServiceSha ?? ''));
  const shaMatches = shaPresent && expectedShaPresent
    ? String(serviceSha).toLowerCase() === String(expectedServiceSha).toLowerCase()
    : null;
  const joined = handoffIdentityReady.filter(() => shaMatches === true);

  const canonicalBlockers = dataComplete.flatMap(({ card }) => {
    const resolution = canonicalBySignalId[card.signalId];
    if (resolution?.paperCandidate) return [];
    return Array.isArray(resolution?.blockers) && resolution.blockers.length
      ? resolution.blockers
      : ['CANONICAL_RESOLUTION_NOT_RUN'];
  });
  const riskBlockers = canonicalReady.flatMap(({ card }) => {
    const risk = riskBySignalId[card.signalId];
    if (approvedRisk(risk)) return [];
    return Array.isArray(risk?.blockCodes) && risk.blockCodes.length
      ? risk.blockCodes.map((code) => `RISK:${code}`)
      : ['RISK_EVIDENCE_MISSING_OR_NOT_APPROVED'];
  });
  const workerAccepted = Number(workerResult?.entries ?? 0);
  const workerEvaluated = Number(workerResult?.evaluated ?? 0);
  const privateTradingRequests = Number(workerResult?.privateTradingRequests ?? 0);
  const liveOrders = Number(workerResult?.liveOrders ?? 0);

  return Object.freeze({
    scannedCardCount: rows.length,
    sGradeCandidateCount: sGrade.length,
    completeSGradeCount: dataComplete.length,
    canonicalIdentityCount: canonicalReady.length,
    riskApprovedCount: riskReady.length,
    handoffIdentityCount: handoffIdentityReady.length,
    canonicalHandoffJoin: joined.length,
    worker: Object.freeze({
      status: joined.length === 0
        ? 'NOT_RUN_NO_ACTUAL_JOIN'
        : workerResult == null
          ? 'NOT_OBSERVED'
          : workerAccepted > 0 && workerEvaluated > 0 && privateTradingRequests === 0 && liveOrders === 0
            ? 'DELIVERED_WITHOUT_REAL_ORDER'
            : 'DELIVERY_NOT_PROVEN',
      acceptedEntries: workerAccepted,
      evaluated: workerEvaluated,
      privateTradingRequests,
      liveOrders,
    }),
    causes: Object.freeze({
      candidateShortage: Object.freeze({ active: sGrade.length === 0, observed: sGrade.length }),
      dataIncomplete: Object.freeze({ active: sGrade.length > dataComplete.length, blocked: sGrade.length - dataComplete.length }),
      canonicalEvidenceInsufficient: Object.freeze({
        active: dataComplete.length > riskReady.length
          || (handoffReady && riskReady.length > handoffIdentityReady.length),
        identityBlocked: dataComplete.length - canonicalReady.length,
        riskBlocked: canonicalReady.length - riskReady.length,
        handoffIdentityBlocked: handoffReady ? riskReady.length - handoffIdentityReady.length : 0,
        canonicalBlockers: countReasons(canonicalBlockers),
        riskBlockers: countReasons(riskBlockers),
      }),
      handoffFileDisconnected: Object.freeze({ active: !handoffReady, status: handoff?.status ?? 'MISSING' }),
      serviceShaMismatch: Object.freeze({
        active: shaMatches === false,
        status: shaMatches == null ? 'NOT_EVALUABLE' : shaMatches ? 'MATCH' : 'MISMATCH',
        serviceShaPresent: shaPresent,
        expectedServiceShaPresent: expectedShaPresent,
      }),
    }),
    safety: Object.freeze({
      executionAuthority: 'NONE',
      privateTradingRequests,
      liveOrders,
      realOrderObserved: privateTradingRequests > 0 || liveOrders > 0,
    }),
  });
}
