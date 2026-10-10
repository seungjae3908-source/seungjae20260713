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
  market,symbol,venue,collected,
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
  // Native one-minute venue responses may omit time slots. Separate sparse
  // source rows from invalid symbol/time-window provenance, but do not
  // transform an absent native candle into a zero-volume synthetic candle.
  if(collected.candles.length!==sourceLimits.expectedMinuteRows)
    return blocked(market,venue,symbol,
      "ALT_NATIVE_MINUTE_ROW_COUNT_INCOMPLETE",{
        requestedMinuteSlots:sourceLimits.expectedMinuteRows,
        observedNativeSourceRows:collected.candles.length,
        minuteGapCauseIndependentlyVerified:false,
        absentMinuteIsNotZeroOpportunity:true,
      });
  const prior=collected.candles.slice(0,60);
  const day=collected.candles.slice(60);
  const audit=auditNativeObservedMinuteWindowV1({
    market,venue,source:src,symbol,
    startMs:DAY.utcDayStartMs,endMs:DAY.utcDayEndMs,
    bars:day,preWindowBars:prior,
    baselineMode:"PREVIOUS_UTC_DAY_LAST_MINUTE_CLOSE",
    pageWindowTraversed:true,
  });
  if(audit.status!=="OBSERVED_WINDOW_ONLY")
    return blocked(market,venue,symbol,audit.reason??"ALTS_DAY_MINUTE_GAP");
  return Object.freeze({
    market,venue,symbol,status:"OBSERVED_SELECTED_SYMBOL_DAY",
    utcDayStartMs:DAY.utcDayStartMs,utcDayEndMs:DAY.utcDayEndMs,
    source:src,sourceAcquiredAfterDay:true,
    originalScannerAsOfVerified:false,
    dateSpecificHistoricalPITMembershipVerified:false,
    previousUtcClose:audit.baselinePrice,
    priorHourObservedMinuteCount:60,
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
      result=auditMatchedAltDayFromCollectedV1({
        market:"CRYPTO_SPOT",venue:"UPBIT_KRW",symbol,collected:c,
      });
      if(result.status==="OBSERVED_SELECTED_SYMBOL_DAY")
        raw["CRYPTO_SPOT:"+symbol]={sourceDigestSha256:result.rawCandleSha256,
          candles:c.candles,venue:"UPBIT_KRW"};
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
  return Object.freeze({
    schemaVersion:"native-watch-matched-alt-six-utc-day-v1",
    sourceDate:WATCH_MATCH_ALT_PILOT_V1,
    status:accepted.length?"SOURCE_LIMITED_SELECTED_ALTS_ONLY":"BLOCKED_DATA",
    markets:{
      KR_STOCK:blocked("KR_STOCK","KRX",null,"KR_PIT_ONE_MINUTE_NOT_CONNECTED"),
      US_STOCK:blocked("US_STOCK","US_SIP",null,"US_PIT_SIP_ONE_MINUTE_NOT_CONNECTED"),
      CRYPTO_SPOT:spot,CRYPTO_FUTURES:futures,
    },
    selectedAltSymbolDays:6,observedSelectedAltSymbolDays:accepted.length,
    blockedSelectedAltSymbolDays:6-accepted.length,
    thresholdCrossingsInVerifiedSelectedDays:accepted.length
      ?accepted.reduce((n,r)=>n+r.observedDayCrossingCount,0):null,
    fivePctDirectionalEpisodesInVerifiedSelectedDays:accepted.length
      ?accepted.reduce((n,r)=>n+r.opportunities.filter(e=>e.thresholdPct===5).length,0):null,
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
  const r=await probeMatchedAltSymbolsNativeDayV1();
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
    blockedAltDays:r.blockedSelectedAltSymbolDays,
    knownThresholdCrossings:r.thresholdCrossingsInVerifiedSelectedDays,
    knownFivePctEpisodes:r.fivePctDirectionalEpisodesInVerifiedSelectedDays,
    symbols:[...r.markets.CRYPTO_SPOT,...r.markets.CRYPTO_FUTURES].map(x=>({
      symbol:x.symbol,market:x.market,status:x.status,
      priceEvents:x.observedDayCrossingCount,
      reason:x.reason??null,
    })),
    trueMarketWideRecall:null,profitabilityProven:false,executionAuthority:"NONE",
  })+"\n");
}
