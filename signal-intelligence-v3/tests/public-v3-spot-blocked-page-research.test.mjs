import test from 'node:test';
import assert from 'node:assert/strict';
import {selectV3TrustedSpotResearchOnly as select}
 from '../src/public-v3-spot-blocked-page-research.mjs';
const NOW=Date.parse('2026-10-12T01:00:00Z');
const card=(symbol,quality='TRUSTED')=>({
 assetClass:'coin_spot',market:'UPBIT_KRW',symbol,
 action:'BUY',direction:'LONG',listingStatus:'LISTED',
 dataState:quality==='TRUSTED'?'complete':'untrusted',
 dataQuality:{state:quality,strongSignalAllowed:quality==='TRUSTED',
  issues:quality==='TRUSTED'?[]:[{code:'MISSING_CANDLE',severity:'blocking',
    message:'PRIVATE_SYMBOL_MESSAGE'}]},
 observedAt:new Date(NOW-20_000).toISOString(),
 expiresAt:new Date(NOW+10*60_000).toISOString(),
 dataSources:['upbit-public-candles','upbit-public-ticker'],
 price:1,secret:'NOT_FOR_SNAPSHOT',
});
function page(){
 return {ok:true,market:'UPBIT_KRW',assetClass:'coin_spot',dataState:'untrusted',
  orderSubmitted:false,exchangeRequestSent:false,
  universe:{source:'upbit-public',totalCount:294,cursor:0,partial:false,
    stale:false,nextCursor:5},
  execution:{requestedCount:5,startedCount:5,completedCount:5,
    providerErrorCount:0,timeoutCount:0,partial:false,timedOut:false,
    cancelled:false},
  cards:[card('BTC'),card('ETH','DATA_UNTRUSTED'),card('XRP','DEGRADED')],
  failures:[],
 };
}
test('only trusted current Spot cards are preserved as research, not a page PASS',()=>{
 const x=select(page(),{status:'BLOCKED_DATA',cursor:0,nowMs:NOW});
 assert.deepEqual(x.cards.map(y=>y.symbol),['BTC']);
 assert.equal(x.diagnostic.trustedCardsAvailable,1);
 assert.equal(x.diagnostic.excludedCards,2);
 assert.equal(x.diagnostic.wholePageAdmitted,false);
 assert.equal(x.diagnostic.telegramEligible,false);
 assert.equal(x.diagnostic.oosOrProfitabilityCredit,false);
 assert.equal(x.diagnostic.addedProviderCalls,0);
 const summary=JSON.stringify(x.diagnostic);
 for(const secret of ['BTC','ETH','XRP','NOT_FOR_SNAPSHOT','PRIVATE_SYMBOL_MESSAGE'])
  assert.equal(summary.includes(secret),false);
});
test('provider error, stale roster, missing receipts, mismatched cursor never grant research',()=>{
 for(const fn of [
  p=>{p.execution.timeoutCount=1;},
  p=>{p.execution.completedCount=4;},
  p=>{p.universe.partial=true;},
  p=>{p.universe.source='bitget-public';},
  p=>{p.failures.push({reason:'timeout'});},
  p=>{p.exchangeRequestSent=true;},
  p=>{p.universe.cursor=7;},
 ]){
  const p=page();fn(p);
  assert.equal(select(p,{status:'BLOCKED_DATA',cursor:0,nowMs:NOW})
    .cards.length,0);
 }
});
test('freshness, action, quality and price-source mismatches fail closed per card',()=>{
 const p=page();p.cards[0].expiresAt=new Date(NOW-10).toISOString();
 assert.equal(select(p,{status:'BLOCKED_DATA',cursor:0,nowMs:NOW})
   .cards.length,0);
 p.cards[0].expiresAt=new Date(NOW+10000).toISOString();
 p.cards[0].action='SELL';
 assert.equal(select(p,{status:'BLOCKED_DATA',cursor:0,nowMs:NOW})
   .cards.length,0);
 p.cards[0].action='BUY';
 p.cards[0].dataSources=['private-cache'];
 assert.equal(select(p,{status:'BLOCKED_DATA',cursor:0,nowMs:NOW})
   .cards.length,0);
 assert.equal(select(page(),{status:'CANDIDATES_AVAILABLE',cursor:0,
   nowMs:NOW}).diagnostic.status,'NOT_BLOCKED_SPOT_PAGE');
});
