import {createHash} from "node:crypto";
import {isAbsolute,resolve} from "node:path";
import {planFourMarketPITReplayWorkV1} from "./four-market-pit-replay-work-queue-v1.js";
import {runFourMarketOriginalMinuteReplayV1} from "./four-market-original-minute-replay-v1.js";
import {auditFourMarketOriginalMinuteOpportunityDayV1} from "./four-market-original-minute-opportunities-v1.js";
import {listArchivedResearchMinuteSessionsV1}
  from "./research-minute-archive-v1.js";

/**
 * One bounded OFFLINE read-only page: full dated PIT roster planning ->
 * immutable original 1m inspection -> research strategy diagnostic ->
 * retrospective T-minus PRICE-EVENT labels.
 *
 * This isn't a valid independent OOS test, an as-of scanner, a live signal,
 * or admission to automatic Paper. The user must supply independently sourced
 * historical private archives; missing dates / sessions are BLOCKED_DATA.
 */
const MAX_PAGE_TASKS = 20;
const MAX_INDEX_ROWS = 4096;
const MAX_SESSION_COUNT_PER_DATE = 16;
const DIGEST = /^[a-f0-9]{64}$/u;
const hash = x => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const METHODS = Object.freeze(["LONG","SHORT"]);
const BLOCKED = "BLOCKED_DATA";
const safe = extra => Object.freeze({
  schemaVersion:"four-market-original-minute-batch-v1",
  status:BLOCKED,reason:null,readOnly:true,sourceOnly:true,
  historicalMarketPITIndependentlyAuthenticated:false,
  completeHistoricalMinuteSourceProven:false,
  fullMarketOpportunityDenominatorVerified:false,
  firstTradeCrossingTimeEstablished:false,
  historicalAsOfScannerSignalVerified:false,
  actualMarketWideOpportunityCount:null,trueMarketWideRecall:null,
  OOSPassCount:0,actualFillCount:null,actualNetProfitPercent:null,
  profitabilityProven:false,executionAuthority:"NONE",
  paperAdmissionAllowed:false,automaticPaperExecution:false,
  liveTrading:false,autoTrading:false,realOrders:false,
  providerGETCount:0,privateAccountCalls:0,...extra,
});
function fail(reason){throw new TypeError(reason);}
function validEntry(row,market){
  if(!row||typeof row!=="object"||Array.isArray(row)
    ||row.market!==market
    ||typeof row.symbol!=="string"||typeof row.date!=="string"
    ||!Number.isSafeInteger(row.startMs)
    ||!Number.isSafeInteger(row.endMs)||row.endMs<=row.startMs
    ||!["PREMARKET","REGULAR","AFTERMARKET","UTC_24H"].includes(row.kind)
    ||!["UTC","Asia/Seoul","America/New_York"].includes(row.zone)
    ||(row.sourceDigestSha256!=null&&!DIGEST.test(row.sourceDigestSha256)))
    fail("ORIGINAL_BATCH_SESSION_INDEX_INVALID");
}
function sourceIndex(market,sourceSessions){
  if(!Array.isArray(sourceSessions)||sourceSessions.length>MAX_INDEX_ROWS)
    fail("ORIGINAL_BATCH_SESSION_INDEX_BUDGET");
  const byKey = new Map(), identities = new Set();
  for(const row of sourceSessions){
    validEntry(row,market);
    const key=[row.date,row.symbol].join(":");
    const id=[key,row.startMs,row.endMs,row.kind].join(":");
    if(identities.has(id))fail("ORIGINAL_BATCH_DUPLICATE_SESSION_INDEX");
    identities.add(id);
    const bucket=byKey.get(key)??[];
    bucket.push(row);
    if(bucket.length>MAX_SESSION_COUNT_PER_DATE)
      fail("ORIGINAL_BATCH_TOO_MANY_SESSIONS_PER_DATE");
    byKey.set(key,bucket);
  }
  for(const group of byKey.values())
    group.sort((a,b)=>a.startMs-b.startMs);
  return byKey;
}
function matchSourceForTask(task,index){
  const rows=index.get([task.date,task.symbol].join(":"))??[];
  return rows.map(row=>({
    date:row.date,startMs:row.startMs,endMs:row.endMs,
    kind:row.kind,zone:row.zone,
    ...(row.sourceDigestSha256==null?{}:{sourceDigestSha256:row.sourceDigestSha256}),
  }));
}
function blockedRow(task,reason){
  return Object.freeze({market:task.market,symbol:task.symbol,date:task.date,
    status:BLOCKED,reason,modeledTradeCount:null,
    modeledNetPnlKRW:null,modeledReturnPercent:null,
    retrospectiveObservedPriceEventCount:null,
    sourceSessionCount:null,sourceLineageSha256:null,
    modeledTrainValidationTestDiagnostics:null,
    modeledStageOnlyNotIndependentOOS:true,
    paperAdmissionAllowed:false});
}
/**
 * Only one stock/coin market and <=20 task identities/dates per invocation.
 * The work queue is resumable; caller preserves cursor/memberOffset receipts.
 * Date selection is arbitrary, not a fixed three-year interval.
 */
export async function runFourMarketOriginalMinuteBatchV1({
  root,market,researchWindow,manifest,stockTradingDates=null,
  stockCalendar=null,sourceSessions=[],cursorDate=null,memberOffset=0,
  memberPageSize=20,chunkCalendarDays=1,asOfMs,
  timeframe="5m",direction="LONG",thresholdPercents=[3,5,10],
  initialCapitalKRW=1_000_000,leverage=1,riskFraction=0.01,
  fxRateKRWPerQuote=null,costModel={},strategy={},inspectOpportunities=true,
  discoverArchivedSessions=false,
}={}){
  if(typeof root!=="string"||!isAbsolute(root)||resolve(root)!==root
    ||!Number.isSafeInteger(asOfMs)||asOfMs<=0
    ||!METHODS.includes(direction)
    ||(market!=="CRYPTO_FUTURES"&&direction!=="LONG")
    ||typeof inspectOpportunities!=="boolean"
    ||typeof discoverArchivedSessions!=="boolean"
    ||(discoverArchivedSessions&&sourceSessions.length!==0))
    fail("ORIGINAL_BATCH_SCOPE_OR_SIDE_INVALID");
  if(manifest==null)
    return safe({market,reason:"HISTORICAL_FULL_PIT_ROSTER_NOT_CONNECTED",
      sourceTasksRequested:null,inspectedSourceTasks:0,
      blockedSourceTasks:null,sourceOnlyEventLabels:null,
      sourceOnlyModeledTradeCount:null,taskRows:[]});
  const plan=planFourMarketPITReplayWorkV1({
    market,researchWindow,manifest,stockTradingDates,
    cursorDate,memberOffset,memberPageSize,chunkCalendarDays,
  });
  const base={market,selectedStartDate:plan.selectedStartDate,
    selectedEndDate:plan.selectedEndDate,
    inspectedStartDate:plan.inspectedStartDate,
    inspectedEndDate:plan.inspectedEndDate,
    selectedPageOffset:plan.selectedPageOffset??null,
    selfAttestedRosterDigestSha256:
      plan.selfAttestedRosterDigestSha256??null,
    // A historically blocked stock date (e.g. no independently dated
    // exchange session) still advances to the NEXT calendar date in a
    // bounded sweep. It is BLOCKED_DATA, never zero trade opportunities.
    nextCursorDate:plan.nextCursorDate??(
      plan.status==="SOURCE_ONLY_PIT_WORK_PAGINATED"
        ?null:plan.nextChunkCursorDate??null),
    nextCursorMemberOffset:plan.nextCursorMemberOffset??0,
    sourceTasksRequested:plan.candidateTaskCount??null,
    historicalActiveMembersSelfAttested:
      plan.historicRosterActiveMemberDaysSelfAttested??null};
  if(plan.status!=="SOURCE_ONLY_PIT_WORK_PAGINATED")
    return safe({...base,reason:plan.reason??"HISTORIC_PIT_ROSTER_NOT_CONNECTED",
      inspectedSourceTasks:0,blockedSourceTasks:null,
      sourceOnlyEventLabels:null,sourceOnlyModeledTradeCount:null,
      taskRows:[]});
  if(!Array.isArray(plan.candidateTasks)
    ||plan.candidateTasks.length>MAX_PAGE_TASKS)
    return safe({...base,reason:"SOURCE_TASK_PAGE_EXCEEDS_SAFE_EXECUTION_BUDGET",
      maxTasksPerInvocation:MAX_PAGE_TASKS,
      inspectedSourceTasks:0,blockedSourceTasks:null,
      sourceOnlyEventLabels:null,sourceOnlyModeledTradeCount:null,
      taskRows:[]});
  const index=sourceIndex(market,sourceSessions);
  const taskRows=[];
  let blockedSourceTasks=0,modeledTradeCount=0,sourcePriceEvents=0;
  for(const task of plan.candidateTasks){
    if(task.status!=="SOURCE_COLLECTION_OR_REPLAY_REQUIRED"){
      blockedSourceTasks++;
      taskRows.push(blockedRow(task,task.status));
      continue;
    }
    let sessions=matchSourceForTask(task,index);
    if(discoverArchivedSessions){
      let listing;
      try{
        listing=await listArchivedResearchMinuteSessionsV1({
          root,market,symbol:task.symbol,
          researchWindow:{startDate:task.date,endDate:task.date},
          maxSessions:MAX_SESSION_COUNT_PER_DATE,
        });
      }catch{
        blockedSourceTasks++;
        taskRows.push(blockedRow(task,"PRIVATE_NATIVE_SESSION_INDEX_UNSAFE"));
        continue;
      }
      if(listing.status!=="LOCAL_ORIGINAL_SESSION_INDEX_PAGE_ONLY"
        ||listing.nextCursorStartMs!==null){
        blockedSourceTasks++;
        taskRows.push(blockedRow(task,
          listing.reason??"PRIVATE_NATIVE_SESSION_INDEX_INCOMPLETE"));
        continue;
      }
      sessions=listing.sourceSessions.map(row=>({
        date:row.date,startMs:row.startMs,endMs:row.endMs,
        kind:row.kind,zone:row.zone,
        sourceDigestSha256:row.sourceDigestSha256,
      }));
    }
    if(sessions.length===0){
      blockedSourceTasks++;
      taskRows.push(blockedRow(task,"PRIVATE_NATIVE_1M_SOURCE_SESSIONS_ABSENT"));
      continue;
    }
    let replay;
    try{
      replay=await runFourMarketOriginalMinuteReplayV1({
        root,market,symbol:task.symbol,manifest,
        researchWindow:{startDate:task.date,endDate:task.date},
        stockCalendar,sessionSources:sessions,
        timeframe,direction,asOfMs,initialCapitalKRW,leverage,
        riskFraction,fxRateKRWPerQuote,costModel,strategy,
      });
    }catch{
      blockedSourceTasks++;
      taskRows.push(blockedRow(task,"PRIVATE_NATIVE_1M_SOURCE_REPLAY_INVALID"));
      continue;
    }
    if(replay.status!=="RETROSPECTIVE_SOURCE_ONLY_STRATEGY_DIAGNOSTIC"
      ||replay.executionAuthority!=="NONE"
      ||replay.profitabilityProven!==false){
      blockedSourceTasks++;
      taskRows.push(blockedRow(task,replay.reason??"PRIVATE_REPLAY_NOT_READY"));
      continue;
    }
    let observedLabels=0,sourceEventDigests=[];
    let eventBlocked=false;
    if(inspectOpportunities){
      try{
        const dated=await auditFourMarketOriginalMinuteOpportunityDayV1({
          root,market,symbol:task.symbol,day:task.date,
          sessions,stockCalendar,manifest,asOfMs,
          side:direction,thresholdPercents,
        });
        if(dated.status!=="SOURCE_ONLY_OBSERVED_PRICE_EVENTS"
          ||dated.executionAuthority!=="NONE"
          ||dated.profitabilityProven!==false){
          eventBlocked=true;
        }else{
          observedLabels=dated.retrospectiveEventCount;
          sourceEventDigests=[dated.sourceDigestChainSha256];
        }
      }catch{eventBlocked=true;}
    }
    if(eventBlocked){
      blockedSourceTasks++;
      taskRows.push(blockedRow(task,"PRIVATE_RETROSPECTIVE_PRICE_EVENT_SOURCE_BLOCKED"));
      continue;
    }
    modeledTradeCount+=replay.modeledTradeCount;
    sourcePriceEvents+=observedLabels;
    taskRows.push(Object.freeze({
      market,symbol:task.symbol,date:task.date,
      status:"SOURCE_ONLY_BACKTEST_AND_PRICE_LABELS",
      reason:"NOT_SCANNER_ASOF_NOT_INDEPENDENT_OOS_OR_ACTUAL_FILL",
      modeledTradeCount:replay.modeledTradeCount,
      modeledNetPnlKRW:replay.modeledNetPnlKRW,
      modeledReturnPercent:replay.modeledReturnPercent,
      modeledTrainValidationTestDiagnostics:
        replay.modeledTrainValidationTestDiagnostics,
      modeledStageOnlyNotIndependentOOS:true,
      retrospectiveObservedPriceEventCount:
        inspectOpportunities?observedLabels:null,
      sourceSessionCount:replay.sourceSessionsRead,
      sourceLineageSha256:replay.sourceDigestChainSha256,
      eventSourceLineageSha256:inspectOpportunities
        ?hash(sourceEventDigests):null,
      paperAdmissionAllowed:false,
    }));
  }
  const sourceRowsComplete=blockedSourceTasks===0
    &&taskRows.length===plan.candidateTasks.length;
  return safe({...base,
    status:sourceRowsComplete
      ?"SOURCE_ONLY_REPLAY_PAGE_INSPECTED":"BLOCKED_DATA",
    reason:sourceRowsComplete
      ?"RETROSPECTIVE_RESEARCH_ONLY_NO_HISTORIC_ASOF_OR_PAPER_AUTHORITY"
      :"ORIGINAL_MINUTE_OR_PIT_EVIDENCE_INCOMPLETE",
    inspectedSourceTasks:taskRows.length,blockedSourceTasks,
    sourceOnlyEventLabels:sourceRowsComplete&&inspectOpportunities
      ?sourcePriceEvents:null,
    sourceOnlyModeledTradeCount:sourceRowsComplete?modeledTradeCount:null,
    sourceTaskPageDigestSha256:hash(taskRows),
    fullSelectedWindowReviewed:false,
    taskRows:Object.freeze(taskRows),
  });
}
