import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeV3RawCryptoQuality as diagnose}
 from '../src/public-v3-crypto-quality-diagnostic.mjs';
const card=(symbol,status,issues=[],dataState='untrusted')=>({
 symbol,price:99,privateApiKey:'SHOULD_NOT_APPEAR',dataState,
 dataQuality:{state:status,strongSignalAllowed:status==='TRUSTED',
  issues:issues.map(([code,severity])=>({code,severity,message:'SENSITIVE_DATA'}))},
});
test('public V3 Spot 15m preserves counts for missing, stale, volume and OHLC without exposing tickers',()=>{
 const a=diagnose({
  cards:[
   card('PRIVATE_BTC','DATA_UNTRUSTED',[['MISSING_CANDLE','blocking']]),
   card('PRIVATE_ETH','TRUSTED',[],'complete'),
   card('PRIVATE_XRP','DATA_UNTRUSTED',[
     ['INVALID_OHLC','blocking'],['STALE_TIMESTAMP','warning']]),
  ],failures:[{symbol:'HIDDEN',message:'SECRET'}],execution:{requestedCount:5},
 },{rankedCards:2});
 assert.equal(a.observedPreRankingCards,3);
 assert.equal(a.displayedAfterRankingCards,2);
 assert.equal(a.removedByRankingOrDirection,1);
 assert.equal(a.qualityStates.DATA_UNTRUSTED,2);
 assert.equal(a.qualityIssues['MISSING_CANDLE:blocking'],1);
 assert.equal(a.qualityIssues['INVALID_OHLC:blocking'],1);
 assert.equal(a.qualityIssues['STALE_TIMESTAMP:warning'],1);
 assert.equal(a.sourceFailuresCount,1);
 assert.equal(a.scannedCount,5);
 assert.equal(a.extraProviderRequests,0);
 assert.equal(a.profitabilityProven,false);
 for(const hidden of ['PRIVATE_BTC','PRIVATE_ETH','PRIVATE_XRP',
   'SENSITIVE_DATA','SHOULD_NOT_APPEAR'])
   assert.ok(!JSON.stringify(a).includes(hidden));
});
test('reported clean pre-rank cards cannot grant a V3 trading signal or full universe completion',()=>{
 const q=diagnose({cards:[card('BTC','TRUSTED',[],'complete')],
  failures:[],execution:{requestedCount:1}},{rankedCards:1});
 assert.equal(q.qualityStates.TRUSTED,1);
 assert.equal(q.qualityIssues['MISSING_CANDLE:blocking'],undefined);
 assert.equal(q.fullMarketCoverageProven,false);
 assert.equal(q.signalAuthority,'NONE');
 assert.equal(q.profitabilityProven,false);
});
test('malformed raw quality receipts never silently become trusted',()=>{
 const a=diagnose({cards:[{symbol:'SECRET_X',dataState:'complete',
   dataQuality:{state:'COUNTERFEIT',issues:[]}}],failures:[]},
   {rankedCards:0});
 assert.equal(a.invalidQualityReceipts,1);
 assert.equal(a.qualityStates.TRUSTED,0);
 assert.throws(()=>diagnose({cards:Array.from({length:101},()=>({}))}),/RECEIPT_INVALID/);
 assert.throws(()=>diagnose({cards:[{}]},{rankedCards:3}),/RECEIPT_INVALID/);
});
