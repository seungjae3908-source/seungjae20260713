import {constants} from "node:fs";
import {lstat,open} from "node:fs/promises";
import {dirname,isAbsolute,join,resolve} from "node:path";
import {reviewOriginalMinuteForCanonicalPaperV1} from
  "./four-market-original-minute-candidate-review-v1.js";

/**
 * Admin-only source of SANITIZED local research-diagnostic readback.
 * Input path comes from SERVER configuration, NEVER an HTTP parameter.
 * One pinned, small 0600 result per market in a private 0700 directory.
 * No network calls, no original OHLCV/bar material, no credentials, orders,
 * source paths, strategy parameters, mutable write, or Paper promotion.
 */
const SCHEMA="research-original-minute-diagnostic-readonly-v1";
const MAX_FILE_BYTES=1024*1024;
const MARKETS=new Set(["KR_STOCK","US_STOCK","CRYPTO_SPOT","CRYPTO_FUTURES"]);
const PERIOD="four-market-original-minute-period-v1";
const SWEEP="four-market-original-minute-sweep-v1";
const WINDOW=/^\d{4}-\d{2}-\d{2}$/u;
const STATUS=/^[A-Z][A-Z0-9_]{0,119}$/u;
const SYMBOL=/^[A-Z0-9][A-Z0-9._:-]{0,39}$/u;
const NONE="NONE";
const SHA=/^[a-f0-9]{64}$/u;
const MAX_PUBLICATION_AGE_MS=7*86_400_000;
const safe=(market,reason,report=null,publication=null)=>Object.freeze({
  schemaVersion:SCHEMA,market,
  available:report!==null,status:report?.status??"BLOCKED_DATA",
  reason,report,
  readOnly:true,privateSourcePathsDisclosed:false,
  providerGETCount:0,financialMutationCount:0,
  fullMarketOpportunityDenominatorVerified:false,
  actualMarketWideOpportunityCount:null,trueMarketWideRecall:null,
  actualFillCount:null,netProfitPct:null,OOSPassCount:0,
  historicalAsOfScannerSignalVerified:false,
  independentOOSAndFullCostProven:false,profitabilityProven:false,
  executionAuthority:NONE,paperAdmissionAllowed:false,
  orderSubmitted:false,realOrders:false,
  // Local file publication time is NOT independent evidence of a historical
  // scanner, OOS, source-license rights, fills or venue data authenticity.
  reportPublishedAtMs:publication?.atMs??null,
  publicationAgeStatus:publication?.ageStatus??"UNKNOWN",
  publicationTimeIndependentlyAttested:false,
});
const count=v=>Number.isSafeInteger(v)&&v>=0;
const optionalCount=v=>v===null||count(v);
const percent=v=>v===null||
  typeof v==="number"&&Number.isFinite(v)&&v>=-100&&v<=1_000_000;
function validDay(v){
  if(typeof v!=="string"||!WINDOW.test(v))return false;
  const n=Date.parse(v+"T00:00:00.000Z");
  return Number.isFinite(n)
    &&new Date(n).toISOString().slice(0,10)===v;
}
function plain(v){return v!==null&&typeof v==="object"&&!Array.isArray(v);}
function text(v){return typeof v==="string"&&v.length>0&&v.length<=160;}
function verifyRaw(raw,market){
  if(!plain(raw)||raw.market!==market
    ||![PERIOD,SWEEP].includes(raw.schemaVersion)
    ||raw.executionAuthority!==NONE||raw.profitabilityProven!==false
    ||raw.actualFillCount!==null||raw.trueMarketWideRecall!==null
    ||raw.actualMarketWideOpportunityCount!==null
    ||raw.netProfitPct!==null
    ||raw.fullMarketOpportunityDenominatorVerified!==false
    ||raw.OOSPassCount!==0||raw.paperAdmissionAllowed!==false
    ||raw.realOrders!==false||raw.liveTrading!==false
    ||raw.autoTrading!==false
    ||raw.providerGETCount!=null&&raw.providerGETCount!==0
    ||raw.orderSubmitted===true||raw.automaticPaperExecution===true
    ||raw.historicalPITAndCalendarIndependentProof===true
    ||raw.historicalPITAndMinuteDataIndependentlyVerified===true
    ||raw.fullMarketOpportunityDenominatorVerified===true
    ||(raw.sourceModelDigestSha256!==undefined
      &&!SHA.test(raw.sourceModelDigestSha256))
    ||typeof raw.status!=="string"||!STATUS.test(raw.status)
    ||!["BLOCKED_DATA","SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY",
      "LOCAL_HISTORIC_SOURCE_PAGES_TRAVERSED_RESEARCH_ONLY"]
       .includes(raw.status)
    ||!validDay(raw.selectedStartDate)||!validDay(raw.selectedEndDate)
    ||raw.selectedStartDate>raw.selectedEndDate
    ||(raw.reason!=null&&!text(raw.reason)))
    throw new TypeError("NATIVE_DIAGNOSTIC_PRIVATE_MODEL_CONTRACT_INVALID");
  if(raw.reportPublishedAtMs!==undefined
    ||raw.sourceResultDigestSha256!==undefined){
    if(!Number.isSafeInteger(raw.reportPublishedAtMs)
      ||raw.reportPublishedAtMs<946684800000
      ||raw.reportPublishedAtMs>Date.now()+300_000
      ||!SHA.test(raw.sourceResultDigestSha256??""))
      throw new TypeError("NATIVE_DIAGNOSTIC_PUBLICATION_PROVENANCE_INVALID");
  }
  const available=raw.status!=="BLOCKED_DATA";
  if(raw.schemaVersion===PERIOD){
    if(available&&raw.status!=="SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY")
      throw new TypeError("NATIVE_DIAGNOSTIC_PERIOD_STATUS_SCHEMA_MISMATCH");
    if(!SYMBOL.test(raw.symbol??"")
      ||(available&&(!count(raw.indexedPrivateSessions)
        ||!count(raw.verifiedNativeMinuteSessions)
        ||raw.verifiedNativeMinuteSessions!==raw.indexedPrivateSessions
        ||!count(raw.modeledTradeCount)
        ||!percent(raw.modeledReturnPercent)
        ||raw.modeledReturnPercent==null
        ||!Number.isFinite(raw.modeledNetPnlKRW)))
      ||(!available&&raw.modeledReturnPercent!=null))
      throw new TypeError("NATIVE_DIAGNOSTIC_PERIOD_VALUES_INVALID");
    const report={
      kind:"PERIOD",status:raw.status,
      selectedStartDate:raw.selectedStartDate,
      selectedEndDate:raw.selectedEndDate,
      symbol:raw.symbol,
      timeframe:typeof raw.timeframe==="string"
        &&raw.timeframe.length<=5?raw.timeframe:null,
      modeledTradeCount:available?raw.modeledTradeCount:null,
      modeledReturnPercent:available?raw.modeledReturnPercent:null,
      // Do NOT report modeled profit as an actual KRW return.
      modeledNetPnlKRW:available?raw.modeledNetPnlKRW:null,
      sourceSessionsVerified:available?raw.verifiedNativeMinuteSessions:null,
      independentOOSProven:false,independentFullCostProven:false,
      originalHistoricalSignalVerified:false,
      actualFillCount:null,profitabilityProven:false,
      paperCandidatePASS:false,executionAuthority:NONE,
      canonicalPaperResearchReview:Object.freeze((()=>{
        const verdict=reviewOriginalMinuteForCanonicalPaperV1({
          market,symbol:raw.symbol,
          periodResult:raw,
        });
        return {
          status:verdict.status,
          blockerCount:verdict.blockers.length,
          blockers:verdict.blockers,
          canonicalProfitabilityStatus:verdict.canonicalProfitabilityStatus,
          canonicalPaperBridgeStatus:verdict.canonicalPaperBridgeStatus,
          canonicalPaperBridgeBlockers:verdict.canonicalPaperBridgeBlockers,
          paperAdmissionAllowed:false,
          executionAuthority:NONE,
        };
      })()),
    };
    return available?report:null;
  }
  if(raw.schemaVersion===SWEEP){
    if(available
      &&raw.status!=="LOCAL_HISTORIC_SOURCE_PAGES_TRAVERSED_RESEARCH_ONLY")
      throw new TypeError("NATIVE_DIAGNOSTIC_SWEEP_STATUS_SCHEMA_MISMATCH");
    if((available&&(!count(raw.pageCountSelfAttested)
      ||!count(raw.sourceOnlyCompletePages)
      ||raw.sourceBlockedPages!==0
      ||raw.sourceOnlyCompletePages!==raw.pageCountSelfAttested
      ||!count(raw.sourceOnlyObservedPriceEventLabels)
      ||raw.localPageTraversalReachedEnd!==true))
      ||(!available&&raw.sourceOnlyObservedPriceEventLabels!=null))
      throw new TypeError("NATIVE_DIAGNOSTIC_SWEEP_VALUES_INVALID");
    return available?{
      kind:"SWEEP",status:raw.status,
      selectedStartDate:raw.selectedStartDate,
      selectedEndDate:raw.selectedEndDate,
      pageCountSelfAttested:raw.pageCountSelfAttested,
      sourceOnlyObservedPriceEventLabels:raw.sourceOnlyObservedPriceEventLabels,
      sourceTasksSelfAttested:optionalCount(raw.sourceTasksSelfAttested)
        ?raw.sourceTasksSelfAttested:null,
      actualMarketWideOpportunityCount:null,
      fullMarketOpportunityDenominatorVerified:false,
      independentOOSProven:false,independentFullCostProven:false,
      originalHistoricalSignalVerified:false,actualFillCount:null,
      profitabilityProven:false,paperCandidatePASS:false,
      executionAuthority:NONE,
    }:null;
  }
  throw new TypeError("NATIVE_DIAGNOSTIC_UNKNOWN_REPORT_MODE");
}
/** Validate one entire private modeled source; allow ONLY sanitized fields out. */
export function validateAndSanitizeOriginalMinuteDiagnosticV1(raw,market){
  if(!MARKETS.has(market))
    throw new TypeError("NATIVE_DIAGNOSTIC_MARKET_INVALID");
  return verifyRaw(raw,market);
}
async function checkRoot(root){
  let cursor=root;
  while(true){
    const st=await lstat(cursor);
    if(st.isSymbolicLink()||!st.isDirectory())
      throw new TypeError("NATIVE_DIAGNOSTIC_UNSAFE_PARENT");
    if(cursor===root&&(st.mode&0o077)!==0)
      throw new TypeError("NATIVE_DIAGNOSTIC_PRIVATE_ROOT_REQUIRED");
    const parent=dirname(cursor);
    if(parent===cursor)break;
    cursor=parent;
  }
}
export async function readResearchOriginalMinuteDiagnosticV1({
  root,market,
}={}){
  if(!MARKETS.has(market))
    throw new TypeError("NATIVE_DIAGNOSTIC_MARKET_INVALID");
  if(typeof root!=="string"||!root
    ||!isAbsolute(root)||resolve(root)!==root)
    return safe(market,"PRIVATE_MODEL_REPORT_ROOT_NOT_CONFIGURED");
  try{await checkRoot(root);}
  catch(error){
    if(error?.code==="ENOENT")return safe(market,"PRIVATE_MODEL_REPORT_ROOT_NOT_FOUND");
    throw error;
  }
  // No user-provided filename, symbol, path, formula or account ID.
  const file=join(root,market+".json");
  let handle;
  try{
    handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    const st=await handle.stat();
    if(!st.isFile()||st.nlink!==1||(st.mode&0o077)!==0
      ||st.size<10||st.size>MAX_FILE_BYTES)
      throw new TypeError("NATIVE_DIAGNOSTIC_PRIVATE_FILE_INVALID");
    const raw=JSON.parse(await handle.readFile("utf8"));
    const report=validateAndSanitizeOriginalMinuteDiagnosticV1(raw,market);
    const published=raw.reportPublishedAtMs;
    const publication=Number.isSafeInteger(published)?{
      atMs:published,
      ageStatus:Date.now()-published>MAX_PUBLICATION_AGE_MS
        ?"OLDER_THAN_7_DAYS":"LOCAL_PUBLICATION_ONLY",
    }:null;
    return safe(market,
      report?"RETROSPECTIVE_MODEL_ONLY_NOT_LIVE_OR_OOS":
        "OFFLINE_MODEL_BLOCKED_OR_INCOMPLETE",report,publication);
  }catch(error){
    if(error?.code==="ENOENT")return safe(market,"PRIVATE_MODEL_REPORT_NOT_FOUND");
    throw error;
  }finally{await handle?.close();}
}
