import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PUBLIC_PROVIDER_CYCLE_DIAGNOSTIC_VERSION,
  inspectExactPublicProviderCycle,
  summarizePublicProviderFailureReasons,
  createV3PublicYahooTerminalFailureCounter,
} from '../src/public-provider-cycle-diagnostics.mjs';
const NOW=Date.parse('2026-10-11T00:00:00.000Z');
const SHA='a'.repeat(40);
const MARKETS=['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES'];
const STRATEGIES=['SCALPING','SWING','MID_LONG'];
function snapshot() {
  return {
    generatedAt:new Date(NOW-1000).toISOString(),
    serviceSha:SHA,publicDataOnly:true,
    safety:{executionAuthority:'NONE'},
    profile:{fullStrategyCoverage:true},
    coverage:MARKETS.flatMap(market=>STRATEGIES.map((strategy,i)=>({
      market,strategy,status:'VALID_NO_TRADE',
      totalUniverse:market==='KR_STOCK'?4010:market==='US_STOCK'?12322:market==='CRYPTO_SPOT'?294:820,
      cursorBefore:0,cursorAfter:i===0?20:20,
      universeSource:market==='KR_STOCK'?'krx-symbol-master':'public',
      universePartial:false,providerErrors:0,timeouts:0,
    }))),
  };
}
test('read-only projection has all four markets without extra provider calls or fake economic proof',()=>{
  const actual=inspectExactPublicProviderCycle(snapshot(),SHA,NOW);
  assert.equal(actual.schemaVersion,PUBLIC_PROVIDER_CYCLE_DIAGNOSTIC_VERSION);
  assert.equal(actual.rows.length,4);
  assert.deepEqual(actual.rows.map(row=>row.universe),[4010,12322,294,820]);
  assert.equal(actual.independentNewProviderRequests,0);
  assert.equal(actual.executionAuthority,'NONE');
  assert.equal(actual.formulaPassProven,false);
  assert.equal(actual.paperFillProven,false);
  assert.equal(actual.fullUniverseQuotesProven,false);
  assert.ok(actual.rows.every(row=>row.failures===null&&row.symbolFailureDetailsNotCaptured));
});
test('429s, timeouts and partial coverage survive projection as blockers, never PASS',()=>{
  const s=snapshot();
  const kr=s.coverage.find(row=>row.market==='KR_STOCK'&&row.strategy==='SCALPING');
  kr.status='BLOCKED_DATA';kr.cursorRotatedBlockedOnly=true;kr.universePartial=true;
  const spot=s.coverage.find(row=>row.market==='CRYPTO_SPOT'&&row.strategy==='SWING');
  spot.status='SEARCH_FAILURE';spot.providerErrors=10;
  const us=s.coverage.find(row=>row.market==='US_STOCK'&&row.strategy==='MID_LONG');
  us.status='SEARCH_FAILURE';us.timeouts=2;
  const d=inspectExactPublicProviderCycle(s,SHA,NOW);
  assert.equal(d.rows.find(x=>x.market==='KR_STOCK').status,'PARTIAL_OR_UNTRUSTED');
  assert.equal(d.rows.find(x=>x.market==='KR_STOCK').lanes[0].cursorRotatedBlockedOnly,true);
  assert.equal(d.rows.find(x=>x.market==='CRYPTO_SPOT').status,'PROVIDER_BLOCKED');
  assert.equal(d.rows.find(x=>x.market==='CRYPTO_SPOT').providerErrorCount,10);
  assert.equal(d.rows.find(x=>x.market==='US_STOCK').timeoutCount,2);
});
test('missing source proof cannot silently become zero provider failures',()=>{
  const s=snapshot();
  s.coverage[0].providerErrors=undefined;
  const d=inspectExactPublicProviderCycle(s,SHA,NOW);
  assert.equal(d.rows[0].providerErrorCount,null);
  assert.equal(d.rows[0].failures,null);
});
test('wrong release, stale/future report or incomplete 12-lane evidence is rejected',()=>{
  const s=snapshot();
  assert.throws(()=>inspectExactPublicProviderCycle(s,'b'.repeat(40),NOW),/EXACT_CYCLE_REQUIRED/);
  assert.throws(()=>inspectExactPublicProviderCycle(s,SHA,NOW+11*60_000),/STALE_OR_FUTURE/);
  assert.throws(()=>inspectExactPublicProviderCycle(s,SHA,NOW-10000),/STALE_OR_FUTURE/);
  assert.throws(()=>inspectExactPublicProviderCycle({...s,coverage:s.coverage.slice(1)},SHA,NOW),/EXACT_CYCLE_REQUIRED/);
  s.coverage[0].strategy='WRONG';
  assert.throws(()=>inspectExactPublicProviderCycle(s,SHA,NOW),/LANES_INVALID/);
});

test('same-cycle reason buckets identify futures HTTP and exchange codes without exposing symbols or raw messages', () => {
  const raw = [
    { symbol: 'BTCUSDT', reason: 'provider_error', message: 'HTTP_429' },
    { symbol: 'ETHUSDT', reason: 'provider_error', message: 'BITGET_40034 sensitive source details' },
    { symbol: 'BTCUSDT', reason: 'provider_error', message: 'HTTP_502 arbitrary host' },
    { symbol: 'SOLUSDT', reason: 'provider_error', message: 'CIRCUIT_OPEN internal metadata' },
    { symbol: 'AVAXUSDT', reason: 'timeout', message: 'connection timeout on hidden host' },
    { symbol: 'DOTUSDT', reason: 'invalid_data', message: 'no primary candles' },
  ];
  const result = summarizePublicProviderFailureReasons(raw);
  assert.equal(result.failuresObserved, 6);
  assert.equal(result.categories.HTTP_429, 1);
  assert.equal(result.categories.BITGET_REST_CODE, 1);
  assert.equal(result.categories.HTTP_5XX, 1);
  assert.equal(result.categories.PROVIDER_ADMISSION, 1);
  assert.equal(result.categories.TIMEOUT, 1);
  assert.equal(result.categories.INVALID_DATA, 1);
  assert.deepEqual(result.bitgetNumericCodes, ['40034']);
  assert.equal(JSON.stringify(result).includes('BTCUSDT'), false);
  assert.equal(JSON.stringify(result).includes('sensitive source details'), false);
  assert.equal(result.symbolsRedacted,true);
});

test('provider failures missing or overflowing cannot be misreported as an empty-success reason list', () => {
  assert.equal(summarizePublicProviderFailureReasons(undefined), null);
  assert.equal(summarizePublicProviderFailureReasons(Array.from({length:81},()=>({reason:'provider_error',message:'HTTP_429'}))), null);
  const rows = [{reason:'provider_error', message:'BITGET_bad_secret_001'}];
  const diagnostic = summarizePublicProviderFailureReasons(rows);
  assert.equal(diagnostic.categories.PROVIDER_OTHER, 1);
  assert.deepEqual(diagnostic.bitgetNumericCodes, []);
  const shot = snapshot();
  const last = shot.coverage.find(x => x.market==='CRYPTO_FUTURES' && x.strategy==='MID_LONG');
  last.status = 'SEARCH_FAILURE';
  last.providerErrors = 6;
  last.publicProviderFailureSummary = summarizePublicProviderFailureReasons([
    {reason:'provider_error',message:'HTTP_429'},
    {reason:'provider_error',message:'BITGET_40034'},
  ]);
  const result = inspectExactPublicProviderCycle(shot,SHA,NOW);
  const lane = result.rows.find(x=>x.market==='CRYPTO_FUTURES').lanes.find(x=>x.strategy==='MID_LONG');
  assert.equal(lane.publicProviderFailureSummary.categories.HTTP_429, 1);
  assert.deepEqual(lane.publicProviderFailureSummary.bitgetNumericCodes, ['40034']);
  assert.equal(lane.publicProviderFailureSummary.failuresObserved, 2);
  assert.equal(result.rows.find(x=>x.market==='CRYPTO_FUTURES').providerErrorCount, 6);
});

test('V3 Yahoo terminal exceptions classify exact public fetch failure without symbol or raw API leakage',()=>{
  const collector=createV3PublicYahooTerminalFailureCounter();
  const samples=[
    [new Error('YAHOO_HEDGED_PAIR_FAILED:YAHOO_CHART_HTTP_429|YAHOO_CHART_HTTP_429:private-symbol'),'HTTP_429'],
    [new Error('YAHOO_HEDGED_PAIR_FAILED:YAHOO_CHART_HTTP_404|YAHOO_CHART_HTTP_404:SENSITIVE'),'HTTP_4XX'],
    [new Error('YAHOO_CHART_HTTP_503 provider.example HIDDEN'),'HTTP_5XX'],
    [new Error('YAHOO_CHART_BUDGET_EXCEEDED token=DO_NOT_EXPOSE'),'TIMEOUT'],
    [new Error('PUBLIC_STOCK_EMPTY_CANDLES:BTC_SECRET'),'EMPTY_SOURCE'],
    [new Error('PUBLIC_STOCK_INVALID_PROVIDER_RESPONSE:PRIVATE_BODY'),'INVALID_RESPONSE'],
    [new Error('YAHOO_UNSUPPORTED_TIMEFRAME:PRIVATE_FRAME'),'UNSUPPORTED_TIMEFRAME'],
    [new Error('unclassified failure with private user ID'),'PROVIDER_OTHER'],
  ];
  for(const [error] of samples)collector.observe(error);
  const result=collector.snapshot();
  assert.equal(result.terminalFailedFetches,8);
  for(const [,key] of samples)assert.equal(result.categories[key],1,key);
  assert.equal(result.symbolsRedacted,true);
  assert.equal(result.addedProviderRequests,0);
  assert.equal(result.economicAuthority,'NONE');
  for(const forbidden of ['SENSITIVE','PRIVATE','DO_NOT_EXPOSE','provider.example',
    'private-symbol','BTC_SECRET'])
    assert.equal(JSON.stringify(result).includes(forbidden),false,forbidden);
});
test('the public-only provider diagnostic surfaces Yahoo category counts but never raw exception text',()=>{
  const report=createV3PublicYahooTerminalFailureCounter();
  report.observe(new Error('YAHOO_CHART_HTTP_503:_PRIVATE_USER_SYMBOL'));
  const current=snapshot();
  current.coverage[0].status='SEARCH_FAILURE';
  current.coverage[0].providerErrors=1;
  current.coverage[0].publicStockTerminalFailureSummary=report.snapshot();
  const out=inspectExactPublicProviderCycle(current,SHA,NOW);
  const bucket=out.rows.find(x=>x.market==='KR_STOCK').lanes[0].publicStockTerminalFailureSummary;
  assert.equal(bucket.categories.HTTP_5XX,1);
  assert.equal(bucket.terminalFailedFetches,1);
  assert.equal(JSON.stringify(bucket).includes('PRIVATE_USER_SYMBOL'),false);
  assert.equal(out.rows[0].status,'PROVIDER_BLOCKED');
  const missing=snapshot();
  assert.equal(inspectExactPublicProviderCycle(missing,SHA,NOW)
    .rows[0].lanes[0].publicStockTerminalFailureSummary,null);
});

test('only allowlisted structural reason counts survive the public reporter',()=>{
 const q=createV3PublicYahooTerminalFailureCounter();
 q.observeStructural('OHLC_INCONSISTENT');
 q.observeStructural('TIMESTAMP_DUPLICATE');
 q.observeStructural('SENSITIVE_PRIVATE_TICKER_005930');
 const state=q.snapshot();
 assert.equal(state.structuralCandleRejections.total,3);
 assert.equal(state.structuralCandleRejections.reasons.OHLC_INCONSISTENT,1);
 assert.equal(state.structuralCandleRejections.reasons.TIMESTAMP_DUPLICATE,1);
 assert.equal(state.structuralCandleRejections.reasons.NOT_ARRAY,1,
   'unknown code falls to a known sanitized class');
 assert.equal(JSON.stringify(state).includes('SENSITIVE_PRIVATE_TICKER'),false);
 assert.equal(state.addedProviderRequests,0);
});
test('structural problems remain observable on exactly the failed public current page',()=>{
 const report=createV3PublicYahooTerminalFailureCounter();
 report.observeStructural('PRICE_INVALID');
 report.observe(new Error('PUBLIC_STOCK_INVALID_PROVIDER_RESPONSE hidden-private-symbol'));
 const current=snapshot();
 current.coverage[0].status='SEARCH_FAILURE';
 current.coverage[0].providerErrors=1;
 current.coverage[0].publicStockTerminalFailureSummary=report.snapshot();
 const proj=inspectExactPublicProviderCycle(current,SHA,NOW);
 const detail=proj.rows[0].lanes[0].publicStockTerminalFailureSummary;
 assert.equal(detail.terminalFailedFetches,1);
 assert.equal(detail.structuralCandleRejections.total,1);
 assert.equal(detail.structuralCandleRejections.reasons.PRICE_INVALID,1);
 assert.equal(detail.structuralCandleRejections.reasons.VOLUME_INVALID,0);
 assert.equal(JSON.stringify(detail).includes('hidden-private-symbol'),false);
 assert.equal(proj.rows[0].status,'PROVIDER_BLOCKED');
});
