import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPublicReadOnlyRuntimeReceipt,auditPublicReadOnly24hReceiptWindow,
} from '../src/public-runtime-receipt-window.mjs';
const SHA='a'.repeat(40);
const START=Date.parse('2026-10-10T00:00:00.000Z');
const MARKETS=['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES'];
const STRATEGIES=['SCALPING','SWING','MID_LONG'];
function snapshot(at){
  return {serviceSha:SHA,publicDataOnly:true,safety:{executionAuthority:'NONE'},
    generatedAt:new Date(at).toISOString(),
    profile:{fullStrategyCoverage:true,surface:'RESEARCH_V3'},
    coverage:MARKETS.flatMap(market=>STRATEGIES.map(strategy=>({
      market,strategy,status:'VALID_NO_TRADE',providerErrors:0,timeouts:0,
      symbol:'SHOULD_NOT_LEAK',
    })))};
}
function receipt(at,override={}){
  return createPublicReadOnlyRuntimeReceipt({
    serviceSha:SHA,startedAtMs:at-3000,finishedAtMs:at,
    producerSucceeded:true,snapshot:snapshot(at),...override,
  });
}
test('sanitized exact-head receipt never exposes a symbol or certifies distribution, orders, or PIT',()=>{
  const r=receipt(START);
  assert.equal(r.status,'SUCCEEDED_BATCHES_ONLY');
  assert.equal(r.observedLanes,12);
  assert.equal(r.wholeMarketCoverageProven,false);
  assert.equal(r.licensedForRedistribution,false);
  assert.equal(r.executionAuthority,'NONE');
  assert.equal(JSON.stringify(r).includes('SHOULD_NOT_LEAK'),false);
});
test('source-blocked cycles remain receipts but cannot be called healthy batches',()=>{
  const s=snapshot(START);
  s.coverage[0].status='BLOCKED_DATA';
  s.coverage[1].status='SEARCH_FAILURE';
  s.coverage[1].providerErrors=2;
  s.coverage[2].timeouts=1;
  const r=receipt(START,{snapshot:s});
  assert.equal(r.status,'SUCCEEDED_WITH_SOURCE_BLOCKERS');
  assert.equal(r.blockedOrFailedLanes,2);
  assert.equal(r.providerErrors,2);
  assert.equal(r.timeouts,1);
  const bad=createPublicReadOnlyRuntimeReceipt({
    serviceSha:SHA,startedAtMs:START-2000,finishedAtMs:START,
    producerSucceeded:false,
  });
  assert.equal(bad.status,'PRODUCER_OR_SNAPSHOT_FAILED');
  assert.equal(bad.observedLanes,0);
});
test('720 synthetic two-minute intervals pass only structure, never genuine external 24h attestation',()=>{
  const observations=Array.from({length:721},(_,i)=>receipt(START+i*120000));
  const proof=auditPublicReadOnly24hReceiptWindow({
    observations,serviceSha:SHA,asOfMs:START+86400000,maxSilenceMs:300000,
  });
  assert.equal(proof.receiptWindowStructurallyContinuous,true);
  assert.equal(proof.observedBatchesWithoutProviderErrors,true);
  assert.equal(proof.real24hInfrastructureAttested,false);
  assert.equal(proof.wholeMarketConstituentCoverageProven,false);
  assert.equal(proof.profitabilityProven,false);
});
test('long gap, missing start and failed producer cannot silently prove 24h',()=>{
  const full=Array.from({length:721},(_,i)=>receipt(START+i*120000));
  const gap=full.filter((_,i)=>i<120||i>140);
  assert.equal(auditPublicReadOnly24hReceiptWindow({
    observations:gap,serviceSha:SHA,asOfMs:START+86400000,maxSilenceMs:300000,
  }).receiptWindowStructurallyContinuous,false);
  assert.equal(auditPublicReadOnly24hReceiptWindow({
    observations:full.slice(100),serviceSha:SHA,asOfMs:START+86400000,maxSilenceMs:300000,
  }).missingWindowStart,true);
  const failed=full.slice();
  failed[100]=receipt(START+100*120000,{producerSucceeded:false,snapshot:null});
  const out=auditPublicReadOnly24hReceiptWindow({
    observations:failed,serviceSha:SHA,asOfMs:START+86400000,maxSilenceMs:300000,
  });
  assert.equal(out.failedProducerCycles,1);
  assert.equal(out.receiptWindowStructurallyContinuous,false);
});
test('ref identity, source authority, bad clock or duplicate receipts are rejected',()=>{
  assert.throws(()=>receipt(START,{serviceSha:'b'.repeat(40)}),/UNTRUSTED|BAD_EXPECTATION/);
  assert.throws(()=>receipt(START,{snapshot:{...snapshot(START),profile:{surface:'MEMBER_UI',fullStrategyCoverage:true}}}),
    /RESEARCH_SURFACE/);
  assert.throws(()=>auditPublicReadOnly24hReceiptWindow({
    observations:[receipt(START),receipt(START)],serviceSha:SHA,asOfMs:START+86400000,
  }),/ORDER_OR_FUTURE/);
  assert.throws(()=>auditPublicReadOnly24hReceiptWindow({
    observations:[{...receipt(START),executionAuthority:'LIVE'}],
    serviceSha:SHA,asOfMs:START+86400000,
  }),/UNTRUSTED/);
});

test('stale or future prior-cycle snapshot cannot be credited as a new successful receipt',()=>{
 assert.throws(()=>receipt(START,{snapshot:snapshot(START-120000)}),
  /PUBLIC_RUNTIME_RECEIPT_OUT_OF_CYCLE_SNAPSHOT/);
 assert.throws(()=>receipt(START,{snapshot:snapshot(START+5000)}),
  /PUBLIC_RUNTIME_RECEIPT_OUT_OF_CYCLE_SNAPSHOT/);
 const failure=receipt(START,{snapshot:null,producerSucceeded:false});
 assert.equal(failure.producerSucceeded,false);
 assert.equal(failure.status,'PRODUCER_OR_SNAPSHOT_FAILED');
});


test('each read-only receipt accounts for all four markets without raw symbols',()=>{
 const r=receipt(START);
 assert.deepEqual(Object.keys(r.marketEvidence),MARKETS);
 assert.equal(r.marketEvidence.KR_STOCK.verifiedBatches,3);
 assert.equal(r.marketEvidence.CRYPTO_FUTURES.failedBatches,0);
 assert.equal(JSON.stringify(r).includes('SHOULD_NOT_LEAK'),false);
 const samples=Array.from({length:721},(_,i)=>receipt(START+i*120000));
 const a=auditPublicReadOnly24hReceiptWindow({
  observations:samples,serviceSha:SHA,asOfMs:START+86400000,
 });
 assert.equal(a.marketEvidence.CRYPTO_SPOT.verifiedBatches,2163);
 assert.equal(a.marketEvidence.US_STOCK.providerErrors,0);
 assert.equal(a.real24hInfrastructureAttested,false);
 const tampered={...r,marketEvidence:{...r.marketEvidence,
  KR_STOCK:{...r.marketEvidence.KR_STOCK,verifiedBatches:9999}}};
 assert.throws(()=>auditPublicReadOnly24hReceiptWindow({
  observations:[tampered],serviceSha:SHA,asOfMs:START+86400000,
 }),/UNTRUSTED/);
 const injected={...r,rawSymbol:'005930'};
 assert.throws(()=>auditPublicReadOnly24hReceiptWindow({
  observations:[injected],serviceSha:SHA,asOfMs:START+86400000,
 }),/UNTRUSTED/);
});
