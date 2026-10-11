/** Isolated public-only Signal V3 source binding.
 * The real Stock Scanner reads getCandlesMeta through its provider health
 * wrapper. Replacing getCandles alone silently misses that call path.
 * This helper never issues requests itself and always restores both methods.
 */
export function bindPublicStockCandleSource(service, fetchCandles, { now = Date.now } = {}) {
  if (!service || typeof service.getCandles !== 'function'
    || typeof service.getCandlesMeta !== 'function'
    || typeof fetchCandles !== 'function' || typeof now !== 'function') {
    throw new TypeError('PUBLIC_STOCK_BINDING_INVALID');
  }
  const previousCandles = service.getCandles;
  const previousMeta = service.getCandlesMeta;
  const candles = async (ticker, timeframe = '1D') => {
    const result = await fetchCandles(ticker, timeframe);
    // Do not convert empty or failed public data into apparently valid bars;
    // the existing health and quality gates must inspect the actual result.
    if (!Array.isArray(result)) throw new TypeError('PUBLIC_STOCK_CANDLES_INVALID');
    return result;
  };
  service.getCandles = candles;
  service.getCandlesMeta = async (ticker, timeframe = '1D') => ({
    candles: await candles(ticker, timeframe),
    provider: 'yahoo-public',
    fetchedAt: new Date(now()).toISOString(),
  });
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    service.getCandles = previousCandles;
    service.getCandlesMeta = previousMeta;
  };
}

/** A curated eligible public-only roster may exclude verified listed codes.
 * Search of the eligible page cannot certify the EXCLUDED roster as scanned.
 * Keep the existing zero-authority V3 batch research cycle rotating, but
 * explicitly mark the entire market lane as incomplete until coverage exists.
 */
export function enforcePublicStockRosterCoverage(response, roster) {
  const raw=roster?.rawTotalCount;
  const eligible=roster?.totalCount;
  const excluded=roster?.explainedExcludedCount;
  const knownExcluded=Number.isSafeInteger(excluded)&&excluded>0;
  const knownGap=Number.isSafeInteger(raw)
    && Number.isSafeInteger(eligible)&&raw>eligible;
  if(!knownExcluded&&!knownGap)return response;
  if(!response||typeof response!=='object'||!response.universe
    ||!response.execution||!Number.isSafeInteger(eligible)||eligible<1
    ||!Number.isSafeInteger(raw)||raw<eligible
    ||!Number.isSafeInteger(excluded)||excluded<0) {
    throw new Error('PUBLIC_STOCK_ROSTER_EVIDENCE_INCONSISTENT');
  }
  return {
    ...response,
    universe:{...response.universe,partial:true},
    execution:{...response.execution,partial:true},
    dataState:response.dataState==='complete'?'partial':response.dataState,
    publicRosterCoverage:Object.freeze({
      eligibleTotalCount:eligible,
      rawTotalCount:raw,
      explainedExcludedCount:excluded,
      fullRosterProven:false,
    }),
  };
}

const PUBLIC_STOCK_QUALITY_CODES = new Set([
  'STALE_TIMESTAMP','MISSING_CANDLE','DUPLICATE_CANDLE',
  'INVALID_OHLC','INVALID_VOLUME','ABNORMAL_SPIKE',
  'SYMBOL_MISMATCH','PROVIDER_DISAGREEMENT','MARKET_CLOSED','TRADING_HALT',
]);
const PUBLIC_STOCK_QUALITY_STATES = new Set([
  'TRUSTED','DEGRADED','DATA_UNTRUSTED',
]);

/** Report only bounded issue-code counts from candles already fetched
 * during one existing V3 scan. Never retain symbols or OHLCV payloads.
 */
export function createPublicStockQualityCounter() {
  const stateCounts = {TRUSTED:0,DEGRADED:0,DATA_UNTRUSTED:0};
  const issueCounts = Object.create(null);
  let evaluationErrorCount=0;
  return Object.freeze({
    observe(result) {
      if(!result||!PUBLIC_STOCK_QUALITY_STATES.has(result.state)
        ||!Array.isArray(result.issues)){
        evaluationErrorCount+=1;return;
      }
      stateCounts[result.state]+=1;
      for(const issue of result.issues){
        if(!PUBLIC_STOCK_QUALITY_CODES.has(issue?.code)
          ||!['blocking','warning'].includes(issue?.severity))continue;
        const key=issue.code+':'+issue.severity;
        issueCounts[key]=(issueCounts[key]??0)+1;
      }
    },
    observeError(){evaluationErrorCount+=1;},
    snapshot() {
      return Object.freeze({
        inspectedCount:Object.values(stateCounts).reduce((a,b)=>a+b,0),
        evaluationErrorCount,
        stateCounts:Object.freeze({...stateCounts}),
        issueCounts:Object.freeze(Object.fromEntries(
          Object.entries(issueCounts).sort(([a],[b])=>a.localeCompare(b))
        )),
        providerRequestsAdded:0,
        symbolOrCandleSamplesCaptured:false,
        economicAuthority:'NONE',
      });
    },
  });
}
