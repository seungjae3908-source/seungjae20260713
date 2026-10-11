import {createHash,randomUUID} from "node:crypto";
import {constants} from "node:fs";
import {dirname,isAbsolute,join,resolve} from "node:path";
import {lstat,open,rename,unlink} from "node:fs/promises";
import {validateAndSanitizeOriginalMinuteDiagnosticV1} from
  "./research-original-minute-diagnostic-readonly-v1.js";

/**
 * Explicitly approved OFFLINE publication, not a trading or Paper action.
 *
 * A private create-only research CLI receipt has an arbitrary name, while
 * the admin GET reads the FIXED {MARKET}.json. Without this bridge the
 * readback never sees a finished model. Publish a WHITELISTED compact
 * projection, never the original trade preview / API key / OHLCV / path.
 *
 * 0600 file, 0700 output directory; target replacement only when explicitly
 * allowed. Private .lock serializes writers, rename is atomic for readers.
 * A crashed publisher leaves the lock, blocking writes until manual review.
 */
const VERSION="research-original-minute-diagnostic-publisher-v1";
const MAX_FILE_BYTES=1024*1024,MAX_OUT_BYTES=64*1024;
const MARKETS=new Set(["KR_STOCK","US_STOCK","CRYPTO_SPOT","CRYPTO_FUTURES"]);
const digest=value=>createHash("sha256").update(value).digest("hex");
const fail=reason=>{throw new TypeError(reason);};
const blocked=(market,reason)=>Object.freeze({
  schemaVersion:VERSION,market:MARKETS.has(market)?market:null,
  status:"BLOCKED_DATA",reason,published:false,reportReplaced:false,
  privateReportRootExposed:false,sourceSensitiveDataPublished:false,
  providerGETCount:0,financialMutationCount:0,
  executionAuthority:"NONE",profitabilityProven:false,
  OOSPassCount:0,actualFillCount:null,trueMarketWideRecall:null,
  paperAdmissionAllowed:false,orderSubmitted:false,realOrders:false,
  liveTrading:false,autoTrading:false,
});
async function directoryCheck(root){
  if(typeof root!=="string"||!isAbsolute(root)||resolve(root)!==root)
    fail("RESEARCH_PUBLISH_ABSOLUTE_ROOT_REQUIRED");
  let current=root;
  while(true){
    const st=await lstat(current);
    if(!st.isDirectory()||st.isSymbolicLink())
      fail("RESEARCH_PUBLISH_DIRECTORY_ANCESTOR_UNSAFE");
    if(current===root&&(st.mode&0o077)!==0)
      fail("RESEARCH_PUBLISH_PRIVATE_DIRECTORY_REQUIRED");
    const parent=dirname(current);
    if(parent===current)break;
    current=parent;
  }
}
async function readPrivateOriginal(path){
  if(typeof path!=="string"||!isAbsolute(path)||resolve(path)!==path)
    fail("RESEARCH_PUBLISH_SOURCE_PATH_INVALID");
  await directoryCheck(dirname(path));
  let file;
  try{
    file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=await file.stat();
    if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o077)!==0
      ||stat.size<10||stat.size>MAX_FILE_BYTES)
      fail("RESEARCH_PUBLISH_PRIVATE_SOURCE_REQUIRED");
    const body=await file.readFile("utf8");
    let data;
    try{data=JSON.parse(body);}
    catch{fail("RESEARCH_PUBLISH_SOURCE_JSON_INVALID");}
    return {data,sourceDigestSha256:digest(body)};
  }finally{await file?.close();}
}
async function optionalOldReport(path,expectedMarket){
  let fd;
  try{
    fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=await fd.stat();
    if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o077)!==0
      ||stat.size<10||stat.size>MAX_OUT_BYTES)
      fail("RESEARCH_PUBLISH_EXISTING_REPORT_UNSAFE");
    const raw=await fd.readFile("utf8");
    const old=JSON.parse(raw);
    if(!MARKETS.has(old.market)||old.market!==expectedMarket)
      fail("RESEARCH_PUBLISH_EXISTING_REPORT_MARKET_MISMATCH");
    validateAndSanitizeOriginalMinuteDiagnosticV1(old,expectedMarket);
    if(old.sourceModelDigestSha256!==undefined
      &&!/^[0-9a-f]{64}$/u.test(old.sourceModelDigestSha256))
      fail("RESEARCH_PUBLISH_EXISTING_MODEL_IDENTITY_INVALID");
    // Migration of previously hand-copied (pre-publisher) immutable report:
    // old legacy entries have no timestamp. They are accepted for explicit
    // replacement only after FULL safety validation, never silently reused.
    if(old.reportPublishedAtMs===undefined
      &&old.sourceResultDigestSha256===undefined)
      return {...old,reportPublishedAtMs:0,legacyLocalReport:true};
    if(!Number.isSafeInteger(old.reportPublishedAtMs)
      ||old.reportPublishedAtMs<=0
      ||typeof old.sourceResultDigestSha256!=="string"
      ||!/^[0-9a-f]{64}$/u.test(old.sourceResultDigestSha256))
      fail("RESEARCH_PUBLISH_EXISTING_REPORT_PROVENANCE_REQUIRED");
    return old;
  }catch(error){
    if(error?.code==="ENOENT")return null;
    throw error;
  }finally{await fd?.close();}
}
function publicationProjection(raw,market,sourceDigestSha256,publishedAtMs){
  // Only a genuine offline PERIOD/SWEEP result can become a market summary.
  // Publishing a previously sanitized market report again cannot create a
  // false new run timestamp or laundering a source receipt.
  if(raw?.reportPublishedAtMs!==undefined
    ||raw?.sourceResultDigestSha256!==undefined)
    fail("RESEARCH_PUBLISH_REPUBLISHED_SOURCE_FORBIDDEN");
  // Throws for forged OOS PASS, real orders, malformed model/sweep and
  // wrong venue. Returns a reviewed *small* DTO, not whole raw input.
  const report=validateAndSanitizeOriginalMinuteDiagnosticV1(raw,market);
  const required={
    schemaVersion:raw.schemaVersion,market,
    selectedStartDate:raw.selectedStartDate,
    selectedEndDate:raw.selectedEndDate,
    status:raw.status,reason:raw.reason??"ORIGINAL_LOCAL_MODEL_NOT_ATTESTED",
    executionAuthority:"NONE",profitabilityProven:false,
    actualFillCount:null,trueMarketWideRecall:null,netProfitPct:null,
    actualMarketWideOpportunityCount:null,
    fullMarketOpportunityDenominatorVerified:false,OOSPassCount:0,
    paperAdmissionAllowed:false,orderSubmitted:false,
    automaticPaperExecution:false,realOrders:false,
    liveTrading:false,autoTrading:false,providerGETCount:0,
    reportPublishedAtMs:publishedAtMs,
    sourceResultDigestSha256:sourceDigestSha256,
  };
  if(raw.schemaVersion==="four-market-original-minute-period-v1")
    return Object.freeze({...required,
      symbol:raw.symbol,timeframe:raw.timeframe??null,
      indexedPrivateSessions:raw.indexedPrivateSessions??null,
      verifiedNativeMinuteSessions:raw.verifiedNativeMinuteSessions??null,
      modeledTradeCount:report?.modeledTradeCount??null,
      modeledReturnPercent:report?.modeledReturnPercent??null,
      modeledNetPnlKRW:report?.modeledNetPnlKRW??null,
    });
  return Object.freeze({...required,
    pageCountSelfAttested:raw.pageCountSelfAttested??null,
    sourceOnlyCompletePages:raw.sourceOnlyCompletePages??null,
    sourceBlockedPages:raw.sourceBlockedPages??null,
    sourceTasksSelfAttested:raw.sourceTasksSelfAttested??null,
    sourceOnlyObservedPriceEventLabels:
      report?.sourceOnlyObservedPriceEventLabels??null,
    localPageTraversalReachedEnd:
      raw.localPageTraversalReachedEnd===true,
  });
}
/**
 * Requires explicit local publication permission, plus a second distinct
 * approval to replace the market's previous report. No LIVE/PAPER authority.
 */
export async function publishResearchOriginalMinuteDiagnosticV1({
  sourceResultPath,reportRoot,market,
  allowLocalReportPublish=false,allowReplaceExisting=false,
  nowImpl=()=>Date.now(),
}={}){
  if(!MARKETS.has(market)||typeof allowLocalReportPublish!=="boolean"
    ||typeof allowReplaceExisting!=="boolean")
    fail("RESEARCH_PUBLISH_MARKET_OR_APPROVAL_INVALID");
  if(!allowLocalReportPublish)
    return blocked(market,"EXPLICIT_LOCAL_REPORT_PUBLICATION_NOT_APPROVED");
  if(typeof sourceResultPath!=="string"||!isAbsolute(sourceResultPath)
    ||resolve(sourceResultPath)!==sourceResultPath)
    fail("RESEARCH_PUBLISH_SOURCE_PATH_INVALID");
  await directoryCheck(reportRoot);
  await directoryCheck(dirname(sourceResultPath));
  const target=join(reportRoot,market+".json");
  if(sourceResultPath===target)
    fail("RESEARCH_PUBLISH_SOURCE_AND_DESTINATION_CANNOT_MATCH");
  const now=nowImpl();
  if(!Number.isSafeInteger(now)||now<946684800000||now>Date.now()+300_000)
    fail("RESEARCH_PUBLISH_PUBLICATION_TIME_INVALID");
  const source=await readPrivateOriginal(sourceResultPath);
  const projected=publicationProjection(source.data,market,
    source.sourceDigestSha256,now);
  // A canonical model-evidence identity ignores result-file whitespace and
  // irrelevant private extra fields, but includes immutable source lineage
  // when a real new historical corpus is replayed. This prevents changing
  // only a publication timestamp to disguise stale source as a fresh run.
  const lineage=source.data.sourceSessionIndexDigestSha256
    ??source.data.sourceDigestChainSha256
    ??source.data.pageChainSha256??null;
  if(lineage!==null
    &&(typeof lineage!=="string"||!/^[0-9a-f]{64}$/u.test(lineage)))
    fail("RESEARCH_PUBLISH_ORIGINAL_LINEAGE_INVALID");
  const stable={...projected};
  delete stable.reportPublishedAtMs;
  delete stable.sourceResultDigestSha256;
  const modelDigest=digest(JSON.stringify({stable,lineage}));
  const encoded=JSON.stringify({
    ...projected,sourceModelDigestSha256:modelDigest,
  })+"\n";
  if(Buffer.byteLength(encoded)>MAX_OUT_BYTES)
    fail("RESEARCH_PUBLISH_SANITIZED_REPORT_TOO_LARGE");
  const lockPath=join(reportRoot,"."+market+".publish.lock");
  const lock=await open(lockPath,constants.O_WRONLY|constants.O_CREAT
    |constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  let tempPath=null;
  try{
    const previous=await optionalOldReport(target,market);
    if(previous!==null&&!allowReplaceExisting)
      return blocked(market,"EXPLICIT_EXISTING_MARKET_REPORT_REPLACEMENT_REQUIRED");
    if(previous!==null&&previous.reportPublishedAtMs>=now)
      return blocked(market,"STALE_OR_DUPLICATED_REPORT_PUBLICATION_TIME");
    if(previous!==null&&(previous.sourceResultDigestSha256
      ===source.sourceDigestSha256
      ||previous.sourceModelDigestSha256===modelDigest))
      return blocked(market,"PREVIOUSLY_PUBLISHED_SOURCE_MODEL_NOT_NEW_EVIDENCE");
    tempPath=join(reportRoot,"."+market+"."+randomUUID()+".new");
    let out;
    try{
      out=await open(tempPath,constants.O_WRONLY|constants.O_CREAT
        |constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      await out.writeFile(encoded,"utf8");
      await out.sync();
    }finally{await out?.close();}
    // Same-private-directory rename is atomic: admin readers see a complete
    // previous or new 0600 file, never an in-place partial write.
    await rename(tempPath,target);
    tempPath=null;
    let directory;
    try{
      directory=await open(reportRoot,constants.O_RDONLY);
      await directory.sync();
    }finally{await directory?.close();}
    return Object.freeze({
      ...blocked(market,"LOCAL_MODEL_ONLY_PUBLICATION_NOT_ECONOMIC_PROOF"),
      status:"LOCAL_SANITIZED_DIAGNOSTIC_PUBLISHED",
      published:true,reportReplaced:previous!==null,
      sourceResultDigestSha256:source.sourceDigestSha256,
      sourceModelDigestSha256:modelDigest,
      reportPublishedAtMs:now,
      reportMarket:market,
    });
  }finally{
    if(tempPath!==null)await unlink(tempPath).catch(()=>{});
    await lock.close();
    await unlink(lockPath).catch(()=>{});
  }
}
