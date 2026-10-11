import test from 'node:test';
import assert from 'node:assert/strict';
import {accumulatePublicV3RosterProgress} from '../src/public-v3-roster-progress.mjs';
const lanes=['KR','US','SPOT','FUTURES'].flatMap(m=>
  ['SCALPING_15M','SWING_60M','MID_LONG_1D'].map(t=>m+'_'+t));
const row=(lane,before,after,total=5,kind='TRUSTED_PAGE')=>{
  const market=lane.split('_')[0],blocked=kind==='BLOCKED_OBSERVATION_ONLY';
  const count=after===0?total-before:after-before;
  return {
    laneId:lane,cursorBefore:before,cursorAfter:after,totalUniverse:total,
    universeSource:{KR:'krx-symbol-master',
      US:'nasdaq-trader-public-directory',SPOT:'upbit-public',
      FUTURES:'bitget-public'}[market],
    universeRawTotalCount:market==='KR'?total+2:null,
    universeExplainedExcludedCount:market==='KR'?2:null,
    cursorRotatedBlockedOnly:blocked,
    cursorRotationReason:blocked?'BLOCKED_RESEARCH_ROTATION_ONLY':'VERIFIED_BATCH',
    status:blocked?'BLOCKED_DATA':'CANDIDATES_AVAILABLE',
    responseDataState:blocked?'partial':'complete',
    universePartial:blocked,universeStale:false,
    lastGoodPreserved:blocked,providerErrors:0,timeouts:0,
    universeProviderErrors:0,
    publicExecutionDiagnostic:{state:blocked?'UNEXPLAINED_PARTIAL':'PAGE_EXECUTION_COMPLETE',
      requested:count,started:count,completed:count,
      providerErrors:0,timeouts:0,timedOut:false,partial:blocked,
      failuresObserved:0},
  };
};
const snapshot=(before,after,kind='TRUSTED_PAGE',total=5)=>
  lanes.map(l=>row(l,before,after,total,kind));
test('a contiguous eligible page traversal increments only honest research counters',()=>{
  let state=accumulatePublicV3RosterProgress(null,snapshot(0,2));
  state=accumulatePublicV3RosterProgress(state,snapshot(2,4,'BLOCKED_OBSERVATION_ONLY'));
  assert.equal(state.KR_SCALPING_15M.attemptedInCurrentPass,4);
  assert.equal(state.KR_SCALPING_15M.trustedInCurrentPass,2);
  assert.equal(state.KR_SCALPING_15M.blockedInCurrentPass,2);
  assert.equal(state.KR_SCALPING_15M.providerExcluded,2);
  state=accumulatePublicV3RosterProgress(state,snapshot(4,0));
  const row=state.KR_SCALPING_15M;
  assert.equal(row.completedEligibleCursorPasses,1);
  assert.equal(row.attemptedInCurrentPass,0);
  assert.equal(row.fullMarketUniverseCovered,false);
  assert.equal(row.rosterMembershipVerified,false);
  assert.equal(row.economicAuthority,'NONE');
  assert.equal(JSON.stringify(state).includes('ticker'),false);
});
test('a held or incomplete page cannot advance or double-count the pass',()=>{
  let prev=accumulatePublicV3RosterProgress(null,snapshot(0,2));
  const held=snapshot(2,2);
  for(const row of held){
    row.status='SEARCH_FAILURE';row.cursorRotationReason='PROVIDER_FAILURE';
    row.publicExecutionDiagnostic.completed=0;
  }
  prev=accumulatePublicV3RosterProgress(prev,held);
  assert.equal(prev.SPOT_SWING_60M.attemptedInCurrentPass,2);
  assert.equal(prev.SPOT_SWING_60M.nextCursor,2);
  assert.equal(prev.SPOT_SWING_60M.heldOrUnverifiedCycles,1);
  prev=accumulatePublicV3RosterProgress(prev,snapshot(2,4));
  assert.equal(prev.SPOT_SWING_60M.attemptedInCurrentPass,4);
});
test('resumed mid-universe cannot claim a completed full pass',()=>{
  let state=accumulatePublicV3RosterProgress(null,snapshot(3,0));
  assert.equal(state.US_SCALPING_15M.completedEligibleCursorPasses,0);
  state=accumulatePublicV3RosterProgress(state,snapshot(0,2));
  state=accumulatePublicV3RosterProgress(state,snapshot(2,0));
  assert.equal(state.US_SCALPING_15M.completedEligibleCursorPasses,1);
});
test('changing provider or roster counts resets old evidence and cannot produce PASS',()=>{
  let state=accumulatePublicV3RosterProgress(null,snapshot(0,2));
  const changed=snapshot(0,2,'BLOCKED_OBSERVATION_ONLY',8);
  state=accumulatePublicV3RosterProgress(state,changed);
  assert.equal(state.KR_SCALPING_15M.attemptedInCurrentPass,2);
  assert.equal(state.KR_SCALPING_15M.eligibleUniverse,8);
  assert.equal(state.KR_SCALPING_15M.completedEligibleCursorPasses,0);
  assert.equal(state.KR_SCALPING_15M.lastResult,'BLOCKED_OBSERVATION_ONLY');
});
test('partial/missing/unsafe diagnostic receipts yield no claimed full-market authority',()=>{
  assert.deepEqual(accumulatePublicV3RosterProgress(null,[]),{});
  const invalid=snapshot(0,2);
  invalid[0].cursorAfter=3;
  invalid[1].publicExecutionDiagnostic.started=1;
  invalid[2].providerErrors=1;
  const progress=accumulatePublicV3RosterProgress({},invalid);
  for(const name of lanes){
    assert.equal(progress[name].fullMarketUniverseCovered,false);
    assert.equal(progress[name].economicAuthority,'NONE');
  }
  for(const name of [lanes[0],lanes[1],lanes[2]])
    assert.equal(progress[name].attemptedInCurrentPass,0);
});
