import {createHash} from "node:crypto";
import {isAbsolute,resolve} from "node:path";
import {setImmediate as yieldImmediate} from "node:timers/promises";
import {resolveSelectedResearchWindowV1} from "./research-selected-window-v1.js";
import {listArchivedResearchMinuteSessionsV1} from "./research-minute-archive-v1.js";
import {runFourMarketOriginalMinuteReplayV1,
  resolveOriginalMinuteEvidenceScopeV1,validateOriginalMinuteExecutionControlV1,
  originalMinuteReplayInterruptionReasonV1} from "./four-market-original-minute-replay-v1.js";

/**
 * User-selected historical period -> immutable native 1m archive -> one
 * stateful per-symbol RESEARCH replay across ALL declared sessions.
 *
 * This intentionally does not concatenate independently reset daily
 * simulated PnLs. EMA, equity and reserve state cross sessions inside the
 * existing bounded-memory replay engine. Positions close at EACH native
 * session end and pending entries are discarded there. Missing original
 * minutes, unknown exchange sessions and competing revisions fail CLOSED.
 *
 * It reads only server-private original files. No licensed-source discovery,
 * public/private provider GET, trading/API calls, Paper/Journals/Telegram,
 * autoscheduling, or source correction/backfill is attempted.
 */
// Ten years of stock PRE/REGULAR/AFTER sessions can exceed 5,000
// separate native archives even for ONE symbol. Explicitly accommodate
// the documented 10-year user range without relaxing per-file 1m bounds.
export const ORIGINAL_MINUTE_PERIOD_LIMITS_V1=Object.freeze({
  indexPageSize:31,maxIndexPages:650,maxSessionsPerSymbol:20_000,
});
const PAGE_SIZE=ORIGINAL_MINUTE_PERIOD_LIMITS_V1.indexPageSize;
const MAX_PAGES=ORIGINAL_MINUTE_PERIOD_LIMITS_V1.maxIndexPages;
const MAX_SESSIONS=ORIGINAL_MINUTE_PERIOD_LIMITS_V1.maxSessionsPerSymbol;
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
  validateOriginalMinuteExecutionControlV1(input);
  const evidence=resolveOriginalMinuteEvidenceScopeV1(input);
  return {period,evidence};
}
function blocked(input,period,evidence,reason,extra={}){
  return safety({
    market:input.market,symbol:input.symbol,
    ...evidence,historicalPITRosterChecked:false,
    historicalMemberLifespanSelfAttestedNotIndependentlyVerified:!evidence.sourceOnlyMode,
    historicalTradingAvailabilityVerified:false,
    sessionClosePolicy:"CLOSE_EACH_SOURCE_SESSION",
    selectedStartDate:period.startDate,selectedEndDate:period.endDate,
    mode:"backtest-only",orderSubmitted:false,
    reason,
    indexedPrivateSessions:null,verifiedNativeMinuteSessions:null,
    modeledTradeCount:null,modeledNetPnlKRW:null,
    modeledReturnPercent:null,sourceLineageSha256:null,
    modeledCostKRW:null,modeledMaximumDrawdownPercent:null,
    sourceDigestChainSha256:null,sourceModelDigestSha256:null,
    ...extra,
  });
}
export async function runFourMarketOriginalMinutePeriodV1(input={}){
  const {period,evidence}=parseInputs(input);
  const stop=(reason,extra={})=>blocked(input,period,evidence,reason,extra);
  const interruptionReason=error=>originalMinuteReplayInterruptionReasonV1(input)
    ??(["ORIGINAL_MINUTE_REPLAY_CANCELLED","ORIGINAL_MINUTE_REPLAY_TIME_BUDGET_EXCEEDED"]
      .includes(error?.code??error?.message)?error.code??error.message:null);
  let interrupted=interruptionReason();if(interrupted)return stop(interrupted);
  let cursor=null,previousStart=-1,pageCount=0;
  const sessions=[],digestChain=[];
  while(true){
    interrupted=interruptionReason();if(interrupted)return stop(interrupted);
    await yieldImmediate();
    interrupted=interruptionReason();if(interrupted)return stop(interrupted);
    if(pageCount>=MAX_PAGES)return stop(
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
    }catch(error){
      return stop(interruptionReason(error)??"ORIGINAL_PERIOD_PRIVATE_SESSION_INDEX_UNSAFE");
    }
    interrupted=interruptionReason();if(interrupted)return stop(interrupted);
    pageCount++;
    if(page.status!=="LOCAL_ORIGINAL_SESSION_INDEX_PAGE_ONLY"
      ||page.executionAuthority!=="NONE"
      ||page.profitabilityProven!==false
      ||!Array.isArray(page.sourceSessions)
      ||!Number.isSafeInteger(page.sessionCount)
      ||page.sessionCount!==page.sourceSessions.length
      ||page.sourceSessions.length<1
      ||page.sourceSessions.length>PAGE_SIZE)
      return stop(page.reason
        ??"ORIGINAL_PERIOD_PRIVATE_SESSION_INDEX_UNAVAILABLE",{
          sessionIndexPagesRead:pageCount,
        });
    for(const row of page.sourceSessions){
      interrupted=interruptionReason();if(interrupted)return stop(interrupted);
      if(row.market!==input.market||row.symbol!==input.symbol
        ||!Number.isSafeInteger(row.startMs)||row.startMs<=previousStart
        ||!Number.isSafeInteger(row.endMs)||row.endMs<=row.startMs
        ||!SHA.test(row.sourceDigestSha256??"")
        ||typeof row.date!=="string"
        ||row.date<period.startDate||row.date>period.endDate
        ||!["PREMARKET","REGULAR","AFTERMARKET","UTC_24H"].includes(row.kind)
        ||!["UTC","Asia/Seoul","America/New_York"].includes(row.zone))
        return stop("ORIGINAL_PERIOD_SOURCE_IDENTITY_OR_ORDER_INVALID");
      previousStart=row.startMs;
      if(row.nativeMinuteSlotInventoryComplete!==true)
        return stop("ORIGINAL_PERIOD_SOURCE_HAS_UNVERIFIED_MINUTE_GAPS",{
          blockedDate:row.date,blockedSessionStartMs:row.startMs,
        });
      sessions.push(Object.freeze({
        date:row.date,startMs:row.startMs,endMs:row.endMs,
        kind:row.kind,zone:row.zone,
        sourceDigestSha256:row.sourceDigestSha256,
      }));
      digestChain.push([row.date,row.startMs,row.endMs,row.sourceDigestSha256]);
      if(sessions.length>MAX_SESSIONS)return stop(
        "ORIGINAL_PERIOD_PRIVATE_SESSION_COUNT_BUDGET_EXCEEDED",{
          partialSessionIndexPagesRead:pageCount,
          partialIndexedSourceSessions:sessions.length,
        });
    }
    const next=page.nextCursorStartMs;
    if(next===null)break;
    if(!Number.isSafeInteger(next)||next<=previousStart)
      return stop("ORIGINAL_PERIOD_NON_PROGRESSING_PAGE_CURSOR");
    cursor=next;
  }
  // Neither an archive index nor an explicit current-roster cohort is
  // proof of historical membership, scanner availability or Paper admission.
  interrupted=interruptionReason();if(interrupted)return stop(interrupted);
  let replay;
  try{
    replay=await runFourMarketOriginalMinuteReplayV1({
      ...input,sessionSources:sessions,
    });
  }catch(error){
    return stop(interruptionReason(error)??"ORIGINAL_PERIOD_REPLAY_INPUT_OR_SOURCE_INVALID",{
      sessionIndexPagesRead:pageCount,indexedPrivateSessions:sessions.length,
    });
  }
  interrupted=interruptionReason();if(interrupted)return stop(interrupted,{
    sessionIndexPagesRead:pageCount,indexedPrivateSessions:sessions.length,
  });
  if(replay.status!=="RETROSPECTIVE_SOURCE_ONLY_STRATEGY_DIAGNOSTIC"
    ||replay.executionAuthority!=="NONE"
    ||replay.profitabilityProven!==false
    ||replay.paperAdmissionAllowed!==false
    ||replay.actualFillCount!==null
    ||!Number.isSafeInteger(replay.sourceSessionsRead)
    ||replay.sourceSessionsRead!==sessions.length)
    return stop(replay.reason??"ORIGINAL_PERIOD_REPLAY_BLOCKED",{
      sessionIndexPagesRead:pageCount,indexedPrivateSessions:sessions.length,
      verifiedNativeMinuteSessions:null,
      requestedUtcDayCount:period.requestedUtcDayCount,
      missingSourceDays:Number.isSafeInteger(replay.missingSourceDays)
        &&replay.missingSourceDays>=0?replay.missingSourceDays:null,
      missingExpectedStockSessions:Number.isSafeInteger(replay.missingExpectedStockSessions)
        &&replay.missingExpectedStockSessions>=0?replay.missingExpectedStockSessions:null,
      blockedDatesPreview:Array.isArray(replay.blockedDatesPreview)
        ?replay.blockedDatesPreview.filter(date=>typeof date==="string"
          &&/^\d{4}-\d{2}-\d{2}$/u.test(date)).slice(0,30):[],
      ...(typeof replay.blockedDate==="string"
        &&/^\d{4}-\d{2}-\d{2}$/u.test(replay.blockedDate)
        ?{blockedDate:replay.blockedDate}:{}),
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
    sourceSessionIndexDigestSha256:sha(evidence.sourceOnlyMode?{
      evidenceScope:evidence.evidenceScope,
      currentRosterDigestSha256:evidence.currentRosterDigestSha256,
      sessions:digestChain,
    }:digestChain),
    selectedPeriodIncludesIndependentRealTimeEvidence:false,
    selectedPeriodBacktestResultsRemainModeledOnly:true,
  });
}
