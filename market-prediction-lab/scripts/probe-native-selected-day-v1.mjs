#!/usr/bin/env node
/**
 * Deliberately small, fixed-symbol public 1m source acquisition pilot.
 * Fixed mainstream symbols are PRESENT-DAY SELECTED; historical universe,
 * delistings and comprehensive opportunity denominators remain unverified.
 * A post-hoc stress-date case, NOT walk-forward/OOS. NO private endpoints.
 */
import {mkdirSync,writeFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {collectUpbitSpotHistory} from "../src/upbit-spot-history.js";
import {collectBitgetCandles} from "../src/bitget-candle-collector.js";
import {BitgetPublicClient} from "../src/bitget-public-client.js";
import {classifyPublicSourceFailure} from "./probe-native-minute-historical-v1.mjs";
import {nativeDayResultFromCollectedV1,UTC_DAY_SAMPLE_V1}
  from "./probe-native-utc-day-historical-v1.mjs";

export const SELECTED_NATIVE_DAY_PILOT_V1=Object.freeze({
  spotSymbols:Object.freeze(["KRW-BTC","KRW-ETH","KRW-XRP","KRW-SOL"]),
  futuresSymbols:Object.freeze(["BTCUSDT","ETHUSDT","XRPUSDT","SOLUSDT"]),
  historyStartMs:UTC_DAY_SAMPLE_V1.historyStartMs,
  endMs:UTC_DAY_SAMPLE_V1.utcDayEndMs,
  selection:"PRESENT_DAY_FIXED_SYMBOLS_POST_HOC_DATE_SURVIVOR_BIASED",
  notHistoricalUniverse:true,
});
function blocked(market,venue,symbol,reason){
  return Object.freeze({
    market,venue,symbol,status:"BLOCKED_DATA",reason,
    observedDayCrossingCount:null,previousUtcClose:null,
    rawCandleSha256:null,
    earlyDetectedCount:null,trueMarketWideRecall:null,
    actualFillCount:null,netProfitPct:null,
  });
}
function symbols(list,re){
  if(!Array.isArray(list)||list.length>4
     ||list.some(s=>typeof s!=="string"||!re.test(s))
     ||new Set(list).size!==list.length)throw new TypeError("BOUNDED_SELECTED_SYMBOLS_INVALID");
  return list;
}
export function summarizeSelectedNativeUtcDayV1({market,symbol,collected}={}){
  const venue=market==="CRYPTO_SPOT"?"UPBIT_KRW":
    market==="CRYPTO_FUTURES"?"BITGET_USDT_FUTURES":null;
  if(!venue||typeof symbol!=="string")throw new TypeError("SELECTED_MARKET_OR_SYMBOL_INVALID");
  const result=nativeDayResultFromCollectedV1(market,venue,collected,symbol);
  if(result.status!=="OBSERVED_DAY_ONLY")return blocked(market,venue,symbol,result.reason);
  return Object.freeze({
    market,venue,symbol,status:"OBSERVED_SELECTED_SYMBOL_DAY",
    previousUtcClose:result.previousUtcClose,
    minuteCount:result.observedMinuteCount,priorMinutes:result.priorHourObservedMinuteCount,
    openingGapPct:result.openingGapPct,
    observedDayCrossingCount:result.observedDayCrossingCount,
    opportunities:result.opportunities,
    rawCandleSha256:result.rawCandleSha256,
    fromHistoricCurrentListingUniverse:false,
    historicalListingAndDelistingVerified:false,
    historicalScannerEvidenceVerified:false,earlyDetectedCount:null,
    trueMarketWideRecall:null,actualFillCount:null,netProfitPct:null,
    costAdjustedProfitabilityProven:false,executionAuthority:"NONE",
  });
}
export async function probeSelectedNativeUtcDayV1({
  spotSymbols=SELECTED_NATIVE_DAY_PILOT_V1.spotSymbols,
  futuresSymbols=SELECTED_NATIVE_DAY_PILOT_V1.futuresSymbols,
  upbitFetch=globalThis.fetch,
  bitgetClient=new BitgetPublicClient({minIntervalMs:180,maxRetries:1,timeoutMs:12_000}),
}={}){
  const spots=symbols(spotSymbols,/^KRW-[A-Z0-9]{1,20}$/);
  const futures=symbols(futuresSymbols,/^[A-Z0-9]{2,20}USDT$/);
  const spot=[],future=[],raw={};
  const {historyStartMs,endMs}=SELECTED_NATIVE_DAY_PILOT_V1;
  for(const symbol of spots){
    try{
      const collected=await collectUpbitSpotHistory({
        symbol,timeframe:"1m",startTime:historyStartMs,endTime:endMs,
        maxPages:12,minCandles:2,requireFullWindow:true,
        minIntervalMs:190,fetchImpl:upbitFetch,
        signal:AbortSignal.timeout(60_000),
      });
      const report=summarizeSelectedNativeUtcDayV1({market:"CRYPTO_SPOT",symbol,collected});
      spot.push(report);
      if(report.status==="OBSERVED_SELECTED_SYMBOL_DAY")raw[symbol]={
        venue:"UPBIT_KRW",source:"upbit-public-candles",
        sourceSha256:report.rawCandleSha256,
        candles:collected.candles,
      };
    }catch(error){
      if(classifyPublicSourceFailure(error)!=="BLOCKED_DATA")throw error;
      spot.push(blocked("CRYPTO_SPOT","UPBIT_KRW",symbol,
        String(error.message??error).slice(0,150)));
    }
  }
  for(const symbol of futures){
    try{
      const collected=await collectBitgetCandles({
        client:bitgetClient,market:"CRYPTO_FUTURES",symbol,timeframe:"1m",
        startTime:historyStartMs,endTime:endMs,
        maxCandles:1700,minCandles:2,requireFullWindow:true,
      });
      const report=summarizeSelectedNativeUtcDayV1({market:"CRYPTO_FUTURES",symbol,collected});
      future.push(report);
      if(report.status==="OBSERVED_SELECTED_SYMBOL_DAY")raw[symbol]={
        venue:"BITGET_USDT_FUTURES",source:"bitget-public-v2",
        sourceSha256:report.rawCandleSha256,
        candles:collected.candles,
      };
    }catch(error){
      if(classifyPublicSourceFailure(error)!=="BLOCKED_DATA")throw error;
      future.push(blocked("CRYPTO_FUTURES","BITGET_USDT_FUTURES",symbol,
        String(error.message??error).slice(0,150)));
    }
  }
  const groups={CRYPTO_SPOT:spot,CRYPTO_FUTURES:future};
  const observed=[...spot,...future].filter(x=>x.status==="OBSERVED_SELECTED_SYMBOL_DAY");
  const blockedCount=spot.length+future.length-observed.length;
  return Object.freeze({
    schemaVersion:"native-selected-historical-utc-day-1m-pilot-v1",
    sample:SELECTED_NATIVE_DAY_PILOT_V1,
    status:observed.length?"SOURCE_LIMITED_OBSERVATIONS_ONLY":"BLOCKED_DATA",
    markets:{
      KR_STOCK:blocked("KR_STOCK","KRX",null,"PIT_STOCK_MINUTE_PROVIDER_NOT_AVAILABLE"),
      US_STOCK:blocked("US_STOCK","US_SIP",null,"PIT_SIP_MINUTE_PROVIDER_NOT_AVAILABLE"),
      CRYPTO_SPOT:spot,CRYPTO_FUTURES:future,
    },
    selectedSymbolCount:spot.length+future.length,
    observedSymbolDays:observed.length,
    blockedSelectedSymbolDays:blockedCount,
    observedCrossingsWithinAvailableSelectedSymbolDays:
      observed.reduce((n,row)=>n+row.observedDayCrossingCount,0),
    historicalPointInTimeUniverseVerified:false,
    earlyScannerRecallVerified:false,
    fullMarketOpportunityDenominatorVerified:false,
    trueMarketWideRecall:null,actualFillCount:null,netProfitPct:null,
    OOSPassCount:0,profitabilityProven:false,
    executionAuthority:"NONE",liveTrading:false,autoTrading:false,realOrders:false,
    privateApiCalls:false,
    raw,
  });
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=await probeSelectedNativeUtcDayV1();
  const summaryPath=resolve(process.argv[2]??
    "market-prediction-lab/docs/native-selected-historical-day-v1.json");
  const rawPath=resolve(process.argv[3]??
    "market-prediction-lab/docs/native-selected-historical-day-raw-v1.json");
  for(const path of [summaryPath,rawPath])mkdirSync(dirname(path),{recursive:true});
  const {raw,...summary}=result;
  writeFileSync(summaryPath,JSON.stringify(summary,null,2)+"\n",{encoding:"utf8",mode:0o600});
  writeFileSync(rawPath,JSON.stringify({
    schemaVersion:"native-selected-public-historical-raw-1m-v1",
    sample:SELECTED_NATIVE_DAY_PILOT_V1,
    raw,profitabilityProven:false,executionAuthority:"NONE",
  })+"\n",{encoding:"utf8",mode:0o600});
  process.stdout.write(JSON.stringify({
    status:summary.status,
    selectedSymbolCount:summary.selectedSymbolCount,
    observedSymbolDays:summary.observedSymbolDays,
    blockedSelectedSymbolDays:summary.blockedSelectedSymbolDays,
    observedCrossingsWithinAvailableSelectedSymbolDays:
      summary.observedCrossingsWithinAvailableSelectedSymbolDays,
    symbols:Object.values(summary.markets).flat()
      .filter(row=>row?.symbol).map(row=>({
        symbol:row.symbol,status:row.status,
        crossings:row.observedDayCrossingCount,
        blocker:row.reason??null,
      })),
    profitabilityProven:false,executionAuthority:"NONE",
  })+"\n");
}
