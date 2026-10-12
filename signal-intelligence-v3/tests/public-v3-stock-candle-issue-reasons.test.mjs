import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectV3PublicYahooCandlePage,V3_PUBLIC_YAHOO_SOURCE_REASONS,
  validV3PublicYahooCandlePage} from '../src/public-v3-stock-candle-integrity.mjs';
const NOW=Date.parse('2026-10-12T14:00:00Z');
const bar=(time,patch={})=>({time,open:100,high:110,low:90,
  close:105,volume:12,...patch});
const START='2026-10-09T13:30:00.000Z',NEXT='2026-10-09T13:45:00.000Z';
test('structural issue reason is bounded and does not expose provider raw source',()=>{
 const cases=[
   [null,'NOT_ARRAY'],[[],'EMPTY_PAGE'],
   [[bar(START),bar(START)],'TIMESTAMP_DUPLICATE'],
   [[bar(NEXT),bar(START)],'TIMESTAMP_REVERSED'],
   [[bar('not-a-date')],'TIMESTAMP_FORMAT'],
   [[{time:START}],'PRICE_INVALID'],
   [[bar(START,{high:100})],'OHLC_INCONSISTENT'],
   [[bar(START,{volume:-1})],'VOLUME_INVALID'],
   [[bar(START,{close:NaN})],'PRICE_INVALID'],
   [[bar('2026-10-12T17:30:00.000Z')],'FUTURE_TIMESTAMP'],
 ];
 for(const [rows,reason] of cases){
   const d=inspectV3PublicYahooCandlePage(rows,{nowMs:NOW});
   assert.deepEqual(d,{valid:false,reason});
   assert.ok(V3_PUBLIC_YAHOO_SOURCE_REASONS.includes(reason));
   assert.equal(validV3PublicYahooCandlePage(rows,{nowMs:NOW}),false);
   assert.equal(JSON.stringify(d).includes(START),false);
 }
});
test('valid same-provider chronological candles preserve exact OHLC and no-trade gaps',()=>{
 const rows=[bar(START),bar(NEXT)];
 const d=inspectV3PublicYahooCandlePage(rows,{nowMs:NOW});
 assert.deepEqual(d,{valid:true,reason:'READY'});
 assert.equal(validV3PublicYahooCandlePage(rows,{nowMs:NOW}),true);
 assert.equal(rows.length,2);
 assert.equal(rows[0].high,110);
});
