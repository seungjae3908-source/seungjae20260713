import test from 'node:test';
import assert from 'node:assert/strict';
import {
 installV3WithinPageWatchPriority,prioritizeV3CurrentCryptoPage,
 selectV3OutOfCursorResearch,
} from '../src/public-watch-v3-priority.mjs';
import {
 runV3OutOfCursorResearch,V3_OFFPAGE_RESEARCH_MAX,
} from '../src/public-watch-v3-offpage-research.mjs';
const OBS=Date.parse('2026-10-12T00:10:00.000Z');
const watch={
 status:'PARTIAL_SOURCE',
 priorities:[
  {market:'CRYPTO_SPOT',symbol:'BTC',direction:'UP',score:2,
    watchEventId:'a'.repeat(64),sourceAtMs:OBS-60_000,status:'RESEARCH_OBSERVATION_ONLY',
    executionAuthority:'NONE'},
  {market:'CRYPTO_SPOT',symbol:'ETH',direction:'UP',score:1,
    watchEventId:'b'.repeat(64),sourceAtMs:OBS-60_000,status:'RESEARCH_OBSERVATION_ONLY',
    executionAuthority:'NONE'},
  {market:'CRYPTO_FUTURES',symbol:'XRPUSDT',direction:'DOWN',score:1.5,
    watchEventId:'c'.repeat(64),sourceAtMs:OBS-60_000,status:'RESEARCH_OBSERVATION_ONLY',
    executionAuthority:'NONE'},
  {market:'KR_STOCK',symbol:'005930',direction:'UP',score:2,
    watchEventId:'d'.repeat(64),sourceAtMs:OBS-60_000,status:'RESEARCH_OBSERVATION_ONLY',
    executionAuthority:'NONE'},
 ]};
function response(symbol,market,dir){
 return {ok:true,market:market==='CRYPTO_SPOT'?'UPBIT_KRW':'BITGET_USDT_FUTURES',
  orderSubmitted:false,exchangeRequestSent:false,dataState:'complete',
  universe:{totalCount:200,partial:false,stale:false},
  execution:{requestedCount:1,startedCount:1,completedCount:1,
    providerErrorCount:0,timeoutCount:0,partial:false,timedOut:false,
    cancelled:false},
  cards:[{symbol,direction:dir,dataState:'complete',
    dataQuality:{state:'TRUSTED',strongSignalAllowed:true}}],
  failures:[]};
}
test('only missing crypto out-of-page symbols can enter independent review',()=>{
 installV3WithinPageWatchPriority(watch);
 const base=[{symbol:'BTC'},{symbol:'ADA'}];
 prioritizeV3CurrentCryptoPage(base,'spot');
 const reviews=selectV3OutOfCursorResearch(watch);
 assert.equal(reviews.length,2);
 assert.deepEqual(reviews.map(x=>x.symbol),['ETH','XRPUSDT']);
 assert.ok(reviews.every(x=>x.executionAuthority==='NONE'));
 installV3WithinPageWatchPriority(null);
 assert.equal(selectV3OutOfCursorResearch(null).length,0);
});
test('read-only two-market review verifies one real current-roster response each, no Telegram or trade credit',async()=>{
 installV3WithinPageWatchPriority(watch);
 prioritizeV3CurrentCryptoPage([{symbol:'BTC'}],'spot');
 const reviews=selectV3OutOfCursorResearch(watch);
 let calls=0;
 const out=await runV3OutOfCursorResearch(reviews,{
  enabled:true,
  scanOne:async row=>{
   calls++;
   return {httpRequests:row.market==='CRYPTO_SPOT'?4:2,
     requestCountMeasured:true,response:response(row.symbol,row.market,
     row.direction==='UP'?'LONG':'SHORT')};
  },
 });
 assert.equal(calls,2);
 assert.equal(out.selectedForReview,2);
 assert.equal(out.reviewedFromCurrentRoster,2);
 assert.equal(out.trustedPublicData,2);
 assert.equal(out.watchSideAgreed,2);
 assert.equal(out.observedPublicHttpRequests,6);
 assert.equal(out.telegramMessagesSent,0);
 assert.equal(out.costOosPassProven,false);
 assert.equal(out.skippedCursorSymbols,0);
 assert.equal(out.changedScannerUniverseCursor,false);
 assert.ok(!JSON.stringify(out).includes('XRPUSDT'));
 installV3WithinPageWatchPriority(null);
});
test('untrusted, wrong instrument, missing HTTP evidence and network failure are not promoted',async()=>{
 installV3WithinPageWatchPriority(watch);
 const reviews=selectV3OutOfCursorResearch(watch);
 const bad=await runV3OutOfCursorResearch(reviews,{
  enabled:true,nowMs:OBS,scanOne:async row=>({
   httpRequests:2,requestCountMeasured:true,
   response:response('OTHER',row.market,'SHORT'),
  }),
 });
 assert.equal(bad.trustedPublicData,0);
 assert.equal(bad.dataBlocked,2);
 assert.equal(bad.status,'RESEARCH_SOURCE_PARTIAL');
 const network=await runV3OutOfCursorResearch(reviews,{
  enabled:true,nowMs:OBS,scanOne:async()=>{throw Error('sensitive token never return');},
 });
 assert.equal(network.sourceError,2);
 assert.ok(!JSON.stringify(network).includes('sensitive'));
 const fabricated=await runV3OutOfCursorResearch(reviews,{
  enabled:true,nowMs:OBS,scanOne:async row=>({httpRequests:0,response:response(
    row.symbol,row.market,'LONG')}),
 });
 assert.equal(fabricated.sourceError,2);
 assert.equal(fabricated.publicRequestCountProven,true,
   'false confidence must be represented by blocked source count, not success');
 installV3WithinPageWatchPriority(null);
});
test('review is off unless explicitly activated; malformed duplicate/stock shorts fail closed',async()=>{
 installV3WithinPageWatchPriority(watch);
 const good=selectV3OutOfCursorResearch(watch);
 const idle=await runV3OutOfCursorResearch(good,{
  scanOne:async()=>{throw Error('MUST_NOT_RUN');},
 });
 assert.equal(idle.status,'DISABLED');
 assert.equal(V3_OFFPAGE_RESEARCH_MAX.total,2);
 const bad=[good[0],good[0]];
 assert.equal((await runV3OutOfCursorResearch(bad,{
  enabled:true,nowMs:OBS,scanOne:async()=>{throw Error('MUST_NOT_RUN');},
 })).status,'REJECTED_UNSAFE_REVIEW_INPUT');
 const wrong=[{...good[0],market:'KR_STOCK',direction:'DOWN'}];
 assert.equal((await runV3OutOfCursorResearch(wrong,{
  enabled:true,nowMs:OBS,scanOne:async()=>{throw Error('MUST_NOT_RUN');},
 })).status,'REJECTED_UNSAFE_REVIEW_INPUT');
 installV3WithinPageWatchPriority(null);
});

test('a watch receipt expires during a long 12-lane scan without any late HTTP calls',async()=>{
 installV3WithinPageWatchPriority(watch);
 const reviews=selectV3OutOfCursorResearch(watch);
 let count=0;
 const out=await runV3OutOfCursorResearch(reviews,{enabled:true,
  nowMs:OBS+400_000,scanOne:async()=>{count++;throw Error('must not run');},
 });
 assert.equal(count,0);
 assert.equal(out.staleWatchEvidenceSkipped,2);
 assert.equal(out.observedPublicHttpRequests,0);
 assert.equal(out.status,'RESEARCH_SOURCE_PARTIAL');
 installV3WithinPageWatchPriority(null);
});
