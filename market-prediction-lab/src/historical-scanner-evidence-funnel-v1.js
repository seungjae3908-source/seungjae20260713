import { computeSearchQualityMetrics } from "./search-quality-metrics-v1.js";

/**
 * Compare source-limited *observed* historical first crossings with ORIGINAL
 * minute-by-minute scanner evidence. Never turn an absent or retrospectively
 * generated scanner ledger into missed signals, zero discovery, or PnL.
 *
 * Deliberately not an independent OMS/Paper/backtester implementation.
 * Canonical quality math is reused only for a named, fully logged test/cohort.
 */
const MINUTE_MS=60_000;
const MARKETS=Object.freeze({
  KR_STOCK:"KRX",US_STOCK:"US_SIP",
  CRYPTO_SPOT:"UPBIT_KRW",CRYPTO_FUTURES:"BITGET_USDT_FUTURES",
});
const MARKET_KEYS=Object.freeze(Object.keys(MARKETS));
const STAGES=new Set(["CANDIDATE","RANK_EXCLUDED","ENTRY_BLOCKED","EXECUTION_FAILED","PAPER_FILLED"]);
const THRESHOLDS=new Set([5,10,20]);
const isTime=n=>Number.isSafeInteger(n)&&n>0;
const sha=s=>typeof s==="string" && /^[0-9a-f]{64}$/i.test(s);
const norm=s=>String(s??"").trim().toUpperCase();
function blockedMarket(market,reason,additional={}){
  return Object.freeze({
    market,status:"BLOCKED_DATA",reason,
    observedOpportunityCount:null,earlyDetectedCount:null,
    observedCohortEarlyRecall:null,observedCohortPrecision:null,
    falsePositiveSignals:null,opportunities:null,
    reasonCounts:null,metrics:null,
    trueMarketWideRecall:null,fullMarketOpportunityDenominatorVerified:false,
    actualFillCount:null,netProfitPct:null,...additional,
  });
}
function validateObservedDay(market,day){
  if(!day||day.status!=="OBSERVED_DAY_ONLY")return {error:"NO_OBSERVED_DAY_PROOF"};
  const start=day.utcDayStartMs,end=day.utcDayEndMs;
  if(day.market!==market||day.venue!==MARKETS[market]||!isTime(start)||!isTime(end)
     ||end-start!==86_400_000||!Number.isFinite(day.previousUtcClose)
     ||day.previousUtcClose<=0||day.observedMinuteCount!==1440
     ||day.priorHourObservedMinuteCount!==60
     ||day.baselineDefinition!=="PREVIOUS_UTC_DAY_FINAL_1M_CLOSE_SAME_VENUE"
     ||day.sourceAcquiredAfterDay!==true||!sha(day.rawCandleSha256)
     ||!Array.isArray(day.opportunities)
     ||day.observedDayCrossingCount!==day.opportunities.length
     ||day.fullMarketListedAndDelistedUniverseProven!==false
     ||day.historicalScannerAsOfAvailabilityVerified!==false
     ||day.trueMarketWideRecall!==null||day.actualFillCount!==null
     ||day.netProfitPct!==null) return {error:"OBSERVED_DAY_TRUTH_CONTRACT_INVALID"};
  const seen=new Set();
  const symbol=norm(day.symbol);
  if(!symbol)return {error:"OBSERVED_DAY_SYMBOL_INVALID"};
  for(const event of day.opportunities){
    const direction=norm(event?.direction);
    if(!event || event.market!==market||event.venue!==MARKETS[market]
       ||norm(event.symbol)!==symbol||!THRESHOLDS.has(event.thresholdPct)
       ||(direction!=="LONG" && !(market==="CRYPTO_FUTURES" && direction==="SHORT"))
       ||typeof event.eventId!=="string"||!event.eventId
       ||seen.has(event.eventId)
       ||!isTime(event.firstCrossingBarStartMs)
       ||event.firstCrossingBarStartMs<start||event.firstCrossingBarStartMs>=end
       ||event.firstCrossingBarEndMs!==event.firstCrossingBarStartMs+MINUTE_MS
       ||typeof event.openedAlreadyBeyondThreshold!=="boolean"
       ||event.exactTradeTimestampMs!==null
       ||event.firstSeenByHistoricalScannerAtMs!==null
       ||event.actualExecutableEntryPrice!==null){
      return {error:"OBSERVED_EVENT_CONTRACT_INVALID"};
    }
    seen.add(event.eventId);
  }
  return {day,start,end,symbol,events:day.opportunities};
}
function validateHistoricalScannerLedger(dayData,ledger){
  if(!ledger)return {error:"HISTORICAL_SCANNER_LEDGER_NOT_AVAILABLE"};
  const {day,start,end,symbol}=dayData;
  if(ledger.schemaVersion!=="historical-scanner-prospective-ledger-v1"
    ||ledger.market!==day.market||ledger.venue!==day.venue
    ||ledger.startMs!==start||ledger.endMs!==end
    ||!sha(ledger.sourceEvidenceSha256)
    ||typeof ledger.sourceId!=="string"||!ledger.sourceId.trim()
    ||!["PROSPECTIVE_IMMUTABLE","TEST_FIXTURE"].includes(ledger.captureMode)
    ||(ledger.captureMode==="TEST_FIXTURE"&&ledger.testOnly!==true)
    ||ledger.syntheticHistoricalData===true && ledger.captureMode!=="TEST_FIXTURE"
    ||!Array.isArray(ledger.snapshots)||ledger.snapshots.length!==1440){
    return {error:"HISTORICAL_SCANNER_LEDGER_UNVERIFIED"};
  }
  const signals=[];
  const minutes=[];
  const usedSignalIds=new Map();
  for(const [index,snapshot] of ledger.snapshots.entries()){
    const minute=start+index*MINUTE_MS;
    if(snapshot?.asOfMs!==minute
      ||!isTime(snapshot.persistedAtMs)
      ||snapshot.persistedAtMs<minute
      ||snapshot.persistedAtMs>=minute+MINUTE_MS
      ||!isTime(snapshot.dataCutoffMs)
      ||snapshot.dataCutoffMs>minute
      ||!["READY","DATA_DELAYED"].includes(snapshot.status)
      ||!Array.isArray(snapshot.watchedSymbols)
      ||!Array.isArray(snapshot.signals)){
      return {error:"SCANNER_HEARTBEAT_OR_ASOF_GAP",index};
    }
    const watchList=snapshot.watchedSymbols.map(norm);
    if(watchList.some(x=>!x)||new Set(watchList).size!==watchList.length)
      return {error:"SCANNER_WATCHLIST_INVALID",index};
    const stale=minute-snapshot.dataCutoffMs>180_000;
    if(stale && snapshot.status!=="DATA_DELAYED")
      return {error:"SCANNER_STALE_DATA_MISLABELED_READY",index};
    minutes.push({asOfMs:minute,watched:watchList.includes(symbol),
      delayed:snapshot.status==="DATA_DELAYED"});
    for(const row of snapshot.signals){
      const stage=norm(row?.stage),sym=norm(row?.symbol),dir=norm(row?.direction);
      const id=String(row?.signalId??"").trim();
      if(!STAGES.has(stage)||!sym||!id
        ||!(dir==="LONG"||(day.market==="CRYPTO_FUTURES"&&dir==="SHORT"))
        ||!isTime(row?.availableAtMs)
        ||row.availableAtMs<minute||row.availableAtMs>snapshot.persistedAtMs
        ||!watchList.includes(sym)
        ||snapshot.status==="DATA_DELAYED"){
        return {error:"SCANNER_SIGNAL_PROVENANCE_INVALID",index};
      }
      const old=usedSignalIds.get(id);
      if(old && (old.symbol!==sym||old.direction!==dir))
        return {error:"SCANNER_SIGNAL_ID_COLLISION",index};
      usedSignalIds.set(id,{symbol:sym,direction:dir});
      signals.push({
        signalId:id,symbol:sym,direction:dir,stage,
        availableAtMs:row.availableAtMs,
        persistedAtMs:snapshot.persistedAtMs,
      });
    }
  }
  return {minutes,signals,dayStartMs:start,dayEndMs:end,day,subjectSymbol:symbol,
    captureMode:ledger.captureMode};
}
function summarizeObservedMarket(market,day,ledger){
  const validated=validateObservedDay(market,day);
  if(validated.error)return blockedMarket(market,validated.error);
  const n=validated.events.length;
  const basic=Object.freeze({
    market,venue:day.venue,symbol:day.symbol,
    status:"OBSERVED_COHORT_SCANNER_UNVERIFIED",
    observedOpportunityCount:n,priorClose:day.previousUtcClose,
    candleSha256:day.rawCandleSha256,
    trueMarketWideRecall:null,fullMarketOpportunityDenominatorVerified:false,
    actualFillCount:null,netProfitPct:null,profitabilityProven:false,
    executionAuthority:"NONE",
  });
  if(!ledger){
    return Object.freeze({...basic,
      earlyDetectedCount:null,observedCohortEarlyRecall:null,
      observedCohortPrecision:null,falsePositiveSignals:null,
      metrics:null,reasonCounts:n?{"SCANNER_LEDGER_NOT_AVAILABLE":n}:{},
      opportunities:validated.events.map(event=>({
        eventId:event.eventId,firstCrossingBarStartMs:event.firstCrossingBarStartMs,
        direction:event.direction,thresholdPct:event.thresholdPct,
        discoveryStatus:"UNVERIFIED_SCANNER_LEDGER",
        earlyDetected:null,firstEligibleSignalAtMs:null,
        matchedSignalId:null,realFillProven:false,
      })),
    });
  }
  const scan=validateHistoricalScannerLedger(validated,ledger);
  if(scan.error)return Object.freeze({...basic,status:"SCANNER_LEDGER_BLOCKED",
    reason:scan.error,reasonDetails:scan.index===undefined?null:{index:scan.index},
    earlyDetectedCount:null,observedCohortEarlyRecall:null,
    observedCohortPrecision:null,falsePositiveSignals:null,
    metrics:null,reasonCounts:null,opportunities:null});
  const uniqueSignals=new Map();
  for(const signal of scan.signals){
    if(signal.symbol!==validated.symbol)continue;
    const prev=uniqueSignals.get(signal.signalId);
    if(!prev)uniqueSignals.set(signal.signalId,signal);
  }
  const assigned=validated.events.map(event=>{
    const before=scan.signals.filter(x=>x.symbol===validated.symbol
      &&x.direction===norm(event.direction)
      &&x.persistedAtMs<event.firstCrossingBarStartMs);
    const firstBySignal=new Map();
    for(const s of before)if(!firstBySignal.has(s.signalId))
      firstBySignal.set(s.signalId,s);
    const ranked=[...firstBySignal.values()].sort(
      (a,b)=>a.persistedAtMs-b.persistedAtMs || a.signalId.localeCompare(b.signalId));
    const first=ranked[0];
    const cutoff=event.firstCrossingBarStartMs;
    const earlierMinutes=scan.minutes.filter(x=>x.asOfMs<cutoff);
    let reason,matchedSignalId=null,firstEligibleSignalAtMs=null;
    if(first){
      matchedSignalId=first.signalId;
      firstEligibleSignalAtMs=first.persistedAtMs;
      const last=before.filter(x=>x.signalId===matchedSignalId).at(-1);
      reason=last?.stage==="CANDIDATE"?"ENTRY_OUTCOME_UNVERIFIED"
        :last?.stage==="PAPER_FILLED"?"PAPER_FILL_NOT_LIVE"
        :last?.stage??"ENTRY_OUTCOME_UNVERIFIED";
    }else if(event.openedAlreadyBeyondThreshold){
      reason="OPEN_ALREADY_BEYOND_THRESHOLD";
    }else if(!earlierMinutes.some(x=>x.watched)){
      reason="UNIVERSE_MISSING";
    }else if(earlierMinutes.some(x=>x.watched&&x.delayed)){
      reason="DATA_DELAYED";
    }else {
      reason="SIGNAL_MISSED";
    }
    return Object.freeze({
      eventId:event.eventId,direction:event.direction,thresholdPct:event.thresholdPct,
      firstCrossingBarStartMs:cutoff,
      firstCrossingBarEndMs:event.firstCrossingBarEndMs,
      discoveryStatus:reason,
      earlyDetected:!!first,
      firstEligibleSignalAtMs,matchedSignalId,
      observedLeadLowerBoundMs:first ? cutoff-first.persistedAtMs : null,
      realFillProven:false,
    });
  });
  // This is ONLY a within-symbol observed sample metric, not all-symbol market
  // recall. Canonical metrics require full ledger for all candidate signals.
  const settledSignals=[];
  for(const signal of uniqueSignals.values()) {
    for(const pct of THRESHOLDS) {
      const horizonKey="FIRST_"+pct+"PCT";
      const hit=assigned.find(x=>x.direction===signal.direction
        &&x.thresholdPct===pct &&signal.persistedAtMs<x.firstCrossingBarStartMs);
      settledSignals.push({
        signalId:signal.signalId+":"+pct,horizonKey,direction:signal.direction,
        hit:!!hit,matchedOpportunityId:hit?.eventId??null,
        returnPct:null,leadTimeMs:hit?hit.firstCrossingBarStartMs-signal.persistedAtMs:null,
      });
    }
  }
  const quality=computeSearchQualityMetrics({
    settledSignals,
    groundTruthOpportunities:assigned.map(e=>({
      opportunityId:e.eventId,horizonKey:"FIRST_"+e.thresholdPct+"PCT",
    })),
  });
  const matchedCount=assigned.filter(x=>x.earlyDetected).length;
  const reasonCounts={};
  for(const row of assigned)reasonCounts[row.discoveryStatus]=(reasonCounts[row.discoveryStatus]??0)+1;
  const metrics=Object.freeze({
    ...quality,
    // Distinguish a fixture from a genuine originally recorded ledger.
    evidenceClassification:scan.captureMode==="TEST_FIXTURE"
      ?"SYNTHETIC_CONTRACT_TEST_ONLY":"ATTESTED_ORIGINAL_LEDGER_NAMED_SYMBOL_COHORT",
  });
  return Object.freeze({...basic,
    status:scan.captureMode==="TEST_FIXTURE"
      ?"TEST_FIXTURE_ONLY":"ATTESTED_OBSERVED_COHORT_ONLY",
    earlyDetectedCount:matchedCount,
    observedCohortEarlyRecall:n?matchedCount/n:null,
    observedCohortPrecision:quality.overall.precision,
    falsePositiveSignals:quality.overall.falsePositiveCount,
    reasonCounts,opportunities:assigned,metrics,
    scannerSourceId:ledger.sourceId,scannerSourceEvidenceSha256:ledger.sourceEvidenceSha256,
    originalHistoricalScannerCaptureIndependentlyVerified:false,
  });
}

export function buildHistoricalScannerFunnelReadinessV1({nativeUtcDayReport,scannerLedgers={}}={}){
  if(!nativeUtcDayReport||nativeUtcDayReport.schemaVersion!=="native-utc-day-historical-public-1m-audit-v1"
     ||nativeUtcDayReport.executionAuthority!=="NONE"
     ||nativeUtcDayReport.profitabilityProven!==false
     ||nativeUtcDayReport.fullMarketOpportunityDenominatorVerified!==false
     ||nativeUtcDayReport.trueMarketWideRecall!==null
     ||!nativeUtcDayReport.markets||typeof nativeUtcDayReport.markets!=="object")
    throw new TypeError("NATIVE_DAY_RESEARCH_SAFETY_RECEIPT_INVALID");
  if(!scannerLedgers||typeof scannerLedgers!=="object"||Array.isArray(scannerLedgers))
    throw new TypeError("SCANNER_LEDGERS_INVALID");
  const markets={};
  for(const market of MARKET_KEYS){
    const day=nativeUtcDayReport.markets[market];
    if(!day)throw new TypeError("FOUR_MARKET_SOURCE_MISSING:"+market);
    if(day.status==="BLOCKED_DATA"){
      markets[market]=blockedMarket(market,day.reason??"SOURCE_DATA_BLOCKED");
    }else{
      markets[market]=summarizeObservedMarket(market,day,scannerLedgers[market]);
    }
  }
  const totalKnown=Object.values(markets)
    .filter(x=>Number.isInteger(x.observedOpportunityCount))
    .reduce((sum,x)=>sum+x.observedOpportunityCount,0);
  return Object.freeze({
    schemaVersion:"historical-scanner-evidence-funnel-readiness-v1",
    status:"RESEARCH_COHORT_ONLY",
    eventDay:nativeUtcDayReport.sampledDay,
    observedOpportunityCountInAvailableSamples:totalKnown,
    markets,
    marketWideOpportunityDenominatorVerified:false,
    trueMarketWideRecall:null,
    realTradeCount:null,actualFillCount:null,costAdjustedNetReturn:null,
    OOSPassCount:0,profitabilityProven:false,
    executionAuthority:"NONE",liveTrading:false,autoTrading:false,
    privateApiRequests:false,realOrders:false,
    sourceAfterTheFactCannotProveHistoricalScannerDiscovery:true,
  });
}
