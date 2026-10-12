import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindPublicStockCandleSource,
  enforcePublicStockRosterCoverage,
  createPublicStockQualityCounter,
  withPublicStockProviderFallback,
} from '../src/public-stock-candle-binding.mjs';
import { classifyPublicCycleLaneStatus } from '../src/public-cycle-coverage.mjs';

const at=Date.parse('2026-10-11T05:00:00.000Z');
test('Signal V3 public binding covers the actual stock-scanner metadata path',async()=>{
  const oldCandles=async()=>{throw Error('UNEXPECTED_APP_FALLBACK_CANDLES');};
  const oldMeta=async()=>{throw Error('UNEXPECTED_APP_FALLBACK_META');};
  const service={getCandles:oldCandles,getCandlesMeta:oldMeta};
  const requests=[];
  const publicFetch=async (ticker,frame)=>{
    requests.push([ticker,frame]);
    return [{time:new Date(at-60_000).toISOString(),open:9,high:11,low:8,close:10,volume:100}];
  };
  const restore=bindPublicStockCandleSource(service,publicFetch,{now:()=>at});
  const meta=await service.getCandlesMeta('005930','15m');
  assert.equal(meta.provider,'yahoo-public');
  assert.equal(meta.fetchedAt,new Date(at).toISOString());
  assert.equal(meta.candles[0].close,10);
  assert.equal((await service.getCandles('AAPL','60m'))[0].close,10);
  assert.deepEqual(requests,[['005930','15m'],['AAPL','60m']]);
  restore();restore();
  assert.equal(service.getCandles,oldCandles);
  assert.equal(service.getCandlesMeta,oldMeta);
});

test('public source failure or empty bars never fall back into app metadata',async()=>{
  let unsafeCalls=0;
  const oldCandles=async()=>{unsafeCalls++;return [];};
  const oldMeta=async()=>{unsafeCalls++;return {candles:[]};};
  const service={getCandles:oldCandles,getCandlesMeta:oldMeta};
  const restore=bindPublicStockCandleSource(service,async ticker=>{
    if(ticker==='FAIL')throw Error('PUBLIC_SOURCE_UNAVAILABLE');
    return [];
  },{now:()=>at});
  assert.deepEqual((await service.getCandlesMeta('EMPTY','15m')).candles,[]);
  await assert.rejects(service.getCandlesMeta('FAIL','15m'),/PUBLIC_SOURCE_UNAVAILABLE/);
  assert.equal(unsafeCalls,0);
  restore();
  assert.equal(service.getCandles,oldCandles);
  assert.equal(service.getCandlesMeta,oldMeta);
});

test('binding rejects malformed providers without leaving a partial override',()=>{
  const getCandles=async()=>[],service={getCandles,getCandlesMeta:async()=>({candles:[]})};
  assert.throws(()=>bindPublicStockCandleSource(service,null),/PUBLIC_STOCK_BINDING_INVALID/);
  assert.equal(service.getCandles,getCandles);
});

test('known KRX public-roster exclusions cannot silently become complete coverage',()=>{
  const response={
    universe:{source:'krx-symbol-master',totalCount:4010,cursor:0,
      nextCursor:20,partial:false,stale:false,providerErrorCount:0},
    execution:{requestedCount:20,startedCount:20,completedCount:20,
      providerErrorCount:0,timeoutCount:0,partial:false,
      timedOut:false,cancelled:false,duplicate:false},
    cards:[],failures:[],dataState:'complete',outcome:'VALID_ZERO_SIGNAL',
  };
  assert.equal(classifyPublicCycleLaneStatus(response),'VALID_NO_TRADE');
  const incomplete=enforcePublicStockRosterCoverage(response,{
    totalCount:4010,rawTotalCount:6847,explainedExcludedCount:2837,
  });
  assert.equal(incomplete.universe.partial,true);
  assert.equal(incomplete.execution.partial,true);
  assert.equal(incomplete.dataState,'partial');
  assert.equal(incomplete.publicRosterCoverage.fullRosterProven,false);
  assert.equal(incomplete.publicRosterCoverage.explainedExcludedCount,2837);
  assert.equal(classifyPublicCycleLaneStatus(incomplete),'BLOCKED_DATA');
  assert.equal(response.universe.partial,false);
  const complete=enforcePublicStockRosterCoverage(response,{
    totalCount:4010,rawTotalCount:4010,explainedExcludedCount:0,
  });
  assert.equal(complete,response);
  assert.throws(()=>enforcePublicStockRosterCoverage(response,{
    totalCount:4010,rawTotalCount:3999,explainedExcludedCount:1,
  }),/EVIDENCE_INCONSISTENT/);
});

test('same-cycle quality diagnostics keep only safe cause counts',()=>{
  const quality=createPublicStockQualityCounter();
  quality.observe({state:'DATA_UNTRUSTED',
    symbol:'CONFIDENTIAL_INSTRUMENT',candles:[{secret:'NEVER_LOG_THIS_CANDLE'}],
    issues:[{code:'STALE_TIMESTAMP',severity:'blocking',message:'RAW_PROVIDER_DETAILS'},
      {code:'MISSING_CANDLE',severity:'warning',message:'PRIVATE_SOURCE_DETAILS'},
      {code:'NOT_RECOGNIZED',severity:'blocking',message:'PRIVATE_UNKNOWN'}]});
  quality.observe({state:'DEGRADED',issues:[
    {code:'STALE_TIMESTAMP',severity:'warning',message:'PRIVATE_DEBUG'}]});
  quality.observe({state:'TRUSTED',issues:[]});
  quality.observeError();
  const snapshot=quality.snapshot();
  assert.deepEqual(snapshot.stateCounts,
    {TRUSTED:1,DEGRADED:1,DATA_UNTRUSTED:1});
  assert.equal(snapshot.inspectedCount,3);
  assert.equal(snapshot.evaluationErrorCount,1);
  assert.equal(snapshot.issueCounts['STALE_TIMESTAMP:blocking'],1);
  assert.equal(snapshot.issueCounts['STALE_TIMESTAMP:warning'],1);
  assert.equal(snapshot.issueCounts['MISSING_CANDLE:warning'],1);
  assert.equal(snapshot.providerRequestsAdded,0);
  assert.equal(snapshot.economicAuthority,'NONE');
  for(const value of ['CONFIDENTIAL_INSTRUMENT','NEVER_LOG_THIS_CANDLE',
    'RAW_PROVIDER_DETAILS','PRIVATE_DEBUG','PRIVATE_SOURCE_DETAILS']) {
    assert.equal(JSON.stringify(snapshot).includes(value),false);
  }
});

test('empty Yahoo candle page probes one alternate venue and never counts as completed source',async()=>{
  const calls=[];
  const v=await withPublicStockProviderFallback(['001234.KS','001234.KQ'],async name=>{
    calls.push(name);
    return name.endsWith('.KS')?[]:[
      {time:'2026-10-09T00:00:00Z',open:5,high:6,low:4,close:5,volume:10},
    ];
  },{pause:async()=>{throw Error('EMPTY_PAGE_SHOULD_NOT_RETRY');}});
  assert.equal(v.length,1);
  assert.deepEqual(calls,['001234.KS','001234.KQ']);
  assert.equal(v[0].close,5);
  assert.equal((await withPublicStockProviderFallback(['AAPL'],async()=>({price:100}))).price,100);
});
test('all-empty or failed public stock providers never silently become valid bars',async()=>{
  const names=[];
  await assert.rejects(withPublicStockProviderFallback(['AAPL','AAPL.X'],
    async name=>{names.push(name);return [];},{pause:async()=>{throw Error('UNEXPECTED_RETRY');}}),
    /PUBLIC_STOCK_EMPTY_CANDLES/);
  assert.deepEqual(names,['AAPL','AAPL.X']);
  await assert.rejects(withPublicStockProviderFallback([],async()=>[]),
    /PUBLIC_STOCK_FALLBACK_INVALID/);
  await assert.rejects(withPublicStockProviderFallback(['AAPL'],async()=>{
    throw Error('PUBLIC_QUOTE_REJECTED');},{retryCount:1}),/PUBLIC_QUOTE_REJECTED/);
});

test('malformed public Yahoo candle source is not accepted before trying one authorized alternative',async()=>{
  const complete=[{time:'2026-10-12T00:00:00Z',open:1,high:2,low:1,close:2,volume:4}];
  for(const bad of [null,undefined,{rows:[]}]) {
    const observed=[];
    const rows=await withPublicStockProviderFallback(['AAPL','AAPL.X'],async ticker=>{
      observed.push(ticker);return ticker==='AAPL'?bad:complete;
    },{validValue:Array.isArray,pause:async()=>{throw Error('NO_USELESS_RETRY');}});
    assert.deepEqual(rows,complete);
    assert.deepEqual(observed,['AAPL','AAPL.X']);
  }
  await assert.rejects(withPublicStockProviderFallback(['AAPL'],async()=>({rows:[]}),{
    retryCount:1,validValue:Array.isArray,
  }),/PUBLIC_STOCK_INVALID_PROVIDER_RESPONSE/);
  assert.deepEqual(await withPublicStockProviderFallback(['AAPL'],async()=>({price:99})),
    {price:99},'quote objects must remain acceptable');
});

test('deterministic paired Yahoo 404 skips repeated same-alias calls but allows the approved alternate',async()=>{
  const requested=[];
  const value=await withPublicStockProviderFallback(['001234.KS','001234.KQ'],async candidate=>{
    requested.push(candidate);
    if(candidate.endsWith('.KS'))
      throw Error('YAHOO_HEDGED_PAIR_FAILED:YAHOO_CHART_HTTP_404|YAHOO_CHART_HTTP_404');
    return [{time:'2026-10-10T00:00:00Z',open:3,high:4,low:2,close:3,volume:1}];
  },{pause:async()=>{throw Error('404_MUST_NOT_RETRY');}});
  assert.equal(value.length,1);
  assert.deepEqual(requested,['001234.KS','001234.KQ']);
});
test('Yahoo rate-limit response stops the entire retry burst, including alternate symbols',async()=>{
  const requested=[];
  await assert.rejects(withPublicStockProviderFallback(['AAPL','AAPL.X'],async symbol=>{
    requested.push(symbol);
    throw Error('YAHOO_HEDGED_PAIR_FAILED:YAHOO_CHART_HTTP_429|YAHOO_CHART_HTTP_429');
  },{pause:async()=>{throw Error('SHOULD_NOT_RETRY');}}),/PUBLIC_STOCK_RATE_LIMITED/);
  assert.deepEqual(requested,['AAPL']);
});
test('mixed 404 and network timeout is not misclassified as certain permanent rejection',async()=>{
  let attempts=0;
  const value=await withPublicStockProviderFallback(['AAPL'],async()=>{
    attempts+=1;
    if(attempts===1)
      throw Error('YAHOO_HEDGED_PAIR_FAILED:YAHOO_CHART_HTTP_404|YAHOO_CHART_BUDGET_EXCEEDED');
    return {price:100};
  },{pause:async()=>{}});
  assert.equal(attempts,2);
  assert.equal(value.price,100);
});
