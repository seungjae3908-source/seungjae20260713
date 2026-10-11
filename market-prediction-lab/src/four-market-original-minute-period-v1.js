import {createHash} from "node:crypto";
import {isAbsolute,resolve} from "node:path";
import {resolveSelectedResearchWindowV1} from "./research-selected-window-v1.js";
import {listArchivedResearchMinuteSessionsV1} from "./research-minute-archive-v1.js";
import {runFourMarketOriginalMinuteReplayV1} from "./four-market-original-minute-replay-v1.js";

/**
 * User-selected historical period -> immutable native 1m archive -> one
 * stateful per-symbol RESEARCH replay across ALL declared sessions.
 *
 * This intentionally does not concatenate independently reset daily
 * simulated PnLs. Position/equity state crosses sessions inside the existing
 * bounded-memory replay engine, while missing original minutes, unknown
 * exchange sessions and competing revisions fail CLOSED.
 *
 * It reads only server-private original files. No licensed-source discovery,
 * public/private provider GET, trading/API calls, Paper/Journals/Telegram,
 * autoscheduling, or source correction/backfill is attempted.
 */
const PAGE_SIZE=31;
const MAX_PAGES=180;
const MAX_SESSIONS=5_000;
const MAX_DATE_DAYS=36_600;
const SHA=/^[0-9a-f]{64}$/u;
const sha=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const BLOCKED="BLOCKED_DATA";
const safety=fields=>Object.freeze({
  schemaVersion:"four-market-original-minute-period-v1",
  status:BLOCKED,reason:null,
  originalSourceBackfill:false,modelOnly:true,
  historicalPITAndCalendarIndependentProof:false,
  originalHistoricalScannerAvailabilityVerified:false,
  independentOOSAndForwardProven:false,
  historicalFXFundingAndTrueFillCostsVerified:false,
  fullMarketOpportunityDenominatorVerified:false,
  actualMarketWideOpportunityCount:null,trueMarketWideRecall:null,
  actualFillCount:null,netProfitPct:null,OOSPassCount:0,
  profitabilityProven:false,
  executionAuthority:"NONE",paperAdmissionAllowed:false,
  automaticPaperExecution:false,orderSubmitted:false,
  liveTrading:false,autoTrading:false,realOrders:false,providerGETCount:0,
  ...fields,
});
const fail=reason=>{throw new TypeError(reason);};
function parseInputs(input){
  if(!input||typeof input!=="object"||Array.isArray(input)
    ||typeof input.root!=="string"
    ||!isAbsolute(input.root)||resolve(input.root)!==input.root
    ||!["KR_STOCK","US_STOCK","CRYPTO_SPOT","CRYPTO_FUTURES"]
      .includes(input.market)
    ||typeof input.symbol!=="string"||!input.symbol
    ||input.sourceSessions!==undefined
    ||input.cursorStartMs!==undefined
    ||input.discoverArchivedSessions===false)
    fail("PRIVATE_PERIOD_REPLAY_SOURCE_SCOPE_INVALID");
  const period=resolveSelectedResearchWindowV1(input.researchWindow);
  if(period.requestedUtcDayCount>MAX_DATE_DAYS)
    fail("PRIVATE_PERIOD_REPLAY_WINDOW_BUDGET_INVALID");
  return period;
}
function blocked(input,period,reason,extra={}){
  return safety({
    market:input.market,symbol:input.symbol,
    selectedStartDate:period.startDate,selectedEndDate:period.endDate,
    mode:"backtest-only",orderSubmitted:false,
    reason,
    indexedPrivateSessions:null,verifiedNativeMinuteSessions:null,
    modeledTradeCount:null,modeledNetPnlKRW:null,
    modeledReturnPercent:null,sourceLineageSha256:null,
    ...extra,
  });
}
export async function runFourMarketOriginalMinutePeriodV1(input={}){
  const period=parseInputs(input);
  let cursor=null,previousStart=-1,pageCount=0;
  const sessions=[],digestChain=[];
  while(true){
    if(pageCount>=MAX_PAGES)return blocked(input,period,
      "ORIGINAL_PERIOD_PRIVATE_SESSION_INDEX_PAGE_BUDGET_EXCEEDED",{
        partialSessionIndexPagesRead:pageCount,
        partialIndexedSourceSessions:sessions.length,
      });
    let page;
    try{
      page=await listArchivedResearchMinuteSessionsV1({
        root:input.root,market:input.market,symbol:input.symbol,
        researchWindow:input.researchWindow,
        cursorStartMs:cursor,maxSessions:PAGE_SIZE,
      });
    }catch{
      return blocked(input,period,"ORIGINAL_PERIOD_PRIVATE_SESSION_INDEX_UNSAFE");
    }
    pageCount++;
    if(page.status!=="LOCAL_ORIGINAL_SESSION_INDEX_PAGE_ONLY"
      ||page.executionAuthority!=="NONE"
      ||page.profitabilityProven!==false
      ||!Array.isArray(page.sourceSessions)
      ||!Number.isSafeInteger(page.sessionCount)
      ||page.sessionCount!==page.sourceSessions.length
      ||page.sourceSessions.length<1
      ||page.sourceSessions.length>PAGE_SIZE)
      return blocked(input,period, page.reason
        ??"ORIGINAL_PERIOD_PRIVATE_SESSION_INDEX_UNAVAILABLE",{
          sessionIndexPagesRead:pageCount,
        });
    for(const row of page.sourceSessions){
      if(row.market!==input.market||row.symbol!==input.symbol
        ||!Number.isSafeInteger(row.startMs)||row.startMs<=previousStart
        ||!Number.isSafeInteger(row.endMs)||row.endMs<=row.startMs
        ||!SHA.test(row.sourceDigestSha256??"")
        ||typeof row.date!=="string"
        ||row.date<period.startDate||row.date>period.endDate
        ||!["PREMARKET","REGULAR","AFTERMARKET","UTC_24H"].includes(row.kind)
        ||!["UTC","Asia/Seoul","America/New_York"].includes(row.zone))
        return blocked(input,period,"ORIGINAL_PERIOD_SOURCE_IDENTITY_OR_ORDER_INVALID");
      previousStart=row.startMs;
      if(row.nativeMinuteSlotInventoryComplete!==true)
        return blocked(input,period,"ORIGINAL_PERIOD_SOURCE_HAS_UNVERIFIED_MINUTE_GAPS",{
          blockedDate:row.date,blockedSessionStartMs:row.startMs,
        });
      sessions.push(Object.freeze({
        date:row.date,startMs:row.startMs,endMs:row.endMs,
        kind:row.kind,zone:row.zone,
        sourceDigestSha256:row.sourceDigestSha256,
      }));
      digestChain.push([row.date,row.startMs,row.endMs,row.sourceDigestSha256]);
      if(sessions.length>MAX_SESSIONS)return blocked(input,period,
        "ORIGINAL_PERIOD_PRIVATE_SESSION_COUNT_BUDGET_EXCEEDED",{
          partialSessionIndexPagesRead:pageCount,
          partialIndexedSourceSessions:sessions.length,
        });
    }
    const next=page.nextCursorStartMs;
    if(next===null)break;
    if(!Number.isSafeInteger(next)||next<=previousStart)
      return blocked(input,period,"ORIGINAL_PERIOD_NON_PROGRESSING_PAGE_CURSOR");
    cursor=next;
  }
  // Importantly, no source/index receipt is accepted as proof of a
  // contemporaneous scanner or as automatic Paper admission.
  let replay;
  try{
    replay=await runFourMarketOriginalMinuteReplayV1({
      ...input,sessionSources:sessions,
    });
  }catch{
    return blocked(input,period,"ORIGINAL_PERIOD_REPLAY_INPUT_OR_SOURCE_INVALID",{
      sessionIndexPagesRead:pageCount,indexedPrivateSessions:sessions.length,
    });
  }
  if(replay.status!=="RETROSPECTIVE_SOURCE_ONLY_STRATEGY_DIAGNOSTIC"
    ||replay.executionAuthority!=="NONE"
    ||replay.profitabilityProven!==false
    ||replay.paperAdmissionAllowed!==false
    ||replay.actualFillCount!==null
    ||!Number.isSafeInteger(replay.sourceSessionsRead)
    ||replay.sourceSessionsRead!==sessions.length)
    return blocked(input,period,replay.reason??"ORIGINAL_PERIOD_REPLAY_BLOCKED",{
      sessionIndexPagesRead:pageCount,indexedPrivateSessions:sessions.length,
      verifiedNativeMinuteSessions:null,
    });
  return safety({
    ...replay,
    schemaVersion:"four-market-original-minute-period-v1",
    status:"SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY",
    reason:"PRIVATE_ORIGINAL_1M_MULTI_SESSION_RESEARCH_ONLY_NOT_OOS",
    originalSourceBackfill:false,modelOnly:true,
    historicalPITAndCalendarIndependentProof:false,
    originalHistoricalScannerAvailabilityVerified:false,
    independentOOSAndForwardProven:false,
    historicalFXFundingAndTrueFillCostsVerified:false,
    fullMarketOpportunityDenominatorVerified:false,
    actualMarketWideOpportunityCount:null,trueMarketWideRecall:null,
    actualFillCount:null,netProfitPct:null,OOSPassCount:0,
    profitabilityProven:false,executionAuthority:"NONE",
    paperAdmissionAllowed:false,automaticPaperExecution:false,
    orderSubmitted:false,liveTrading:false,autoTrading:false,
    realOrders:false,providerGETCount:0,
    sessionIndexPagesRead:pageCount,
    indexedPrivateSessions:sessions.length,
    verifiedNativeMinuteSessions:sessions.length,
    sourceSessionIndexDigestSha256:sha(digestChain),
    selectedPeriodIncludesIndependentRealTimeEvidence:false,
    selectedPeriodBacktestResultsRemainModeledOnly:true,
  });
}
