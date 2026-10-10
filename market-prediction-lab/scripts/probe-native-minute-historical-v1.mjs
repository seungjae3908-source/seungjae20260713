#!/usr/bin/env node
/**
 * Small, historical read-only public-source probe for 1m candles.
 * This is NOT the 3-year PIT-universe dataset, historical scanner observation
 * availability, validated absence of trades, actual quotes, or ROI evidence.
 * Never uses credentials, LIVE/AUTO, private account APIs, or order endpoints.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectUpbitSpotHistory } from "../src/upbit-spot-history.js";
import { BitgetPublicClient, BitgetPublicApiError } from "../src/bitget-public-client.js";
import { collectBitgetCandles } from "../src/bitget-candle-collector.js";
import { auditNativeObservedMinuteWindowV1 } from "../src/historical-intraday-opportunity-audit-v1.js";

export const HISTORICAL_SAMPLE_WINDOW_V1 = Object.freeze({
  startMs: Date.parse("2025-01-02T00:00:00Z"),
  endMs: Date.parse("2025-01-02T02:00:00Z"),
});
const SOURCE_LIMITS = Object.freeze({ upbitPages:4, maxBitgetCandles:500 });

export function classifyPublicSourceFailure(error) {
  const msg=String(error?.message ?? error);
  if (error instanceof BitgetPublicApiError
      || /^UPBIT_HISTORY_HTTP_\d{3}$/.test(msg)
      || /^UPBIT_HISTORY_(RANGE_INCOMPLETE|INSUFFICIENT_\d+)$/.test(msg)
      || /^BITGET_HISTORY_RANGE_INCOMPLETE$/.test(msg)
      || /^not enough candles collected: \d+$/.test(msg)
      || /^(?:fetch failed|network|timeout|request timeout)/i.test(msg)) {
    return "BLOCKED_DATA";
  }
  return "UNEXPECTED_CODE_FAILURE";
}

export function safeNativeSampleResult(market, venue, collected) {
  if (collected?.historicalSignalAvailabilityProven !== false
      || collected?.actualFillProven !== false
      || collected?.rawPageWindowTraversed !== true
      || !Number.isSafeInteger(collected?.candles?.length)
      || collected.candles.length < 2) throw new Error("SAMPLE_TRUTH_BOUNDARY_INVALID");
  const {startMs,endMs}=HISTORICAL_SAMPLE_WINDOW_V1;
  const count=collected.candles.filter(x=>
    Number.isSafeInteger(x.timestamp) && x.timestamp>=startMs && x.timestamp<endMs).length;
  if (count < 2) throw new Error("SAMPLE_HISTORICAL_WINDOW_EMPTY");
  const minuteOpportunityWindow=auditNativeObservedMinuteWindowV1({
    market,venue,source:collected.source ?? collected.provider,
    symbol:collected.providerMarket ?? collected.symbol,
    startMs,endMs,bars:collected.candles,pageWindowTraversed:collected.rawPageWindowTraversed,
  });
  // Source-limited events require a closed continuous minute window. Missing
  // minute gaps cannot be relabeled as no-trade or hidden by a successful HTTP.
  if (minuteOpportunityWindow.status!=="OBSERVED_WINDOW_ONLY")
    throw new Error("SAMPLE_MINUTE_AUDIT_BLOCKED:"+minuteOpportunityWindow.reason);
  return Object.freeze({
    market,venue,status:"OBSERVED_SAMPLE_ONLY",
    candleCount:count,source:collected.source ?? collected.provider,
    timeframe:"1m",
    firstTimestampMs:collected.candles[0].timestamp,
    lastTimestampMs:collected.candles.at(-1).timestamp,
    requestedStartMs:startMs,requestedEndMs:endMs,
    rawPageWindowTraversed:true,
    minuteOpportunityWindow,
    observedWindowCrossingCount:minuteOpportunityWindow.observedCrossingCount,
    historicalListingMembershipProven:false,
    timeAvailableToScannerProven:false,
    missingMinuteNoTradesProven:false,
    trueMarketWideRecall:null,fillCount:null,netReturnPct:null,
  });
}
function blockedMarket(market,venue,reason) {
  return Object.freeze({
    market,venue,status:"BLOCKED_DATA",reason,
    candleCount:null,observedOpportunityCount:null,
    trueMarketWideRecall:null,fillCount:null,netReturnPct:null,
  });
}

export async function probeNativeMinuteHistoricalV1({
  upbitFetch=globalThis.fetch,
  bitgetClient=new BitgetPublicClient({maxRetries:1,minIntervalMs:150,timeoutMs:10_000}),
}={}) {
  const {startMs,endMs}=HISTORICAL_SAMPLE_WINDOW_V1;
  const markets={
    KR_STOCK:blockedMarket("KR_STOCK","KRX","HISTORICAL_PIT_ONE_MINUTE_FEED_NOT_ATTACHED"),
    US_STOCK:blockedMarket("US_STOCK","US_SIP","HISTORICAL_PIT_SIP_ONE_MINUTE_FEED_NOT_ATTACHED"),
  };
  try {
    const spot=await collectUpbitSpotHistory({
      symbol:"KRW-BTC",timeframe:"1m",
      startTime:startMs,endTime:endMs,maxPages:SOURCE_LIMITS.upbitPages,
      minCandles:2,minIntervalMs:200,requireFullWindow:true,
      fetchImpl:upbitFetch,signal:AbortSignal.timeout(20_000),
    });
    markets.CRYPTO_SPOT=safeNativeSampleResult("CRYPTO_SPOT","UPBIT_KRW",spot);
  } catch (error) {
    if(classifyPublicSourceFailure(error)!=="BLOCKED_DATA") throw error;
    markets.CRYPTO_SPOT=blockedMarket("CRYPTO_SPOT","UPBIT_KRW",
      String(error.message ?? error).slice(0,120));
  }
  try {
    const futures=await collectBitgetCandles({
      client:bitgetClient,market:"CRYPTO_FUTURES",symbol:"BTCUSDT",
      timeframe:"1m",startTime:startMs,endTime:endMs,
      maxCandles:SOURCE_LIMITS.maxBitgetCandles,minCandles:2,requireFullWindow:true,
    });
    markets.CRYPTO_FUTURES=safeNativeSampleResult("CRYPTO_FUTURES","BITGET_USDT_FUTURES",futures);
  } catch(error) {
    if(classifyPublicSourceFailure(error)!=="BLOCKED_DATA") throw error;
    markets.CRYPTO_FUTURES=blockedMarket("CRYPTO_FUTURES","BITGET_USDT_FUTURES",
      String(error.message ?? error).slice(0,120));
  }
  const observed=Object.values(markets).filter(v=>v.status==="OBSERVED_SAMPLE_ONLY").length;
  return Object.freeze({
    schemaVersion:"native-historical-minute-public-sample-v1",
    sampledWindow:HISTORICAL_SAMPLE_WINDOW_V1,
    sourceStatus:observed===0?"BLOCKED_DATA":"PARTIAL_SOURCE_OBSERVATION",
    observedSourceCount:observed,
    markets,
    marketWideOpportunityDenominatorVerified:false,
    intradayFirstCrossingVerified:false,
    historicalScannerAvailabilityVerified:false,
    actualFillEvidenceVerified:false,
    fullCostVerified:false,
    OOSPassCount:0,
    profitabilityProven:false,
    executionAuthority:"NONE",
    liveTrading:false,autoTrading:false,realOrders:false,
    privateApiRequests:false,
  });
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=await probeNativeMinuteHistoricalV1();
  const output=resolve(process.argv[2] ??
    "market-prediction-lab/docs/native-historical-minute-source-smoke-v1.json");
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify(result,null,2)+"\n",{encoding:"utf8",mode:0o600});
  process.stdout.write(JSON.stringify({
    sourceStatus:result.sourceStatus,observedSourceCount:result.observedSourceCount,
    markets:Object.fromEntries(Object.entries(result.markets).map(([key,value])=>[key,{
      status:value.status,reason:value.reason ?? null,candleCount:value.candleCount,
      observedWindowCrossingCount:value.observedWindowCrossingCount ?? null,
    }])),profitabilityProven:false,executionAuthority:"NONE",
  })+"\n");
}
