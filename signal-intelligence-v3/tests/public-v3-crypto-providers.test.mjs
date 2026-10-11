import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicV3CryptoProviders,normalizePublicV3Candles,upbitPublicCandleUtcStart} from '../src/public-v3-crypto-providers.mjs';

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
      {candle_date_time_utc:'2026-10-11T08:00:00',
       timestamp:NOW-60000,opening_price:10,high_price:12,low_price:9,trade_price:11,
       candle_acc_trade_volume:100,candle_acc_trade_price:1110},
    ]);
    return response({code:'00000',data:[[String(Date.parse('2026-10-09T00:00:00Z')),'10','11','9','10.5','100','1000']]});
  }
  if(u.pathname==='/v1/orderbook')return response([{orderbook_units:[{bid_price:10,ask_price:11}]}]);
  throw Error('UNEXPECTED_ENDPOINT_'+u.pathname);
 };
 return {fetchImpl,urls};
}
test('Spot and futures source page order remains symbol-index stable across a changing volume-ranked source',async()=>{
 const m=mock(),p=createPublicV3CryptoProviders({fetchImpl:m.fetchImpl,now:()=>NOW});
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
 const m=mock(),p=createPublicV3CryptoProviders({fetchImpl:m.fetchImpl,now:()=>NOW});
 const spot=await p.getCandles('spot','ALPHA','4H');
 assert.equal(spot.length,1);
 assert.equal(spot[0].close,11);
 assert.equal(spot[0].time,Date.parse('2026-10-11T08:00:00Z'),
   'Upbit opening UTC, not the last-tick timestamp, is the candle key');
 const future=await p.getCandles('futures','ALPHAUSDT','1D');
 assert.equal(future.length,1);
 assert.equal(future[0].close,10.5);
 assert.deepEqual(await p.getSpread('spot',{symbol:'ALPHA'}),{bid:10,ask:11});
 assert.deepEqual(await p.getSpread('futures',{bid:100,ask:101}),{bid:100,ask:101});
 assert.ok(m.urls.every(path=>/^(\/v1\/(market\/all|ticker|candles\/|orderbook)|\/api\/v2\/mix\/market\/(tickers|candles))/.test(path)));
});
test('source omitting one Upbit ticker remains provider-partial instead of false full-roster PASS',async()=>{
 const m=mock();
 const p=createPublicV3CryptoProviders({now:()=>NOW,fetchImpl:async url=>{
  if(new URL(url).pathname==='/v1/ticker')
    return response([{market:'KRW-ALPHA',trade_price:10,acc_trade_price_24h:100}]);
  return m.fetchImpl(url);
 }});
 const source=await p.getUniverse('spot');
 assert.equal(source.providerErrorCount,1);
 assert.equal(source.rows.length,1);
});

test('strict candles retain native high/low, detect invalid OHLC and refuse contradictory source series',()=>{
 const input=[
  {time:NOW-7200000,open:10,high:11,low:9,close:10.5,volume:10,quoteVolume:105},
  {time:NOW-3600000,open:10,high:8,low:9,close:10.5,volume:10,quoteVolume:105},
 ];
 const bad=normalizePublicV3Candles(input,NOW,'5m');
 assert.equal(bad.rejectedSourceSeries,true);
 assert.equal(bad.invalidOhlcBars,1);
 assert.deepEqual(bad.candles,[]);
 const good=normalizePublicV3Candles(input.slice(0,1),NOW,'5m');
 assert.equal(good.rejectedSourceSeries,false);
 assert.deepEqual(good.candles.map(x=>[x.high,x.low]),[[11,9]]);
 assert.equal(good.tradeAuthority,'NONE');
});
test('last trade timestamp is not the Upbit UTC interval OPEN time, irrespective of server timezone',()=>{
 assert.equal(upbitPublicCandleUtcStart('2026-10-11T08:00:00'),Date.parse('2026-10-11T08:00:00Z'));
 for(const bad of ['2026-02-30T08:00:00','2026-10-11T08:00:00Z','2026-10-11T25:00:00',null])
   assert.ok(Number.isNaN(upbitPublicCandleUtcStart(bad)));
});
test('in-progress bars are excluded, never used in complete research indicators',()=>{
 const older={time:NOW-8*3600000,open:10,high:12,low:9,close:11,volume:50,quoteVolume:550};
 const current={...older,time:NOW-3600000,close:11.5};
 const r=normalizePublicV3Candles([current,older],NOW,'4H');
 assert.equal(r.candles.length,1);
 assert.equal(r.candles[0].time,older.time);
 assert.equal(r.incompleteCurrentBarsExcluded,1);
 assert.equal(r.invalidOhlcBars,0);
});
test('identical candles can be deduplicated but conflicting duplicate or invalid time blocks ALL results',()=>{
 const one={time:NOW-7200000,open:10,high:12,low:9,close:11,volume:50,quoteVolume:550};
 const equal=normalizePublicV3Candles([one,{...one}],NOW,'5m');
 assert.equal(equal.equivalentDuplicateBars,1);
 assert.equal(equal.candles.length,1);
 const mismatched=normalizePublicV3Candles([one,{...one,close:11.5}],NOW,'5m');
 assert.equal(mismatched.conflictingDuplicateBars,1);
 assert.equal(mismatched.candles.length,0);
 const missing=normalizePublicV3Candles([one,{...one,time:Number.NaN}],NOW,'5m');
 assert.equal(missing.malformedSourceBars,1);
 assert.equal(missing.candles.length,0);
});
test('read-only public Spot and Futures invalid series return insufficient candle evidence, not invented OHLC',async()=>{
 const m=mock();
 const wrapper=async url=>{
   const u=new URL(url);
   if(u.pathname.includes('candles')&&u.hostname==='api.upbit.com')
     return response([{candle_date_time_utc:'2026-10-11T08:00:00',timestamp:NOW-60000,
       opening_price:10,high_price:9,low_price:8,trade_price:11,
       candle_acc_trade_volume:100,candle_acc_trade_price:1100}]);
   if(u.pathname.includes('candles')&&u.hostname==='api.bitget.com')
     return response({code:'00000',data:[[
       String(NOW-86400000),'10','8','9','11','100','1100'
     ]]});
   return m.fetchImpl(url);
 };
 const p=createPublicV3CryptoProviders({fetchImpl:wrapper,now:()=>NOW});
 const spot=await p.getCandles('spot','ALPHA','4H');
 const futures=await p.getCandles('futures','ALPHAUSDT','1D');
 assert.deepEqual(spot,[]);
 assert.deepEqual(futures,[]);
 assert.equal(p.readCandleQuality('spot').invalidOhlcBars,1);
 assert.equal(p.readCandleQuality('futures').invalidOhlcBars,1);
 assert.equal(p.readCandleQuality('spot').rejectedSourceSeries,1);
 assert.equal(p.readCandleQuality('futures').tradeAuthority,'NONE');
 assert.equal(JSON.stringify(p.readCandleQuality('spot')).includes('ALPHA'),false);
});
