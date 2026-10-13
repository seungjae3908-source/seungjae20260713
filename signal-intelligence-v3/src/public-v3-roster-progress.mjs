/**
 * Persistent, bounded, public-only cursor progress for the 4-market V3 scan.
 * "Attempted" != complete trusted data != all-symbol market coverage.
 * Stores ONLY aggregates/roster counts (no tickers, candles, providers' JSON).
 */
const LANES=Object.freeze(['KR','US','SPOT','FUTURES'].flatMap(m=>
  ['SCALPING_15M','SWING_60M','MID_LONG_1D'].map(mode=>m+'_'+mode)));
const SOURCES=Object.freeze({
  KR:new Set(['krx-symbol-master']),
  US:new Set(['nasdaq-trader-public-directory','finnhub-symbol-master']),
  SPOT:new Set(['upbit-public']),FUTURES:new Set(['bitget-public']),
});
const INT=x=>Number.isSafeInteger(x)&&x>=0&&x<=1_000_000;
const inc=(x,by=1)=>Math.min(10_000_000,x+by);
function envelope(r){
  if(!r||!LANES.includes(r.laneId))return null;
  const prefix=r.laneId.split('_')[0];
  const total=r.totalUniverse;
  const raw=r.universeRawTotalCount==null?total:r.universeRawTotalCount;
  const excluded=r.universeExplainedExcludedCount==null?0:r.universeExplainedExcludedCount;
  if(!INT(total)||total===0||!INT(raw)||raw<total
    ||!INT(excluded)||raw-total!==excluded
    ||!SOURCES[prefix]?.has(r.universeSource))return null;
  return {total,raw,excluded,source:r.universeSource};
}
function newRow(r,e){
  return {laneId:r.laneId,source:e.source,eligibleUniverse:e.total,
    rawListedUniverse:e.raw,providerExcluded:e.excluded,
    passStartCursor:INT(r.cursorBefore)?r.cursorBefore:0,
    nextCursor:INT(r.cursorBefore)?r.cursorBefore:0,
    attemptedInCurrentPass:0,trustedInCurrentPass:0,
    blockedInCurrentPass:0,completedEligibleCursorPasses:0,
    heldOrUnverifiedCycles:0,lastResult:'NOT_OBSERVED'};
}
function compatible(prior,e,r){
  return prior && prior.laneId===r.laneId
    &&prior.source===e.source&&prior.eligibleUniverse===e.total
    &&prior.rawListedUniverse===e.raw&&prior.providerExcluded===e.excluded
    &&INT(prior.nextCursor)&&prior.nextCursor===r.cursorBefore
    &&INT(prior.passStartCursor)
    &&INT(prior.attemptedInCurrentPass)
    &&prior.attemptedInCurrentPass<=e.total
    &&INT(prior.trustedInCurrentPass)&&INT(prior.blockedInCurrentPass)
    &&prior.trustedInCurrentPass+prior.blockedInCurrentPass===
      prior.attemptedInCurrentPass
    &&INT(prior.completedEligibleCursorPasses)
    &&INT(prior.heldOrUnverifiedCycles);
}
function completedPage(r,e){
  const diag=r.publicExecutionDiagnostic;
  const req=diag?.requested;
  if(!INT(r.cursorBefore)||r.cursorBefore>=e.total
    ||!INT(r.cursorAfter)||r.cursorAfter>=e.total
    ||!INT(req)||req<1||r.cursorBefore+req>e.total
    ||diag?.started!==req||diag?.completed!==req
    ||r.cursorAfter!==(r.cursorBefore+req===e.total?0:r.cursorBefore+req)
    ||r.universeStale!==false||r.providerErrors!==0||r.timeouts!==0
    ||r.universeProviderErrors!==0
    ||diag.providerErrors!==0||diag.timeouts!==0||diag.timedOut!==false)
    return null;
  const trusted=(r.status==='CANDIDATES_AVAILABLE'||r.status==='VALID_NO_TRADE')
    &&r.cursorRotationReason==='VERIFIED_BATCH'
    &&r.cursorRotatedBlockedOnly===false
    &&r.lastGoodPreserved===false&&r.universePartial===false
    &&r.responseDataState==='complete'
    &&diag.state==='PAGE_EXECUTION_COMPLETE'
    &&diag.partial===false&&diag.failuresObserved===0;
  const blocked=r.status==='BLOCKED_DATA'
    &&r.cursorRotatedBlockedOnly===true&&r.lastGoodPreserved===true
    &&['BLOCKED_RESEARCH_ROTATION_ONLY',
      'BLOCKED_INVALID_DATA_RESEARCH_ROTATION_ONLY'].includes(r.cursorRotationReason)
    &&['PAGE_EXECUTION_COMPLETE','UNEXPLAINED_PARTIAL',
      'REPORTED_ITEM_FAILURES'].includes(diag.state)
    &&r.responseDataState!=='stale'&&r.responseDataState!=='unavailable';
  return trusted?{requested:req,kind:'TRUSTED_PAGE'}
    :blocked?{requested:req,kind:'BLOCKED_OBSERVATION_ONLY'}:null;
}
/** Honest across-cycle progress: cursor traversal of ELIGIBLE symbols only.
 * No roster fingerprint/real full-market assertion, no decision authority.
 */
export function accumulatePublicV3RosterProgress(previous,coverage){
  if(!Array.isArray(coverage)||coverage.length!==LANES.length
    ||new Set(coverage.map(r=>r?.laneId)).size!==LANES.length
    ||coverage.some(r=>!LANES.includes(r?.laneId)))return Object.freeze({});
  const out=Object.create(null);
  for(const row of coverage){
    const e=envelope(row);
    if(!e)continue;
    const prev=previous?.[row.laneId];
    const progress=compatible(prev,e,row)?{...prev}:newRow(row,e);
    const page=completedPage(row,e);
    if(!page){
      progress.heldOrUnverifiedCycles=inc(progress.heldOrUnverifiedCycles);
      progress.lastResult='HELD_UNVERIFIED';
    }else{
      progress.attemptedInCurrentPass+=page.requested;
      if(page.kind==='TRUSTED_PAGE')
        progress.trustedInCurrentPass+=page.requested;
      else progress.blockedInCurrentPass+=page.requested;
      progress.nextCursor=row.cursorAfter;
      progress.lastResult=page.kind;
      if(row.cursorAfter===0){
        if(progress.passStartCursor===0&&
          progress.attemptedInCurrentPass===e.total)
          progress.completedEligibleCursorPasses=
            inc(progress.completedEligibleCursorPasses);
        progress.passStartCursor=0;
        progress.attemptedInCurrentPass=0;
        progress.trustedInCurrentPass=0;
        progress.blockedInCurrentPass=0;
      }
    }
    progress.cumulativeInterpretation='ELIGIBLE_CURSOR_TRAVERSAL_ONLY';
    progress.rosterMembershipVerified=false;
    progress.fullMarketUniverseCovered=false;
    progress.economicAuthority='NONE';
    out[row.laneId]=Object.freeze(progress);
  }
  return Object.freeze(out);
}
