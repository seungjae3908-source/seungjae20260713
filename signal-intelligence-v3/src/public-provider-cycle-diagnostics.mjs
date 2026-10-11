// Diagnostics only. Reuse the exact real public Scanner cycle; do not
// issue a second round of costly Upbit/Bitget/Yahoo requests just to
// inspect provider errors after the first cycle has finished.
export const PUBLIC_PROVIDER_CYCLE_DIAGNOSTIC_VERSION = 'public-provider-cycle-diagnostic-v2';
const SHA40 = /^[a-f0-9]{40}$/u;
const MARKETS = Object.freeze(['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES']);
const STRATEGIES = Object.freeze(['SCALPING','SWING','MID_LONG']);
const STATUSES = new Set(['CANDIDATES_AVAILABLE','VALID_NO_TRADE','SEARCH_FAILURE','BLOCKED_DATA']);
const count = v => Number.isSafeInteger(v) && v >= 0;
function statusFor(rows) {
  if (rows.some(row => row.status === 'SEARCH_FAILURE')) return 'PROVIDER_BLOCKED';
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
      }))),
      providerErrorCount, timeoutCount,
      // Original per-symbol provider errors are not available in the
      // cycle summary. Do not invent an empty list or fabricated metrics.
      failures:null, symbolFailureDetailsNotCaptured:true,
    });
  });
  return Object.freeze({
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
