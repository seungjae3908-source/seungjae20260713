import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectPublicStockCandles,choosePublicStockCandles,choosePublicStockQuote}
  from '../src/public-stock-source-selection.mjs';
const NOW=Date.parse('2026-10-11T08:00:00Z');
const bar=(time='2026-10-09T14:30:00.000Z')=>({
  time,open:100,high:102,low:99,close:101,volume:1000,
});
test('empty / invalid KR Yahoo source moves to the alternate public .KQ, preserves authentic OHLC',async()=>{
 const seen=[],observed=[];
 const result=await choosePublicStockCandles({
  symbols:['005930.KS','005930.KQ'],timeframe:'1D',now:NOW,preferAtLeast:1,
  load:async symbol=>{
    seen.push(symbol);
    return symbol.endsWith('.KS')?[{...bar(),high:90}]:[bar()];
  },
  onSource:r=>observed.push(r.length),
 });
 assert.deepEqual(seen,['005930.KS','005930.KQ']);
 assert.equal(result.length,1);
 assert.deepEqual([result[0].high,result[0].low],[102,99]);
 assert.deepEqual(observed,[1,1]);
});
test('first empty chart cannot terminate public fallback prematurely',async()=>{
 let calls=0;
 const candles=await choosePublicStockCandles({
  symbols:['019900.KS','019900.KQ'],timeframe:'5m',now:NOW,preferAtLeast:1,
  load:async()=>{calls++;return calls===1?[]:[bar('2026-10-09T14:30:00.000Z')]},
 });
 assert.equal(calls,2);
 assert.equal(candles.length,1);
});
test('HTTP 429 and 418 are fail-closed and never retried or sent to alternate symbol',async()=>{
 for(const status of [429,418]){
  let calls=0,errors=0;
  await assert.rejects(choosePublicStockCandles({
   symbols:['005930.KS','005930.KQ'],timeframe:'1D',now:NOW,
   load:async()=>{calls++;throw Error('YAHOO_CHART_HTTP_'+status)},
   onError:()=>{errors++},
  }),/PUBLIC_STOCK_RATE_LIMIT_FAIL_CLOSED/);
  assert.equal(calls,1);
  assert.equal(errors,1);
 }
});
test('invalid Yahoo OHLC and conflicting duplicate series produce no synthetic price',()=>{
 const corrupted=inspectPublicStockCandles([bar(),{...bar(),close:101.5}], '15m',NOW);
 assert.equal(corrupted.rejected,true);
 assert.equal(corrupted.conflictingDuplicateBars,1);
 assert.equal(corrupted.candles.length,0);
 const invalid=inspectPublicStockCandles([{...bar(),open:0}],'15m',NOW);
 assert.equal(invalid.malformedBars,1);
 assert.equal(invalid.candles.length,0);
 const identical=inspectPublicStockCandles([bar(),{...bar()}],'15m',NOW);
 assert.equal(identical.identicalDuplicateBars,1);
 assert.equal(identical.candles.length,1);
});
test('unclosed US 15m candle excluded, no synthetic last interval',()=>{
 const source=[
  bar('2026-10-11T07:30:00.000Z'),
  bar('2026-10-11T07:50:00.000Z'),
 ];
 const r=inspectPublicStockCandles(source,'15m',NOW);
 assert.equal(r.rejected,false);
 assert.equal(r.incompleteBarsExcluded,1);
 assert.equal(r.candles.length,1);
 assert.equal(r.candles[0].close,101);
 assert.equal(r.executionAuthority,'NONE');
});
test('short source can select longer alternate evidence but never claim full-roster coverage',async()=>{
 let calls=0;
 const series=await choosePublicStockCandles({
  symbols:['ABC.KS','ABC.KQ'],timeframe:'1D',now:NOW,preferAtLeast:20,
  load:async()=>{calls++;return Array.from({length:calls===1?3:21},(_,i)=>
    bar(new Date(NOW-(i+3)*86400000).toISOString()))},
 });
 assert.equal(calls,2);
 assert.equal(series.length,21);
});
test('quote source selection validates finite positive prices, blocks 429 without repeated requests',async()=>{
 let calls=0;
 const q=await choosePublicStockQuote({
  symbols:['005930.KS','005930.KQ'],now:NOW,
  load:async()=>{calls++;return calls===1?{price:0}:{
    price:100,updatedAt:'2026-10-10T00:00:00.000Z',volume:50}},
 });
 assert.equal(q.price,100);
 assert.equal(calls,2);
 let rejectedCalls=0;
 await assert.rejects(choosePublicStockQuote({
  symbols:['A','B'],now:NOW,
  load:async()=>{rejectedCalls++;throw Error('YAHOO_CHART_HTTP_429')},
 }),/RATE_LIMIT_FAIL_CLOSED/);
 assert.equal(rejectedCalls,1);
});
test('unusable source chart does not create a candidate and quote invalidity is explicit',async()=>{
 const rows=await choosePublicStockCandles({
  symbols:['A','B'],timeframe:'15m',now:NOW,
  load:async()=>[{...bar(),high:90}],
 });
 assert.deepEqual(rows,[]);
 await assert.rejects(choosePublicStockQuote({
  symbols:['A'],now:NOW,
  load:async()=>({price:Number.NaN,updatedAt:'unknown'}),
 }),/QUOTE_UNTRUSTED/);
});
