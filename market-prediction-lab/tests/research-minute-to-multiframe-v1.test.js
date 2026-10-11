import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {deriveResearchTimeframesFromMinuteSourceV1 as derive}
 from "../src/research-minute-to-multiframe-v1.js";
import {TIMEFRAME_MS,timeframeToMs} from "../src/timeframes.js";
const MIN=60_000,DAY=86_400_000;
const digest=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const d=Date.parse("2026-09-18T00:00:00Z");
const session=(market,start,end,kind)=>({
 startMs:start,endMs:end,
 kind:kind??(market==="CRYPTO_SPOT"||market==="CRYPTO_FUTURES"?"UTC_24H":"REGULAR"),
 timeZone:market==="KR_STOCK"?"Asia/Seoul":market==="US_STOCK"?
   "America/New_York":"UTC",
 calendarSourceId:"PRIVATE_EXCHANGE_SESSION_EVIDENCE_TEST_ONLY",
});
const venue=m=>({
 CRYPTO_SPOT:"UPBIT_KRW",CRYPTO_FUTURES:"BITGET_USDT_FUTURES",
 KR_STOCK:"KRX",US_STOCK:"US_SIP",
})[m];
function bars(market,start,count,{id="TEST_PRIVATE_MINUTE_SOURCE"}={}){
 const symbol=market==="CRYPTO_SPOT"?"KRW-ABC":
   market==="CRYPTO_FUTURES"?"ABCUSDT":
   market==="KR_STOCK"?"005930":"ACME";
 return Array.from({length:count},(_,i)=>({
  market,venue:venue(market),symbol,sourceId:id,
  timestampMs:start+i*MIN,availableAtMs:start+(i+1)*MIN,
  open:100+i,high:104+i,low:99+i,close:101+i,
  volume:10+i,
 }));
}
function run(market,start,end,minuteBars,options={}){
 const symbol=market==="CRYPTO_SPOT"?"KRW-ABC":
   market==="CRYPTO_FUTURES"?"ABCUSDT":
   market==="KR_STOCK"?"005930":"ACME";
 return derive({
  market,venue:venue(market),symbol,sourceId:"TEST_PRIVATE_MINUTE_SOURCE",
  session:session(market,start,end),
  minuteBars,sourceMinuteRowsSha256:digest(minuteBars),
  asOfMs:options.asOfMs??end,timeframes:options.timeframes??
   ["1m","3m","5m","15m","30m","1h","4h"],
 });
}
test("shared timeframes include 1,3,5,15,30,60,240-minute research intervals",()=>{
 assert.deepEqual(
  ["1m","3m","5m","15m","30m","1h","4h"].map(x=>timeframeToMs(x)),
  [1,3,5,15,30,60,240].map(x=>x*MIN));
 assert.equal(TIMEFRAME_MS["1d"],DAY);
});
test("4 crypto hours of minute bars produce all requested shorter frames, never future buckets",()=>{
 const m="CRYPTO_SPOT",all=bars(m,d,240);
 const x=run(m,d,d+DAY,all,{asOfMs:d+240*MIN});
 assert.equal(x.status,"SOURCE_LIMITED_DERIVED_MULTI_TIMEFRAME_BARS_ONLY");
 assert.equal(x.intervalData["1m"].completeBarCount,240);
 assert.equal(x.intervalData["3m"].completeBarCount,80);
 assert.equal(x.intervalData["5m"].completeBarCount,48);
 assert.equal(x.intervalData["15m"].completeBarCount,16);
 assert.equal(x.intervalData["30m"].completeBarCount,8);
 assert.equal(x.intervalData["1h"].completeBarCount,4);
 assert.equal(x.intervalData["4h"].completeBarCount,1);
 const r=x.intervalData["5m"].bars[0];
 assert.equal(r.startMs,d);
 assert.equal(r.endMs,d+5*MIN);
 assert.equal(r.availableAtMs,d+5*MIN);
 assert.equal(r.open,100);
 assert.equal(r.high,108);
 assert.equal(r.low,99);
 assert.equal(r.close,105);
 assert.equal(r.volume,60);
 assert.equal(r.derivedFromClosedOneMinuteBars,5);
 assert.equal(x.actualMarketWideOpportunityCount,null);
 assert.equal(x.trueMarketWideRecall,null);
 assert.equal(x.firstCrossingTickTimeEstablished,false);
 assert.equal(x.executionAuthority,"NONE");
});
test("24h crypto UTC 1d bar requires all 1440 closed minutes, not only an hourly quote",()=>{
 const m="CRYPTO_FUTURES",data=bars(m,d,1440);
 const x=run(m,d,d+DAY,data,{timeframes:["1d"],asOfMs:d+DAY});
 assert.equal(x.intervalData["1d"].completeBarCount,1);
 assert.equal(x.intervalData["1d"].bars[0].derivedFromClosedOneMinuteBars,1440);
 assert.equal(x.intervalData["1d"].sourceSessionCoverageComplete,true);
 assert.equal(x.profitabilityProven,false);
});
test("KRX and US regular sessions anchor 60m/240m from official session START not UTC midnight",()=>{
 const starts={
  KR_STOCK:Date.parse("2026-09-18T00:00:00Z"),// 09:00 KST
  US_STOCK:Date.parse("2026-09-18T13:30:00Z"),// 09:30 ET (DST)
 };
 for(const m of ["KR_STOCK","US_STOCK"]){
  const start=starts[m],length=390;
  const x=run(m,start,start+length*MIN,bars(m,start,length),{
   timeframes:["5m","1h","4h"]});
  assert.equal(x.intervalData["5m"].completeBarCount,78);
  assert.equal(x.intervalData["1h"].completeBarCount,6);
  assert.equal(x.intervalData["4h"].completeBarCount,1);
  assert.equal(x.intervalData["1h"].bars[0].startMs,start);
  assert.equal(x.intervalData["4h"].bars[0].startMs,start);
  assert.equal(x.intervalData["4h"].partialSessionTailMinutes,150);
  assert.equal(x.intervalData["4h"].sourceSessionCoverageComplete,false);
  assert.equal(x.stockExchangeSessionIndependentlyVerified,false);
 }
});
test("US session crossing a daylight-saving boundary is never inferred from the wall-clock hour",()=>{
 const start=Date.parse("2026-01-12T14:30:00Z");// 09:30 EST
 const m="US_STOCK";
 const x=run(m,start,start+390*MIN,bars(m,start,390),{timeframes:["1h"]});
 assert.equal(x.intervalData["1h"].bars[0].startMs,start);
 assert.equal(x.intervalData["1h"].bars[0].endMs,start+60*MIN);
 assert.equal(x.intervalData["1h"].completeBarCount,6);
});
test("missing or duplicate 1m input cannot silently fabricate higher candles",()=>{
 const m="CRYPTO_SPOT",input=bars(m,d,10);
 const sparse=input.filter(x=>x.timestampMs!==d+2*MIN);
 const x=run(m,d,d+DAY,sparse,{timeframes:["5m"],asOfMs:d+10*MIN});
 assert.equal(x.intervalData["5m"].completeBarCount,1);
 assert.equal(x.intervalData["5m"].missingUnverifiedSourceBuckets,1);
 assert.equal(x.intervalData["5m"].missingPreview[0].missingOneMinuteCount,1);
 assert.equal(x.status,"SOURCE_LIMITED_PARTIAL_MULTI_TIMEFRAME_BARS");
 assert.equal(x.firstCrossingTickTimeEstablished,false);
 const duplicate=[...input.slice(0,2),input[1],...input.slice(2)];
 assert.equal(run(m,d,d+DAY,duplicate).reason,
  "MULTITIMEFRAME_ORIGINAL_ONE_MINUTE_BAR_INVALID");
});
test("open/as-of-unavailable candles remain excluded until all bars are published",()=>{
 const m="CRYPTO_SPOT",input=bars(m,d,10);
 input[4].availableAtMs=d+11*MIN;
 const early=run(m,d,d+DAY,input,{
  timeframes:["5m"],asOfMs:d+10*MIN});
 assert.equal(early.intervalData["5m"].completeBarCount,1);
 assert.equal(early.intervalData["5m"].barDataUnavailableAtCutoffBuckets,1);
 const stop=run(m,d,d+DAY,input,{
  timeframes:["5m"],asOfMs:d+4*MIN});
 assert.equal(stop.intervalData["5m"].completeBarCount,0);
 assert.equal(stop.intervalData["5m"].notYetClosedBuckets,288);
 const later=run(m,d,d+DAY,input,{
  timeframes:["5m"],asOfMs:d+11*MIN});
 assert.equal(later.intervalData["5m"].completeBarCount,2);
});
test("raw minute source digest and market/venue identities fail closed",()=>{
 const m="CRYPTO_SPOT",input=bars(m,d,5);
 const base={
  market:m,venue:venue(m),symbol:"KRW-ABC",
  sourceId:"TEST_PRIVATE_MINUTE_SOURCE",minuteBars:input,
  sourceMinuteRowsSha256:digest(input),
  session:session(m,d,d+DAY),asOfMs:d+5*MIN,timeframes:["5m"],
 };
 assert.equal(derive({...base,sourceMinuteRowsSha256:"f".repeat(64)}).reason,
  "MULTITIMEFRAME_MINUTE_ROWS_MISSING_OR_DIGEST_CHANGED");
 assert.equal(derive({...base,venue:"BINANCE_SPOT"}).reason,
  "MULTITIMEFRAME_MARKET_SYMBOL_SOURCE_INVALID");
 const cross=[...input];
 cross[2]={...cross[2],symbol:"KRW-DEF"};
 assert.equal(derive({...base,minuteBars:cross,
  sourceMinuteRowsSha256:digest(cross)}).reason,
  "MULTITIMEFRAME_ORIGINAL_ONE_MINUTE_BAR_INVALID");
});
test("custom seven-minute chart is possible but tail minutes are reported, never converted",()=>{
 const m="CRYPTO_SPOT",data=bars(m,d,60);
 const x=run(m,d,d+DAY,data,{timeframes:["7m"],asOfMs:d+60*MIN});
 assert.equal(x.intervalData["7m"].completeBarCount,8);
 assert.equal(x.intervalData["7m"].bars[0].derivedFromClosedOneMinuteBars,7);
 assert.equal(x.intervalData["7m"].bars[7].close,156);
 assert.equal(x.intervalData["7m"].notYetClosedBuckets>0,true);
 assert.equal(x.actualFillCount,null);
});
test("reject unsupported intraday intervals and stock 1d without corporate-action/session daily source",()=>{
 const m="KR_STOCK",start=d;
 assert.throws(()=>run(m,start,start+390*MIN,bars(m,start,390),{
  timeframes:["1d"]}),/STOCK_DAILY_REQUIRES_OFFICIAL_SESSION_AND_CORPORATE_ACTION_BARS/);
 assert.throws(()=>run("CRYPTO_SPOT",d,d+DAY,bars("CRYPTO_SPOT",d,5),{
  timeframes:["2000m"]}),/RESEARCH_INTERVAL_UNSUPPORTED/);
 assert.throws(()=>run("CRYPTO_SPOT",d,d+DAY,bars("CRYPTO_SPOT",d,5),{
  timeframes:["5m","5m"]}),/RESEARCH_MULTITIMEFRAME_SELECTION_INVALID/);
});
