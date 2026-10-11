// Diagnostics only. Reuse the exact real public Scanner cycle; do not
// issue a second round of costly Upbit/Bitget/Yahoo requests just to
// inspect provider errors after the first cycle has finished.
export const PUBLIC_PROVIDER_CYCLE_DIAGNOSTIC_VERSION = 'public-provider-cycle-diagnostic-v2';
const SHA40 = /^[a-f0-9]{40}$/u;
const MARKETS = Object.freeze(['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES']);
const STRATEGIES = Object.freeze(['SCALPING','SWING','MID_LONG']);
const STATUSES = new Set(['CANDIDATES_AVAILABLE','VALID_NO_TRADE','SEARCH_FAILURE','BLOCKED_DATA']);
const count = v => Number.isSafeInteger(v) && v >= 0;

// Summarize public provider failures WITHOUT exposing symbols, request bodies,
// raw exception text, headers, keys, account data or any user identifiers.
// This is an observation-only codebook, not a provider-health PASS signal.
export function summarizePublicProviderFailureReasons(failures) {
  if (!Array.isArray(failures) || failures.length > 80) return null;
  const counts = {
    HTTP_429: 0, HTTP_418: 0, HTTP_4XX: 0, HTTP_5XX: 0,
    BITGET_REST_CODE: 0, PROVIDER_ADMISSION: 0,
    PROVIDER_OTHER: 0, TIMEOUT: 0, INVALID_DATA: 0, SYMBOL_MAPPING: 0,
  };
  const bitgetCodes = new Set();
  for (const row of failures) {
    if (!row || typeof row !== 'object') {
      counts.PROVIDER_OTHER += 1;
      continue;
    }
    const reason = typeof row.reason === 'string' ? row.reason : '';
    const message = typeof row.message === 'string' ? row.message : '';
    if (reason === 'timeout') { counts.TIMEOUT += 1; continue; }
    if (reason === 'invalid_data') { counts.INVALID_DATA += 1; continue; }
    if (reason === 'symbol_mapping') { counts.SYMBOL_MAPPING += 1; continue; }
    if (reason !== 'provider_error') { counts.PROVIDER_OTHER += 1; continue; }
    const http = /^HTTP_([1-5][0-9]{2})(?:$|[^0-9])/u.exec(message);
    if (http) {
      const status = Number(http[1]);
      if (status === 429) counts.HTTP_429 += 1;
      else if (status === 418) counts.HTTP_418 += 1;
      else if (status >= 500) counts.HTTP_5XX += 1;
      else counts.HTTP_4XX += 1;
      continue;
    }
    const bitget = /^BITGET_([0-9]{4,7})(?:$|[^0-9])/u.exec(message);
    if (bitget) {
      counts.BITGET_REST_CODE += 1;
      if (bitgetCodes.size < 8) bitgetCodes.add(bitget[1]);
      continue;
    }
    if (/^(?:CIRCUIT_OPEN|CAPACITY_EXHAUSTED|PROVIDER_ADMISSION)/u.test(message)) {
      counts.PROVIDER_ADMISSION += 1;
      continue;
    }
    counts.PROVIDER_OTHER += 1;
  }
  return Object.freeze({
    failuresObserved: failures.length,
    categories: Object.freeze(counts),
    // Numeric exchange status values are not raw provider response bodies.
    bitgetNumericCodes: Object.freeze([...bitgetCodes].sort()),
    symbolsRedacted: true,
  });
}

function statusFor(rows) {
  if (rows.some(row => row.status === 'SEARCH_FAILURE'
    || Number(row.insufficientDataCount ?? 0) > 0
    || Number(row.invalidDataFailureCount ?? 0) > 0
    || Number(row.publicProviderFailureSummary?.categories?.INVALID_DATA ?? 0) > 0
    || Number(row.publicProviderFailureSummary?.categories?.SYMBOL_MAPPING ?? 0) > 0))
    return 'PROVIDER_BLOCKED';
  if (rows.some(row => row.status === 'BLOCKED_DATA')) return 'PARTIAL_OR_UNTRUSTED';
  return 'CURRENT_BATCHES_ONLY';
}
export function inspectExactPublicProviderCycle(snapshot, expectedSha, nowMs = Date.now()) {
  if (!SHA40.test(expectedSha ?? '') || !Number.isFinite(nowMs) || nowMs <= 0)
    throw new Error('PUBLIC_CYCLE_DIAGNOSTIC_INPUT_INVALID');
  if (!snapshot || typeof snapshot !== 'object'
    || snapshot.serviceSha !== expectedSha
    || snapshot.publicDataOnly !== true
    || snapshot.safety?.executionAuthority !== 'NONE'
    || snapshot.profile?.fullStrategyCoverage !== true
    || !Array.isArray(snapshot.coverage) || snapshot.coverage.length !== 12)
    throw new Error('PUBLIC_CYCLE_DIAGNOSTIC_EXACT_CYCLE_REQUIRED');
  const at = Date.parse(snapshot.generatedAt ?? '');
  if (!Number.isFinite(at) || at > nowMs + 5000 || nowMs - at > 10 * 60_000)
    throw new Error('PUBLIC_CYCLE_DIAGNOSTIC_STALE_OR_FUTURE');
  const rows = MARKETS.map(market => {
    const scope = snapshot.coverage.filter(row => row?.market === market);
    if (scope.length !== STRATEGIES.length
      || STRATEGIES.some(strategy => scope.filter(row => row.strategy === strategy).length !== 1)
      || scope.some(row => !STATUSES.has(row.status)))
      throw new Error('PUBLIC_CYCLE_DIAGNOSTIC_LANES_INVALID');
    const universeCounts = [...new Set(scope.map(row => row.totalUniverse).filter(count))];
    const completeCounts = scope.length === universeCounts.length
      || scope.every(row => count(row.totalUniverse) && row.totalUniverse === universeCounts[0]);
    const missingProviderErrorEvidence = scope.some(row =>
      !count(row.providerErrors) || !count(row.timeouts));
    const providerErrorCount = missingProviderErrorEvidence ? null
      : scope.reduce((sum,row) => sum + row.providerErrors, 0);
    const timeoutCount = missingProviderErrorEvidence ? null
      : scope.reduce((sum,row) => sum + row.timeouts, 0);
    return Object.freeze({
      market,
      // Maximum current universe roster sizes are not proof that every
      // listed symbol was evaluated or that historic/delisted names exist.
      universe: completeCounts && universeCounts.length === 1 ? universeCounts[0] : null,
      rosterCountConsistent: completeCounts && universeCounts.length === 1,
      sourceLabels: Object.freeze([...new Set(scope.map(row => row.universeSource)
        .filter(v=>typeof v==='string'&&v.length>0))].sort()),
      status: statusFor(scope),
      lanes: Object.freeze(scope.map(row => Object.freeze({
        strategy:row.strategy,status:row.status,
        cursorBefore:count(row.cursorBefore)?row.cursorBefore:null,
        cursorAfter:count(row.cursorAfter)?row.cursorAfter:null,
        cursorRotatedBlockedOnly:row.cursorRotatedBlockedOnly===true,
        universePartial:row.universePartial===true,
        requestedCount:count(row.requestedCount)?row.requestedCount:null,
        startedCount:count(row.startedCount)?row.startedCount:null,
        completedCount:count(row.completedCount)?row.completedCount:null,
        insufficientDataCount:count(row.insufficientDataCount)?row.insufficientDataCount:null,
        invalidDataFailureCount:count(row.invalidDataFailureCount)?row.invalidDataFailureCount:null,
        publicProviderFailureSummary: row.publicProviderFailureSummary &&
          row.publicProviderFailureSummary.symbolsRedacted === true &&
          typeof row.publicProviderFailureSummary === 'object'
            ? Object.freeze({
                failuresObserved: count(row.publicProviderFailureSummary.failuresObserved)
                  ? row.publicProviderFailureSummary.failuresObserved : null,
                categories: Object.freeze(Object.fromEntries(
                  Object.keys({
                    HTTP_429:0, HTTP_418:0, HTTP_4XX:0, HTTP_5XX:0,
                    BITGET_REST_CODE:0, PROVIDER_ADMISSION:0,
                    PROVIDER_OTHER:0, TIMEOUT:0, INVALID_DATA:0, SYMBOL_MAPPING:0,
                  }).map(key => [key, count(row.publicProviderFailureSummary.categories?.[key])
                    ? row.publicProviderFailureSummary.categories[key] : null]))),
                bitgetNumericCodes: Object.freeze(
                  Array.isArray(row.publicProviderFailureSummary.bitgetNumericCodes)
                    ? row.publicProviderFailureSummary.bitgetNumericCodes
                        .filter(code => typeof code === 'string' && /^[0-9]{4,7}$/u.test(code))
                        .slice(0,8) : []),
                symbolsRedacted: true,
              }) : null,
      }))),
      providerErrorCount, timeoutCount,
      // Original per-symbol provider errors are not available in the
      // cycle summary. Do not invent an empty list or fabricated metrics.
      failures:null, symbolFailureDetailsNotCaptured:true,
    });
  });
  // Contract green is not equivalent to a complete member scanner release.
  const memberUiProfileObserved = snapshot.profile?.surface === 'MEMBER_UI'
    && JSON.stringify(snapshot.profile?.timeframes) === JSON.stringify(['5m','4H','1D']);
  const blockers = [
    ...rows.filter(row => row.status !== 'CURRENT_BATCHES_ONLY')
      .map(row => `MARKET_${row.market}_${row.status}`),
    'WHOLE_UNIVERSE_QUOTE_ROUNDTRIP_NOT_PROVEN',
    'CONTINUOUS_24H_ROTATION_NOT_PROVEN',
    ...(memberUiProfileObserved ? [] : ['MEMBER_UI_5M_4H_1D_PUBLIC_QA_NOT_OBSERVED']),
    'CANONICAL_OOS_FULL_COST_PASS_NOT_PROVEN',
    'PROSPECTIVE_PAPER_FILL_NOT_PROVEN',
    'AUTHENTICATED_MEMBER_ROUTE_AND_WILLIAMS_OVERLAY_NOT_PROVEN',
  ];
  return Object.freeze({
    releaseReadiness: Object.freeze({
      status: 'BLOCKED',
      ready: false,
      memberUiFirstBatchObserved: memberUiProfileObserved,
      memberUiTimeframesObserved: memberUiProfileObserved,
      authenticatedMemberRouteVerified: false,
      profileSurface: snapshot.profile?.surface ?? 'RESEARCH_V3',
      observedTimeframes: Object.freeze([...new Set(snapshot.profile?.timeframes ?? [])]),
      blockers: Object.freeze(blockers),
      fullUniverseRealQuotesVerified: false,
      continuous24hVerified: false,
    }),
    schemaVersion:PUBLIC_PROVIDER_CYCLE_DIAGNOSTIC_VERSION,
    generatedAt:new Date(nowMs).toISOString(),
    observedCycleAt:new Date(at).toISOString(),
    serviceSha:expectedSha,
    provenance:'EXACT_FRESH_PUBLIC_CYCLE_SNAPSHOT',
    publicOnly:true,
    independentNewProviderRequests:0,
    executionAuthority:'NONE',
    fullUniverseQuotesProven:false,
    formulaPassProven:false,
    paperFillProven:false,
    rows:Object.freeze(rows),
  });
}
