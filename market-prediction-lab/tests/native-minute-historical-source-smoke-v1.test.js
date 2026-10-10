import test from "node:test";
import assert from "node:assert/strict";
import { BitgetPublicApiError } from "../src/bitget-public-client.js";
import { auditNativeObservedMinuteWindowV1 } from "../src/historical-intraday-opportunity-audit-v1.js";
import { HISTORICAL_SAMPLE_WINDOW_V1, classifyPublicSourceFailure,
  safeNativeSampleResult, probeNativeMinuteHistoricalV1 } from "../scripts/probe-native-minute-historical-v1.mjs";

function fullMinuteFixtures({
  market="CRYPTO_SPOT", upPct=0, downPct=0, spikeAt=25,
}={}) {
  const {startMs,endMs}=HISTORICAL_SAMPLE_WINDOW_V1;
  const candles=Array.from({length:(endMs-startMs)/60_000},(_,i)=>({
    timestamp:startMs+i*60_000,
    open:100,high:100,low:100,close:100,volume:1,
  }));
  const candle=candles[spikeAt];
  candle.high=100*(1+upPct/100);
  candle.low=100*(1-downPct/100);
  return {
    historicalSignalAvailabilityProven:false,
    actualFillProven:false,
    rawPageWindowTraversed:true,
    source:market==="CRYPTO_SPOT"?"upbit-public-candles":undefined,
    provider:market==="CRYPTO_FUTURES"?"bitget-public-v2":undefined,
    providerMarket:market==="CRYPTO_SPOT"?"KRW-BTC":undefined,
    symbol:market==="CRYPTO_SPOT"?"BTC":"BTCUSDT",
    candles,
  };
}

test("historical minute fixture remains sample-only with no scan/fill/PIT promotion",()=>{
  const s=HISTORICAL_SAMPLE_WINDOW_V1.startMs;
  const sample=safeNativeSampleResult("CRYPTO_SPOT","UPBIT_KRW",fullMinuteFixtures());
  assert.equal(sample.status,"OBSERVED_SAMPLE_ONLY");
  assert.equal(sample.candleCount,120);
  assert.equal(sample.minuteOpportunityWindow.status,"OBSERVED_WINDOW_ONLY");
  assert.equal(sample.minuteOpportunityWindow.observedCrossingCount,0);
  assert.equal(sample.minuteOpportunityWindow.baselineDefinition,
    "FIRST_OBSERVED_WINDOW_OPEN_NOT_PREVIOUS_DAY_CLOSE");
  assert.equal(sample.timeAvailableToScannerProven,false);
  assert.equal(sample.historicalListingMembershipProven,false);
  assert.equal(sample.trueMarketWideRecall,null);
  assert.equal(sample.netReturnPct,null);
});

test("untraversed historical 1m window is not an observed sample",()=>{
  assert.throws(()=>safeNativeSampleResult("CRYPTO_FUTURES","BITGET_USDT_FUTURES",{
    ...fullMinuteFixtures({market:"CRYPTO_FUTURES"}),rawPageWindowTraversed:false,
  }),/SAMPLE_TRUTH_BOUNDARY_INVALID/);
});

test("public API outage differs from implementation and parsing errors",()=>{
  assert.equal(classifyPublicSourceFailure(new BitgetPublicApiError("Bitget blocked")), "BLOCKED_DATA");
  assert.equal(classifyPublicSourceFailure(new Error("UPBIT_HISTORY_HTTP_451")),"BLOCKED_DATA");
  assert.equal(classifyPublicSourceFailure(new Error("BITGET_HISTORY_RANGE_INCOMPLETE")),"BLOCKED_DATA");
  assert.equal(classifyPublicSourceFailure(new TypeError("undefined is not a function")),"UNEXPECTED_CODE_FAILURE");
});

test("two provider outages leave all 4 markets BLOCKED_DATA, never zero PnL",async()=>{
  const result=await probeNativeMinuteHistoricalV1({
    upbitFetch:async()=>({ok:false,status:451}),
    bitgetClient:{get:async()=>{throw new BitgetPublicApiError("Bitget public blocked")}},
  });
  assert.equal(result.sourceStatus,"BLOCKED_DATA");
  assert.equal(result.observedSourceCount,0);
  assert.equal(Object.values(result.markets).every(row=>row.status==="BLOCKED_DATA"),true);
  assert.equal(result.markets.CRYPTO_SPOT.candleCount,null);
  assert.equal(result.markets.CRYPTO_FUTURES.netReturnPct,null);
  assert.equal(result.profitabilityProven,false);
  assert.equal(result.executionAuthority,"NONE");
});


test("observed native 1m +5/+10/+20 threshold produces bounded T0 only",()=>{
  const {startMs,endMs}=HISTORICAL_SAMPLE_WINDOW_V1;
  const sample=fullMinuteFixtures({upPct:22,spikeAt:90});
  const result=auditNativeObservedMinuteWindowV1({
    market:"CRYPTO_SPOT",venue:"UPBIT_KRW",source:sample.source,
    symbol:"KRW-BTC",startMs,endMs,bars:sample.candles,pageWindowTraversed:true,
  });
  assert.equal(result.status,"OBSERVED_WINDOW_ONLY");
  assert.deepEqual(result.opportunities.map(o=>o.thresholdPct),[5,10,20]);
  assert.ok(result.opportunities.every(o=>o.direction==="LONG"));
  assert.equal(result.opportunities[1].firstCrossingBarStartMs,startMs+90*60_000);
  assert.equal(result.opportunities[1].firstCrossingBarEndMs,startMs+91*60_000);
  assert.equal(result.opportunities[1].exactTradeTimestampMs,null);
  const t60=result.opportunities[1].tMinusObservedReconstruction.T_MINUS_60;
  assert.equal(t60.barStartMs,startMs+29*60_000);
  assert.equal(t60.asOfScannerAvailabilityVerified,false);
  assert.equal(result.trueMarketWideRecall,null);
  assert.equal(result.realFillCount,null);
  assert.equal(result.netProfitPct,null);
});

test("Bitget sample permits futures SHORT crossing without inventing fill",()=>{
  const {startMs,endMs}=HISTORICAL_SAMPLE_WINDOW_V1;
  const sample=fullMinuteFixtures({market:"CRYPTO_FUTURES",downPct:21,spikeAt:80});
  const result=auditNativeObservedMinuteWindowV1({
    market:"CRYPTO_FUTURES",venue:"BITGET_USDT_FUTURES",source:sample.provider,
    symbol:"BTCUSDT",startMs,endMs,bars:sample.candles,pageWindowTraversed:true,
  });
  assert.equal(result.observedCrossingCount,3);
  assert.ok(result.opportunities.every(e=>e.direction==="SHORT"));
  assert.equal(result.historicalScannerAsOfAvailabilityVerified,false);
  assert.equal(result.costAdjustedProfitabilityProven,false);
});

test("one missing source minute blocks event count, not claims zero opportunities",()=>{
  const sample=fullMinuteFixtures({upPct:22});
  sample.candles.splice(42,1);
  const result=auditNativeObservedMinuteWindowV1({
    market:"CRYPTO_SPOT",venue:"UPBIT_KRW",source:sample.source,
    symbol:"KRW-BTC",
    ...HISTORICAL_SAMPLE_WINDOW_V1,
    bars:sample.candles,pageWindowTraversed:true,
  });
  assert.equal(result.status,"BLOCKED_DATA");
  assert.equal(result.reason,"SAMPLE_MINUTE_COVERAGE_INCOMPLETE");
  assert.equal(result.observedOpportunityCount,null);
  assert.equal(result.trueMarketWideRecall,null);
});

test("falsely shifted/duplicate 1m candles fail even when bar count is unchanged",()=>{
  const {startMs,endMs}=HISTORICAL_SAMPLE_WINDOW_V1;
  const sample=fullMinuteFixtures();
  sample.candles[10].timestamp=sample.candles[9].timestamp;
  const result=auditNativeObservedMinuteWindowV1({
    market:"CRYPTO_SPOT",venue:"UPBIT_KRW",source:sample.source,
    symbol:"KRW-BTC",startMs,endMs,bars:sample.candles,pageWindowTraversed:true,
  });
  assert.equal(result.reason,"SAMPLE_MINUTE_PRICE_OR_TIMESTAMP_INVALID");
});

test("cross-venue historical substitution is always BLOCKED_DATA",()=>{
  const {startMs,endMs}=HISTORICAL_SAMPLE_WINDOW_V1;
  const sample=fullMinuteFixtures();
  const result=auditNativeObservedMinuteWindowV1({
    market:"CRYPTO_SPOT",venue:"BITGET_USDT_FUTURES",source:sample.source,
    symbol:"KRW-BTC",startMs,endMs,bars:sample.candles,pageWindowTraversed:true,
  });
  assert.equal(result.status,"BLOCKED_DATA");
  assert.equal(result.reason,"SAMPLE_SOURCE_PROVENANCE_OR_WINDOW_INVALID");
});
