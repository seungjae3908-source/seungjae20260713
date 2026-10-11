// Public research-only bounded data-gap retry and eligible-index progress.
// NEVER generates candidate/AI/Paper/LIVE authority. Rotated DATA_MISSING
// pages are recorded as blocked observations and automatically revisited
// when the source cursor wraps to the start of the next round.
import {classifyPublicCycleLaneStatus, decidePublicCycleCursor} from './public-cycle-coverage.mjs';
const TRUSTED = new Set(['krx-symbol-master','nasdaq-trader-public-directory','finnhub-symbol-master','upbit-public','bitget-public']);
const nonnegative = v => Number.isSafeInteger(v) && v >= 0;

export function resolvePublicResearchDataRetry({response,status,cursor,priorRetry,maxAttempts=3}) {
  const normal=decidePublicCycleCursor({response,status,cursor});
  const untouched=()=>Object.freeze({decision:normal,retry:null});
  if (status!=='SEARCH_FAILURE' || status!==classifyPublicCycleLaneStatus(response)
    || !Number.isSafeInteger(maxAttempts) || maxAttempts<2 || maxAttempts>10)
    return untouched();
  const u=response?.universe, e=response?.execution;
  const fs=response?.failures;
  const identified=(nonnegative(e?.insufficientDataCount)&&e.insufficientDataCount>0)
    || (Array.isArray(fs) && fs.some(row=>row?.reason==='invalid_data'||row?.reason==='symbol_mapping'));
  // Never defer genuine provider failures, timeouts, stale data, source
  // mismatch, partial work, malformed cursors or aborted scans.
  if (!identified || !u || !e || !TRUSTED.has(u.source)
    || u.stale===true || response.dataState==='stale'
    || (Array.isArray(fs) && fs.some(row=>!['invalid_data','symbol_mapping'].includes(row?.reason)))
    || !nonnegative(e.providerErrorCount) || e.providerErrorCount!==0
    || !nonnegative(e.timeoutCount) || e.timeoutCount!==0
    || (u.providerErrorCount != null && (!nonnegative(u.providerErrorCount) || u.providerErrorCount!==0))
    || e.timedOut===true || e.cancelled===true || e.duplicate===true
    || (e.partial===true && u.partial!==true)
    || !nonnegative(e.requestedCount) || e.requestedCount<1
    || !nonnegative(e.startedCount) || e.startedCount!==e.requestedCount
    || !nonnegative(e.completedCount) || e.completedCount!==e.requestedCount
    || !nonnegative(u.cursor) || u.cursor!==cursor
    || !nonnegative(u.totalCount) || u.totalCount<1
    || cursor+e.requestedCount>u.totalCount)
    return untouched();
  const end=cursor+e.requestedCount;
  if (u.nextCursor===null ? end!==u.totalCount : u.nextCursor!==end || end>=u.totalCount)
    return untouched();
  const last=priorRetry && priorRetry.cursor===cursor
    && priorRetry.source===u.source && priorRetry.total===u.totalCount
    && nonnegative(priorRetry.attempts) ? priorRetry.attempts : 0;
  const attempts=last+1;
  if (attempts<maxAttempts)
    return Object.freeze({decision:normal,retry:Object.freeze({
      cursor,source:u.source,total:u.totalCount,attempts,
    })});
  return Object.freeze({
    retry:null,
    decision:Object.freeze({
      nextCursor:u.nextCursor===null?0:u.nextCursor,
      blockedObservationOnly:true,
      deferredDataRetry:true,
      reason:'DATA_INSUFFICIENT_DEFERRED_UNTIL_SOURCE_WRAP',
    }),
  });
}

const cleanState = (source,total,cursor) => ({
  version:1,source,total,expectedCursor:cursor,roundStartCursor:cursor,
  attempted:0,verified:0,blocked:0,failedRuns:0,
  roundsObserved:0,roundsEligibleIndexVerified:0,lastRound:null,
});

export function advancePublicResearchIndexProgress(previous,{response,status,decision,observedAt}) {
  const u=response?.universe, e=response?.execution;
  const total=u?.totalCount,cursor=u?.cursor,source=u?.source;
  if (!TRUSTED.has(source)||!nonnegative(total)||total===0||!nonnegative(cursor)||cursor>=total)
    return Object.freeze({state:previous??null,summary:Object.freeze({
      eligibleIndexRoundVerified:false,wholeMarketQuotesProven:false,reason:'ROSTER_UNVERIFIED',
    })});
  const compatible=previous && previous.version===1 && previous.source===source
    && previous.total===total && previous.expectedCursor===cursor;
  const p=compatible ? {...previous} : cleanState(source,total,cursor);
  const count=e?.requestedCount;
  const verified=status==='CANDIDATES_AVAILABLE'||status==='VALID_NO_TRADE';
  const observed=verified||decision?.blockedObservationOnly===true;
  const expectedEnd=cursor+count;
  const correct=nonnegative(count)&&count>0&&expectedEnd<=total
    && e.startedCount===count&&e.completedCount===count
    && decision?.nextCursor===(expectedEnd===total?0:expectedEnd)
    && observed && (verified ? decision.blockedObservationOnly!==true : true);
  if (!correct) {
    p.failedRuns+=1;
    return Object.freeze({state:Object.freeze(p),summary:Object.freeze({
      expectedCursor:p.expectedCursor,attemptedEligibleIndexes:p.attempted,
      verifiedEligibleIndexes:p.verified,blockedEligibleIndexes:p.blocked,
      completedEligibleIndexRounds:p.roundsObserved,
      verifiedEligibleIndexRounds:p.roundsEligibleIndexVerified,
      wholeMarketQuotesProven:false,reason:'PAGE_NOT_COMPLETED',
    })});
  }
  p.attempted+=count;
  p.verified+=verified?count:0;
  p.blocked+=verified?0:count;
  p.expectedCursor=decision.nextCursor;
  let roundEnded=false;
  if (expectedEnd===total) {
    roundEnded=true;
    const indexesSeen=p.roundStartCursor===0&&p.attempted===total;
    const allEligibleVerified=indexesSeen&&p.verified===total&&p.blocked===0&&u.partial!==true;
    p.lastRound={
      at:typeof observedAt==='string'?observedAt:new Date().toISOString(),
      eligibleIndexesSeen:indexesSeen,verifiedEligibleIndexes:p.verified,
      blockedEligibleIndexes:p.blocked,allEligibleIndexPagesVerified:allEligibleVerified,
      fullMarketConstituentProof:false,
    };
    if (indexesSeen) p.roundsObserved+=1;
    if (allEligibleVerified) p.roundsEligibleIndexVerified+=1;
    p.attempted=0;p.verified=0;p.blocked=0;p.roundStartCursor=0;p.expectedCursor=0;
  }
  return Object.freeze({
    state:Object.freeze(p),
    summary:Object.freeze({
      expectedCursor:p.expectedCursor,attemptedEligibleIndexes:p.attempted,
      verifiedEligibleIndexes:p.verified,blockedEligibleIndexes:p.blocked,
      completedEligibleIndexRounds:p.roundsObserved,
      verifiedEligibleIndexRounds:p.roundsEligibleIndexVerified,
      lastRound:p.lastRound,roundEnded,
      wholeMarketQuotesProven:false,
      reason:decision.reason,
    }),
  });
}
