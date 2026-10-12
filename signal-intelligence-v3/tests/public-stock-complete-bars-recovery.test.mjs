import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverV3CompletedPublicBars} from '../src/public-stock-complete-bars-recovery.mjs';
const M=60_000;
const US=Date.parse('2026-10-09T13:30:00.000Z'); // Friday 09:30 New York EDT
const KR=Date.parse('2026-10-12T00:00:00.000Z'); // Monday 09:00 Seoul
function b(at,close=100){return {time:new Date(at).toISOString(),
  open:close,high:close+1,low:close-1,close,volume:10};}
const repair=(native,lower,extra={})=>recoverV3CompletedPublicBars(native,lower,{
  market:'US_STOCK',timeframe:'15m',nowMs:US+150*M,...extra});
test('complete 5m source fills a missing 15m US bar and never overwrites native',()=>{
  const native=[b(US),b(US+30*M)];
  const lower=[b(US,100),b(US+5*M,100),b(US+10*M,100),
    b(US+15*M,100),b(US+20*M,100),b(US+25*M,100),
    b(US+30*M,100),b(US+35*M,100),b(US+40*M,100)];
  const out=repair(native,lower);
  assert.equal(out.status,'VERIFIED_LOWER_BARS_ADDED');
  assert.equal(out.added,1);
  assert.deepEqual(out.candles.map(x=>Date.parse(x.time)),[US,US+15*M,US+30*M]);
  assert.equal(out.candles[0],native[0],'original Yahoo bar must be preserved');
  assert.equal(out.candles[1].volume,30);
});
test('missing 5m component never creates a fictional 15m bar',()=>{
  const out=repair([b(US)],[b(US+15*M),b(US+25*M)]);
  assert.equal(out.added,0);
  assert.equal(out.status,'NO_COMPLETE_GAPS');
  assert.equal(out.candles.length,1);
});
test('conflicting native/lower Yahoo quote prevents any insertion',()=>{
  const lower=[b(US,110),b(US+5*M,110),b(US+10*M,110),
    b(US+15*M),b(US+20*M),b(US+25*M)];
  const original=[b(US,100)];
  const out=repair(original,lower);
  assert.equal(out.status,'CONFLICTING_PROVIDER_BARS');
  assert.equal(out.added,0);
  assert.equal(out.candles,original);
});
test('no overnight, weekend, premarket, afterhours or incomplete bar synthesis',()=>{
  const prior=US-5*M;
  const later=US+390*M; // Friday regular-session close
  const bars=[b(prior),b(US+385*M),b(later),b(later+5*M),b(later+10*M)];
  assert.equal(repair([],bars,{nowMs:US+24*60*M}).added,0);
  const unfinished=[b(US+15*M),b(US+20*M),b(US+25*M)];
  assert.equal(repair([],unfinished,{nowMs:US+28*M}).added,0);
});
test('US 60m reconstruction anchors at 09:30 local, never 10:00 UTC buckets',()=>{
  const lower=[b(US),b(US+15*M),b(US+30*M),b(US+45*M)];
  const out=repair([],lower,{timeframe:'60m',nowMs:US+120*M});
  assert.equal(out.added,1);
  assert.equal(Date.parse(out.candles[0].time),US);
});
test('KR 15m reconstruction uses Seoul 09:00, does not invent missing 5m',()=>{
  const lower=[b(KR),b(KR+5*M),b(KR+10*M)];
  const out=repair([],lower,{market:'KR_STOCK',nowMs:KR+60*M});
  assert.equal(out.added,1);
  assert.equal(Date.parse(out.candles[0].time),KR);
});
test('corrupt OHLC, duplicates and untrusted configuration fail closed',()=>{
  assert.throws(()=>repair([],[b(US),b(US)]),/SOURCE_INVALID/);
  assert.throws(()=>repair([],[{...b(US),high:5}]),/SOURCE_INVALID/);
  assert.throws(()=>repair([],[b(US)],{timeframe:'4H'}),/CONFIG_INVALID/);
  assert.throws(()=>repair([],[b(US)],{market:'UNKNOWN'}),/CONFIG_INVALID/);
});
