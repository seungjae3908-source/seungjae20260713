import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectPublicCryptoAllVenueSnapshots,probePublicCryptoAllVenues,
  UPBIT_QUOTE_MARKETS,BITGET_FUTURES_TYPES,
} from '../src/public-crypto-all-venue-coverage.mjs';
const NOW=Date.parse('2026-10-11T09:00:00.000Z');
const u=(market)=>({market,market_event:{warning:false}});
const ut=(market,age=30000)=>({market,trade_timestamp:NOW-age,trade_price:100,
  acc_trade_price_24h:2000});
const contracts=(symbol,status='normal')=>({symbol,symbolStatus:status});
const ft=(symbol,age=30000)=>({symbol,ts:String(NOW-age),lastPr:'200'});
const ok=(data)=>({code:'00000',data});
const fixture=()=>({
 upbitPairs:[u('KRW-BTC'),u('BTC-ETH'),u('USDT-ETH')],
 upbitTickers:[ut('USDT-ETH'),ut('KRW-BTC'),ut('BTC-ETH')],
 bitgetByProduct:{
  'USDT-FUTURES':{contracts:ok([contracts('BTCUSDT')]),tickers:ok([ft('BTCUSDT')])},
  'COIN-FUTURES':{contracts:ok([contracts('BTCUSD')]),tickers:ok([ft('BTCUSD')])},
  'USDC-FUTURES':{contracts:ok([contracts('ETHUSDC')]),tickers:ok([ft('ETHUSDC')])},
 },
 nowMs:NOW,
});
test('quote/base and futures product IDs stay distinct; no raw prices or symbols leak',()=>{
 const v=inspectPublicCryptoAllVenueSnapshots(fixture());
 assert.deepEqual(Object.keys(v.upbit.quoteGroups),UPBIT_QUOTE_MARKETS);
 assert.deepEqual(Object.keys(v.bitget.productTypes),BITGET_FUTURES_TYPES);
 assert.equal(v.upbit.rosterRowsObserved,3);
 for(const row of Object.values(v.upbit.quoteGroups)){
  assert.equal(row.rosterCount,1);
  assert.equal(row.matchedTickerCount,1);
  assert.equal(row.observedRosterTickerParity,true);
 }
 assert.equal(v.bitget.productTypes['COIN-FUTURES'].rosterCount,1);
 assert.equal(v.anySourceDataBlocked,false);
 assert.equal(v.publicRedistributionLicensed,false);
 assert.equal(v.wholeVenueTradingSignalReady,false);
 assert.equal(v.executionAuthority,'NONE');
 assert.equal(JSON.stringify(v).includes('ETHUSDC'),false);
 assert.equal(JSON.stringify(v).includes('100'),false);
});
test('missing and duplicate source rows remain failed evidence, never fabricated zero',()=>{
 const x=fixture();
 x.upbitTickers=[ut('KRW-BTC'),ut('KRW-BTC'),ut('USDT-ETH')];
 x.bitgetByProduct['COIN-FUTURES'].tickers=ok([]);
 const v=inspectPublicCryptoAllVenueSnapshots(x);
 assert.equal(v.upbit.quoteGroups.BTC.missingTickerCount,1);
 assert.equal(v.upbit.quoteGroups.KRW.duplicateIdentityCount,1);
 assert.equal(v.bitget.productTypes['COIN-FUTURES'].missingTickerCount,1);
 assert.equal(v.anySourceDataBlocked,true);
 assert.equal(v.upbit.quoteGroups.KRW.status,'BLOCKED_ROSTER_TICKER_MISMATCH');
 assert.equal(v.wholeVenueTradingSignalReady,false);
});
test('stale last trade, quote price invalidity and inactive contracts block signals',()=>{
 const x=fixture();
 x.upbitTickers=[ut('KRW-BTC',720000),ut('BTC-ETH'),ut('USDT-ETH')];
 x.bitgetByProduct['USDC-FUTURES'].contracts=ok([contracts('ETHUSDC','restrictedAPI')]);
 x.bitgetByProduct['USDT-FUTURES'].tickers=ok([{...ft('BTCUSDT'),lastPr:'0'}]);
 const v=inspectPublicCryptoAllVenueSnapshots(x);
 assert.equal(v.upbit.quoteGroups.KRW.staleLastTradeCount,1);
 assert.equal(v.upbit.quoteGroups.KRW.status,'BLOCKED_PRICE_OR_LAST_TRADE_AGE');
 assert.equal(v.bitget.productTypes['USDC-FUTURES'].nonNormalContractCount,1);
 assert.equal(v.bitget.productTypes['USDT-FUTURES'].invalidPriceCount,1);
 assert.equal(v.anySourceDataBlocked,true);
});
test('unavailable provider payload never becomes zero-market complete',()=>{
 const x=fixture();
 x.upbitTickers=null;
 delete x.bitgetByProduct['COIN-FUTURES'];
 const v=inspectPublicCryptoAllVenueSnapshots(x);
 assert.equal(v.upbit.quoteGroups.KRW.rosterCount,null);
 assert.equal(v.bitget.productTypes['COIN-FUTURES'].tickerCount,null);
 assert.equal(v.anySourceDataBlocked,true);
 assert.equal(v.allExchangeVenuesCertified,false);
});
test('public probe makes only eight bounded official requests, redacts returns',async()=>{
 const x=fixture(),called=[];
 const fetchImpl=async (url,options)=>{
  called.push([url,options]);
  const parsed=new URL(url);
  let value;
  if(parsed.hostname==='api.upbit.com'){
    value=parsed.pathname==='/v1/market/all'?x.upbitPairs:x.upbitTickers;
  }else{
    const type=parsed.searchParams.get('productType');
    value=parsed.pathname.endsWith('/contracts')
      ?x.bitgetByProduct[type].contracts:x.bitgetByProduct[type].tickers;
  }
  return new Response(JSON.stringify(value),{
    status:200,headers:{'content-type':'application/json'},
  });
 };
 const v=await probePublicCryptoAllVenues({fetchImpl,now:()=>NOW,wait:async()=>{}});
 assert.equal(called.length,8);
 assert.equal(v.anySourceDataBlocked,false);
 assert.ok(called.every(([url,opt])=>/^https:\/\/(?:api\.upbit\.com\/v1\/(?:market\/all|ticker\/all)|api\.bitget\.com\/api\/v2\/mix\/market\/(?:contracts|tickers))/u.test(url)
  && !url.includes('/orders')&&!url.includes('/account')
  && !('Authorization' in opt.headers)));
 assert.equal(v.providerSourceOutcomes.UPBIT_ROSTER,'OK');
 assert.equal(v.realOrderAuthority,false);
 assert.equal(JSON.stringify(v).includes('BTCUSDT'),false);
});
test('429/403 blocks only affected category, never retries or promotes',async()=>{
 let count=0;
 const report=await probePublicCryptoAllVenues({
  now:()=>NOW,wait:async()=>{},fetchImpl:async(url)=>{
   count++;
   if(new URL(url).hostname==='api.upbit.com')
     return new Response('{}',{status:429});
   return new Response('{}',{status:403});
  },
 });
 assert.equal(count,8);
 assert.equal(report.providerSourceOutcomes.UPBIT_ROSTER,'HTTP_429');
 assert.equal(report.providerSourceOutcomes.BITGET_USDT_FUTURES_CONTRACTS,'HTTP_403');
 assert.equal(report.upbit.quoteGroups.KRW.rosterCount,null);
 assert.equal(report.bitget.productTypes['USDT-FUTURES'].tickerCount,null);
 assert.equal(report.anySourceDataBlocked,true);
 assert.equal(report.memberSignalPromotionAllowed,false);
});
