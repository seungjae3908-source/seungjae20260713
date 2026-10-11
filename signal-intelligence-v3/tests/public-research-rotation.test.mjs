import test from 'node:test';
import assert from 'node:assert/strict';
import {resolvePublicResearchDataRetry,advancePublicResearchIndexProgress} from '../src/public-research-rotation.mjs';
import {classifyPublicCycleLaneStatus} from '../src/public-cycle-coverage.mjs';
function source({total=41,cursor=0,count=20,partial=false,data='complete',failures=[],providerErrors=0,timeouts=0,insufficient=0}={}){
 const u={source:'nasdaq-trader-public-directory',totalCount:total,cursor,nextCursor:cursor+count<total?cursor+count:null,partial,stale:false,providerErrorCount:0};
 const e={requestedCount:count,startedCount:count,completedCount:count,providerErrorCount:providerErrors,timeoutCount:timeouts,partial:false,timedOut:false,cancelled:false,duplicate:false,insufficientDataCount:insufficient};
 return {universe:u,execution:e,cards:[],dataState:data,failures};
}
test('actual data-missing page holds twice, then defers only as observation and revisits on wrap',()=>{
 let retry=null;let cursor=0;let decision;
 const response=source({insufficient:2});
 for(let i=1;i<=3;i++){
   const status=classifyPublicCycleLaneStatus(response);
   assert.equal(status,'SEARCH_FAILURE');
   const v=resolvePublicResearchDataRetry({response,status,cursor,priorRetry:retry});
   retry=v.retry;decision=v.decision;
   assert.equal(decision.nextCursor,i===3?20:0);
 }
 assert.equal(decision.blockedObservationOnly,true);
 assert.equal(decision.deferredDataRetry,true);
 assert.equal(retry,null);
 assert.match(decision.reason,/DEFERRED_UNTIL_SOURCE_WRAP/);
 const withoutOptionalUniverseCount=source({insufficient:2});
 delete withoutOptionalUniverseCount.universe.providerErrorCount;
 const recovery=resolvePublicResearchDataRetry({
   response:withoutOptionalUniverseCount,status:classifyPublicCycleLaneStatus(withoutOptionalUniverseCount),
   cursor:0,priorRetry:{source:'nasdaq-trader-public-directory',total:41,cursor:0,attempts:2},
 });
 assert.equal(recovery.decision.blockedObservationOnly,true);
});
test('HTTP 429, timeout, stale, incomplete or mixed failures can NEVER be deferred',()=>{
 for(const response of [
   source({providerErrors:1,insufficient:1}),
   source({timeouts:1,insufficient:1}),
   {...source({insufficient:1}),dataState:'stale'},
   {...source({insufficient:1}),execution:{...source({insufficient:1}).execution,completedCount:19}},
   source({insufficient:1,failures:[{reason:'provider_error',message:'HTTP_429'}]}),
 ]) {
  const status=classifyPublicCycleLaneStatus(response);
  const value=resolvePublicResearchDataRetry({response,status,cursor:0,
    priorRetry:{source:'nasdaq-trader-public-directory',total:41,cursor:0,attempts:10}});
  assert.equal(value.decision.nextCursor,0);
  assert.equal(value.decision.blockedObservationOnly,false);
 }
});
test('eligible index audit distinguishes verified versus blocked research turns, never full market',()=>{
 let p=null;
 for(const cursor of [0,20,40]){
   const count=cursor===40?1:20,response=source({cursor,count});
   const decision={nextCursor:cursor+count===41?0:cursor+count,blockedObservationOnly:false,reason:'VERIFIED_BATCH'};
   const result=advancePublicResearchIndexProgress(p,{response,status:'VALID_NO_TRADE',decision});
   p=result.state;
 }
 assert.equal(p.roundsObserved,1);
 assert.equal(p.roundsEligibleIndexVerified,1);
 assert.equal(p.lastRound.verifiedEligibleIndexes,41);
 assert.equal(p.lastRound.fullMarketConstituentProof,false);
 let blocked=null;
 for(const cursor of [0,20]){
   const response=source({total:40,cursor,count:20,partial:true,data:'partial'});
   const result=advancePublicResearchIndexProgress(blocked,{response,status:'BLOCKED_DATA',
     decision:{nextCursor:cursor===20?0:20,blockedObservationOnly:true,reason:'BLOCKED_RESEARCH_ROTATION_ONLY'}});
   blocked=result.state;
 }
 assert.equal(blocked.roundsObserved,1);
 assert.equal(blocked.roundsEligibleIndexVerified,0);
 assert.equal(blocked.lastRound.blockedEligibleIndexes,40);
 assert.equal(blocked.lastRound.allEligibleIndexPagesVerified,false);
});
test('roster mutation and partial fetch never inherit a previous complete run',()=>{
 const first=source({total:40});
 const prev=advancePublicResearchIndexProgress(null,{response:first,status:'VALID_NO_TRADE',
    decision:{nextCursor:20,blockedObservationOnly:false,reason:'VERIFIED_BATCH'}}).state;
 const changed=source({total:80,cursor:0});
 const result=advancePublicResearchIndexProgress(prev,{response:changed,status:'VALID_NO_TRADE',
    decision:{nextCursor:20,blockedObservationOnly:false,reason:'VERIFIED_BATCH'}});
 assert.equal(result.state.total,80);
 assert.equal(result.state.attempted,20);
 assert.equal(result.state.roundsEligibleIndexVerified,0);
 const fail=advancePublicResearchIndexProgress(result.state,{response:source({total:80,cursor:20}),
    status:'SEARCH_FAILURE',decision:{nextCursor:20,blockedObservationOnly:false,reason:'PROVIDER_FAILURE'}});
 assert.equal(fail.state.attempted,20);
 assert.equal(fail.state.failedRuns,1);
});
