import test from 'node:test';
import assert from 'node:assert/strict';
import {validV3PublicYahooCandlePage} from '../src/public-v3-stock-candle-integrity.mjs';
const NOW=Date.parse('2026-10-12T14:00:00.000Z');
const candle=(time,rest={})=>({time,open:100,high:110,low:90,close:105,volume:20,...rest});
const A=candle('2026-10-09T13:30:00.000Z');
const B=candle('2026-10-12T13:30:00.000Z');
test('strict V3 Yahoo page permits legitimate market closures and sparse intervals without synthesis',()=>{
  assert.equal(validV3PublicYahooCandlePage([A,B],{nowMs:NOW}),true,
    'Friday to Monday stock session gap is allowed, not invented as candles');
  assert.equal(validV3PublicYahooCandlePage([A,candle('2026-10-09T13:45:00.000Z')],{
    nowMs:NOW,
  }),true);
  // A real missing interval must remain absent. No interpolation or quality waiver.
  assert.equal(validV3PublicYahooCandlePage([A,candle('2026-10-09T15:30:00.000Z')],{
    nowMs:NOW,
  }),true);
});
test('V3 Yahoo price, volume and chronological source identity must be valid before accepting a fallback',()=>{
  for(const rows of [
    [],null,{candles:[A]},[A,A],[B,A],
    [candle(A.time,{open:0})],[candle(A.time,{high:99})],
    [candle(A.time,{low:106})],[candle(A.time,{volume:-1})],
    [candle(A.time,{close:NaN})],[candle(A.time,{volume:Infinity})],
    [candle('2026-10-09T13:30:00')],[candle('BAD-DATE')],
    [candle('2026-10-12T16:30:00.000Z')],
  ])assert.equal(validV3PublicYahooCandlePage(rows,{nowMs:NOW}),false,
    JSON.stringify(rows));
});
test('V3 Yahoo safety rejects invalid clocks and oversized source without changing values',()=>{
  assert.equal(validV3PublicYahooCandlePage([A],{nowMs:0}),false);
  assert.equal(validV3PublicYahooCandlePage([A],{nowMs:NaN}),false);
  const oversized=Array.from({length:16001},()=>A);
  assert.equal(validV3PublicYahooCandlePage(oversized,{nowMs:NOW}),false);
  assert.equal(A.close,105);
});
