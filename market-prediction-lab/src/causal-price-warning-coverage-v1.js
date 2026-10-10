import {createHash} from "node:crypto";
import {computeSearchQualityMetrics} from "./search-quality-metrics-v1.js";
import {nativeDayResultFromCollectedV1,UTC_DAY_SAMPLE_V1}
  from "../scripts/probe-native-utc-day-historical-v1.mjs";

/**
 * Causal PRICE-ONLY baseline diagnosis on a small, deliberately selected
 * historic native 1m source cohort. This is a retrospective counterfactual
 * calculation, NOT the original market scanner's logged detections and never
 * a real backtest fill/PnL/OOS. Daily highs score events only AFTER decisions.
 */
const MIN=60_000;
const MARKETS=["CRYPTO_SPOT","CRYPTO_FUTURES"];
const DIRECTIONS=Object.freeze({CRYPTO_SPOT:["LONG"],CRYPTO_FUTURES:["LONG","SHORT"]});
const defaultThresholds=Object.freeze([1,2,3,4]);
const sha256Bars=rows=>{
 const hash=createHash("sha256");
 for(const r of rows)hash.update([r.timestamp,r.open,r.high,r.low,r.close,r.volume].join(",")+"\n");
 return hash.digest("hex");
};
const finitePrice=v=>typeof v==="number"&&Number.isFinite(v)&&v>0;
function blocked(symbol,market,reason){
 return {market,symbol,status:"BLOCKED_DATA",reason,
   knownSourceCrossings:null,priceSignals:null,firstEarlySignal:null,
   trueMarketWideRecall:null,actualFillCount:null,netProfitPct:null};
}
function reconstructSourceRow(market,row,raw){
 const v=raw?.[row.symbol];
 if(!v||!Array.isArray(v.candles)||v.sourceSha256!==row.rawCandleSha256
   ||!v.venue||v.venue!==row.venue || !/^[a-f0-9]{64}$/i.test(row.rawCandleSha256??"")
   ||sha256Bars(v.candles)!==row.rawCandleSha256){
   return {error:"HISTORICAL_RAW_CANDLE_SHA_OR_VENUE_MISMATCH"};
 }
 const symbol=row.symbol,spot=market==="CRYPTO_SPOT";
 const collected={
   market,timeframe:"1m",
   requestedStartTime:UTC_DAY_SAMPLE_V1.historyStartMs,
   requestedEndTime:UTC_DAY_SAMPLE_V1.utcDayEndMs,
   rawPageWindowTraversed:true,historicalSignalAvailabilityProven:false,
   actualFillProven:false,candles:v.candles,
   ...(spot?{source:"upbit-public-candles",exchange:"UPBIT",
     providerMarket:symbol,intervalMs:MIN,symbol:symbol.slice(4)}:
     {provider:"bitget-public-v2",symbol}),
 };
 const reread=nativeDayResultFromCollectedV1(market,row.venue,collected,symbol);
 if(reread.status!=="OBSERVED_DAY_ONLY"
   ||reread.rawCandleSha256!==row.rawCandleSha256
   ||reread.previousUtcClose!==row.previousUtcClose
   ||reread.observedDayCrossingCount!==row.observedDayCrossingCount
   ||JSON.stringify(reread.opportunities)!==JSON.stringify(row.opportunities)){
   return {error:"DAILY_EVENT_AND_RAW_REPLAY_MISMATCH"};
 }
 return {candles:v.candles.slice(60),referenceClose:reread.previousUtcClose,
   events:reread.opportunities.filter(x=>x.thresholdPct===5)};
}
function evalMarket(row,market,thresholds,latencyMs,raw){
 if(row.status==="BLOCKED_DATA")return blocked(row.symbol,market,row.reason??"SOURCE_BLOCKED");
 if(row.status!=="OBSERVED_SELECTED_SYMBOL_DAY"||!row.symbol||row.market!==market)
   return blocked(row.symbol,market,"UNEXPECTED_SELECTED_MARKET_RECEIPT");
 const source=reconstructSourceRow(market,row,raw);
 if(source.error)return blocked(row.symbol,market,source.error);
 const eventsByDirection=new Map(source.events.map(e=>[e.direction,e]));
 const signals=[];
 for(const direction of DIRECTIONS[market]){
   const directionFactor=direction==="LONG"?1:-1;
   for(const thresholdPct of thresholds){
     const warning=source.candles.find(c=>
       directionFactor*(c.close/source.referenceClose-1)>=thresholdPct/100);
     const availableAtMs=warning?.timestamp+MIN+latencyMs;
     if(warning===undefined||availableAtMs>=UTC_DAY_SAMPLE_V1.utcDayEndMs)
       continue;
     const hitEvent=eventsByDirection.get(direction)??null;
     const hit=!!hitEvent && availableAtMs<hitEvent.firstCrossingBarStartMs;
     signals.push(Object.freeze({
       symbol:row.symbol,market,direction,warningThresholdPct:thresholdPct,
       signalId:["PRICE_ONLY",thresholdPct,market,row.symbol,direction,warning.timestamp].join(":"),
       signalAvailableAtMs:availableAtMs,
       assumedDataDelayMs:latencyMs,
       first5PctCrossingBarStartMs:hitEvent?.firstCrossingBarStartMs??null,
       hit,
       reason:hit?"BEFORE_5PCT_FIRST_CROSSING":
         !hitEvent?"NO_5PCT_FOLLOW_THROUGH":
         "TOO_LATE_OR_AFTER_FIRST_CROSSING",
       observedLeadLowerBoundMs:hit?hitEvent.firstCrossingBarStartMs-availableAtMs:null,
       actualScannerSignal:false,realOrderAllowed:false,actualFillCount:null,
     }));
   }
 }
 return Object.freeze({
   market,symbol:row.symbol,status:"COUNTERFACTUAL_SOURCE_COHORT_ONLY",
   knownSourceCrossings:source.events.length,
   known5PctEvents:source.events.map(e=>({eventId:e.eventId,symbol:row.symbol,
     direction:e.direction,firstCrossingBarStartMs:e.firstCrossingBarStartMs})),
   priceSignals:signals,
   historicalSignalAvailabilityProven:false,
   validListingAndDelistingUniverseProven:false,
   actualFillCount:null,netProfitPct:null,
 });
}
export function evaluateCausalPriceWarningCoverageV1({
  selectedSummary,selectedRaw,
  thresholds=defaultThresholds,assumedSourceToSignalDelayMs=2000,
}={}){
 if(!selectedSummary||selectedSummary.schemaVersion!=="native-selected-historical-utc-day-1m-pilot-v1"
   ||!selectedRaw||selectedRaw.schemaVersion!=="native-selected-public-historical-raw-1m-v1"
   ||selectedSummary.executionAuthority!=="NONE"
   ||selectedSummary.profitabilityProven!==false
   ||selectedSummary.historicalPointInTimeUniverseVerified!==false
   ||selectedSummary.trueMarketWideRecall!==null
   ||!selectedSummary.markets||!selectedRaw.raw)
   throw new TypeError("COUNTERFACTUAL_COHORT_RESEARCH_SOURCE_INVALID");
 if(!Array.isArray(thresholds)||!thresholds.length
   ||thresholds.length>4||thresholds.some(x=>!Number.isInteger(x)||x<1||x>=5)
   ||new Set(thresholds).size!==thresholds.length
   ||!Number.isSafeInteger(assumedSourceToSignalDelayMs)
   ||assumedSourceToSignalDelayMs<0||assumedSourceToSignalDelayMs>60_000)
   throw new TypeError("COUNTERFACTUAL_WARNING_SWEEP_INVALID");
 const observed=[];
 const marketRows={};
 for(const market of MARKETS){
   const rows=selectedSummary.markets[market];
   if(!Array.isArray(rows)||rows.length>4)throw new TypeError("SELECTED_MARKET_DATA_INVALID");
   marketRows[market]=rows.map(r=>evalMarket(r,market,thresholds,
     assumedSourceToSignalDelayMs,selectedRaw.raw));
   observed.push(...marketRows[market].filter(r=>r.status==="COUNTERFACTUAL_SOURCE_COHORT_ONLY"));
 }
 const results={};
 for(const warningThresholdPct of thresholds){
   const signals=observed.flatMap(row=>row.priceSignals.filter(
     x=>x.warningThresholdPct===warningThresholdPct));
   const events=observed.flatMap(row=>row.known5PctEvents);
   const settledSignals=signals.map(s=>({
     signalId:s.signalId,horizonKey:"FIRST_5PCT",direction:s.direction,
     hit:s.hit,matchedOpportunityId:s.hit
       ?events.find(e=>e.symbol===s.symbol&&e.direction===s.direction
          &&e.firstCrossingBarStartMs===s.first5PctCrossingBarStartMs)?.eventId??null:null,
     returnPct:null,leadTimeMs:s.observedLeadLowerBoundMs,
   }));
   const quality=computeSearchQualityMetrics({
     settledSignals,groundTruthOpportunities:events.map(e=>({
       opportunityId:e.eventId,horizonKey:"FIRST_5PCT",
     })),
   }).overall;
   results[String(warningThresholdPct)]=Object.freeze({
     warningThresholdPct,
     observedEventCount:events.length,
     candidateCount:signals.length,
     observedEarlyMatchedEvents:quality.matchedOpportunityCount,
     falsePositiveCandidates:quality.falsePositiveCount,
     missedObservedEvents:quality.falseNegativeCount,
     withinSelectedCohortPrecision:quality.precision,
     withinSelectedCohortRecall:quality.recall,
     meanObservedLeadMinutes:quality.averageLeadTimeMs==null
       ?null:quality.averageLeadTimeMs/MIN,
     // Signals use post-hoc native bars, which were NOT originally available
     // to this historical trading system. No economic or live credit.
     originalHistoricalScannerDetectionProven:false,
     oosStrategyPass:false,
   });
 }
 return Object.freeze({
   schemaVersion:"causal-price-only-warning-observed-cohort-v1",
   status:"POST_HOC_NAMED_SYMBOLS_NOT_OOS",
   dateUtc:"2025-02-03",thresholdsPct:[...thresholds],
   priceTargetPct:5,assumedSourceToSignalDelayMs,
   signalConstruction:"CLOSED_1M_CLOSE_PLUS_ASSUMED_DELAY_NOT_REAL_SCANNER",
   decisionUsedFutureBarHighLow:false,
   futureHighLowUsedOnlyForScoring:true,
   selectedSymbolDays:observed.length,
   blockedSelectedSymbolDays:Object.values(marketRows).flat().length-observed.length,
   markets:marketRows,results,
   historicalPointInTimeUniverseVerified:false,
   fullMarketOpportunityDenominatorVerified:false,
   realHistoricalScannerRecall:null,
   realHistoricalScannerPrecision:null,
   actualOrders:0,actualFills:null,netProfitPct:null,
   OOSPassCount:0,profitabilityProven:false,
   executionAuthority:"NONE",liveTrading:false,autoTrading:false,
 });
}
