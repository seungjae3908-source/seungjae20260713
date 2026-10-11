import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PUBLIC_PROVIDER_CYCLE_DIAGNOSTIC_VERSION,
  inspectExactPublicProviderCycle,
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
