// Research cursor progress is never candidate, OOS, profitability or Paper authority.
const sources = {
  KR_STOCK: ['krx-symbol-master'],
  US_STOCK: ['finnhub-symbol-master', 'nasdaq-trader-public-directory'],
  CRYPTO_SPOT: ['upbit-public'], CRYPTO_FUTURES: ['bitget-public'],
};
const count = value => Number.isSafeInteger(value) && value >= 0;
const lanes = ['KR', 'US', 'SPOT', 'FUTURES'].flatMap(m =>
  ['SCALPING_15M', 'SWING_60M', 'MID_LONG_1D'].map(p => `${m}_${p}`));
const marketForLane = lane => ({ KR: 'KR_STOCK', US: 'US_STOCK', SPOT: 'CRYPTO_SPOT', FUTURES: 'CRYPTO_FUTURES' })[lane?.split('_')[0]];

export function publicCyclePageDecision(response, market, cursor) {
  const hold = (status, reason) => ({ status, nextCursor: cursor, blockedObservationOnly: false, reason });
  const u = response?.universe, e = response?.execution;
  if (!count(cursor) || !u || !e || !Array.isArray(response.cards) || !Array.isArray(response.failures)) {
    return hold('SEARCH_FAILURE', 'MALFORMED_SOURCE_PAGE');
  }
  if (!count(e.providerErrorCount) || e.providerErrorCount !== 0 || !count(e.timeoutCount) || e.timeoutCount !== 0
    || (u.providerErrorCount != null && u.providerErrorCount !== 0)
    || u.stale !== false || response.dataState === 'stale' || response.dataState === 'unavailable'
    || e.cancelled !== false || e.timedOut !== false || e.duplicate !== false
    || ['PROVIDER_FAILURE', 'REQUEST_TIMEOUT', 'SYMBOL_MAPPING_FAILURE', 'UNIVERSE_EMPTY'].includes(response.outcome)
    || response.failures.some(f => f?.reason !== 'invalid_data')) {
    return hold('SEARCH_FAILURE', 'PROVIDER_OR_STALE_PAGE');
  }
  const trustedSource = sources[market]?.includes(u.source) === true;
  const floor = market === 'KR_STOCK' ? 500 : market === 'US_STOCK' ? 1_000 : 1;
  if (!trustedSource || !count(u.totalCount) || u.totalCount < floor) {
    return hold('BLOCKED_DATA', 'ROSTER_NOT_ATTESTED');
  }
  // A listing removal can leave the persisted cursor beyond the current roster.
  if (cursor >= u.totalCount && u.cursor === u.totalCount
    && e.requestedCount === 0 && e.startedCount === 0 && e.completedCount === 0) {
    return { status: 'BLOCKED_DATA', nextCursor: 0, blockedObservationOnly: true, reason: 'ROSTER_SHRUNK_RESTART' };
  }
  if (u.cursor !== cursor || !count(e.requestedCount) || e.requestedCount === 0
    || e.startedCount !== e.requestedCount || e.completedCount !== e.requestedCount) {
    return hold('SEARCH_FAILURE', 'PAGE_NOT_COMPLETED');
  }
  const end = cursor + e.requestedCount;
  if (end > u.totalCount || (u.nextCursor === null ? end !== u.totalCount : u.nextCursor !== end || end >= u.totalCount)) {
    return hold('SEARCH_FAILURE', 'CURSOR_EVIDENCE_MISMATCH');
  }
  if ((response.outcome === 'VALID_ZERO_SIGNAL' && response.cards.length > 0)
    || (response.outcome === 'CANDIDATES_AVAILABLE' && response.cards.length === 0)) {
    return hold('SEARCH_FAILURE', 'OUTCOME_CARD_MISMATCH');
  }
  const blocked = u.partial !== false || e.partial !== false || response.dataState !== 'complete' || response.failures.length > 0;
  return {
    status: blocked ? 'BLOCKED_DATA' : response.cards.length ? 'CANDIDATES_AVAILABLE' : 'VALID_NO_TRADE',
    nextCursor: u.nextCursor === null ? 0 : end,
    blockedObservationOnly: blocked,
    reason: blocked ? 'BLOCKED_RESEARCH_ROTATION_ONLY' : 'VERIFIED_BATCH',
  };
}

// Only this cycle's fully verified pages may publish new lists/events.
// Retained history remains available in rows for research, never fresh alerts.
export function currentPublicCyclePublication(snapshot) {
  const empty = () => ({ lists: Object.fromEntries(Object.keys(snapshot?.lists ?? {}).map(k => [k, []])), events: [], currentPageReady: false });
  const coverage = snapshot?.coverage, cycle = snapshot?.sourceCycleId;
  if (typeof cycle !== 'string' || !cycle || !Array.isArray(coverage) || coverage.length !== 12
    || new Set(coverage.map(r => r?.laneId)).size !== 12 || coverage.some(r => !lanes.includes(r?.laneId))) return empty();
  const verified = coverage.filter(r => {
    const e = r.pageExecution;
    const expectedEnd = r.cursorBefore + e?.requestedCount;
    return r.sourceCycleId === cycle && marketForLane(r.laneId) === r.market
      && sources[r.market]?.includes(r.universeSource)
      && ['CANDIDATES_AVAILABLE', 'VALID_NO_TRADE'].includes(r.status)
      && r.universePartial === false && r.universeStale === false && r.responseDataState === 'complete'
      && r.providerErrors === 0 && r.timeouts === 0 && r.universeProviderErrors === 0
      && r.cursorRotatedBlockedOnly !== true && count(r.cursorBefore)
      && count(r.totalUniverse) && r.totalUniverse >= (r.market === 'KR_STOCK' ? 500 : r.market === 'US_STOCK' ? 1000 : 1)
      && count(e?.requestedCount) && e.requestedCount > 0
      && e.startedCount === e.requestedCount && e.completedCount === e.requestedCount
      && e.failuresObserved === 0 && e.partial === false && e.timedOut === false && e.cancelled === false
      && expectedEnd <= r.totalUniverse
      && r.cursorAfter === (expectedEnd === r.totalUniverse ? 0 : expectedEnd);
  });
  const byLane = new Map(verified.map(r => [r.laneId, r]));
  const allowed = new Set((snapshot.rows ?? []).filter(row => {
    const p = row?.provenance, lane = byLane.get(p?.laneId);
    return lane && row.market === lane.market && p.sourceCycleId === cycle && p.cursor === lane.cursorBefore;
  }).map(row => row.id));
  return {
    lists: Object.fromEntries(Object.entries(snapshot.lists ?? {}).map(([key, rows]) => [key, rows.filter(row => allowed.has(row.id))])),
    events: (snapshot.events ?? []).filter(event => allowed.has(event.id)),
    currentPageReady: verified.length === 12,
  };
}
