#!/usr/bin/env node
/**
 * Incremental, strictly bounded SIX alt-symbol UTC-day read-only native 1m
 * source pilot. BTC native 1m from the identical day has already been
 * acquired separately; DO NOT requery it or assume full PIT listing coverage.
 *
 * The 2026-10-09 date is prior to this 2026-10-10 research build. Each
 * chosen ETH/XRP/SOL pair is a present-day survivor-selected example,
 * NOT whole venue market membership, OOS strategy, actual trade or ROI.
 */
import {createHash} from "node:crypto";
import {mkdirSync,writeFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {collectUpbitSpotHistory} from "../src/upbit-spot-history.js";
import {BitgetPublicClient} from "../src/bitget-public-client.js";
import {collectBitgetCandles} from "../src/bitget-candle-collector.js";
import {auditNativeObservedMinuteWindowV1}
  from "../src/historical-intraday-opportunity-audit-v1.js";
import {classifyPublicSourceFailure}
  from "./probe-native-minute-historical-v1.mjs";
import {
  diagnoseUpbitMinuteRangeV1,
  recheckMissingUpbitMinuteSlotsV1,
  auditPublicUpbitGapTicksV1,
} from "./diagnose-upbit-two-alt-minute-gaps-v1.mjs";
import {WATCH_MATCHED_UTC_DAY_V1 as DAY}
  from "./probe-watch-matching-utc-day-v1.mjs";

export const WATCH_MATCH_ALT_PILOT_V1=Object.freeze({
  dayUtc:DAY.dayUtc,utcDayStartMs:DAY.utcDayStartMs,
  utcDayEndMs:DAY.utcDayEndMs,historyStartMs:DAY.historyStartMs,
  CRYPTO_SPOT:Object.freeze(["KRW-ETH","KRW-XRP","KRW-SOL"]),
  CRYPTO_FUTURES:Object.freeze(["ETHUSDT","XRPUSDT","SOLUSDT"]),
  sourceSelection:"CURRENT_KNOWN_SURVIVOR_ALT_SYMBOLS_NOT_HISTORIC_PIT_UNIVERSE",
  btcAlreadyCollectedSeparately:true,
});
const M=60_000;
const SPOT=/^KRW-(ETH|XRP|SOL)$/;
const FUTURES=/^(ETH|XRP|SOL)USDT$/;
const sourceLimits=Object.freeze({
  maxSpotPages:12,maxFuturesCandles:1700,
  expectedMinuteRows:1500,minIntervalMs:180,
});
function digest(rows){
  const h=createHash("sha256");
  for(const x of rows)h.update([x.timestamp,x.open,x.high,x.low,x.close,x.volume].join(",")+"\n");
  return h.digest("hex");
}
function blocked(market,venue,symbol,reason,detail={}){
  return Object.freeze({
    market,venue,symbol,status:"BLOCKED_DATA",reason,
    observedMinuteCount:null,observedDayCrossingCount:null,
    previousUtcClose:null,opportunities:null,
    rawCandleSha256:null,trueMarketWideRecall:null,
    originalScannerAsOfVerified:false,actualFillCount:null,
    netProfitPct:null,profitabilityProven:false,executionAuthority:"NONE",
    ...detail,
  });
}
export function auditMatchedAltDayFromCollectedV1({
  market,symbol,venue,collected,sparseGapEvidence=null,
}={}){
  const spot=market==="CRYPTO_SPOT";
  const fut=market==="CRYPTO_FUTURES";
  const src=spot?"upbit-public-candles":"bitget-public-v2";
  const expectedVenue=spot?"UPBIT_KRW":"BITGET_USDT_FUTURES";
  if(!(spot||fut)||!(spot?SPOT:FUTURES).test(symbol??"")
     ||venue!==expectedVenue
     ||collected?.market!==market||collected?.timeframe!=="1m"
     ||collected?.requestedStartTime!==DAY.historyStartMs
     ||collected?.requestedEndTime!==DAY.utcDayEndMs
     ||collected?.rawPageWindowTraversed!==true
     ||collected?.historicalSignalAvailabilityProven!==false
     ||collected?.actualFillProven!==false
     ||(spot
       ? collected?.source!==src||collected?.exchange!=="UPBIT"
         ||collected?.providerMarket!==symbol||collected?.intervalMs!==M
       : collected?.provider!==src||collected?.symbol!==symbol)
     ||!Array.isArray(collected?.candles)
     )
    return blocked(market,venue,symbol,"ALT_NATIVE_SOURCE_OR_WINDOW_UNVERIFIED");
  // Exact native source rows are immutable. If Upbit genuinely skipped
  // an empty minute, accept ONLY a same-source tick-corroborated gap receipt.
  // Status deliberately stays below a dense full-minute source validation.
  const all=collected.candles;
  const isDense=all.length===sourceLimits.expectedMinuteRows;
  const diagnostic=sparseGapEvidence?.diagnostic;
  const pageRecheck=sparseGapEvidence?.targetedRecheck;
  const tickRecheck=sparseGapEvidence?.publicTickCrosscheck;
  const gaps=sourceLimits.expectedMinuteRows-all.length;
  const tickMinutes=tickRecheck?.observations;
  const pageMinutes=pageRecheck?.observations;
  const evidenceReady=!isDense&&spot&&gaps>0&&gaps<=24
    &&diagnostic?.symbol===symbol
    &&diagnostic?.status==="BLOCKED_UNVERIFIED_ONE_MINUTE_GAPS"
    &&diagnostic?.requestedMinuteSlots===sourceLimits.expectedMinuteRows
    &&diagnostic?.observedMinuteRows===all.length
    &&diagnostic?.missingMinuteCount===gaps
    &&diagnostic?.sourcePagesTraversed===true
    &&diagnostic?.priorUTCClosingMinuteReceived===true
    &&diagnostic?.rawCandleSha256===digest(all)
    &&pageRecheck?.status==="TARGETED_NATIVE_RECHECK_COMPLETE"
    &&pageRecheck?.checkedGapMinutes===gaps
    &&pageRecheck?.presentOnRequery===0
    &&pageRecheck?.absentOnRequery===gaps
    &&pageRecheck?.failedRequeries===0
    &&Array.isArray(pageMinutes)&&pageMinutes.length===gaps
    &&pageMinutes.every(x=>x.outcome==="NATIVE_CANDLE_ABSENT_ON_REQUERY")
    &&tickRecheck?.status==="TICK_CROSSCHECK_COMPLETE"
    &&tickRecheck?.checkedMinutes===gaps
    &&tickRecheck?.latestTickPrecedesMissingMinute===gaps
    &&tickRecheck?.tickInsideMissingCandleMinute===0
    &&tickRecheck?.unverifiedMinutes===0
    &&tickRecheck?.independentFullHistoryVerified===false
    &&Array.isArray(tickMinutes)&&tickMinutes.length===gaps
    &&tickMinutes.every(x=>
      pageMinutes.some(p=>p.timestampMs===x.timestampMs)
      &&x.outcome==="PUBLIC_LATEST_TICK_PRECEDES_MISSING_MINUTE"
      &&Number.isSafeInteger(x.latestTickAtMs)
      &&x.latestTickAtMs>0&&x.latestTickAtMs<x.timestampMs);
  if(!isDense&&!evidenceReady)
    return blocked(market,venue,symbol,
      "ALT_NATIVE_MINUTE_ROW_COUNT_INCOMPLETE",{
        requestedMinuteSlots:sourceLimits.expectedMinuteRows,
        observedNativeSourceRows:all.length,
        minuteGapCauseIndependentlyVerified:false,
        absentMinuteIsNotZeroOpportunity:true,
      });
  const prior=all.filter(x=>x.timestamp>=DAY.historyStartMs
    &&x.timestamp<DAY.utcDayStartMs);
  const day=all.filter(x=>x.timestamp>=DAY.utcDayStartMs
    &&x.timestamp<DAY.utcDayEndMs);
  const audit=auditNativeObservedMinuteWindowV1({
    market,venue,source:src,symbol,
    startMs:DAY.utcDayStartMs,endMs:DAY.utcDayEndMs,
    bars:day,preWindowBars:prior,
    baselineMode:"PREVIOUS_UTC_DAY_LAST_MINUTE_CLOSE",
    pageWindowTraversed:true,
    verifiedNoTradeMinutes:evidenceReady?tickMinutes.map(x=>({
      ...x,symbol,venue:"UPBIT_KRW",source:"UPBIT_PUBLIC_TRADES_TICKS",
    })):[],
  });
  const expectedAuditStatus=evidenceReady
    ?"OBSERVED_UPBIT_SPARSE_WITH_PUBLIC_TICKS_ONLY"
    :"OBSERVED_WINDOW_ONLY";
  if(audit.status!==expectedAuditStatus)
    return blocked(market,venue,symbol,audit.reason??"ALTS_DAY_MINUTE_GAP");
  return Object.freeze({
    market,venue,symbol,
    status:evidenceReady?"OBSERVED_SPARSE_UPBIT_TICK_CORROBORATED_DAY"
      :"OBSERVED_SELECTED_SYMBOL_DAY",
    sourceEvidenceTier:evidenceReady
      ?"NATIVE_SPARSE_SAME_PROVIDER_TICK_CORROBORATED_ONLY"
      :"NATIVE_DENSE_CANDLE_SAMPLE_ONLY",
    nativeSourceRowCount:all.length,
    corroboratedNativeNoTradeMinuteCount:audit.sameVenuePublicTickCorroboratedEmptyMinutes,
    independentFullSourceCompletenessVerified:false,
    utcDayStartMs:DAY.utcDayStartMs,utcDayEndMs:DAY.utcDayEndMs,
    source:src,sourceAcquiredAfterDay:true,
    originalScannerAsOfVerified:false,
    dateSpecificHistoricalPITMembershipVerified:false,
    previousUtcClose:audit.baselinePrice,
    priorHourObservedMinuteCount:audit.priorHourObservedMinuteCount,
    expectedMinuteCount:audit.expectedMinuteCount,
    observedMinuteCount:audit.observedMinuteCount,
    observedDayCrossingCount:audit.observedCrossingCount,
    opportunities:audit.opportunities,
    rawCandleSha256:digest(collected.candles),
    realTickFirstCrossingTimeVerified:false,
    trueMarketWideRecall:null,actualFillCount:null,netProfitPct:null,
    profitabilityProven:false,executionAuthority:"NONE",
  });
}
export async function probeMatchedAltSymbolsNativeDayV1({
  upbitFetch=globalThis.fetch,
  enableBoundedSparseGapCrosscheck=false,
  bitgetClient=new BitgetPublicClient({
    minIntervalMs:180,maxRetries:1,timeoutMs:12_000,
  }),
}={}){
  const spot=[],futures=[],raw={};
  for(const symbol of WATCH_MATCH_ALT_PILOT_V1.CRYPTO_SPOT){
    let result;
    try{
      const c=await collectUpbitSpotHistory({
        symbol,timeframe:"1m",
        startTime:DAY.historyStartMs,endTime:DAY.utcDayEndMs,
        maxPages:sourceLimits.maxSpotPages,
        minCandles:2,minIntervalMs:sourceLimits.minIntervalMs,
        requireFullWindow:true,fetchImpl:upbitFetch,
        signal:AbortSignal.timeout(60_000),
      });
      let sparseGapEvidence=null;
      if(enableBoundedSparseGapCrosscheck&&
         (symbol==="KRW-ETH"||symbol==="KRW-SOL")){
        const diagnostic=diagnoseUpbitMinuteRangeV1({symbol,source:c});
        if(diagnostic.status==="BLOCKED_UNVERIFIED_ONE_MINUTE_GAPS"){
          const targetedRecheck=await recheckMissingUpbitMinuteSlotsV1({
            symbol,diagnostic,fetchImpl:upbitFetch,
          });
          const publicTickCrosscheck=targetedRecheck.status
            ==="TARGETED_NATIVE_RECHECK_COMPLETE"
            ?await auditPublicUpbitGapTicksV1({
              symbol,diagnostic,targetedRecheck,fetchImpl:upbitFetch,
            }):null;
          sparseGapEvidence={
            diagnostic,targetedRecheck,publicTickCrosscheck,
          };
        }
      }
      result=auditMatchedAltDayFromCollectedV1({
        market:"CRYPTO_SPOT",venue:"UPBIT_KRW",symbol,collected:c,
        sparseGapEvidence,
      });
      if(["OBSERVED_SELECTED_SYMBOL_DAY",
          "OBSERVED_SPARSE_UPBIT_TICK_CORROBORATED_DAY"].includes(result.status))
        raw["CRYPTO_SPOT:"+symbol]={
          sourceDigestSha256:result.rawCandleSha256,
          nativeCandleRowsOnly:true,syntheticMinuteBarsCreated:false,
          sourceEvidenceTier:result.sourceEvidenceTier,
          candles:c.candles,venue:"UPBIT_KRW",
        };
    }catch(error){
      if(classifyPublicSourceFailure(error)!=="BLOCKED_DATA")throw error;
      result=blocked("CRYPTO_SPOT","UPBIT_KRW",symbol,
        String(error.message??error).slice(0,150));
    }
    spot.push(result);
  }
  for(const symbol of WATCH_MATCH_ALT_PILOT_V1.CRYPTO_FUTURES){
    let result;
    try{
      const c=await collectBitgetCandles({
        client:bitgetClient,market:"CRYPTO_FUTURES",symbol,timeframe:"1m",
        startTime:DAY.historyStartMs,endTime:DAY.utcDayEndMs,
        maxCandles:sourceLimits.maxFuturesCandles,
        minCandles:2,requireFullWindow:true,
      });
      result=auditMatchedAltDayFromCollectedV1({
        market:"CRYPTO_FUTURES",venue:"BITGET_USDT_FUTURES",symbol,collected:c,
      });
      if(result.status==="OBSERVED_SELECTED_SYMBOL_DAY")
        raw["CRYPTO_FUTURES:"+symbol]={
          sourceDigestSha256:result.rawCandleSha256,
          candles:c.candles,venue:"BITGET_USDT_FUTURES"};
    }catch(error){
      if(classifyPublicSourceFailure(error)!=="BLOCKED_DATA")throw error;
      result=blocked("CRYPTO_FUTURES","BITGET_USDT_FUTURES",symbol,
        String(error.message??error).slice(0,150));
    }
    futures.push(result);
  }
  const rows=[...spot,...futures];
  const accepted=rows.filter(r=>r.status==="OBSERVED_SELECTED_SYMBOL_DAY");
  const sparse=rows.filter(r=>
    r.status==="OBSERVED_SPARSE_UPBIT_TICK_CORROBORATED_DAY");
  return Object.freeze({
    schemaVersion:"native-watch-matched-alt-six-utc-day-v1",
    sourceDate:WATCH_MATCH_ALT_PILOT_V1,
    status:accepted.length+sparse.length
      ?"SOURCE_LIMITED_SELECTED_ALTS_ONLY":"BLOCKED_DATA",
    markets:{
      KR_STOCK:blocked("KR_STOCK","KRX",null,"KR_PIT_ONE_MINUTE_NOT_CONNECTED"),
      US_STOCK:blocked("US_STOCK","US_SIP",null,"US_PIT_SIP_ONE_MINUTE_NOT_CONNECTED"),
      CRYPTO_SPOT:spot,CRYPTO_FUTURES:futures,
    },
    selectedAltSymbolDays:6,observedSelectedAltSymbolDays:accepted.length,
    sparseTickCorroboratedSelectedAltDays:sparse.length,
    blockedSelectedAltSymbolDays:6-accepted.length-sparse.length,
    selectedCohortSourceSlotEvidenceCount:accepted.length+sparse.length,
    allSixSourceSlotsCoveredByNativeCandlesOrSameProviderTicks:
      accepted.length+sparse.length===6,
    allSixDenseNativeCandleWindowsVerified:accepted.length===6,
    thresholdCrossingsInVerifiedSelectedDays:accepted.length
      ?accepted.reduce((n,r)=>n+r.observedDayCrossingCount,0):null,
    fivePctDirectionalEpisodesInVerifiedSelectedDays:accepted.length
      ?accepted.reduce((n,r)=>n+r.opportunities.filter(e=>e.thresholdPct===5).length,0):null,
    sparseTickCorroboratedFirstCrossings:sparse.length
      ?sparse.reduce((n,r)=>n+r.observedDayCrossingCount,0):null,
    verifiedEntireChosenSixCount:accepted.length===6
      ?accepted.reduce((n,r)=>n+r.observedDayCrossingCount,0):null,
    selectedAltSourceWindowComplete:accepted.length===6,
    fullMarketPITUniverseAndDelistingsVerified:false,
    originalPublicWatchEventAndCadenceEvidenceAttached:false,
    marketWideOpportunityDenominatorVerified:false,
    trueMarketWideRecall:null,actualFillCount:null,netProfitPct:null,
    OOSPassCount:0,profitabilityProven:false,
    executionAuthority:"NONE",liveTrading:false,autoTrading:false,
    realOrders:false,privateProviderApi:false,
    raw,
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const r=await probeMatchedAltSymbolsNativeDayV1({
    enableBoundedSparseGapCrosscheck:
      process.env.PREDICTION_LAB_UPBIT_GAP_CROSSCHECK==="true",
  });
  const output=resolve(process.argv[2]??
    "market-prediction-lab/docs/native-watch-matched-alt-six-v1.json");
  const rawOutput=resolve(process.argv[3]??
    "market-prediction-lab/docs/native-watch-matched-alt-six-raw-v1.json");
  for(const filename of [output,rawOutput])
    mkdirSync(dirname(filename),{recursive:true});
  const {raw,...summary}=r;
  writeFileSync(output,JSON.stringify(summary,null,2)+"\n",{encoding:"utf8",mode:0o600});
  writeFileSync(rawOutput,JSON.stringify({
    schemaVersion:"native-matched-alt-six-raw-public-v1",
    sourceDate:WATCH_MATCH_ALT_PILOT_V1,raw,
    profitabilityProven:false,executionAuthority:"NONE",
  })+"\n",{encoding:"utf8",mode:0o600});
  process.stdout.write(JSON.stringify({
    dateUtc:r.sourceDate.dayUtc,
    selectedAltDays:r.selectedAltSymbolDays,
    observedAltDays:r.observedSelectedAltSymbolDays,
    sparseTickCorroboratedDays:r.sparseTickCorroboratedSelectedAltDays,
    blockedAltDays:r.blockedSelectedAltSymbolDays,
    knownThresholdCrossings:r.thresholdCrossingsInVerifiedSelectedDays,
    knownFivePctEpisodes:r.fivePctDirectionalEpisodesInVerifiedSelectedDays,
    symbols:[...r.markets.CRYPTO_SPOT,...r.markets.CRYPTO_FUTURES].map(x=>({
      symbol:x.symbol,market:x.market,status:x.status,
      priceEvents:x.observedDayCrossingCount,
      corroboratedNativeEmptyMinutes:x.corroboratedNativeNoTradeMinuteCount??null,
      reason:x.reason??null,
    })),
    trueMarketWideRecall:null,profitabilityProven:false,executionAuthority:"NONE",
  })+"\n");
}
