import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicV3CryptoProviders} from '../src/public-v3-crypto-providers.mjs';

const response=data=>new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
function mock(){
 let swap=false;
 const urls=[];
 const fetchImpl=async url=>{
  const u=new URL(url);urls.push(u.pathname);
  if(u.pathname==='/v1/market/all')return response([
   {market:'KRW-ZETA',korean_name:'Zeta',market_warning:'NONE'},
   {market:'KRW-ALPHA',korean_name:'Alpha',market_warning:'NONE'},
  ]);
  if(u.pathname==='/v1/ticker'){
   const rows=[
    {market:'KRW-ZETA',trade_price:20,signed_change_rate:0.02,acc_trade_volume_24h:90,acc_trade_price_24h:500,timestamp:123},
    {market:'KRW-ALPHA',trade_price:10,signed_change_rate:0.01,acc_trade_volume_24h:20,acc_trade_price_24h:100,timestamp:123},
   ];
   swap=!swap;return response(swap?rows:rows.reverse());
  }
  if(u.pathname==='/api/v2/mix/market/tickers'){
   return response({code:'00000',data:[
    {symbol:'ZETAUSDT',lastPr:'12',usdtVolume:'5000',ts:'1'},
    {symbol:'ALPHAUSDT',lastPr:'10',usdtVolume:'1000',ts:'1'},
   ]});
  }
  if(u.pathname.includes('candles')){
    if(u.hostname==='api.upbit.com')return response([
      {timestamp:Date.now()-3600000,opening_price:10,high_price:12,low_price:9,trade_price:11,candle_acc_trade_volume:100,candle_acc_trade_price:1110},
    ]);
    return response({code:'00000',data:[[(Date.now()-3600000).toString(),'10','11','9','10.5','100','1000']]});
  }
  if(u.pathname==='/v1/orderbook')return response([{orderbook_units:[{bid_price:10,ask_price:11}]}]);
  throw Error('UNEXPECTED_ENDPOINT_'+u.pathname);
 };
 return {fetchImpl,urls};
}
test('Spot and futures source page order remains symbol-index stable across a changing volume-ranked source',async()=>{
 const m=mock(),p=createPublicV3CryptoProviders({fetchImpl:m.fetchImpl});
 const s1=await p.getUniverse('spot');
 const d1=p.readLastRosterDigest('spot');
 const s2=await p.getUniverse('spot');
 assert.deepEqual(s1.rows.map(x=>x.symbol),['ALPHA','ZETA']);
 assert.deepEqual(s2.rows.map(x=>x.symbol),['ALPHA','ZETA']);
 assert.equal(s1.rows.find(x=>x.symbol==='ZETA').tradingValue,500);
 assert.equal(p.readLastRosterDigest('spot'),d1);
 const f=await p.getUniverse('futures');
 assert.deepEqual(f.rows.map(x=>x.symbol),['ALPHAUSDT','ZETAUSDT']);
 assert.match(p.readLastRosterDigest('futures'),/^[a-f0-9]{64}$/);
 assert.equal(s1.providerErrorCount,0);
 assert.equal(f.providerErrorCount,0);
 assert.equal(m.urls.some(url=>url.includes('orders')||url.includes('account')),false);
});
test('standalone public adapter preserves exchange-native candle/quote values without private endpoints',async()=>{
 const m=mock(),p=createPublicV3CryptoProviders({fetchImpl:m.fetchImpl});
 const spot=await p.getCandles('spot','ALPHA','4H');
 assert.equal(spot.length,1);
 assert.equal(spot[0].close,11);
 const future=await p.getCandles('futures','ALPHAUSDT','1D');
 assert.equal(future.length,1);
 assert.equal(future[0].close,10.5);
 assert.deepEqual(await p.getSpread('spot',{symbol:'ALPHA'}),{bid:10,ask:11});
 assert.deepEqual(await p.getSpread('futures',{bid:100,ask:101}),{bid:100,ask:101});
 assert.ok(m.urls.every(path=>/^(\/v1\/(market\/all|ticker|candles\/|orderbook)|\/api\/v2\/mix\/market\/(tickers|candles))/.test(path)));
});
test('source omitting one Upbit ticker remains provider-partial instead of false full-roster PASS',async()=>{
 const m=mock();
 const p=createPublicV3CryptoProviders({fetchImpl:async url=>{
  if(new URL(url).pathname==='/v1/ticker')
    return response([{market:'KRW-ALPHA',trade_price:10,acc_trade_price_24h:100}]);
  return m.fetchImpl(url);
 }});
 const source=await p.getUniverse('spot');
 assert.equal(source.providerErrorCount,1);
 assert.equal(source.rows.length,1);
});
