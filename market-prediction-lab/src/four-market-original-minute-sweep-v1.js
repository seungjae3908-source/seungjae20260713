import {createHash} from "node:crypto";
import {isAbsolute,resolve} from "node:path";
import {resolveSelectedResearchWindowV1} from "./research-selected-window-v1.js";
import {runFourMarketOriginalMinuteBatchV1} from "./four-market-original-minute-batch-v1.js";

/**
 * Bounded offline all-historical-member / selected-date PAGE SWEEP.
 * One invocation scans at most eight source-only pages. The private caller
 * stores a deterministic continuation token in a create-only 0600 receipt.
 *
 * Every page uses the existing strict historic PIT+private 1m batch gate.
 * Unknown/blocked pages nullify the WHOLE-SWEEP price-event count. We NEVER
 * add independently reset day-by-day model returns as if they were a valid
 * portfolio, long-window OOS or profitability proof; the separate per-symbol
 * whole-period model is the only stateful cross-session replay.
 *
 * NOTE: resumable receipts are self-attested local diagnostics, NOT a
 * cryptographically trusted independent exchange/source attestation.
 */
const MAX_PAGES=8;
const MAX_PAGE_MEMBERS=20;
const VERSION="four-market-original-minute-sweep-v1";
const RESUME="four-market-original-minute-sweep-resume-v1";
const DATE=/^\d{4}-\d{2}-\d{2}$/u;
const SHA=/^[0-9a-f]{64}$/u;
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const error=reason=>{throw new TypeError(reason);};
const count=value=>Number.isSafeInteger(value)&&value>=0;
const validDate=value=>typeof value==="string"&&DATE.test(value)
  &&Number.isFinite(Date.parse(value+"T00:00:00Z"))
  &&new Date(value+"T00:00:00Z").toISOString().slice(0,10)===value;
const safe=extra=>Object.freeze({
  schemaVersion:VERSION,status:"BLOCKED_DATA",reason:null,
  readOnly:true,sourceInventoryOnly:true,modelOnly:true,
  fullMarketOpportunityDenominatorVerified:false,
  actualMarketWideOpportunityCount:null,trueMarketWideRecall:null,
  historicalPITAndMinuteDataIndependentlyVerified:false,
  actualFillCount:null,netProfitPct:null,OOSPassCount:0,
  profitabilityProven:false,executionAuthority:"NONE",
  paperAdmissionAllowed:false,automaticPaperExecution:false,
  providerGETCount:0,privateAccountCalls:0,liveTrading:false,
  autoTrading:false,realOrders:false,
  ...extra,
});
function scope(input,period){
  const {
    market,manifest,stockCalendar=null,stockTradingDates=null,
    root,asOfMs,timeframe="5m",direction="LONG",
    initialCapitalKRW=1_000_000,leverage=1,riskFraction=0.01,
    fxRateKRWPerQuote=null,costModel={},strategy={},
    thresholdPercents=[3,5,10],inspectOpportunities=true,
    discoverArchivedSessions=false,sourceSessions=[],memberPageSize=20,
  }=input;
  if(typeof root!=="string"||!isAbsolute(root)||resolve(root)!==root
    ||!Number.isSafeInteger(asOfMs)||asOfMs<=0
    ||!Array.isArray(sourceSessions)||!Array.isArray(thresholdPercents)
    ||typeof discoverArchivedSessions!=="boolean"
    ||(discoverArchivedSessions&&sourceSessions.length!==0)
    ||!["KR_STOCK","US_STOCK","CRYPTO_SPOT","CRYPTO_FUTURES"].includes(market)
    ||!["LONG","SHORT"].includes(direction)
    ||(market!=="CRYPTO_FUTURES"&&direction!=="LONG"))
    error("ORIGINAL_SWEEP_SCOPE_INVALID");
  return hash({
    scopeVersion:VERSION,market,
    // Paths and source data are hashed; never printed in page summary.
    root,period:[period.startDate,period.endDate],
    manifestDigest:manifest?.rawMembershipDigestSha256??null,
    stockDateDigest:stockTradingDates==null?null:hash(stockTradingDates),
    stockCalendarDigest:stockCalendar==null?null:hash(stockCalendar),
    manualSourceIndexDigest:sourceSessions.length?hash(sourceSessions):null,
    asOfMs,timeframe,direction,initialCapitalKRW,leverage,
    riskFraction,fxRateKRWPerQuote,costModel,strategy,
    thresholdPercents,inspectOpportunities,discoverArchivedSessions,
    memberPageSize,
  });
}
function validateResume(token,digest,period){
  if(token==null)return {
    nextCursorDate:null,nextMemberOffset:0,
    previousPageCount:0,previousCompletePageCount:0,
    previousBlockedPageCount:0,previousTaskCount:0,
    previousSourceEventCount:0,previousDigest:"0".repeat(64),
  };
  if(!token||typeof token!=="object"||Array.isArray(token)
    ||token.schemaVersion!==RESUME||token.scopeDigestSha256!==digest
    ||!validDate(token.nextCursorDate)
    ||token.nextCursorDate<period.startDate
    ||token.nextCursorDate>period.endDate
    ||!count(token.nextMemberOffset)
    ||!count(token.previousPageCount)
    ||!count(token.previousCompletePageCount)
    ||!count(token.previousBlockedPageCount)
    ||token.previousCompletePageCount+token.previousBlockedPageCount
      !==token.previousPageCount
    ||token.previousPageCount<1
    ||!SHA.test(token.previousDigest)
    ||(token.previousTaskCount!==null&&!count(token.previousTaskCount))
    ||(token.previousSourceEventCount!==null
      &&!count(token.previousSourceEventCount)))
    error("ORIGINAL_SWEEP_RESUME_SCOPE_OR_COUNTER_INVALID");
  return token;
}
/** One or more single-day, <=20-member bounded pages per invocation. */
export async function runFourMarketOriginalMinuteSweepV1({
  resume=null,pageBudget=4,memberPageSize=20,chunkCalendarDays=1,
  ...input
}={}){
  if(!Number.isSafeInteger(pageBudget)||pageBudget<1||pageBudget>MAX_PAGES
    ||!Number.isSafeInteger(memberPageSize)
    ||memberPageSize<1||memberPageSize>MAX_PAGE_MEMBERS
    ||chunkCalendarDays!==1)
    error("ORIGINAL_SWEEP_PAGE_RESOURCE_BUDGET_INVALID");
  const period=resolveSelectedResearchWindowV1(input.researchWindow);
  const digest=scope({...input,memberPageSize},period);
  const previous=validateResume(resume,digest,period);
  let date=previous.nextCursorDate;
  let offset=previous.nextMemberOffset;
  let pages=previous.previousPageCount,
    complete=previous.previousCompletePageCount,
    blocked=previous.previousBlockedPageCount;
  let tasks=previous.previousTaskCount;
  let sourceEvents=previous.previousSourceEventCount;
  let chain=previous.previousDigest;
  const recentPages=[];
  let finished=false,stoppedEarly=false,visited=0;
  while(visited<pageBudget){
    const requestedCursor=date??period.startDate;
    const result=await runFourMarketOriginalMinuteBatchV1({
      ...input,memberPageSize,chunkCalendarDays:1,
      cursorDate:date,memberOffset:offset,
    });
    if(!result||!["SOURCE_ONLY_REPLAY_PAGE_INSPECTED","BLOCKED_DATA"]
      .includes(result.status)
      ||result.executionAuthority!=="NONE"
      ||result.profitabilityProven!==false
      ||result.actualFillCount!==null
      ||result.realOrders!==false
      ||result.paperAdmissionAllowed!==false)
      error("ORIGINAL_SWEEP_SOURCE_PAGE_SAFETY_INVALID");
    const verified=result.status==="SOURCE_ONLY_REPLAY_PAGE_INSPECTED";
    pages++;visited++;
    if(verified)complete++;else blocked++;
    const n=result.sourceTasksRequested;
    tasks=tasks!==null&&count(n)?tasks+n:null;
    const price=result.sourceOnlyEventLabels;
    sourceEvents=sourceEvents!==null&&verified&&count(price)
      ?sourceEvents+price:null;
    if(tasks!==null&&!Number.isSafeInteger(tasks)
      ||sourceEvents!==null&&!Number.isSafeInteger(sourceEvents))
      error("ORIGINAL_SWEEP_COUNTER_OVERFLOW");
    chain=hash([chain,requestedCursor,offset,result.sourceTaskPageDigestSha256??null,
      result.status,result.reason??null,n,price]);
    if(recentPages.length<MAX_PAGES)recentPages.push(Object.freeze({
      inspectedStartDate:result.inspectedStartDate??null,
      inspectedEndDate:result.inspectedEndDate??null,
      selectedPageOffset:result.selectedPageOffset??null,
      status:result.status,reason:result.reason??null,
      selfAttestedTasks:n??null,
      blockedTasks:result.blockedSourceTasks??null,
      pageDigestSha256:result.sourceTaskPageDigestSha256??null,
    }));
    const nextDate=result.nextCursorDate??null,
      nextOffset=result.nextCursorMemberOffset??0;
    if(nextDate===null){
      // Final calendar day can be blocked without being a fabricated zero.
      // A missing/invalid manifest may also halt an EARLIER day; in that
      // case no valid next token exists, so fail closed without a fake loop.
      finished=result.inspectedEndDate===period.endDate
        &&result.selectedEndDate===period.endDate;
      stoppedEarly=!finished;
      break;
    }
    if(!validDate(nextDate)||nextDate<requestedCursor
      ||nextDate<period.startDate||nextDate>period.endDate
      ||!count(nextOffset)
      ||nextDate===requestedCursor&&nextOffset<=offset
      ||nextDate!==requestedCursor&&nextOffset!==0)
      error("ORIGINAL_SWEEP_STALLED_OR_INVALID_CONTINUATION");
    date=nextDate;offset=nextOffset;
  }
  // No resumption authority if the planner exhausted its evidence without
  // proving an actual final page. Report BLOCKED and keep economic null.
  const allPagesComplete=finished&&blocked===0;
  const nextResume=finished||stoppedEarly?null:Object.freeze({
    schemaVersion:RESUME,scopeDigestSha256:digest,
    nextCursorDate:date??period.startDate,
    nextMemberOffset:offset,
    previousPageCount:pages,
    previousCompletePageCount:complete,
    previousBlockedPageCount:blocked,
    previousTaskCount:tasks,
    previousSourceEventCount:sourceEvents,
    previousDigest:chain,
  });
  return safe({
    market:input.market,
    selectedStartDate:period.startDate,selectedEndDate:period.endDate,
    status:allPagesComplete
      ?"LOCAL_HISTORIC_SOURCE_PAGES_TRAVERSED_RESEARCH_ONLY":"BLOCKED_DATA",
    reason:allPagesComplete
      ?"RETROSPECTIVE_LOCAL_PAGES_NOT_INDEPENDENT_PIT_OOS_OR_FILL"
      :stoppedEarly?"UNRESUMABLE_HISTORIC_PIT_OR_CALENDAR_SOURCE_MISSING"
        :finished?"SOURCE_EVIDENCE_INCOMPLETE_OR_BLOCKED"
          :"SELECTED_WINDOW_LOCAL_PAGE_TRAVERSAL_INCOMPLETE",
    pageBudget,visitedPagesThisInvocation:visited,
    localPageTraversalReachedEnd:finished,
    pageCountSelfAttested:pages,
    sourceOnlyCompletePages:complete,
    sourceBlockedPages:blocked,
    sourceTasksSelfAttested:tasks,
    sourceOnlyObservedPriceEventLabels:allPagesComplete
      ?sourceEvents:null,
    pageChainSha256:chain,scopeDigestSha256:digest,
    nextCursorDate:finished?null:date,
    nextMemberOffset:finished?null:offset,
    resume:nextResume,
    previewPages:Object.freeze(recentPages),
    originalScannerAsOfProof:false,
    fullPeriodCrossSessionPnlModeledHere:false,
    fullPeriodEconomicReturnPercent:null,
    fullPeriodNetPnlKRW:null,
    paperCandidateAuthority:"NONE",
  });
}
