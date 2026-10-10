import test from "node:test";
import assert from "node:assert/strict";
import { BitgetPublicApiError } from "../src/bitget-public-client.js";
import { HISTORICAL_SAMPLE_WINDOW_V1, classifyPublicSourceFailure,
  safeNativeSampleResult, probeNativeMinuteHistoricalV1 } from "../scripts/probe-native-minute-historical-v1.mjs";

test("historical minute fixture remains sample-only with no scan/fill/PIT promotion",()=>{
  const s=HISTORICAL_SAMPLE_WINDOW_V1.startMs;
  const sample=safeNativeSampleResult("CRYPTO_SPOT","UPBIT_KRW",{
    historicalSignalAvailabilityProven:false,actualFillProven:false,
    rawPageWindowTraversed:true,source:"upbit-public-candles",
    candles:[{timestamp:s},{timestamp:s+60_000}],
  });
  assert.equal(sample.status,"OBSERVED_SAMPLE_ONLY");
  assert.equal(sample.candleCount,2);
  assert.equal(sample.timeAvailableToScannerProven,false);
  assert.equal(sample.historicalListingMembershipProven,false);
  assert.equal(sample.trueMarketWideRecall,null);
  assert.equal(sample.netReturnPct,null);
});

test("untraversed historical 1m window is not an observed sample",()=>{
  const s=HISTORICAL_SAMPLE_WINDOW_V1.startMs;
  assert.throws(()=>safeNativeSampleResult("CRYPTO_FUTURES","BITGET_USDT_FUTURES",{
    historicalSignalAvailabilityProven:false,actualFillProven:false,
    rawPageWindowTraversed:false,candles:[{timestamp:s},{timestamp:s+60_000}],
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
