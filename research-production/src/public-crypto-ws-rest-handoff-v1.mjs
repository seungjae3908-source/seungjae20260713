// Pure, offline REST recovery handoff for the source-only WS supervisor.
// Does NOT fetch provider data, treat no-trade as a gap, admit OOS or
// delete/settle supervisor audits without independently sealed REST receipts.
import {createHash} from 'node:crypto';
import {readOriginalMinutePage,validateMinuteTask} from
  './four-market-minute-archive-intake-v1.mjs';
import {PUBLIC_WS_SUPERVISOR_CONTRACT,
  PUBLIC_WS_SUPERVISOR_LIMITS} from './public-crypto-ws-supervisor-v1.mjs';

export const PUBLIC_WS_REST_HANDOFF_CONTRACT=
  'research-public-ws-rest-audit-handoff/v1';
const MARKETS=new Set(['CRYPTO_SPOT','CRYPTO_FUTURES']);
const int=x=>Number.isSafeInteger(x)&&x>0;
const nonnegative=x=>Number.isSafeInteger(x)&&x>=0;
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=x=>{throw new TypeError(x);};
const zeros=()=>({
  publicProviderGETCount:0,websocketsOpened:0,archiveFilesWritten:0,
  restPagesVerified:0,originalMinuteProven:false,needsIndependentRest:true,
  independentPITProven:false,independentOosProven:false,
  paperAdmissionAllowed:false,profitabilityProven:false,
  executionAuthority:'NONE',
});
/**
 * Cursor indexing is stable for an immutable state snapshot. Do not trust
 * missing-minute reasons: even a sealed websocket receipt is provisional.
 * Outputs exact bounded REST page INTENTS, not executable network requests.
 */
export function planPendingPublicWsRestAuditsV1({
  state,asOfMs=Date.now(),limit=16,startIndex=0,
  pageWindowMinutes=120,
}={}){
  if(!state||state.contract!==PUBLIC_WS_SUPERVISOR_CONTRACT
    ||state.status!=='SIMULATION_ONLY'
    ||state.executionAuthority!=='NONE'
    ||!Array.isArray(state.pendingRestAudits)
    ||state.pendingRestAudits.length>
      PUBLIC_WS_SUPERVISOR_LIMITS.maxPendingRestAudits
    ||!int(asOfMs)||asOfMs<state.updatedAtMs
    ||!nonnegative(startIndex)||startIndex>state.pendingRestAudits.length
    ||!int(limit)||limit>16
    ||![120,180].includes(pageWindowMinutes))
    fail('WS_REST_HANDOFF_INPUT_INVALID');
  const cutoff=Math.floor((asOfMs-5_000)/60_000)*60_000;
  const pending=state.pendingRestAudits;
  const tasks=[];
  let cursor=startIndex,notYetClosed=0,tailUnverified=0;
  while(cursor<pending.length && tasks.length<limit){
    const audit=pending[cursor];
    const index=cursor++;
    const fullEnd=audit?.requestedEndExclusiveMs??audit?.toExclusiveMs;
    if(!MARKETS.has(audit?.market)
      ||typeof audit.symbol!=='string'
      ||(audit.market==='CRYPTO_SPOT'
        ? !/^[A-Z0-9]{1,20}$/u.test(audit.symbol)
        : !/^[A-Z0-9\p{Script=Han}]{1,26}USDT$/u.test(audit.symbol))
      ||!int(audit.fromMs)||audit.fromMs%60_000
      ||!int(audit.toExclusiveMs)||audit.toExclusiveMs%60_000
      ||!int(fullEnd)||fullEnd%60_000
      ||audit.fromMs>=audit.toExclusiveMs
      ||audit.toExclusiveMs>fullEnd
      ||audit.unverifiedBeyondCap!==(fullEnd>audit.toExclusiveMs)
      ||audit.sourceVerified!==false
      ||audit.restBackfillRequired!==true)
      fail('WS_REST_HANDOFF_AUDIT_INVALID');
    const end=Math.min(fullEnd,cutoff,
      audit.fromMs+pageWindowMinutes*60_000);
    if(end<=audit.fromMs){
      notYetClosed++;continue;
    }
    if(fullEnd>end)tailUnverified++;
    const scope={market:audit.market,symbol:audit.symbol,
      windowStartMs:audit.fromMs,windowEndMs:end};
    tasks.push(Object.freeze({
      ...scope,
      requestWindowMinutes:(end-audit.fromMs)/60_000,
      sourceAuditIndex:index,
      auditDigest:sha([audit.market,audit.symbol,audit.fromMs,fullEnd,
        audit.observedAtMs,audit.reason]),
      sourceProvider:audit.market==='CRYPTO_SPOT'
        ?'UPBIT_PUBLIC_1M':'BITGET_PUBLIC_FUTURES_1M',
      proposedNextCursorMs:end,
      outstandingUnverifiedTailEndMs:fullEnd,
      hasRemainingUnverifiedTail:fullEnd>end,
      noTradeIndependentlyProven:false,
      sourceOnly:true,queryMustBeOwnerApproved:true,
      authority:'NONE',
    }));
  }
  return Object.freeze({
    contract:PUBLIC_WS_REST_HANDOFF_CONTRACT,
    status:tasks.length?'REST_SOURCE_ONLY_AUDITS_PLANNED'
      :'NO_CLOSED_AUDITS_TO_PROPOSE',
    tasks:Object.freeze(tasks),startIndex,nextIndex:cursor,
    remainingAuditRecords:pending.length-cursor,
    notYetClosed,unverifiedTails:tailUnverified,
    pageWindowMinutes,closedCutoffMs:cutoff,
    scopeDigest:sha([state.generatedFromPlanDigest,
      state.updatedAtMs,startIndex,pageWindowMinutes]),
    sourceAvailabilityNotProven:true,independentlyClassifiedNoTrade:false,
    ...zeros(),
  });
}

/**
 * Advances one pending audit ONLY after reopening an immutable, SHA-sealed
 * original REST page from the pre-existing private research archive.
 * Same 1m OHLC history is source evidence, NOT original scanner-time PIT,
 * independent OOS, fills, full costs, profit or Paper authority.
 * Incomplete Upbit no-trade slots deliberately keep the audit pending.
 */
export async function inspectAndAdvancePublicWsRestAuditV1({
  state,sourceAuditIndex=0,root,researchSha,
  asOfMs=Date.now(),pageWindowMinutes=120,
}={}){
  const planned=planPendingPublicWsRestAuditsV1({
    state,asOfMs,limit:1,startIndex:sourceAuditIndex,pageWindowMinutes,
  });
  const selected=planned.tasks[0];
  if(!selected||selected.sourceAuditIndex!==sourceAuditIndex)
    return Object.freeze({
      contract:PUBLIC_WS_REST_HANDOFF_CONTRACT,
      status:'HOLD_NO_CLOSED_REST_WINDOW',
      updatedState:null,sourceAuditIndex,...zeros(),
    });
  const task=validateMinuteTask({
    market:selected.market,symbol:selected.symbol,
    windowStartMs:selected.windowStartMs,
    windowEndMs:selected.windowEndMs,
  });
  // Require the actual original immutable REST source receipt, never
  // an assertion from WS, a fabricated hash, or a test-only count.
  const page=await readOriginalMinutePage(root,task,researchSha);
  if(!page)
    return Object.freeze({
      contract:PUBLIC_WS_REST_HANDOFF_CONTRACT,
      status:'HOLD_SEALED_REST_ORIGINAL_MISSING',
      updatedState:null,sourceAuditIndex,task,
      ...zeros(),
    });
  const retrievedAtMs=Date.parse(page.retrievedAt);
  if(!int(retrievedAtMs)||retrievedAtMs>asOfMs+5_000)
    fail('WS_REST_SOURCE_RETRIEVAL_FUTURE_INVALID');
  if(!page.minuteSlotAudit?.localSlotCountComplete
    ||page.minuteSlotAudit?.unverifiedMissingMinuteSlots!==0
    ||page.candleCount!==(task.windowEndMs-task.windowStartMs)/60_000)
    return Object.freeze({
      contract:PUBLIC_WS_REST_HANDOFF_CONTRACT,
      status:'HOLD_UNVERIFIED_ORIGINAL_MINUTE_GAPS',
      updatedState:null,sourceAuditIndex,task,
      unverifiedMissingMinuteSlots:
        page.minuteSlotAudit?.unverifiedMissingMinuteSlots??null,
      ...zeros(),
    });
  const next=structuredClone(state);
  const audit=next.pendingRestAudits[sourceAuditIndex];
  if(!audit||audit.fromMs!==task.windowStartMs
    ||audit.market!==task.market||audit.symbol!==task.symbol)
    fail('WS_REST_HANDOFF_STATE_RACE');
  const requestedEnd=audit.requestedEndExclusiveMs??audit.toExclusiveMs;
  const originalPageDigest=page.contentDigest;
  let completedAudit=false;
  if(task.windowEndMs===requestedEnd) {
    next.pendingRestAudits.splice(sourceAuditIndex,1);
    completedAudit=true;
  }else{
    audit.fromMs=task.windowEndMs;
    audit.toExclusiveMs=Math.min(requestedEnd,
      audit.fromMs+PUBLIC_WS_SUPERVISOR_LIMITS.maxOutageAuditMinutes*60_000);
    audit.unverifiedBeyondCap=requestedEnd>audit.toExclusiveMs;
    audit.lastOriginalReadbackAtMs=retrievedAtMs;
    audit.lastOriginalReadbackDigest=originalPageDigest;
    audit.sourceVerified=false;
    audit.restBackfillRequired=true;
  }
  next.updatedAtMs=asOfMs;
  return Object.freeze({
    contract:PUBLIC_WS_REST_HANDOFF_CONTRACT,
    status:'LOCAL_REST_MINUTE_WINDOW_CONFIRMED_SOURCE_ONLY',
    task,sourceAuditIndex,
    completedAudit,
    originalPageDigest,
    actualRestRetrievalAtMs:retrievedAtMs,
    genuineScannerAsOfAvailabilityProven:false,
    updatedState:Object.freeze(next),
    // Proof of a 120/180-minute local slot count is NOT 4-market PIT,
    // independent market availability or trade-cost profitability.
    ...zeros(),restPagesVerified:1,
  });
}
