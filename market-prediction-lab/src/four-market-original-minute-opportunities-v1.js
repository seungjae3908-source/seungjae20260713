import {deriveArchivedResearchTimeframesV1} from "./research-minute-archive-v1.js";
import {auditHistoricalPITVenueUniverseV1,digestPITMembershipRowsV1}
  from "./historical-pit-venue-universe-gate-v1.js";
import {validateResearchStockSessionsForDateV1}
  from "./research-minute-archive-window-v1.js";
import {createHash} from "node:crypto";

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
const DAY=86_400_000,MINUTE=60_000;
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
function evidenceAt(bars,index,requestedAtMs=null){
  if(index<0)return null;
  const current=bars[index];
  // Never combine a 5/20-minute average across an exchange closure,
  // interruption or missing source minute. Such indicators stay UNKNOWN.
  const consecutive=count=>index>=count&&
    bars.slice(index-count,index+1).every((b,i,window)=>
      i===0||b.startMs===window[i-1].endMs);
  const p=consecutive(5)?bars[index-5]:null;
  const prior=consecutive(20)?bars.slice(index-20,index):[];
  const volumeAverage=prior.length===20?
    prior.reduce((sum,x)=>sum+x.volume,0)/20:null;
  const all=bars.slice(0,index+1);
  const totalVolume=all.reduce((sum,x)=>sum+x.volume,0);
  const vwap=totalVolume>0?
    all.reduce((sum,x)=>sum+x.close*x.volume,0)/totalVolume:null;
  const lag=requestedAtMs==null?null:
    (requestedAtMs-current.endMs)/MINUTE;
  return Object.freeze({
    lastClosedMinuteEndMs:current.endMs,
    requestedEvidenceWallClockMs:requestedAtMs,
    minutesBetweenEvidenceAnchorAndLastClosedBar:lag,
    closeToAnchorWithoutGap:lag===0,
    closedOneMinuteBarsUsed:index+1,
    priceReturnLastFiveBarsPercent:p?
      percent(current.close,p.close):null,
    relativeVolumeToPrior20Minutes:volumeAverage>0?
      current.volume/volumeAverage:null,
    closeVsObservedDateVWAPPercent:vwap>0?
      percent(current.close,vwap):null,
    closeVsSessionVWAPPercent:vwap>0?
      percent(current.close,vwap):null,
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
      // Select an actually CLOSED original bar at T-minus WALL-CLOCK
      // minutes. Never mistake 60 separated bars for 60 continuous
      // minutes or include the threshold-crossing minute's high/low.
      const at=current.startMs-minutes*MINUTE;
      let cutoff=index-1;
      while(cutoff>=0&&bars[cutoff].endMs>at)cutoff--;
      anchors["T-"+minutes]=evidenceAt(bars,cutoff,at);
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



/**
 * Whole EXCHANGE-LOCAL TRADING DAY 1m threshold labels. Session boundaries
 * are supplied explicitly (and can contain a real market closure gap).
 * This never synthesizes intermediate candles and never restarts the price
 * baseline at the regular open after a premarket session.
 */
export async function auditFourMarketOriginalMinuteOpportunityDayV1({
  root,market,symbol,day,manifest,stockCalendar=null,
  sessions=[],asOfMs,side="LONG",thresholdPercents=[3,5,10],
}={}){
  if(!MARKETS.has(market)||typeof symbol!=="string"||!symbol.trim()
    ||typeof day!=="string"||!DATE.test(day)
    ||!Number.isSafeInteger(asOfMs)||asOfMs<=0
    ||!["LONG","SHORT"].includes(side)
    ||(side==="SHORT"&&market!=="CRYPTO_FUTURES")
    ||!Array.isArray(sessions)||sessions.length<1||sessions.length>16
    ||!Array.isArray(thresholdPercents)||thresholdPercents.length<1
    ||thresholdPercents.length>8
    ||new Set(thresholdPercents).size!==thresholdPercents.length
    ||thresholdPercents.some(v=>!finite(v)||v<=0||v>99))
    fail("PIT_ORIGINAL_DATED_EVENT_INPUT_INVALID");
  const stock=market==="KR_STOCK"||market==="US_STOCK";
  if(stockCalendar!==null&&!stock)
    fail("PIT_ORIGINAL_DATED_EVENT_CRYPTO_STOCK_CALENDAR_FORBIDDEN");
  const blocked=reason=>safe({market,symbol,day,side,
    status:"BLOCKED_DATA",reason,sourceSessionsInspected:null,
    sourceMinuteRows:null,observedPriceEvents:[],
    retrospectiveEventCount:null});
  if(!manifest||!Array.isArray(manifest.memberships)
    ||manifest.market!==market
    ||digestPITMembershipRowsV1(manifest.memberships)!==manifest.rawMembershipDigestSha256)
    return blocked("HISTORIC_PIT_ROSTER_INVALID_OR_MISSING");
  const dateMs=Date.parse(day+"T00:00:00Z");
  if(!Number.isSafeInteger(dateMs)
    ||new Date(dateMs).toISOString().slice(0,10)!==day)
    fail("PIT_ORIGINAL_DATED_EVENT_DATE_INVALID");
  const pit=auditHistoricalPITVenueUniverseV1({market,
    dayStartMs:dateMs,dayEndMs:dateMs+DAY,
    selectedRows:[],manifest});
  if(!["TEST_FIXTURE_ONLY","SOURCE_ATTESTED_PIT_COHORT_ONLY"]
    .includes(pit.status))
    return blocked("HISTORICAL_PIT_DAY_UNVERIFIED");
  const zone=market==="KR_STOCK"?"Asia/Seoul":
    market==="US_STOCK"?"America/New_York":"UTC";
  if(stock&&!stockCalendar)return blocked("EXCHANGE_SESSION_CALENDAR_REQUIRED");
  const expected=stock
    ?validateResearchStockSessionsForDateV1(
      market,stockCalendar,day,day):[];
  if(stock&&expected.length!==sessions.length)
    return blocked("MISSING_OR_EXTRA_EXCHANGE_DAY_SESSIONS");
  if(!stock&&(sessions.length!==1
    ||sessions[0]?.startMs!==dateMs
    ||sessions[0]?.endMs!==dateMs+DAY
    ||sessions[0]?.kind!=="UTC_24H"))
    return blocked("CRYPTO_DAY_MUST_HAVE_EXACT_UTC_SESSION");
  let prev=-Infinity;
  const bars=[],digests=[];
  for(let i=0;i<sessions.length;i++){
    const item=sessions[i];
    if(!item||typeof item!=="object"||Array.isArray(item)
      ||item.date!==day
      ||!Number.isSafeInteger(item.startMs)||!Number.isSafeInteger(item.endMs)
      ||item.startMs<=prev||item.endMs<=item.startMs
      ||item.endMs-item.startMs>DAY
      ||item.zone!==zone||!["PREMARKET","REGULAR","AFTERMARKET","UTC_24H"]
        .includes(item.kind)
      ||(item.sourceDigestSha256!=null
        &&!SHA.test(item.sourceDigestSha256)))
      return blocked("EXCHANGE_DAY_SESSION_INDEX_INVALID");
    prev=item.endMs-1;
    if(stock){
      const exp=expected[i];
      if(item.date!==exp.tradingDateLocal
        ||item.startMs!==exp.startMs||item.endMs!==exp.endMs
        ||item.kind!==exp.kind||item.zone!==exp.timeZone)
        return blocked("EXPECTED_STOCK_SESSION_NOT_MATCHED");
    }
    const members=manifest.memberships.filter(m=>
      String(m.symbol).trim().toUpperCase()===symbol.toUpperCase()
      &&m.listedAtMs<=item.startMs
      &&(m.removedAtMs??Infinity)>=item.endMs);
    if(members.length!==1||members[0].halts.some(h=>
      h.startMs<item.endMs&&h.endMs>item.startMs))
      return blocked("HISTORIC_MEMBER_EXCHANGE_SESSION_NOT_ENTITLED");
    const result=await deriveArchivedResearchTimeframesV1({
      root,market,symbol,sessionStartMs:item.startMs,
      sourceDigestSha256:item.sourceDigestSha256??null,
      asOfMs,timeframes:["1m"],
    });
    const frame=result.intervalData?.["1m"];
    if(result.status==="BLOCKED_DATA"
      ||result.sourceMinuteIntegrityVerified!==true
      ||result.archiveSessionEndMs!==item.endMs
      ||result.sessionKind!==item.kind
      ||result.sessionTimeZone!==item.zone
      ||!frame||frame.sourceSessionCoverageComplete!==true
      ||frame.completeBarCount!==(item.endMs-item.startMs)/MINUTE)
      return blocked("EXCHANGE_DAY_ORIGINAL_1M_SOURCE_PARTIAL_OR_MISSING");
    if(bars.length&&frame.bars[0].startMs<bars.at(-1).endMs)
      return blocked("OVERLAPPING_EXCHANGE_SESSIONS_UNSAFE");
    bars.push(...frame.bars);
    digests.push([item.date,item.startMs,result.archiveSourceDigestSha256]);
  }
  const result=scanPriceEvents({bars,side,thresholds:thresholdPercents});
  return safe({market,symbol,day,side,
    status:"SOURCE_ONLY_OBSERVED_PRICE_EVENTS",
    reason:"RETROSPECTIVE_DATED_1M_EVENT_LABELS_NOT_ASOF_SIGNAL_OR_FILL",
    sourceSessionsInspected:sessions.length,
    sourceMinuteRows:bars.length,
    sourceDigestChainSha256:createHash("sha256")
      .update(JSON.stringify(digests)).digest("hex"),
    observedPriceEvents:result,
    retrospectiveEventCount:result.length,
    officialFullExchangeDayCalendarIndependentlyAuthenticated:false,
    originalHistoricalScannerPublicationVerified:false,
  });
}
