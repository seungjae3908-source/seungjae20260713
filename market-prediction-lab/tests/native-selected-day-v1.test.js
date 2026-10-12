import test from "node:test";
import assert from "node:assert/strict";
import {SELECTED_NATIVE_DAY_PILOT_V1, summarizeSelectedNativeUtcDayV1,
  probeSelectedNativeUtcDayV1} from "../scripts/probe-native-selected-day-v1.mjs";
const start=SELECTED_NATIVE_DAY_PILOT_V1.historyStartMs;
const end=SELECTED_NATIVE_DAY_PILOT_V1.endMs;
const MIN=60_000;
function make(market,symbol,{dropIndex=null,spike=0,low=0}={}){
  const candles=Array.from({length:(end-start)/MIN},(_,i)=>{
    const p=i<60?100:100;
    return {timestamp:start+i*MIN,open:p,close:p,
      high:p+(i===160?spike:0),low:p-(i===160?low:0),volume:10};
  });
  if(dropIndex!==null)candles.splice(dropIndex,1);
  return {
    market,timeframe:"1m",requestedStartTime:start,requestedEndTime:end,
    rawPageWindowTraversed:true,historicalSignalAvailabilityProven:false,
    actualFillProven:false,candles,
    ...(market==="CRYPTO_SPOT"?{
      source:"upbit-public-candles",exchange:"UPBIT",providerMarket:symbol,
      intervalMs:MIN,symbol:symbol.slice(4),
    }:{
      provider:"bitget-public-v2",symbol,
    }),
  };
}
test("Upbit selected ETH day produces observed source event not market-wide recall",()=>{
  const r=summarizeSelectedNativeUtcDayV1({
    market:"CRYPTO_SPOT",symbol:"KRW-ETH",
    collected:make("CRYPTO_SPOT","KRW-ETH",{spike:21}),
  });
  assert.equal(r.status,"OBSERVED_SELECTED_SYMBOL_DAY");
  assert.equal(r.minuteCount,1440);
  assert.deepEqual(r.opportunities.map(x=>x.thresholdPct),[5,10,20]);
  assert.equal(r.opportunities[0].firstCrossingBarStartMs,start+160*MIN);
  assert.equal(r.earlyDetectedCount,null);
  assert.equal(r.trueMarketWideRecall,null);
  assert.equal(r.netProfitPct,null);
});
test("Bitget selected ETH short remains SHORT and is never a filled trade",()=>{
  const r=summarizeSelectedNativeUtcDayV1({
    market:"CRYPTO_FUTURES",symbol:"ETHUSDT",
    collected:make("CRYPTO_FUTURES","ETHUSDT",{low:12}),
  });
  assert.equal(r.status,"OBSERVED_SELECTED_SYMBOL_DAY");
  assert.deepEqual(r.opportunities.map(x=>x.direction),["SHORT","SHORT"]);
  assert.equal(r.actualFillCount,null);
  assert.equal(r.costAdjustedProfitabilityProven,false);
});
test("post-hoc missing minute or source mismatch stays BLOCKED_DATA",()=>{
  const a=summarizeSelectedNativeUtcDayV1({
    market:"CRYPTO_SPOT",symbol:"KRW-XRP",
    collected:make("CRYPTO_SPOT","KRW-XRP",{dropIndex:900}),
  });
  assert.equal(a.status,"BLOCKED_DATA");
  assert.equal(a.observedDayCrossingCount,null);
  const b=summarizeSelectedNativeUtcDayV1({
    market:"CRYPTO_FUTURES",symbol:"SOLUSDT",
    collected:make("CRYPTO_FUTURES","ETHUSDT"),
  });
  assert.equal(b.status,"BLOCKED_DATA");
});
test("unsupported or excessive public symbol batches fail before source requests",async()=>{
  await assert.rejects(()=>probeSelectedNativeUtcDayV1({
    spotSymbols:["KRW-BTC","KRW-ETH","KRW-XRP","KRW-SOL","KRW-ADA"],
    futuresSymbols:[],upbitFetch:async()=>{throw Error("should not call network");},
  }),/BOUNDED_SELECTED_SYMBOLS_INVALID/);
  await assert.rejects(()=>probeSelectedNativeUtcDayV1({
    spotSymbols:["USDT-BTC"],futuresSymbols:[],
  }),/BOUNDED_SELECTED_SYMBOLS_INVALID/);
});
test("all-provider errors stay blocked and never turn into zero profit",async()=>{
  const r=await probeSelectedNativeUtcDayV1({
    spotSymbols:["KRW-ETH"],futuresSymbols:["ETHUSDT"],
    upbitFetch:async()=>({ok:false,status:451}),
    bitgetClient:{get:async()=>{throw new Error("fetch failed")}},
  });
  assert.equal(r.selectedSymbolCount,2);
  assert.equal(r.blockedSelectedSymbolDays,2);
  assert.equal(r.observedSymbolDays,0);
  assert.equal(r.markets.CRYPTO_SPOT[0].observedDayCrossingCount,null);
  assert.equal(r.markets.CRYPTO_FUTURES[0].observedDayCrossingCount,null);
  assert.equal(r.trueMarketWideRecall,null);
  assert.equal(r.profitabilityProven,false);
  assert.equal(r.executionAuthority,"NONE");
});
