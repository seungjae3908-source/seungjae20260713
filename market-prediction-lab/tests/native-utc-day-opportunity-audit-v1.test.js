import test from "node:test";
import assert from "node:assert/strict";
import { BitgetPublicApiError } from "../src/bitget-public-client.js";
import { auditNativeObservedMinuteWindowV1 as audit } from "../src/historical-intraday-opportunity-audit-v1.js";
import { UTC_DAY_SAMPLE_V1, nativeDayResultFromCollectedV1,
  probeNativeUtcDayHistoricalV1 } from "../scripts/probe-native-utc-day-historical-v1.mjs";
const M=60_000, H=60, DAY=1440;
const start=UTC_DAY_SAMPLE_V1.utcDayStartMs;
function rows({market="CRYPTO_SPOT", priorClose=100, dayOpen=104, spike=105.5,
  dip=100, spikeAt=10}={}) {
  const items=Array.from({length:H+DAY},(_,i)=>{
    const timestamp=start-H*M+i*M;
    const p=i<H?priorClose:dayOpen;
    return {timestamp,open:p,high:p,low:p,close:p,volume:100};
  });
  items[H+spikeAt].high=Math.max(dayOpen,spike);
  items[H+spikeAt].low=Math.min(dayOpen,dip);
  return {
    market, timeframe:"1m", intervalMs:M, rawPageWindowTraversed:true,
    historicalSignalAvailabilityProven:false,actualFillProven:false,
    source:market==="CRYPTO_SPOT"?"upbit-public-candles":undefined,
    provider:market==="CRYPTO_FUTURES"?"bitget-public-v2":undefined,
    exchange:market==="CRYPTO_SPOT"?"UPBIT":undefined,
    providerMarket:market==="CRYPTO_SPOT"?"KRW-BTC":undefined,
    symbol:market==="CRYPTO_SPOT"?"BTC":"BTCUSDT",
    requestedStartTime:start-H*M,requestedEndTime:start+DAY*M,
    candles:items,
  };
}
test("prior UTC day final minute close, not same-day opening trade, is baseline",()=>{
  const c=rows({spike:105.5});
  const r=nativeDayResultFromCollectedV1("CRYPTO_SPOT","UPBIT_KRW",c);
  assert.equal(r.status,"OBSERVED_DAY_ONLY");
  assert.equal(r.previousUtcClose,100);
  assert.ok(Math.abs(r.openingGapPct-4)<1e-10);
  assert.equal(r.observedMinuteCount,1440);
  assert.equal(r.priorHourObservedMinuteCount,60);
  assert.equal(r.observedDayCrossingCount,1);
  const hit=r.opportunities[0];
  assert.equal(hit.thresholdPct,5);
  assert.equal(hit.direction,"LONG");
  assert.equal(hit.firstCrossingBarStartMs,start+10*M);
  assert.equal(hit.firstCrossingBarEndMs,start+11*M);
  assert.equal(hit.exactTradeTimestampMs,null);
  assert.equal(hit.firstSeenByHistoricalScannerAtMs,null);
  const t60=hit.tMinusObservedReconstruction.T_MINUS_60;
  assert.equal(t60.barStartMs,start-51*M);
  assert.equal(t60.asOfScannerAvailabilityVerified,false);
  assert.equal(r.trueMarketWideRecall,null);
  assert.equal(r.actualFillCount,null);
  assert.equal(r.netProfitPct,null);
  assert.equal(r.executionAuthority,"NONE");
});
test("opening gap already past threshold is NOT a credited advance signal",()=>{
  const r=nativeDayResultFromCollectedV1("CRYPTO_SPOT","UPBIT_KRW",
    rows({dayOpen:107,spike:107,dip:107}));
  const hit=r.opportunities.find(x=>x.thresholdPct===5);
  assert.equal(hit.openedAlreadyBeyondThreshold,true);
  assert.equal(hit.firstCrossingBarStartMs,start);
  assert.equal(r.historicalScannerAsOfAvailabilityVerified,false);
});
test("futures short -5/-10/-20 distinguishes directions with no stock/spot SHORT",()=>{
  const fut=rows({market:"CRYPTO_FUTURES",dayOpen:100,dip:79,spike:100});
  const r=nativeDayResultFromCollectedV1("CRYPTO_FUTURES","BITGET_USDT_FUTURES",fut);
  assert.equal(r.status,"OBSERVED_DAY_ONLY");
  assert.deepEqual(r.opportunities.map(e=>e.direction),["SHORT","SHORT","SHORT"]);
  assert.deepEqual(r.opportunities.map(e=>e.thresholdPct),[5,10,20]);
  assert.equal(r.actualFillCount,null);
  const spot=nativeDayResultFromCollectedV1("CRYPTO_SPOT","UPBIT_KRW",
    rows({dayOpen:100,dip:79,spike:100}));
  assert.equal(spot.observedDayCrossingCount,0);
});
test("missing prior UTC final minute blocks rather than guessing prior close",()=>{
  const v=rows();
  v.candles.splice(59,1);
  const r=nativeDayResultFromCollectedV1("CRYPTO_SPOT","UPBIT_KRW",v);
  assert.equal(r.status,"BLOCKED_DATA");
  assert.equal(r.previousUtcClose,null);
  assert.equal(r.observedDayCrossingCount,null);
});
test("missing in-day 1m candle blocks instead of treating it as no trades",()=>{
  const v=rows();v.candles.splice(60+300,1);
  const r=nativeDayResultFromCollectedV1("CRYPTO_SPOT","UPBIT_KRW",v);
  assert.equal(r.status,"BLOCKED_DATA");
  assert.equal(r.trueMarketWideRecall,null);
});
test("bad prior close OHLC and bad prior timestamp fail closed",()=>{
  const v=rows();v.candles[59].close=-1;
  assert.equal(nativeDayResultFromCollectedV1("CRYPTO_SPOT","UPBIT_KRW",v).status,"BLOCKED_DATA");
  const w=rows();w.candles[59].timestamp+=M;
  assert.equal(nativeDayResultFromCollectedV1("CRYPTO_SPOT","UPBIT_KRW",w).status,"BLOCKED_DATA");
});
test("bad provider / venue / private metadata cannot be promoted",()=>{
  const v=rows();
  assert.equal(nativeDayResultFromCollectedV1("CRYPTO_SPOT","BITGET_USDT_FUTURES",v).status,"BLOCKED_DATA");
  const y={...v,rawPageWindowTraversed:false};
  assert.equal(nativeDayResultFromCollectedV1("CRYPTO_SPOT","UPBIT_KRW",y).status,"BLOCKED_DATA");
  const x={...v,historicalSignalAvailabilityProven:true};
  assert.equal(nativeDayResultFromCollectedV1("CRYPTO_SPOT","UPBIT_KRW",x).status,"BLOCKED_DATA");
});
test("all 4 market outage receipts preserve NULL not fake 0% PnL",async()=>{
  const r=await probeNativeUtcDayHistoricalV1({
    upbitFetch:async()=>({ok:false,status:451}),
    bitgetClient:{get:async()=>{throw new BitgetPublicApiError("public network unavailable");}},
  });
  assert.equal(r.profitabilityProven,false);
  assert.equal(r.executionAuthority,"NONE");
  assert.equal(r.markets.KR_STOCK.status,"BLOCKED_DATA");
  assert.equal(r.markets.US_STOCK.status,"BLOCKED_DATA");
  assert.equal(r.markets.CRYPTO_SPOT.status,"BLOCKED_DATA");
  assert.equal(r.markets.CRYPTO_FUTURES.status,"BLOCKED_DATA");
  assert.equal(r.markets.CRYPTO_FUTURES.netProfitPct,null);
  assert.equal(r.fullMarketOpportunityDenominatorVerified,false);
});
test("two-hour sample still uses its original window-open baseline",()=>{
  const v=rows();
  const reduced=v.candles.slice(60,180);
  const r=audit({
    market:"CRYPTO_SPOT",venue:"UPBIT_KRW",source:"upbit-public-candles",
    symbol:"KRW-BTC",startMs:start,endMs:start+120*M,bars:reduced,pageWindowTraversed:true,
  });
  assert.equal(r.status,"OBSERVED_WINDOW_ONLY");
  assert.equal(r.baselineDefinition,"FIRST_OBSERVED_WINDOW_OPEN_NOT_PREVIOUS_DAY_CLOSE");
  assert.equal(r.baselinePrice,104);
});
