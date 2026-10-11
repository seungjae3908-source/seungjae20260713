import {deriveArchivedResearchTimeframesV1} from "./research-minute-archive-v1.js";
import {auditHistoricalPITVenueUniverseV1,digestPITMembershipRowsV1}
  from "./historical-pit-venue-universe-gate-v1.js";

/**
 * Retrospective 1m OHLCV price-event labels, separated from CAUSAL entry
 * signals. T-minus features use only bars closed BEFORE the first minute
 * containing a threshold crossing; the exact trade/tick crossing is UNKNOWN.
 * Never count source-observed labels as actual market-wide opportunities or
 * as original scanner detection, fills, OOS PASS or profits.
 */
const MARKETS=new Set(["KR_STOCK","US_STOCK","CRYPTO_SPOT","CRYPTO_FUTURES"]);
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const SHA=/^[a-f0-9]{64}$/;
const DAY=86_400_000;
const fail=x=>{throw new TypeError(x);};
const safe=extra=>Object.freeze({
  schemaVersion:"four-market-original-minute-price-event-v1",
  status:"BLOCKED_DATA",reason:null,
  readOnly:true,sourceOnly:true,priceEventLabelsOnly:true,
  eventTimeResolution:"ONE_MINUTE_OHLCV_NOT_TICK",
  originalScannerAsOfSignalVerified:false,
  firstCrossingTickTimeEstablished:false,
  actualMarketWideOpportunityCount:null,trueMarketWideRecall:null,
  earlyDetectionRecall:null,verifiedHistoricalTradeEntryCount:null,
  actualFillCount:null,netProfitPct:null,OOSPassCount:0,
  fullMarketOpportunityDenominatorVerified:false,
  historicalWholeMarketPITIndependentlyAuthenticated:false,
  profitabilityProven:false,executionAuthority:"NONE",
  paperAdmissionAllowed:false,providerGETCount:0,realOrders:false,
  ...extra,
});
const finite=x=>typeof x==="number"&&Number.isFinite(x);
const percent=(a,b)=>b>0?100*(a/b-1):null;
function evidenceAt(bars,index){
  if(index<0)return null;
  const current=bars[index];
  const p=bars[Math.max(0,index-5)];
  const prior=bars.slice(Math.max(0,index-20),index);
  const volumeAverage=prior.length===20?
    prior.reduce((sum,x)=>sum+x.volume,0)/20:null;
  const all=bars.slice(0,index+1);
  const totalVolume=all.reduce((sum,x)=>sum+x.volume,0);
  const vwap=totalVolume>0?
    all.reduce((sum,x)=>sum+x.close*x.volume,0)/totalVolume:null;
  return Object.freeze({
    lastClosedMinuteEndMs:current.endMs,
    closedOneMinuteBarsUsed:index+1,
    priceReturnLastFiveBarsPercent:index>=5?percent(current.close,p.close):null,
    relativeVolumeToPrior20Minutes:volumeAverage>0?
      current.volume/volumeAverage:null,
    closeVsSessionVWAPPercent:vwap>0?percent(current.close,vwap):null,
    orderBookCVDAndOIUnavailable:true,
    originalProviderPublicationProven:false,
  });
}
function scanPriceEvents({bars,side,thresholds}){
  const first=bars[0].open;
  const events=[];
  for(const threshold of thresholds){
    const trigger=side==="LONG"
      ?first*(1+threshold/100):first*(1-threshold/100);
    const index=bars.findIndex(bar=>side==="LONG"
      ?bar.high>=trigger:bar.low<=trigger);
    if(index<0)continue;
    const current=bars[index];
    const anchors={};
    for(const minutes of [60,30,15,5,0]){
      // T0 MUST exclude the threshold-crossing minute itself. Its
      // high/low and intraminute trade sequence were not known at open.
      const cutoff=index-(minutes===0?1:minutes+1);
      anchors["T-"+minutes]=evidenceAt(bars,cutoff);
    }
    events.push(Object.freeze({
      thresholdPercent:threshold,side,
      firstObservedCrossingMinuteStartMs:current.startMs,
      priceTrigger:trigger,
      firstObservedOHLCVHighOrLow:side==="LONG"?current.high:current.low,
      tickCrossingTime:null,
      snapshots:anchors,
      earliestOriginalAsOfAlertProven:false,
      firstEntryPrice:null,firstEntryMAE:null,firstEntryMFE:null,
      liquidityAndActualCostEvidence:null,
    }));
  }
  return events;
}
export async function auditFourMarketOriginalMinuteOpportunityV1({
  root,market,symbol,day,sessionStartMs,sessionEndMs,
  sessionKind,sessionTimeZone,manifest,
  sourceDigestSha256=null,asOfMs,side="LONG",
  thresholdPercents=[3,5,10],
}={}){
  if(!MARKETS.has(market)||typeof symbol!=="string"||!symbol.trim()
    ||typeof day!=="string"||!DATE.test(day)
    ||new Date(day+"T00:00:00Z").toISOString().slice(0,10)!==day
    ||!Number.isSafeInteger(sessionStartMs)||sessionStartMs<=0
    ||!Number.isSafeInteger(sessionEndMs)||sessionEndMs<=sessionStartMs
    ||sessionEndMs-sessionStartMs>DAY
    ||!Number.isSafeInteger(asOfMs)||asOfMs<sessionEndMs
    ||!["LONG","SHORT"].includes(side)
    ||(side==="SHORT"&&market!=="CRYPTO_FUTURES")
    ||!Array.isArray(thresholdPercents)||thresholdPercents.length<1
    ||thresholdPercents.length>8||new Set(thresholdPercents).size!==thresholdPercents.length
    ||thresholdPercents.some(x=>!finite(x)||x<=0||x>99)
    ||(sourceDigestSha256!==null&&!SHA.test(sourceDigestSha256)))
    fail("PIT_ORIGINAL_PRICE_EVENT_INPUT_INVALID");
  const base={market,symbol,day,sessionStartMs,sessionEndMs,side,
    retrospectiveEventCount:0,
    sourceMinuteRows:null,thresholdsEvaluated:thresholdPercents,
    historicalSourceAndSessionVerified:false};
  if(!manifest||!Array.isArray(manifest.memberships)
    ||manifest.market!==market
    ||digestPITMembershipRowsV1(manifest.memberships)!==manifest.rawMembershipDigestSha256)
    return safe({...base,reason:"HISTORICAL_PIT_ROSTER_ABSENT_OR_CHANGED"});
  const startDay=Date.parse(day+"T00:00:00Z");
  const pit=auditHistoricalPITVenueUniverseV1({market,
    dayStartMs:startDay,dayEndMs:startDay+DAY,
    selectedRows:[],manifest});
  if(!["TEST_FIXTURE_ONLY","SOURCE_ATTESTED_PIT_COHORT_ONLY"]
    .includes(pit.status))
    return safe({...base,reason:"HISTORICAL_PIT_DAY_UNVERIFIED"});
  const member=manifest.memberships.filter(row=>
    String(row.symbol).trim().toUpperCase()===symbol.toUpperCase()
    &&row.listedAtMs<=sessionStartMs
    &&(row.removedAtMs??Infinity)>=sessionEndMs);
  if(member.length!==1||member[0].halts.some(h=>
    h.startMs<sessionEndMs&&h.endMs>sessionStartMs))
    return safe({...base,reason:"HISTORIC_MEMBER_SESSION_NOT_ENTITLED"});
  const data=await deriveArchivedResearchTimeframesV1({
    root,market,symbol,sessionStartMs,sourceDigestSha256,
    asOfMs,timeframes:["1m"],
  });
  const frame=data.intervalData?.["1m"];
  if(data.status==="BLOCKED_DATA"||data.sourceMinuteIntegrityVerified!==true
    ||data.archiveSessionEndMs!==sessionEndMs
    ||data.sessionKind!==sessionKind
    ||data.sessionTimeZone!==sessionTimeZone
    ||!frame||frame.sourceSessionCoverageComplete!==true
    ||frame.completeBarCount!==((sessionEndMs-sessionStartMs)/60_000))
    return safe({...base,reason:"NATIVE_ONE_MINUTE_SESSION_MISSING_OR_UNVERIFIED"});
  const bars=frame.bars;
  const events=scanPriceEvents({bars,side,thresholds:thresholdPercents});
  return safe({...base,status:"SOURCE_ONLY_OBSERVED_PRICE_EVENTS",
    reason:"RETROSPECTIVE_OHLCV_CROSSINGS_ARE_NOT_EARLY_SCANNER_OR_FILL_PROOF",
    sourceMinuteRows:bars.length,retrospectiveEventCount:events.length,
    originalSourceAvailableAtHistoricalCloseIndependentlyVerified:false,
    sourceDigestSha256:data.archiveSourceDigestSha256,
    selfAttestedPITSourceClass:manifest.sourceClass,
    observedPriceEvents:events,
  });
}
