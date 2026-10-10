import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {lstat,open} from "node:fs/promises";
import {isAbsolute,join} from "node:path";
import {
  publicWatchEventIdV1,publicWatchCadenceIdV1,
} from "./public-watch-native-minute-reconcile-v1.js";

/**
 * Strict read-only intake for files exported from the existing Vultr
 * public-watch watch/events/YYYY-MM-DD.jsonl and watch/cadence/...
 *
 * Not a production watcher modification. Raw imported rows NEVER belong in
 * a CI artifact, a public dashboard, or a profitability/OOS PASS claim.
 * A source hash proves only content integrity, not independent capture time.
 */
export const PUBLIC_WATCH_EXPORT_LIMITS_V1=Object.freeze({
  maxFileBytes:8*1024*1024,
  maxLineBytes:16*1024,
  maxEvents:10000,
  maxCadence:2000,
  maxCadenceGapMsForDiagnostic:6*60_000,
});
const CONTRACT_EVENT="lightweight-market-opportunity-watch-v1";
const CONTRACT_CADENCE="public-watch-cadence-observation-v1";
const SHA40=/^[0-9a-f]{40}$/u;
const SHA64=/^[0-9a-f]{64}$/u;
const SYMBOL=/^[A-Z0-9][A-Z0-9._-]{0,31}$/u;
const SOURCE=/^[A-Za-z0-9._-]{3,80}$/u;
const BLOCKED_STATUS=/^BLOCKED_[A-Z0-9_]{1,100}$/u;
const MARKETS=["KR_STOCK","US_STOCK","CRYPTO_SPOT","CRYPTO_FUTURES"];
const GOOD=new Set(["READY","PARTIAL_TICKERS","PARTIAL_UNIVERSE"]);
const RUN_STATUS=new Set(["OBSERVING_ALL_FOUR","PARTIAL_MARKET_COVERAGE","BLOCKED_DATA","THROTTLED","HOLD"]);
const BUDGET=new Set(["RUN","THROTTLED","HOLD"]);
const saneTime=n=>Number.isSafeInteger(n)&&n>0;
const obj=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const digest=x=>createHash("sha256").update(x).digest("hex");
function dayMs(dayUtc){
  if(typeof dayUtc!=="string"||!/^20\d{2}-\d{2}-\d{2}$/.test(dayUtc))
    throw new TypeError("WATCH_EXPORT_DAY_INVALID");
  const n=Date.parse(dayUtc+"T00:00:00.000Z");
  if(!saneTime(n)||new Date(n).toISOString().slice(0,10)!==dayUtc)
    throw new TypeError("WATCH_EXPORT_DAY_INVALID");
  return n;
}
function timestamp(s){
  if(typeof s!=="string"||!/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s))
    return null;
  const n=Date.parse(s);
  return saneTime(n)&&new Date(n).toISOString()===s?n:null;
}
function base(status,reason,dayUtc,expectedResearchSha,extra={}){
  return Object.freeze({
    schemaVersion:"public-watch-jsonl-original-source-intake-v1",
    status,reason,dayUtc,expectedResearchSha:expectedResearchSha??null,
    originalEventRows:null,originalCadenceRows:null,
    distinctEventIds:null,distinctCadenceCycles:null,
    duplicatedIdenticalEvents:null,duplicatedIdenticalCadence:null,
    maxObservedCadenceGapMs:null,sourceBytesSha256:null,
    sourceLogCompletenessVerified:false,
    independentlyVerifiedOriginalPersistence:false,
    fullWatchlistNegativeEvidenceVerified:false,
    trueMarketWideRecall:null,verifiedFalseNegativeCount:null,
    liveHistoricalScannerAsOfVerified:false,
    actualFillCount:null,netProfitPct:null,OOSPassCount:0,
    profitabilityProven:false,executionAuthority:"NONE",
    liveTrading:false,autoTrading:false,realOrders:false,
    privateProviderTradeApi:false,
    ...extra,
  });
}
function parseText(raw,kind,limit){
  if(typeof raw!=="string")return {error:"SOURCE_FILE_MISSING_"+kind};
  const size=Buffer.byteLength(raw,"utf8");
  if(size>PUBLIC_WATCH_EXPORT_LIMITS_V1.maxFileBytes)
    return {error:"SOURCE_FILE_TOO_LARGE_"+kind};
  if(!raw.endsWith("\n") || raw.includes("\r"))
    return {error:"SOURCE_JSONL_TRUNCATED_OR_INVALID_NEWLINES_"+kind};
  const parts=raw.split("\n");parts.pop();
  if(parts.length>limit)return {error:"SOURCE_JSONL_ROW_CAP_"+kind};
  const rows=[];
  for(const [index,line] of parts.entries()){
    if(!line || Buffer.byteLength(line,"utf8")>
      PUBLIC_WATCH_EXPORT_LIMITS_V1.maxLineBytes)
      return {error:"SOURCE_JSONL_ROW_SIZE_"+kind,index};
    try{
      const row=JSON.parse(line);
      if(!obj(row))return {error:"SOURCE_JSONL_NOT_OBJECT_"+kind,index};
      rows.push(row);
    }catch{return {error:"SOURCE_JSONL_PARSE_ERROR_"+kind,index};}
  }
  return {rows,bytes:size,digest:digest(raw)};
}
function verifyEvent(row,release,start,end){
  const at=timestamp(row.observedAt);
  if(row.schemaVersion!==CONTRACT_EVENT||row.kind!=="PROVISIONAL_PRICE_ACCELERATION"
     ||row.researchSha!==release||!SHA64.test(row.eventId??"")
     ||row.eventId!==publicWatchEventIdV1(row)
     ||!MARKETS.includes(row.market)||!SYMBOL.test(row.symbol??"")
     ||!SOURCE.test(row.source??"")
     ||!["UP","DOWN"].includes(row.direction)
     ||!saneTime(at)||at<start||at>=end
     ||!saneTime(row.sourceAtMs)||!saneTime(row.priorSourceAtMs)
     ||row.sourceAtMs>at||at-row.sourceAtMs>6*60_000
     ||row.priorSourceAtMs>=row.sourceAtMs
     ||typeof row.movePercent!=="number"||!Number.isFinite(row.movePercent)
     ||row.executionAuthority!=="NONE"||row.isTradingSignal!==false
     ||row.aiReviewed!==false||row.oosPassed!==false
     ||row.paperAdmitted!==false)return false;
  return true;
}
function verifyCadence(row,release,start,end){
  const at=timestamp(row.observedAt);
  if(row.schemaVersion!==CONTRACT_CADENCE
     ||row.researchSha!==release||!SHA64.test(row.eventId??"")
     ||row.eventId!==publicWatchCadenceIdV1(row)
     ||!saneTime(at)||at<start||at>=end
     ||!RUN_STATUS.has(row.cycleStatus)||!BUDGET.has(row.resourceBudget)
     ||row.executionAuthority!=="NONE"
     ||row.publicPriceObservationOnly!==true
     ||row.economicEvidenceCredit!==0||row.paperCredit!==0
     ||row.oosCredit!==0||!Array.isArray(row.markets)
     ||row.markets.length!==4)return false;
  let healthy=0,fullyReady=0;
  for(let i=0;i<MARKETS.length;i++){
    const m=row.markets[i];
    if(!obj(m)||m.market!==MARKETS[i]
      ||!Number.isSafeInteger(m.observedCount)||m.observedCount<0
      ||m.observedCount>8000
      ||!(GOOD.has(m.status)||BLOCKED_STATUS.test(m.status))
      ||(m.status==="READY"&&m.observedCount===0)
      ||(BLOCKED_STATUS.test(m.status)&&m.observedCount!==0))
      return false;
    if(GOOD.has(m.status))healthy++;
    if(m.status==="READY")fullyReady++;
  }
  if(row.resourceBudget!=="RUN")
    return row.cycleStatus===row.resourceBudget && healthy===0;
  return fullyReady===4?row.cycleStatus==="OBSERVING_ALL_FOUR"
    :healthy>0?row.cycleStatus==="PARTIAL_MARKET_COVERAGE"
    :row.cycleStatus==="BLOCKED_DATA";
}
function sameCycleSupportsPositive(row,event){
  const market=row.markets.find(x=>x.market===event.market);
  return row.resourceBudget==="RUN"&&GOOD.has(market?.status)
    &&market.observedCount>0;
}

/**
 * Pure parser; identical to the prospective watcher JSONL data contract.
 * originalEvents / cadenceRows are returned only in process memory; calling
 * scripts must save the sanitized RECEIPT, never the raw arrays.
 */
export function examineOriginalPublicWatchJsonlV1({
  dayUtc,expectedResearchSha,eventsText=null,cadenceText=null,
}={}){
  const start=dayMs(dayUtc),end=start+86_400_000;
  if(expectedResearchSha!=null&&!SHA40.test(expectedResearchSha))
    throw new TypeError("WATCH_EXPORT_RESEARCH_SHA_INVALID");
  if(eventsText==null&&cadenceText==null)
    return {receipt:base("BLOCKED_DATA","ORIGINAL_WATCH_FILES_NOT_CONNECTED",
      dayUtc,expectedResearchSha),originalEvents:[],cadenceRows:[]};
  if(!SHA40.test(expectedResearchSha??""))
    throw new TypeError("WATCH_EXPORT_RELEASE_SHA_REQUIRED");
  const events=parseText(eventsText,"EVENTS",
    PUBLIC_WATCH_EXPORT_LIMITS_V1.maxEvents);
  const cadence=parseText(cadenceText,"CADENCE",
    PUBLIC_WATCH_EXPORT_LIMITS_V1.maxCadence);
  const err=events.error??cadence.error;
  if(err)return {receipt:base("BLOCKED_DATA",err,dayUtc,expectedResearchSha),
    originalEvents:[],cadenceRows:[]};
  const uniqueE=new Map(),uniqueC=new Map();
  let dupE=0,dupC=0;
  for(const [index,e] of events.rows.entries()){
    if(!verifyEvent(e,expectedResearchSha,start,end))
      return {receipt:base("BLOCKED_DATA","INVALID_OR_MIXED_RELEASE_EVENT",dayUtc,
        expectedResearchSha,{invalidSourceRowIndex:index}),
      originalEvents:[],cadenceRows:[]};
    const prior=uniqueE.get(e.eventId);
    if(prior){
      if(JSON.stringify(prior)!==JSON.stringify(e))
        return {receipt:base("BLOCKED_DATA","CONFLICTING_REPLAYED_EVENT",dayUtc,
          expectedResearchSha,{invalidSourceRowIndex:index}),
        originalEvents:[],cadenceRows:[]};
      dupE++;continue;
    }
    uniqueE.set(e.eventId,e);
  }
  for(const [index,c] of cadence.rows.entries()){
    if(!verifyCadence(c,expectedResearchSha,start,end))
      return {receipt:base("BLOCKED_DATA","INVALID_OR_MIXED_RELEASE_CADENCE",
        dayUtc,expectedResearchSha,{invalidSourceRowIndex:index}),
      originalEvents:[],cadenceRows:[]};
    const time=c.observedAt;
    const prior=uniqueC.get(time);
    if(prior){
      if(prior.eventId!==c.eventId)
        return {receipt:base("BLOCKED_DATA","CONFLICTING_SAME_CYCLE_CADENCE",
          dayUtc,expectedResearchSha,{invalidSourceRowIndex:index}),
        originalEvents:[],cadenceRows:[]};
      dupC++;continue;
    }
    uniqueC.set(time,c);
  }
  if(!uniqueC.size)
    return {receipt:base("BLOCKED_DATA","NO_CADENCE_CYCLES_IN_EXPORT",
      dayUtc,expectedResearchSha),originalEvents:[],cadenceRows:[]};
  for(const [index,e] of [...uniqueE.values()].entries()){
    const c=uniqueC.get(e.observedAt);
    if(!c||!sameCycleSupportsPositive(c,e))
      return {receipt:base("BLOCKED_DATA","UNCORROBORATED_OR_BLOCKED_POSITIVE_CYCLE",
        dayUtc,expectedResearchSha,{invalidSourceRowIndex:index}),
      originalEvents:[],cadenceRows:[]};
  }
  const times=[...uniqueC.keys()].map(timestamp).sort((a,b)=>a-b);
  let maxGap=null;
  for(let i=1;i<times.length;i++)maxGap=Math.max(maxGap??0,times[i]-times[i-1]);
  const allEvents=[...uniqueE.values()],allCadence=[...uniqueC.values()];
  return {
    receipt:base("VALIDATED_POSITIVE_LOG_COHORT_ONLY",
      "SELF_REPORTED_2MIN_LOGS_NOT_EXHAUSTIVE_NEGATIVE_WATCHLIST",dayUtc,
      expectedResearchSha,{
        originalEventRows:events.rows.length,
        originalCadenceRows:cadence.rows.length,
        distinctEventIds:allEvents.length,distinctCadenceCycles:allCadence.length,
        duplicatedIdenticalEvents:dupE,duplicatedIdenticalCadence:dupC,
        maxObservedCadenceGapMs:maxGap,
        cadenceGapExceedsSixMinutes:maxGap==null?null
          :maxGap>PUBLIC_WATCH_EXPORT_LIMITS_V1.maxCadenceGapMsForDiagnostic,
        sourceBytesSha256:{events:events.digest,cadence:cadence.digest},
      }),
    originalEvents:allEvents,cadenceRows:allCadence,
  };
}

/**
 * Read an explicitly supplied *local export root*, not Vultr via network.
 * The raw files follow the worker's existing root/watch/{events,cadence}/day
 * naming. A symlink, hardlink, loose permissions, or oversized file blocks.
 */
export async function readOriginalPublicWatchExportV1({
  rootDir,dayUtc,expectedResearchSha,
}={}){
  dayMs(dayUtc);
  if(!SHA40.test(expectedResearchSha??""))
    throw new TypeError("WATCH_EXPORT_RELEASE_SHA_REQUIRED");
  if(typeof rootDir!=="string"||!isAbsolute(rootDir))
    throw new TypeError("WATCH_EXPORT_ROOT_ABSOLUTE_PATH_REQUIRED");
  async function readCategory(category){
    const path=join(rootDir,"watch",category,dayUtc+".jsonl");
    let info;
    try{info=await lstat(path);}catch(e){
      if(e?.code==="ENOENT")return null;
      throw new Error("WATCH_EXPORT_SOURCE_FILE_STAT_DENIED_"+category);
    }
    if(!info.isFile()||info.nlink!==1
      ||info.size>PUBLIC_WATCH_EXPORT_LIMITS_V1.maxFileBytes
      ||(info.mode&0o077)!==0)
      throw new Error("WATCH_EXPORT_SOURCE_FILE_UNSAFE_"+category);
    let handle;
    try{
      handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
      const now=await handle.stat();
      if(!now.isFile()||now.ino!==info.ino||now.nlink!==1
        ||now.size!==info.size
        ||now.size>PUBLIC_WATCH_EXPORT_LIMITS_V1.maxFileBytes
        ||(now.mode&0o077)!==0)
        throw new Error("WATCH_EXPORT_SOURCE_MUTATED_"+category);
      return await handle.readFile("utf8");
    }finally{if(handle)await handle.close();}
  }
  const [eventsText,cadenceText]=await Promise.all([
    readCategory("events"),readCategory("cadence"),
  ]);
  return examineOriginalPublicWatchJsonlV1({
    dayUtc,expectedResearchSha,eventsText,cadenceText,
  });
}
