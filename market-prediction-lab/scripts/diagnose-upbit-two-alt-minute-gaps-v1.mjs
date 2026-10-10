#!/usr/bin/env node
/**
 * Diagnose source gaps for ONLY two Upbit KRW 1m histories that were blocked
 * in the fixed same-day source-limited opportunity audit.
 * Missing 1m is UNKNOWN_CAUSE, NEVER automatically "no trades".
 * No orders, private endpoints, secrets, full-market or profit claims.
 */
import {createHash} from "node:crypto";
import {mkdirSync,writeFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {collectUpbitSpotHistory} from "../src/upbit-spot-history.js";
import {classifyPublicSourceFailure}
  from "./probe-native-minute-historical-v1.mjs";
import {WATCH_MATCHED_UTC_DAY_V1 as DAY}
  from "./probe-watch-matching-utc-day-v1.mjs";

const M=60_000;
const PAIRS=Object.freeze(["KRW-ETH","KRW-SOL"]);
const TOTAL=(DAY.utcDayEndMs-DAY.historyStartMs)/M;
const SUFFIX="SOURCE_MISSING_ONE_MINUTE_PROOF";
function blocked(symbol,reason){
  return Object.freeze({
    market:"CRYPTO_SPOT",venue:"UPBIT_KRW",symbol,
    status:"BLOCKED_DATA",reason,
    requestedMinuteSlots:TOTAL,observedMinuteRows:null,
    missingMinuteCount:null,missingIntervals:null,
    sourcePagesTraversed:false,sourcePageCount:null,
    rawCandleSha256:null,sourceMissingMinuteCauseVerified:false,
    fullHistoricPITUniverseVerified:false,actualFillCount:null,
    trueMarketWideRecall:null,netProfitPct:null,
    profitabilityProven:false,executionAuthority:"NONE",
  });
}
function contentHash(candles){
  const h=createHash("sha256");
  for(const row of candles)h.update([
    row.timestamp,row.open,row.high,row.low,row.close,row.volume,
  ].join(",")+"\n");
  return h.digest("hex");
}
export function diagnoseUpbitMinuteRangeV1({symbol,source}={}){
  if(!PAIRS.includes(symbol)||!source||source.market!=="CRYPTO_SPOT"
     ||source.exchange!=="UPBIT"||source.providerMarket!==symbol
     ||source.timeframe!=="1m"||source.intervalMs!==M
     ||source.requestedStartTime!==DAY.historyStartMs
     ||source.requestedEndTime!==DAY.utcDayEndMs
     ||source.historicalSignalAvailabilityProven!==false
     ||source.actualFillProven!==false
     ||source.rawPageWindowTraversed!==true
     ||!Array.isArray(source.candles))
    return blocked(symbol??null,"UPBIT_MINUTE_SOURCE_PROVENANCE_INVALID");
  const byTime=new Map();
  for(const row of source.candles){
    if(!Number.isSafeInteger(row?.timestamp)||row.timestamp%M!==0
       ||row.timestamp<DAY.historyStartMs
       ||row.timestamp>=DAY.utcDayEndMs
       ||byTime.has(row.timestamp)
       ||![row.open,row.high,row.low,row.close].every(x=>
         typeof x==="number"&&Number.isFinite(x)&&x>0)
       ||typeof row.volume!=="number"||!Number.isFinite(row.volume)
       ||row.volume<0||row.high<Math.max(row.open,row.close)
       ||row.low>Math.min(row.open,row.close))
      return blocked(symbol,"UPBIT_MINUTE_SOURCE_BAR_INVALID");
    byTime.set(row.timestamp,row);
  }
  const missing=[];
  let current=null;
  for(let minuteIndex=0;minuteIndex<TOTAL;minuteIndex++){
    const t=DAY.historyStartMs+minuteIndex*M;
    if(!byTime.has(t)){
      if(!current)current={startMs:t,endMs:t+M,minutes:1};
      else{current.endMs=t+M;current.minutes++;}
    }else if(current){
      missing.push(current);current=null;
    }
  }
  if(current)missing.push(current);
  const count=missing.reduce((s,r)=>s+r.minutes,0);
  const status=count===0?"VERIFIED_CONTIGUOUS_SOURCE_MINUTES":
    "BLOCKED_UNVERIFIED_ONE_MINUTE_GAPS";
  return Object.freeze({
    market:"CRYPTO_SPOT",venue:"UPBIT_KRW",symbol,status,
    reason:count?SUFFIX:null,
    timeWindowStartMs:DAY.historyStartMs,
    timeWindowEndMs:DAY.utcDayEndMs,
    requestedMinuteSlots:TOTAL,
    observedMinuteRows:byTime.size,
    missingMinuteCount:count,
    priorUTCClosingMinuteReceived:byTime.has(DAY.utcDayStartMs-M),
    missingIntervalCount:missing.length,
    missingIntervals:missing.slice(0,25).map(x=>({
      ...x,utcStart:new Date(x.startMs).toISOString(),
      utcEnd:new Date(x.endMs).toISOString(),
    })),
    omittedIntervals:Math.max(0,missing.length-25),
    sourcePagesTraversed:true,
    sourcePageCount:source.pageCount??null,
    rawCandleSha256:contentHash(source.candles),
    sourceMissingMinuteCauseVerified:false,
    missingMinuteCannotBeTreatedAsNoTrades:true,
    fullHistoricPITUniverseVerified:false,
    historicalScannerDataAvailabilityVerified:false,
    actualFillCount:null,trueMarketWideRecall:null,netProfitPct:null,
    profitabilityProven:false,executionAuthority:"NONE",
  });
}
export async function diagnosePublicUpbitMinuteGapsV1({
  fetchImpl=globalThis.fetch,
}={}){
  const markets={};
  for(const symbol of PAIRS){
    try{
      const collected=await collectUpbitSpotHistory({
        symbol,timeframe:"1m",
        startTime:DAY.historyStartMs,endTime:DAY.utcDayEndMs,
        maxPages:12,minCandles:2,minIntervalMs:200,
        requireFullWindow:true,fetchImpl,
        signal:AbortSignal.timeout(60_000),
      });
      markets[symbol]=diagnoseUpbitMinuteRangeV1({symbol,source:collected});
    }catch(error){
      if(classifyPublicSourceFailure(error)!=="BLOCKED_DATA")throw error;
      markets[symbol]=blocked(symbol,
        String(error.message??error).slice(0,140));
    }
  }
  const rows=Object.values(markets);
  return Object.freeze({
    schemaVersion:"upbit-two-symbol-one-minute-coverage-diagnostic-v1",
    dateUtc:DAY.dayUtc,
    status:"SOURCE_COVERAGE_DIAGNOSTIC_ONLY",
    selectedPairs:PAIRS,
    markets,
    consecutiveSourcePairs:rows.filter(r=>
      r.status==="VERIFIED_CONTIGUOUS_SOURCE_MINUTES").length,
    unverifiedGapPairs:rows.filter(r=>
      r.status==="BLOCKED_UNVERIFIED_ONE_MINUTE_GAPS").length,
    upstreamFailurePairs:rows.filter(r=>r.status==="BLOCKED_DATA").length,
    completeSelectedSourceDenominatorProven:rows.every(r=>
      r.status==="VERIFIED_CONTIGUOUS_SOURCE_MINUTES"),
    fullMarketOpportunityDenominatorVerified:false,
    originalScannerNegativeEvidenceVerified:false,
    trueMarketWideRecall:null,actualFillCount:null,netProfitPct:null,
    profitabilityProven:false,executionAuthority:"NONE",
    liveTrading:false,autoTrading:false,realOrders:false,
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const r=await diagnosePublicUpbitMinuteGapsV1();
  const output=resolve(process.argv[2]??
    "market-prediction-lab/docs/upbit-two-alt-1m-gaps-v1.json");
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify(r,null,2)+"\n",{encoding:"utf8",mode:0o600});
  process.stdout.write(JSON.stringify({
    dateUtc:r.dateUtc,status:r.status,
    markets:Object.fromEntries(Object.entries(r.markets).map(([symbol,x])=>[
      symbol,{status:x.status,
        bars:x.observedMinuteRows,missing:x.missingMinuteCount,
        missingIntervals:x.missingIntervals,
        priorCloseAvailable:x.priorUTCClosingMinuteReceived??null,
        reason:x.reason},
    ])),
    fullMarketOpportunityDenominatorVerified:false,
    trueMarketWideRecall:null,executionAuthority:"NONE",
  })+"\n");
}
