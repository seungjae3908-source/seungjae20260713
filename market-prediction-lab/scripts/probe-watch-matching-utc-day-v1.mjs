#!/usr/bin/env node
/**
 * Exact SAME UTC-DATE native price source for an exported original public-watch
 * event/cadence cohort. No 2025-to-2026 history backfill or invented watcher
 * entries. Fixed completed UTC day avoids runtime drifting between CI runs.
 *
 * Public Upbit KRW-BTC 1m and Bitget BTCUSDT USDT-FUTURES 1m only.
 * Strict 60-minute prior UTC day close + 1440 closed 1m bars. This chosen
 * surviving-symbol sample is NOT full historical PIT universe or OOS.
 */
import {createHash} from "node:crypto";
import {mkdirSync,writeFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {collectUpbitSpotHistory} from "../src/upbit-spot-history.js";
import {BitgetPublicClient,BitgetPublicApiError} from "../src/bitget-public-client.js";
import {collectBitgetCandles} from "../src/bitget-candle-collector.js";
import {auditNativeObservedMinuteWindowV1} from "../src/historical-intraday-opportunity-audit-v1.js";
import {classifyPublicSourceFailure} from "./probe-native-minute-historical-v1.mjs";

const M=60_000,D=86_400_000;
export const WATCH_MATCHED_UTC_DAY_V1=Object.freeze({
  dayUtc:"2026-10-09",
  utcDayStartMs:Date.parse("2026-10-09T00:00:00Z"),
  utcDayEndMs:Date.parse("2026-10-10T00:00:00Z"),
  historyStartMs:Date.parse("2026-10-08T23:00:00Z"),
  chosenSymbolsOnly:true,
  selection:"PAST_COMPLETED_UTC_DAY_PUBLIC_NATIVE_BTC_SAMPLE_NOT_OOS",
});
function digest(rows) {
  const hash=createHash("sha256");
  for(const r of rows)hash.update([
    r.timestamp,r.open,r.high,r.low,r.close,r.volume,
  ].join(",")+"\n");
  return hash.digest("hex");
}
function blocked(market,venue,reason){
  return Object.freeze({
    market,venue,status:"BLOCKED_DATA",reason,
    observedMinuteCount:null,priorHourObservedMinuteCount:null,
    previousUtcClose:null,opportunities:null,
    observedDayCrossingCount:null,rawCandleSha256:null,
    sourceAcquiredAfterDay:true,
    historicalScannerAsOfAvailabilityVerified:false,
    actualFillCount:null,trueMarketWideRecall:null,netProfitPct:null,
    profitabilityProven:false,executionAuthority:"NONE",
  });
}
export function nativeMatchedWatchDayFromCollectedV1({
  market,venue,collected,
}={}){
  const spot=market==="CRYPTO_SPOT";
  const futures=market==="CRYPTO_FUTURES";
  const symbol=spot?"KRW-BTC":"BTCUSDT";
  const source=spot?"upbit-public-candles":"bitget-public-v2";
  const expectedVenue=spot?"UPBIT_KRW":"BITGET_USDT_FUTURES";
  const {historyStartMs,utcDayStartMs,utcDayEndMs}=WATCH_MATCHED_UTC_DAY_V1;
  if(!(spot||futures)||venue!==expectedVenue
     ||collected?.market!==market||collected?.timeframe!=="1m"
     ||collected?.requestedStartTime!==historyStartMs
     ||collected?.requestedEndTime!==utcDayEndMs
     ||collected?.rawPageWindowTraversed!==true
     ||collected?.historicalSignalAvailabilityProven!==false
     ||collected?.actualFillProven!==false
     ||(spot
       ? collected?.source!==source||collected?.exchange!=="UPBIT"
         ||collected?.providerMarket!==symbol||collected?.intervalMs!==M
       : collected?.provider!==source||collected?.symbol!==symbol)
     ||!Array.isArray(collected?.candles)
     ||collected.candles.length!==1500){
    return blocked(market,venue,"SAME_DAY_NATIVE_SOURCE_OR_COUNT_UNVERIFIED");
  }
  const prior=collected.candles.slice(0,60);
  const day=collected.candles.slice(60);
  const audit=auditNativeObservedMinuteWindowV1({
    market,venue,source,symbol,
    startMs:utcDayStartMs,endMs:utcDayEndMs,bars:day,
    preWindowBars:prior,baselineMode:"PREVIOUS_UTC_DAY_LAST_MINUTE_CLOSE",
    pageWindowTraversed:true,
  });
  if(audit.status!=="OBSERVED_WINDOW_ONLY")
    return blocked(market,venue,audit.reason??"NATIVE_MINUTE_AUDIT_BLOCKED");
  return Object.freeze({
    market,venue,status:"OBSERVED_DAY_ONLY",symbol,
    utcDayStartMs,utcDayEndMs,source,
    sourceAcquiredAfterDay:true,
    nativeSourceCandleSha256Verified:true,
    rawCandleSha256:digest(collected.candles),
    previousUtcClose:audit.baselinePrice,
    baselineDefinition:audit.baselineDefinition,
    priorHourObservedMinuteCount:audit.priorHourObservedMinuteCount,
    observedMinuteCount:audit.observedMinuteCount,
    observedDayCrossingCount:audit.observedCrossingCount,
    opportunities:audit.opportunities,
    historicalListedAndDelistedUniverseProven:false,
    originalWatchExportSupplied:false,
    historicalScannerAsOfAvailabilityVerified:false,
    trueMarketWideRecall:null,actualFillCount:null,netProfitPct:null,
    profitabilityProven:false,executionAuthority:"NONE",
    liveTrading:false,realOrders:false,
  });
}
export async function probeNativeMatchingWatchDayV1({
  upbitFetch=globalThis.fetch,
  bitgetClient=new BitgetPublicClient({
    minIntervalMs:170,maxRetries:1,timeoutMs:12_000,
  }),
}={}){
  const {historyStartMs,utcDayEndMs}=WATCH_MATCHED_UTC_DAY_V1;
  const markets={
    KR_STOCK:blocked("KR_STOCK","KRX","HISTORICAL_PIT_STOCK_ONE_MINUTE_UNAVAILABLE"),
    US_STOCK:blocked("US_STOCK","US_SIP","HISTORICAL_CONSOLIDATED_SIP_ONE_MINUTE_UNAVAILABLE"),
  };
  const raw={};
  try{
    const bars=await collectUpbitSpotHistory({
      symbol:"KRW-BTC",timeframe:"1m",
      startTime:historyStartMs,endTime:utcDayEndMs,maxPages:12,
      minCandles:2,minIntervalMs:180,requireFullWindow:true,
      fetchImpl:upbitFetch,signal:AbortSignal.timeout(60_000),
    });
    const receipt=nativeMatchedWatchDayFromCollectedV1({
      market:"CRYPTO_SPOT",venue:"UPBIT_KRW",collected:bars,
    });
    markets.CRYPTO_SPOT=receipt;
    if(receipt.status==="OBSERVED_DAY_ONLY")raw.CRYPTO_SPOT={
      symbol:receipt.symbol,candleSha256:receipt.rawCandleSha256,candles:bars.candles,
    };
  }catch(error){
    if(classifyPublicSourceFailure(error)!=="BLOCKED_DATA")throw error;
    markets.CRYPTO_SPOT=blocked("CRYPTO_SPOT","UPBIT_KRW",
      String(error.message??error).slice(0,140));
  }
  try{
    const bars=await collectBitgetCandles({
      client:bitgetClient,market:"CRYPTO_FUTURES",symbol:"BTCUSDT",
      timeframe:"1m",startTime:historyStartMs,endTime:utcDayEndMs,
      maxCandles:1700,minCandles:2,requireFullWindow:true,
    });
    const receipt=nativeMatchedWatchDayFromCollectedV1({
      market:"CRYPTO_FUTURES",venue:"BITGET_USDT_FUTURES",collected:bars,
    });
    markets.CRYPTO_FUTURES=receipt;
    if(receipt.status==="OBSERVED_DAY_ONLY")raw.CRYPTO_FUTURES={
      symbol:receipt.symbol,candleSha256:receipt.rawCandleSha256,candles:bars.candles,
    };
  }catch(error){
    if(classifyPublicSourceFailure(error)!=="BLOCKED_DATA")throw error;
    markets.CRYPTO_FUTURES=blocked("CRYPTO_FUTURES","BITGET_USDT_FUTURES",
      String(error.message??error).slice(0,140));
  }
  return Object.freeze({
    schemaVersion:"native-utc-day-historical-public-1m-audit-v1",
    sampledDay:WATCH_MATCHED_UTC_DAY_V1,
    status:"SOURCE_LIMITED_NATIVE_BTC_UTC_DAY_ONLY",
    markets,raw,
    observedMarketSamples:Object.values(markets)
      .filter(v=>v.status==="OBSERVED_DAY_ONLY").length,
    fullMarketOpportunityDenominatorVerified:false,
    trueMarketWideRecall:null,
    actualFillEvidenceVerified:false,OOSPassCount:0,
    profitabilityProven:false,executionAuthority:"NONE",
    liveTrading:false,autoTrading:false,realOrders:false,
    privateProviderApi:false,
  });
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const report=await probeNativeMatchingWatchDayV1();
  const path=resolve(process.argv[2]??
    "market-prediction-lab/docs/native-watch-matched-day-v1.json");
  const rawOut=resolve(process.argv[3]??
    "market-prediction-lab/docs/native-watch-matched-day-raw-v1.json");
  for(const file of [path,rawOut])mkdirSync(dirname(file),{recursive:true});
  const {raw,...rest}=report;
  writeFileSync(path,JSON.stringify(rest,null,2)+"\n",{encoding:"utf8",mode:0o600});
  writeFileSync(rawOut,JSON.stringify({
    schemaVersion:"native-watch-matched-day-public-raw-v1",
    sampledDay:report.sampledDay,raw,profitabilityProven:false,
    executionAuthority:"NONE",
  })+"\n",{encoding:"utf8",mode:0o600});
  process.stdout.write(JSON.stringify({
    sourceDate:report.sampledDay.dayUtc,
    observedMarketSamples:report.observedMarketSamples,
    markets:Object.fromEntries(Object.entries(report.markets).map(([market,row])=>[
      market,{status:row.status,reason:row.reason??null,
        nativeCrossingCount:row.observedDayCrossingCount,
        candleCount:row.observedMinuteCount,
        previousUtcClose:row.previousUtcClose},
    ])),
    trueMarketWideRecall:null,profitabilityProven:false,executionAuthority:"NONE",
  })+"\n");
}
