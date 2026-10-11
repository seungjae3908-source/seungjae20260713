import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePublicKrAlphaHistoricalDaily,createPublicKrAlphaHistoricalDailyFeed} from '../src/public-kr-alpha-historical-daily.mjs';
const NOW=Date.parse('2026-10-11T05:00:00Z');
function fixture(){
 const start=Date.UTC(2026,6,1);
 return {code:'0193W0',priceInfos:Array.from({length:70},(_,i)=>{
   const day=new Date(start+i*86400000).toISOString().slice(0,10).replace(/-/gu,'');
   return {localDate:day,openPrice:100+i,highPrice:102+i,lowPrice:99+i,
     closePrice:101+i,accumulatedTradingVolume:10000+i*20};
 })};
}
test('historical dayCandle uses distinct YYYYMMDD closes, not 390 minute timestamps',()=>{
 const p=normalizePublicKrAlphaHistoricalDaily(fixture(),'0193W0',NOW);
 assert.equal(p.barCount,70);
 assert.equal(p.candles.length,70);
 assert.equal(p.candles[0].open,100);
 assert.equal(p.candles[0].close,101);
 assert.equal(p.candles.at(-1).volume,11380);
 assert.equal(p.closedDailyOnly,true);
 assert.equal(p.priceSource,'naver-public-historical-dayCandle');
 assert.equal(p.liveQuoteProven,false);
 assert.equal(p.fullMarketProven,false);
 assert.equal(p.licensingVerified,false);
});
test('forbid conflicting bars, bad codes, minute-view masquerading as daily and incomplete source',()=>{
 const s=fixture(),dup={...s.priceInfos[0]};
 assert.equal(normalizePublicKrAlphaHistoricalDaily({...s,priceInfos:[...s.priceInfos,dup]},'0193W0',NOW).barCount,70);
 assert.throws(()=>normalizePublicKrAlphaHistoricalDaily({...s,priceInfos:[...s.priceInfos,{...dup,closePrice:102}]},'0193W0',NOW),/CONFLICTING_DAY/);
 assert.throws(()=>normalizePublicKrAlphaHistoricalDaily({...s,priceInfos:s.priceInfos.slice(0,20)},'0193W0',NOW),/SOURCE_INSUFFICIENT/);
 const intraday={code:'0193W0',priceInfos:Array.from({length:391},(_,i)=>({
   localDateTime:'20261009'+String(90000+i),
   openPrice:100,highPrice:101,lowPrice:99,currentPrice:100,accumulatedTradingVolume:100+i,
 }))};
 assert.throws(()=>normalizePublicKrAlphaHistoricalDaily(intraday,'0193W0',NOW),/VERIFIED_HISTORY_SHORT/);
 assert.throws(()=>normalizePublicKrAlphaHistoricalDaily(s,'005930',NOW),/CODE_UNSAFE/);
});
test('read-only daily source is restricted to 1D and retains proof of unlicensed distribution',async()=>{
 let requests=0;
 const feed=createPublicKrAlphaHistoricalDailyFeed({
  fetchImpl:async(url)=>{
   requests++;
   assert.equal(url,'https://api.stock.naver.com/chart/domestic/item/0193W0?periodType=dayCandle');
   return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>fixture()};
  },now:()=>NOW,
 });
 await assert.rejects(feed.getCandles('0193W0','5m'),/UNSUPPORTED_TIMEFRAME/);
 assert.equal(requests,0);
 const [a,b]=await Promise.all([feed.read('0193W0'),feed.getCandles('0193W0','1D')]);
 assert.equal(a.candles.length,70);
 assert.equal(b.length,70);
 assert.equal(requests,1);
 assert.equal(feed.fullMarketReady,false);
 assert.equal(feed.executionAuthority,'NONE');
});

test('numeric eight-digit Naver trading dates are supported, invalid or future dates are not passed off as historical bars',()=>{
 const data=fixture();
 const numeric={...data,priceInfos:data.priceInfos.map(row=>({
   ...row,localDate:Number(row.localDate),
 }))};
 assert.equal(normalizePublicKrAlphaHistoricalDaily(numeric,'0193W0',NOW).barCount,70);
 const future={...data,priceInfos:data.priceInfos.map(x=>({
   ...x,localDate:'20270101',
 }))};
 assert.throws(()=>normalizePublicKrAlphaHistoricalDaily(future,'0193W0',NOW),/VERIFIED_HISTORY_SHORT/);
});
