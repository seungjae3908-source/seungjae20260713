import test from 'node:test';
import assert from 'node:assert/strict';
import {currentPagePublication,currentPublicV3CycleReady} from '../src/public-v3-current-page-gate.mjs';

const markets=['KR','US','SPOT','FUTURES'];
const modes=['SCALPING_15M','SWING_60M','MID_LONG_1D'];
const allLanes=markets.flatMap(m=>modes.map(mode=>m+'_'+mode));
const CYCLE_ID='11111111-1111-4111-8111-111111111111';
const PRIOR_CYCLE_ID='22222222-2222-4222-8222-222222222222';
const readyLane=id=>({
  laneId:id,sourceCycleId:CYCLE_ID,status:'CANDIDATES_AVAILABLE',
  universeSource:id.startsWith('KR_')?'krx-symbol-master':
    id.startsWith('US_')?'nasdaq-trader-public-directory':
      id.startsWith('SPOT_')?'upbit-public':'bitget-public',
  scannedCards:2,retainedFromBatch:2,
  cursorBefore:10,cursorAfter:15,totalUniverse:200,
  lastGoodPreserved:false,cursorRotatedBlockedOnly:false,
  responseDataState:'complete',universePartial:false,universeStale:false,
  providerErrors:0,timeouts:0,universeProviderErrors:0,
  publicExecutionDiagnostic:{
    state:'PAGE_EXECUTION_COMPLETE',requested:5,started:5,completed:5,
    partial:false,timedOut:false,providerErrors:0,timeouts:0,
    failuresObserved:0,
  },
});
const receipt=()=>allLanes.map(readyLane);
const freshRow=(id,lane,at=10,overrides={})=>({
  id,state:'CANDIDATE',dataStatus:'READY',
  provenance:{laneId:lane,cursor:at,sourceCycleId:CYCLE_ID},...overrides,
});
const input=()=>{
  const verified=freshRow('verified','US_SCALPING_15M');
  const older=freshRow('historical','US_SCALPING_15M',0,{provenance:{laneId:'US_SCALPING_15M',cursor:0,sourceCycleId:PRIOR_CYCLE_ID}});
  const blocked=freshRow('blocked','KR_SCALPING_15M');
  const wrong=freshRow('unknown','WRONG_LANE');
  const stale=freshRow('stale-row','US_SWING_60M',10,{dataStatus:'BLOCKED'});
  const rows=[verified,older,blocked,wrong,stale];
  return {
    rows,lists:{
      krBuy:[blocked],usBuy:[verified,older,stale],
      spotBuy:[],futuresLong:[],futuresShort:[],
    },
    events:[
      {id:'verified',type:'NEW_CANDIDATE'},
      {id:'historical',type:'NEW_CANDIDATE'},
      {id:'blocked',type:'NEW_CANDIDATE'},
      {id:'unknown',type:'RESCAN_REQUESTED'},
      {id:'verified',type:'STATE_CHANGED'},
    ],
  };
};
test('new signals only from the exactly verified current batch, never retained',()=>{
  const coverage=receipt(),snapshot=input();
  coverage[0]={...coverage[0],status:'BLOCKED_DATA',
    lastGoodPreserved:true,responseDataState:'untrusted'};
  const output=currentPagePublication(snapshot,coverage);
  assert.deepEqual(output.allowedIds,['verified']);
  assert.deepEqual(output.lists.usBuy,[snapshot.rows[0]]);
  assert.equal(output.lists.krBuy.length,0);
  assert.deepEqual(output.events,[snapshot.events[0]]);
  assert.equal(output.fullCoverageProven,false);
  assert.equal(output.executionAuthority,'NONE');
  assert.equal(snapshot.lists.usBuy.length,3,'history is still available to research');
  assert.ok(Object.isFrozen(output.events));
});
test('completeness, source replay and item failures fail closed',()=>{
  const snapshot=input(),variants=[
    a=>a.pop(),
    a=>a.push(a[0]),
    a=>{a[4]={...a[4],laneId:'UNKNOWN'};},
    a=>{a[3]={...a[3],publicExecutionDiagnostic:{
      ...a[3].publicExecutionDiagnostic,started:4}};},
    a=>{a[3]={...a[3],publicExecutionDiagnostic:{
      ...a[3].publicExecutionDiagnostic,failuresObserved:1}};},
  ];
  for(const change of variants){
    const coverage=receipt();change(coverage);
    const out=currentPagePublication(snapshot,coverage);
    if(coverage.length!==12||new Set(coverage.map(x=>x.laneId)).size!==12
      ||coverage.some(x=>!allLanes.includes(x.laneId))){
      assert.deepEqual(out.allowedIds,[]);
      assert.deepEqual(out.events,[]);
    }
  }
  const bad=receipt();
  bad[0]={...bad[0],status:'BLOCKED_DATA',lastGoodPreserved:true,responseDataState:'untrusted'};
  bad[3]={...bad[3],publicExecutionDiagnostic:{
    ...bad[3].publicExecutionDiagnostic,completed:4}};
  const checked=currentPagePublication(snapshot,bad);
  assert.equal(checked.lists.usBuy.length,0);
  assert.equal(checked.events.length,0);
});
test('no stale portfolio or old candidate can be presented when source absent',()=>{
  const source=input();
  for(const item of [null,{},[],receipt().slice(0,11)]){
    const out=currentPagePublication(source,item);
    assert.deepEqual(out.events,[]);
    assert.ok(Object.values(out.lists).every(rows=>rows.length===0));
  }
  const last=receipt();
  last[0]={...last[0],status:'BLOCKED_DATA',lastGoodPreserved:true,responseDataState:'untrusted'};
  last[3].cursorBefore=0;last[3].cursorAfter=5;
  assert.deepEqual(currentPagePublication(source,last).events,[]);
});
test('valid final wrap to zero remains a verifiable completed source page',()=>{
  const snapshot=input(),lanes=receipt();
  lanes[0]={...lanes[0],status:'BLOCKED_DATA',lastGoodPreserved:true,responseDataState:'untrusted'};
  lanes[3].cursorBefore=195;
  lanes[3].cursorAfter=0;
  snapshot.rows[0].provenance.cursor=195;
  const result=currentPagePublication(snapshot,lanes);
  assert.deepEqual(result.allowedIds,['verified']);
});

test('source freshness requires exactly 12 complete pages and correct market roster',()=>{
  const lanes=receipt();
  assert.equal(currentPublicV3CycleReady(lanes),true);
  const variant=receipt();
  variant[3]={...variant[3],universeSource:'bitget-public'};
  assert.equal(currentPublicV3CycleReady(variant),false);
  assert.equal(currentPagePublication(input(),variant).events.some(e=>e.id==='verified'),false,
    'a wrong US provider must not publish the US candidate; healthy other markets may remain');
  const partial=receipt();partial[0].universePartial=true;
  assert.equal(currentPublicV3CycleReady(partial),false);
  const blocked=receipt();blocked[2].status='BLOCKED_DATA';
  assert.equal(currentPublicV3CycleReady(blocked),false);
  const noTrade=receipt();
  noTrade[8]={...noTrade[8],status:'VALID_NO_TRADE',
    scannedCards:0,retainedFromBatch:0};
  assert.equal(currentPublicV3CycleReady(noTrade),true);
  noTrade[8].retainedFromBatch=1;
  assert.equal(currentPublicV3CycleReady(noTrade),false);
  assert.equal(currentPublicV3CycleReady(receipt().slice(1)),false);
});

test('a reused cursor from an older cycle never publishes historical alerts',()=>{
  const shot=input(),lanes=receipt();
  lanes[0]={...lanes[0],status:'BLOCKED_DATA',lastGoodPreserved:true,responseDataState:'untrusted'};
  shot.rows[0].provenance.sourceCycleId=PRIOR_CYCLE_ID;
  assert.deepEqual(currentPagePublication(shot,lanes).events,[]);
  const forged=receipt();
  forged[3]={...forged[3],sourceCycleId:PRIOR_CYCLE_ID};
  assert.equal(currentPublicV3CycleReady(forged),false);
  assert.deepEqual(currentPagePublication(input(),forged).events,[]);
});


test('Spot trusted research-only rows cannot publish even if a later lane receipt appears green',()=>{
  const laneId='SPOT_SCALPING_15M',source=freshRow('SPOT_RESEARCH_ONLY',laneId,10,{
    provenance:{laneId,cursor:10,sourceCycleId:CYCLE_ID,
      blockedPageResearchOnly:true,publicationEligible:false,
      economicAuthority:'NONE'},
  });
  const snapshot={rows:[source],lists:{
    krBuy:[],usBuy:[],spotBuy:[source],futuresLong:[],futuresShort:[],
  },events:[{id:source.id,type:'NEW_CANDIDATE'}]};
  const lanes=receipt(); // intentionally forged healthy current lane
  const view=currentPagePublication(snapshot,lanes);
  assert.deepEqual(view.allowedIds,[]);
  assert.deepEqual(view.lists.spotBuy,[]);
  assert.deepEqual(view.events,[]);
  // Without the research-only mark, canonical pages retain existing policy.
  const ordinary=freshRow('ORDINARY',laneId);
  const normal=currentPagePublication({
    rows:[ordinary],lists:{...snapshot.lists,spotBuy:[ordinary]},
    events:[{id:ordinary.id,type:'NEW_CANDIDATE'}],
  },lanes);
  assert.deepEqual(normal.allowedIds,['ORDINARY']);
  assert.equal(normal.events.length,1);
});
