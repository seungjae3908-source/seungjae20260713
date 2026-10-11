import {createHash} from "node:crypto";
import {TIMEFRAME_MS,timeframeToMs} from "./timeframes.js";

/**
 * Research-only resampling of existing, provider-attested closed 1-minute
 * OHLCV. This is NOT a downloader and cannot infer market coverage, original
 * scanner alerts, trade direction/CVD/OI, ticks, fills, OOS or profitability.
 *
 * Shared TIMEFRAME_MS is the existing prediction-lab interval contract.
 * Clock alignment is venue/session-specific, not blind UTC midnights for
 * KRX/NASDAQ regular/pre/aftermarket sessions. Never silently fabricate
 * missing Upbit no-trade minutes or bridge an overnight/session boundary.
 *
 * Input one venue+symbol+verified source/session at a time. This normalized
 * layer complements (and does not replace) the application's chart-only
 * aggregateOneMinuteCandles in api-server/src/lib.
 */
const MINUTE=60_000,DAY=86_400_000;
const VENUES=Object.freeze({
 KR_STOCK:"KRX",US_STOCK:"US_SIP",
 CRYPTO_SPOT:"UPBIT_KRW",CRYPTO_FUTURES:"BITGET_USDT_FUTURES",
});
const ZONES=Object.freeze({
 KR_STOCK:"Asia/Seoul",US_STOCK:"America/New_York",
 CRYPTO_SPOT:"UTC",CRYPTO_FUTURES:"UTC",
});
const SYMBOL=/^[A-Z0-9][A-Z0-9._:-]{0,39}$/;
const SHA=/^[0-9a-f]{64}$/;
const sha=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const time=x=>Number.isSafeInteger(x)&&x>0;
const positive=x=>typeof x==="number"&&Number.isFinite(x)&&x>0;
const safe=data=>Object.freeze({
 schemaVersion:"four-market-research-minute-multitimeframe-v1",
 status:"BLOCKED_DATA",reason:null,
 market:null,venue:null,symbol:null,
 sourceMinuteRowsSha256:null,sourceMinuteRows:0,
 sourceMinuteIntegrityVerified:false,
 stockExchangeSessionIndependentlyVerified:false,
 venueHistoricalPITUniverseIndependentlyVerified:false,
 firstCrossingTickTimeEstablished:false,
 originalScannerEarlyDiscoveryVerified:false,
 fullMarketOpportunityDenominatorVerified:false,
 actualMarketWideOpportunityCount:null,trueMarketWideRecall:null,
 actualFillCount:null,netProfitPct:null,OOSPassCount:0,
 profitabilityProven:false,executionAuthority:"NONE",
 liveTrading:false,autoTrading:false,realOrders:false,
 ...data,
});
function getIntervals(timeframes){
 if(!Array.isArray(timeframes)||timeframes.length<1||timeframes.length>16
   ||new Set(timeframes).size!==timeframes.length)
   throw new TypeError("RESEARCH_MULTITIMEFRAME_SELECTION_INVALID");
 return timeframes.map(name=>{
  if(typeof name!=="string")throw new TypeError("RESEARCH_INTERVAL_INVALID");
  // Reject Object.prototype keys masquerading as supported timeframes.
  let duration=Object.prototype.hasOwnProperty.call(TIMEFRAME_MS,name)
    ?TIMEFRAME_MS[name]:null;
  if(!duration){
   const match=/^([1-9]\d{0,3})m$/.exec(name);
   const minutes=match?Number(match[1]):0;
   if(minutes<1||minutes>1440)
    throw new TypeError("RESEARCH_INTERVAL_UNSUPPORTED");
   duration=minutes*MINUTE;
  }else if(duration!==timeframeToMs(name)){
   throw new TypeError("RESEARCH_INTERVAL_CONTRACT_MISMATCH");
  }
  return {name,minutes:duration/MINUTE,widthMs:duration};
 });
}
/**
 * session: {startMs,endMs,kind:"UTC_24H"|"REGULAR"|"PREMARKET"|"AFTERMARKET",
 * timeZone:"UTC"|"Asia/Seoul"|"America/New_York",calendarSourceId:"..."}
 * minuteBars: original ordered 1-minute OHLCV rows:
 * {market,venue,symbol,sourceId,timestampMs,availableAtMs,open,high,low,close,volume}
 * The input SHA is checked against exact JSON serialization before analysis.
 */
export function deriveResearchTimeframesFromMinuteSourceV1({
 market,venue,symbol,sourceId,session,minuteBars=null,
 sourceMinuteRowsSha256=null,
 asOfMs,timeframes=["1m","3m","5m","15m","30m","1h","4h"],
}={}){
 const intervals=getIntervals(timeframes);
 const identity={market,venue,symbol};
 const stop=reason=>safe({...identity,reason,
   sourceMinuteRowsSha256:SHA.test(sourceMinuteRowsSha256??"")
     ?sourceMinuteRowsSha256:null,
 });
 if(!Object.prototype.hasOwnProperty.call(VENUES,market)
   ||VENUES[market]!==venue||typeof symbol!=="string"
   ||!SYMBOL.test(symbol)||typeof sourceId!=="string"
   ||sourceId.length<3||sourceId.length>160||!time(asOfMs))
  return stop("MULTITIMEFRAME_MARKET_SYMBOL_SOURCE_INVALID");
 const crypto=market==="CRYPTO_SPOT"||market==="CRYPTO_FUTURES";
 const kinds=crypto?new Set(["UTC_24H"]):
    new Set(["REGULAR","PREMARKET","AFTERMARKET"]);
 if(!session||typeof session!=="object"||Array.isArray(session)
   ||!time(session.startMs)||!time(session.endMs)
   ||session.startMs%MINUTE!==0||session.endMs%MINUTE!==0
   ||session.endMs<=session.startMs
   ||session.endMs-session.startMs>DAY
   ||!kinds.has(session.kind)||session.timeZone!==ZONES[market]
   ||typeof session.calendarSourceId!=="string"
   ||session.calendarSourceId.length<3
   ||session.calendarSourceId.length>160
   ||(crypto&&(session.startMs%DAY!==0
     ||session.endMs-session.startMs!==DAY)))
  return stop("MULTITIMEFRAME_SESSION_BOUNDARIES_NOT_ATTESTED");
 if(!Array.isArray(minuteBars)||minuteBars.length<1
   ||minuteBars.length>1440||!SHA.test(sourceMinuteRowsSha256??"")
   ||sha(minuteBars)!==sourceMinuteRowsSha256)
  return stop("MULTITIMEFRAME_MINUTE_ROWS_MISSING_OR_DIGEST_CHANGED");
 let prev=0;
 for(const bar of minuteBars){
  if(!bar||typeof bar!=="object"||Array.isArray(bar)
    ||bar.market!==market||bar.venue!==venue||bar.symbol!==symbol
    ||bar.sourceId!==sourceId
    ||!time(bar.timestampMs)||bar.timestampMs%MINUTE!==0
    ||bar.timestampMs<session.startMs
    ||bar.timestampMs+MINUTE>session.endMs
    ||bar.timestampMs<=prev
    ||!time(bar.availableAtMs)
    ||bar.availableAtMs<bar.timestampMs+MINUTE
    ||![bar.open,bar.high,bar.low,bar.close].every(positive)
    ||typeof bar.volume!=="number"||!Number.isFinite(bar.volume)
    ||bar.volume<0
    ||bar.high<Math.max(bar.open,bar.close)
    ||bar.low>Math.min(bar.open,bar.close)
    ||bar.high<bar.low)
   return stop("MULTITIMEFRAME_ORIGINAL_ONE_MINUTE_BAR_INVALID");
  prev=bar.timestampMs;
 }
 const nativeByMs=new Map(minuteBars.map(r=>[r.timestampMs,r]));
 const frames=Object.create(null);
 let produced=0,totalMissing=0,totalOpen=0,totalUnavailable=0;
 for(const spec of intervals){
  if(spec.name==="1d"&&!crypto)
   throw new TypeError("STOCK_DAILY_REQUIRES_OFFICIAL_SESSION_AND_CORPORATE_ACTION_BARS");
  const {name,minutes,widthMs}=spec;
  const bars=[];
  let missing=0,openBuckets=0,unavailable=0;
  const missingPreview=[];
  for(let start=session.startMs;start+widthMs<=session.endMs;start+=widthMs){
   const end=start+widthMs;
   if(end>asOfMs){openBuckets++;continue;}
   const parts=[];
   for(let ts=start;ts<end;ts+=MINUTE){
    const b=nativeByMs.get(ts);
    if(b)parts.push(b);
   }
   if(parts.length!==minutes){
    missing++;
    if(missingPreview.length<8)
     missingPreview.push({startMs:start,missingOneMinuteCount:minutes-parts.length});
    continue;
   }
   const available=Math.max(...parts.map(b=>b.availableAtMs));
   if(available>asOfMs){unavailable++;continue;}
   bars.push(Object.freeze({
    market,venue,symbol,sourceId,timeframe:name,
    startMs:start,endMs:end,availableAtMs:available,
    open:parts[0].open,
    high:Math.max(...parts.map(b=>b.high)),
    low:Math.min(...parts.map(b=>b.low)),
    close:parts[parts.length-1].close,
    volume:parts.reduce((sum,b)=>sum+b.volume,0),
    derivedFromClosedOneMinuteBars:parts.length,
  }));
  }
  const tail=(session.endMs-session.startMs)%widthMs/MINUTE;
  produced+=bars.length;totalMissing+=missing;totalOpen+=openBuckets;
  totalUnavailable+=unavailable;
  frames[name]=Object.freeze({
   timeframe:name,intervalMinutes:minutes,
   bars:Object.freeze(bars),barsSha256:sha(bars),
   completeBarCount:bars.length,
   missingUnverifiedSourceBuckets:missing,
   notYetClosedBuckets:openBuckets,
   barDataUnavailableAtCutoffBuckets:unavailable,
   partialSessionTailMinutes:tail,
   missingPreview:Object.freeze(missingPreview),
   sourceSessionCoverageComplete:missing===0&&unavailable===0
     &&openBuckets===0&&tail===0,
  });
 }
 return safe({...identity,sourceId,
  sessionKind:session.kind,sessionTimeZone:session.timeZone,
  sourceMinuteRowsSha256,
  sourceMinuteRows:minuteBars.length,sourceMinuteIntegrityVerified:true,
  status:totalMissing||totalUnavailable
    ?"SOURCE_LIMITED_PARTIAL_MULTI_TIMEFRAME_BARS"
    :"SOURCE_LIMITED_DERIVED_MULTI_TIMEFRAME_BARS_ONLY",
  reason:totalMissing?"UNVERIFIED_MISSING_ONE_MINUTE_SOURCE_NOT_FILLED":
    totalUnavailable?"MINUTE_SOURCE_NOT_AVAILABLE_AT_CUTOFF":
    "RESEARCH_ONLY_NO_INDEPENDENT_MARKET_OR_SCANNER_PROOF",
  asOfMs,intervalsRequested:intervals.map(x=>x.name),
  intervalData:frames,derivedCandleCount:produced,
  missingUnverifiedBucketsAcrossRequestedIntervals:totalMissing,
  notYetClosedBucketsAcrossRequestedIntervals:totalOpen,
  dataUnavailableAtCutoffBucketsAcrossRequestedIntervals:totalUnavailable,
  sourceTimeframe:"1m",sourceDataNotRepublished:true,
 });
}
