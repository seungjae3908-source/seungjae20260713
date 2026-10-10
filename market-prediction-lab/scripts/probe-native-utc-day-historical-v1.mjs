#!/usr/bin/env node
/**
 * Bounded public historical UTC-day sample, NOT multi-year full-universe
 * backtest / as-of feed record / actual-fill evidence.
 * This date is a POST-HOC event-day demonstration, never an unbiased
 * train/test sample or an OOS strategy profitability claim.
 */
import { createHash } from "node:crypto";
import { mkdirSync,writeFileSync } from "node:fs";
import { dirname,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectUpbitSpotHistory } from "../src/upbit-spot-history.js";
import { BitgetPublicClient,BitgetPublicApiError } from "../src/bitget-public-client.js";
import { collectBitgetCandles } from "../src/bitget-candle-collector.js";
import { auditNativeObservedMinuteWindowV1 } from "../src/historical-intraday-opportunity-audit-v1.js";
import { classifyPublicSourceFailure } from "./probe-native-minute-historical-v1.mjs";

const MINUTE=60_000;
const UTC_DAY=86_400_000;
export const UTC_DAY_SAMPLE_V1=Object.freeze({
  utcDayStartMs:Date.parse("2025-02-03T00:00:00Z"),
  utcDayEndMs:Date.parse("2025-02-04T00:00:00Z"),
  historyStartMs:Date.parse("2025-02-02T23:00:00Z"),
  selection:"POST_HOC_EVENT_DAY_DEMONSTRATION_NOT_OOS",
  numberOfRequestedMinuteBars:1500,
});
function digestCandles(candles) {
  const hash=createHash("sha256");
  for(const row of candles)hash.update([
    row.timestamp,row.open,row.high,row.low,row.close,row.volume
  ].join(",")+"\n");
  return hash.digest("hex");
}
function blocked(market,venue,reason) {
  return Object.freeze({
    market,venue,status:"BLOCKED_DATA",reason,
    previousUtcClose:null,observedMinuteCount:null,
    observedDayCrossingCount:null,opportunities:null,rawCandleSha256:null,
    trueMarketWideRecall:null,actualFillCount:null,netProfitPct:null,
    executionAuthority:"NONE",
  });
}
export function nativeDayResultFromCollectedV1(market,venue,collected,selectedSymbol=null){
  const symbol=selectedSymbol ?? (market==="CRYPTO_SPOT"?"KRW-BTC":"BTCUSDT");
  if(typeof symbol!=="string" || !(market==="CRYPTO_SPOT"
     ? /^KRW-[A-Z0-9]{1,20}$/.test(symbol)
     : /^[A-Z0-9]{2,20}USDT$/.test(symbol)))
    return blocked(market,venue,"UTC_DAY_SELECTED_SYMBOL_INVALID");
  const source=market==="CRYPTO_SPOT"?"upbit-public-candles":"bitget-public-v2";
  const {historyStartMs,utcDayStartMs,utcDayEndMs}=UTC_DAY_SAMPLE_V1;
  if(!["CRYPTO_SPOT","CRYPTO_FUTURES"].includes(market)
     || venue!==(market==="CRYPTO_SPOT"?"UPBIT_KRW":"BITGET_USDT_FUTURES")
     || collected?.market!==market || collected?.timeframe!=="1m"
     || (market==="CRYPTO_SPOT"
        ? collected?.source!==source || collected?.exchange!=="UPBIT"
          || collected?.providerMarket!==symbol || collected?.intervalMs!==MINUTE
        : collected?.provider!==source || collected?.symbol!==symbol)
     || collected?.requestedStartTime!==historyStartMs
     || collected?.requestedEndTime!==utcDayEndMs
     || collected?.rawPageWindowTraversed!==true
     || collected?.historicalSignalAvailabilityProven!==false
     || collected?.actualFillProven!==false
     || !Array.isArray(collected?.candles)
     || collected.candles.length!==UTC_DAY_SAMPLE_V1.numberOfRequestedMinuteBars) {
    return blocked(market,venue,"UTC_DAY_SOURCE_OR_COUNT_NOT_ATTESTED");
  }
  const prior=collected.candles.slice(0,60);
  const day=collected.candles.slice(60);
  const audit=auditNativeObservedMinuteWindowV1({
    market,venue,source,symbol,
    startMs:utcDayStartMs,endMs:utcDayEndMs,
    bars:day,preWindowBars:prior,
    baselineMode:"PREVIOUS_UTC_DAY_LAST_MINUTE_CLOSE",
    pageWindowTraversed:true,
  });
  if(audit.status!=="OBSERVED_WINDOW_ONLY") {
    return blocked(market,venue,audit.reason ?? "UTC_DAY_AUDIT_BLOCKED");
  }
  return Object.freeze({
    market,venue,status:"OBSERVED_DAY_ONLY",symbol,
    utcDayStartMs,utcDayEndMs,
    source,provenanceSource:"NATIVE_HISTORICAL_PUBLIC_CLOSED_MINUTE_BARS",
    historicalEventSelection:UTC_DAY_SAMPLE_V1.selection,
    sourceAcquiredAfterDay:true,
    previousUtcClose:audit.baselinePrice,
    baselineDefinition:audit.baselineDefinition,
    priorUtcDayLastBarStartMs:audit.priorUtcDayFinalMinuteStartMs,
    priorHourObservedMinuteCount:audit.priorHourObservedMinuteCount,
    observedMinuteCount:audit.observedMinuteCount,
    missingMinuteCount:audit.missingMinuteCount,
    observedDayCrossingCount:audit.observedCrossingCount,
    openingGapPct:audit.openingGapPct,
    opportunities:audit.opportunities,
    rawCandleSha256:digestCandles(collected.candles),
    retrospectivePriceFirstCrossingIntervalsOnly:true,
    fullMarketListedAndDelistedUniverseProven:false,
    historicalScannerAsOfAvailabilityVerified:false,
    verifiedEarlyDetectionRecall:null,trueMarketWideRecall:null,
    actualFillCount:null,netProfitPct:null,
    OOSPass:false,profitabilityProven:false,
    executionAuthority:"NONE",liveTrading:false,realOrders:false,
  });
}
export async function probeNativeUtcDayHistoricalV1({
  upbitFetch=globalThis.fetch,
  bitgetClient=new BitgetPublicClient({minIntervalMs:160,maxRetries:1,timeoutMs:12_000}),
}={}){
  const {historyStartMs,utcDayEndMs}=UTC_DAY_SAMPLE_V1;
  const markets={
    KR_STOCK:blocked("KR_STOCK","KRX","PIT_HISTORICAL_1M_STOCK_PROVIDER_NOT_CONNECTED"),
    US_STOCK:blocked("US_STOCK","US_SIP","PIT_HISTORICAL_CONSOLIDATED_SIP_1M_NOT_CONNECTED"),
  };
  const raw={};
  try {
    const x=await collectUpbitSpotHistory({
      symbol:"KRW-BTC",timeframe:"1m",startTime:historyStartMs,endTime:utcDayEndMs,
      maxPages:12,minCandles:2,minIntervalMs:180,requireFullWindow:true,
      fetchImpl:upbitFetch,signal:AbortSignal.timeout(55_000),
    });
    const r=nativeDayResultFromCollectedV1("CRYPTO_SPOT","UPBIT_KRW",x);
    markets.CRYPTO_SPOT=r;
    if(r.status==="OBSERVED_DAY_ONLY")raw.CRYPTO_SPOT={
      market:r.market,venue:r.venue,symbol:r.symbol,source:r.source,
      acquiredAtMs:Date.now(),sourceWindow:{historyStartMs,utcDayEndMs},
      candleSha256:r.rawCandleSha256,candles:x.candles,
    };
  }catch(e){
    if(classifyPublicSourceFailure(e)!=="BLOCKED_DATA")throw e;
    markets.CRYPTO_SPOT=blocked("CRYPTO_SPOT","UPBIT_KRW",String(e.message).slice(0,140));
  }
  try {
    const x=await collectBitgetCandles({
      client:bitgetClient,market:"CRYPTO_FUTURES",symbol:"BTCUSDT",
      timeframe:"1m",startTime:historyStartMs,endTime:utcDayEndMs,
      maxCandles:1700,minCandles:2,requireFullWindow:true,
    });
    const r=nativeDayResultFromCollectedV1("CRYPTO_FUTURES","BITGET_USDT_FUTURES",x);
    markets.CRYPTO_FUTURES=r;
    if(r.status==="OBSERVED_DAY_ONLY")raw.CRYPTO_FUTURES={
      market:r.market,venue:r.venue,symbol:r.symbol,source:r.source,
      acquiredAtMs:Date.now(),sourceWindow:{historyStartMs,utcDayEndMs},
      candleSha256:r.rawCandleSha256,candles:x.candles,
    };
  }catch(e){
    if(classifyPublicSourceFailure(e)!=="BLOCKED_DATA")throw e;
    markets.CRYPTO_FUTURES=blocked("CRYPTO_FUTURES","BITGET_USDT_FUTURES",String(e.message).slice(0,140));
  }
  const observed=Object.values(markets).filter(r=>r.status==="OBSERVED_DAY_ONLY").length;
  return Object.freeze({
    schemaVersion:"native-utc-day-historical-public-1m-audit-v1",
    sampledDay:UTC_DAY_SAMPLE_V1,observedMarketSamples:observed,markets,raw,
    fullMarketOpportunityDenominatorVerified:false,
    trueMarketWideRecall:null,fullCostNetReturnPct:null,
    actualFillEvidenceVerified:false,OOSPassCount:0,profitabilityProven:false,
    researchOnly:true,executionAuthority:"NONE",liveTrading:false,
    autoTrading:false,privateApiRequests:false,realOrders:false,
  });
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const r=await probeNativeUtcDayHistoricalV1();
  const out=resolve(process.argv[2]??"market-prediction-lab/docs/native-utc-day-opportunity-v1.json");
  const rawOut=resolve(process.argv[3]??"market-prediction-lab/docs/native-utc-day-raw-1m-v1.json");
  for(const path of [out,rawOut])mkdirSync(dirname(path),{recursive:true});
  const {raw,...report}=r;
  writeFileSync(out,JSON.stringify(report,null,2)+"\n",{encoding:"utf8",mode:0o600});
  writeFileSync(rawOut,JSON.stringify({
    schemaVersion:"native-utc-day-public-raw-candle-evidence-v1",
    sourceAcquiredAfterDay:true,sampledDay:r.sampledDay,markets:raw,
    fullMarketOpportunityDenominatorVerified:false,
    profitabilityProven:false,executionAuthority:"NONE",
  })+"\n",{encoding:"utf8",mode:0o600});
  process.stdout.write(JSON.stringify({
    observedMarketSamples:r.observedMarketSamples,
    markets:Object.fromEntries(Object.entries(r.markets).map(([m,v])=>[
      m,{status:v.status,reason:v.reason??null,observedMinuteCount:v.observedMinuteCount,
        previousUtcClose:v.previousUtcClose,observedDayCrossingCount:v.observedDayCrossingCount,
        events:v.opportunities?.map(e=>({
          direction:e.direction,thresholdPct:e.thresholdPct,firstCrossingBarStartMs:e.firstCrossingBarStartMs,
          openedAlreadyBeyondThreshold:e.openedAlreadyBeyondThreshold,
        }))??null},
    ])),
    profitabilityProven:false,executionAuthority:"NONE",
  })+"\n");
}
