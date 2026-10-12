import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  currentPagePublication,currentPublicV3CycleReady,
} from '../src/public-v3-current-page-gate.mjs';
const CYCLE='11111111-1111-4111-8111-111111111111';
const PRIOR='22222222-2222-4222-8222-222222222222';
const MARKETS={KR:'KR_STOCK',US:'US_STOCK',SPOT:'CRYPTO_SPOT',FUTURES:'CRYPTO_FUTURES'};
const MODES=[['SCALPING_15M','SCALPING','15m'],['SWING_60M','SWING','60m'],
 ['MID_LONG_1D','MID_LONG','1D']];
const PREFIXES=Object.keys(MARKETS);
const SOURCE={KR:'yahoo-public',US:'yahoo-public',SPOT:'upbit-public-candles',
  FUTURES:'bitget-public-candles'};
const ROSTER={KR:'krx-symbol-master',US:'nasdaq-trader-public-directory',
  SPOT:'upbit-public',FUTURES:'bitget-public'};
const SHA='a'.repeat(40);
const laneSpec=(id)=>{
 const parts=id.split('_'),prefix=parts[0];
 const mode=MODES.find(x=>id===prefix+'_'+x[0]);
 assert.ok(MARKETS[prefix]&&mode,id);
 return {market:MARKETS[prefix],prefix,frame:mode[2],strategy:mode[1]};
};
const readyLane=id=>{
 const d=laneSpec(id);
 return {
   laneId:id,sourceCycleId:CYCLE,market:d.market,strategy:d.strategy,
   timeframe:d.frame,universeSource:ROSTER[d.prefix],
   status:'CANDIDATES_AVAILABLE',scannedCards:2,retainedFromBatch:2,
   cursorBefore:10,cursorAfter:15,totalUniverse:200,
   lastGoodPreserved:false,cursorRotatedBlockedOnly:false,
   responseDataState:'complete',universePartial:false,universeStale:false,
   providerErrors:0,timeouts:0,universeProviderErrors:0,
   publicExecutionDiagnostic:{state:'PAGE_EXECUTION_COMPLETE',requested:5,
     started:5,completed:5,partial:false,timedOut:false,providerErrors:0,
     timeouts:0,failuresObserved:0},
 };
};
const receipt=()=>PREFIXES.flatMap(p=>MODES.map(m=>readyLane(p+'_'+m[0])));
function freshRow(symbol,laneId,cursor=10){
 const d=laneSpec(laneId);
 const strategyId='scanner-swing-v1',strategy=strategyId.toUpperCase();
 const direction=d.market==='CRYPTO_FUTURES'?'LONG':'BUY';
 const market=d.market,id=[market,symbol,strategy,d.frame,direction].join('|');
 return {
   id,market,symbol,strategy,timeframe:d.frame,direction,
   state:'CANDIDATE',dataStatus:'READY',quantEligible:true,
   profitEligible:true,riskReady:true,utilityR:0.25,
   utilityMode:'NET_EDGE_ONLY_RISK_SEPARATE',validationTier:'RESEARCH_CANDIDATE',
   leverage:null,evidence:{
     source:'CANONICAL_PROFIT_EVIDENCE_READY',expectedNetEdgeR:0.25,
     expectedNetEdgePercent:1,expectedNetReturnPercent:1,
     riskRewardRatio:2,sampleSize:80,costPolicyId:'cost-v1',
   },
   provenance:{
     laneId,cursor,sourceCycleId:CYCLE,scannerSignalId:'scanner-'+symbol,
     scannerSources:[SOURCE[d.prefix]],
     edgeSource:'CANONICAL_PROFIT_EVIDENCE_READY',
     profitEvidenceStatus:'READY',backtestQualityStatus:'verified',
     costPolicyId:'cost-v1',profitBlockers:[],
     paperIdentity:{
       signalId:'scanner-'+symbol,strategyId,strategyVersion:'v1',
       parameterHash:'parameters-'+symbol,researchCodeSha:SHA,
       market,symbol,timeframe:d.frame,horizon:5,direction,
       costPolicyVersion:'cost-v1',executionAuthority:'NONE',
     },
   },
 };
}
function eventFor(row,patch={}){
 return {
   id:row.id,type:'NEW_CANDIDATE',market:row.market,symbol:row.symbol,
   strategy:row.strategy,timeframe:row.timeframe,direction:row.direction,
   state:row.state,validationTier:row.validationTier,
   utilityR:row.utilityR,utilityMode:row.utilityMode,leverage:row.leverage,...patch,
 };
}
function sample(){
 const verified=freshRow('AAPL','US_SCALPING_15M');
 const older=freshRow('HIST','US_SCALPING_15M',0);
 older.provenance.sourceCycleId=PRIOR;
 const blocked=freshRow('KRONE','KR_SCALPING_15M');
 const wrong=freshRow('BAD','US_SCALPING_15M');
 wrong.provenance.laneId='WRONG_LANE';
 const stale=freshRow('STALE','US_SWING_60M');stale.dataStatus='BLOCKED';
 return {
   rows:[verified,older,blocked,wrong,stale],
   lists:{krBuy:[blocked],usBuy:[verified,older,stale],
     spotBuy:[],futuresLong:[],futuresShort:[]},
   events:[eventFor(verified),eventFor(older),eventFor(blocked),
     eventFor(wrong,{type:'RESCAN_REQUESTED'}),eventFor(verified,{type:'STATE_CHANGED'})],
 };
}
test('only canonical profit-linked current source row survives, not retained or blocked',()=>{
 const s=sample(),lanes=receipt();
 lanes[0]={...lanes[0],status:'BLOCKED_DATA',lastGoodPreserved:true,
   responseDataState:'untrusted'};
 const z=currentPagePublication(s,lanes);
 assert.deepEqual(z.allowedIds,[s.rows[0].id]);
 assert.deepEqual(z.lists.usBuy,[s.rows[0]]);
 assert.equal(z.lists.krBuy.length,0);
 assert.deepEqual(z.events,[s.events[0]]);
 assert.equal(z.fullCoverageProven,false);
 assert.equal(z.executionAuthority,'NONE');
 assert.ok(Object.isFrozen(z.events));
 assert.equal(s.lists.usBuy.length,3,'rolling historical research is retained');
});
test('source completeness, provider identity, epoch and cursor mismatches fail closed',()=>{
 const s=sample();
 for(const mutate of [
   c=>c.pop(),
   c=>c.push(c[0]),
   c=>{c[3].universeSource='bitget-public';},
   c=>{c[3].publicExecutionDiagnostic.completed=4;},
   c=>{c[3].publicExecutionDiagnostic.failuresObserved=1;},
   c=>{c[3].sourceCycleId=PRIOR;},
   c=>{c[3].cursorBefore=0;c[3].cursorAfter=5;},
 ]){
   const lanes=receipt();mutate(lanes);
   const z=currentPagePublication(s,lanes);
   assert.equal(z.events.some(e=>e.id===s.rows[0].id),false,
     'a failed US source must not publish the US candidate');
   assert.equal(z.lists.usBuy.length,0);
   // Other market lanes with fully independent verified receipts may still
   // publish: a partial or failed US page is not a global shutdown.
 }
});
test('missing, partial, replayed or globally blocked source never produces current alerts',()=>{
 const s=sample();
 for(const coverage of [null,{},[],receipt().slice(0,11)]){
   const z=currentPagePublication(s,coverage);
   assert.equal(z.events.length,0);
   assert.ok(Object.values(z.lists).every(rows=>rows.length===0));
 }
 const blocked=receipt();
 blocked[0]={...blocked[0],status:'BLOCKED_DATA',lastGoodPreserved:true,
   responseDataState:'untrusted'};
 const old=s.rows[0];old.provenance.sourceCycleId=PRIOR;
 assert.deepEqual(currentPagePublication(s,blocked).events,[]);
});
test('verified current wrap to zero is a completed source page, not new universe coverage',()=>{
 const s=sample(),lanes=receipt();
 lanes[0].status='BLOCKED_DATA';lanes[0].lastGoodPreserved=true;
 lanes[0].responseDataState='untrusted';
 lanes[3].cursorBefore=195;lanes[3].cursorAfter=0;
 s.rows[0].provenance.cursor=195;
 assert.deepEqual(currentPagePublication(s,lanes).allowedIds,[s.rows[0].id]);
});
test('ready page count only means 12 exact current source pages, not entire market history',()=>{
 const lanes=receipt();
 assert.equal(currentPublicV3CycleReady(lanes),true);
 lanes[3].universeSource='bitget-public';
 assert.equal(currentPublicV3CycleReady(lanes),false);
 const s=sample();
 assert.equal(currentPagePublication(s,lanes).lists.usBuy.length,0);
 const noTrade=receipt();
 noTrade[8]={...noTrade[8],status:'VALID_NO_TRADE',
   scannedCards:0,retainedFromBatch:0};
 assert.equal(currentPublicV3CycleReady(noTrade),true);
 noTrade[8].retainedFromBatch=1;
 assert.equal(currentPublicV3CycleReady(noTrade),false);
});
test('a previously blocked Spot research-only row cannot publish on a forged healthy lane',()=>{
 const row=freshRow('BTC','SPOT_SCALPING_15M');
 row.provenance.blockedPageResearchOnly=true;
 row.provenance.publicationEligible=false;
 const s={rows:[row],lists:{krBuy:[],usBuy:[],spotBuy:[row],
   futuresLong:[],futuresShort:[]},events:[eventFor(row)]};
 const z=currentPagePublication(s,receipt());
 assert.deepEqual(z.allowedIds,[]);
 assert.deepEqual(z.lists.spotBuy,[]);
 assert.deepEqual(z.events,[]);
 const ordinary=freshRow('ETH','SPOT_SCALPING_15M');
 const s2={rows:[ordinary],lists:{...s.lists,spotBuy:[ordinary]},
   events:[eventFor(ordinary)]};
 assert.deepEqual(currentPagePublication(s2,receipt()).allowedIds,[ordinary.id]);
});
test('candidate state cannot spoof canonical economic/OOS/Paper lineage',()=>{
 const source=freshRow('AAPL','US_SCALPING_15M');
 const tryCase=change=>{
   const row=structuredClone(source);
   change(row);
   const s={rows:[row],lists:{krBuy:[],usBuy:[row],
     spotBuy:[],futuresLong:[],futuresShort:[]},
     events:[eventFor(row)]};
   const z=currentPagePublication(s,receipt());
   assert.deepEqual(z.allowedIds,[]);
   assert.deepEqual(z.events,[]);
   assert.equal(z.lists.usBuy.length,0);
 };
 for(const change of [
   x=>{x.quantEligible=false;},x=>{x.profitEligible=false;},
   x=>{x.riskReady=false;},x=>{x.evidence.source='SIMULATED';},
   x=>{x.evidence.expectedNetEdgeR=0;},
   x=>{x.provenance.paperIdentity.costPolicyVersion='other';},
   x=>{x.provenance.paperIdentity.signalId='forged';},
   x=>{x.provenance.paperIdentity.researchCodeSha='bad';},
   x=>{x.provenance.backtestQualityStatus='unverified';},
   x=>{x.provenance.profitBlockers.push('OOS_MISSING');},
   x=>{x.provenance.scannerSources=['upbit-public-candles'];},
   x=>{x.id='US_STOCK|AAPL|UNKNOWN|15m|BUY';},
 ])tryCase(change);
});
test('list copies and events must exactly match canonical row; no cross-market or direction aliasing',()=>{
 const row=freshRow('AAPL','US_SCALPING_15M');
 const e=eventFor(row);
 const initial={rows:[row],lists:{krBuy:[],usBuy:[row],
   spotBuy:[],futuresLong:[],futuresShort:[]},events:[e]};
 const copies=structuredClone(initial);
 // structuredClone preserves aliases between rows and list entries. Replace
 // just the listed copy to model a truly altered serialized-list payload.
 copies.lists.usBuy[0]={...copies.lists.usBuy[0],utilityR:99};
 const z=currentPagePublication(copies,receipt());
 assert.equal(z.lists.usBuy.length,0);
 assert.equal(z.events.length,0);
 const wrongEvent=structuredClone(initial);
 wrongEvent.events[0].direction='SHORT';
 assert.equal(currentPagePublication(wrongEvent,receipt()).events.length,0);
 assert.equal(currentPagePublication(wrongEvent,receipt()).lists.usBuy.length,1);
 const duplicated=structuredClone(initial);
 duplicated.rows.push(structuredClone(row));
 assert.equal(currentPagePublication(duplicated,receipt()).allowedIds.length,0);
});

test('a nominal CANDIDATES_AVAILABLE lane without actual retained page cards never publishes an old row',()=>{
 const original=freshRow('AAPL','US_SCALPING_15M');
 const state={rows:[original],lists:{krBuy:[],usBuy:[original],
   spotBuy:[],futuresLong:[],futuresShort:[]},events:[eventFor(original)]};
 const bad=[
   x=>{x.scannedCards=0;x.retainedFromBatch=0;},
   x=>{x.retainedFromBatch=0;},
   x=>{x.scannedCards=0;},
   x=>{x.strategy='SWING';},
   x=>{x.market='KR_STOCK';},
   x=>{x.timeframe='1D';},
   x=>{x.status='VALID_NO_TRADE';x.scannedCards=0;x.retainedFromBatch=0;},
 ];
 for(const change of bad){
   const lanes=receipt();change(lanes[3]);
   const view=currentPagePublication(state,lanes);
   assert.deepEqual(view.allowedIds,[]);
   assert.deepEqual(view.lists.usBuy,[]);
   assert.deepEqual(view.events,[]);
   assert.equal(currentPublicV3CycleReady(lanes),false);
 }
});
test('fresh verified candidates take the ten published slots after historical research candidates are removed',()=>{
 const old=Array.from({length:11},(_,i)=>{
   const row=freshRow('OLD'+String(i).padStart(2,'0'),'US_SCALPING_15M',0);
   row.provenance.sourceCycleId=PRIOR;
   row.utilityR=100-i;
   return row;
 });
 const fresh=Array.from({length:12},(_,i)=>{
   const row=freshRow('NEW'+String(i).padStart(2,'0'),'US_SCALPING_15M');
   row.utilityR=50-i;
   return row;
 });
 const all=[...old,...fresh]; // all already sorted by descending utility
 const events=fresh.map(row=>eventFor(row));
 const lanes=receipt();
 const us=lanes[3];
 us.scannedCards=12;us.retainedFromBatch=12;us.cursorAfter=30;
 us.publicExecutionDiagnostic={
   ...us.publicExecutionDiagnostic,requested:20,started:20,completed:20,
 };
 const state={rows:all,lists:{krBuy:[],usBuy:all,
   spotBuy:[],futuresLong:[],futuresShort:[]},events};
 const out=currentPagePublication(state,lanes);
 assert.deepEqual(out.lists.usBuy.map(x=>x.symbol),
   fresh.slice(0,10).map(x=>x.symbol));
 assert.equal(out.lists.usBuy.length,10);
 assert.equal(out.events.length,10,'an eleventh candidate cannot bypass the list cap as an alert');
 assert.ok(out.events.every(e=>out.lists.usBuy.some(x=>x.id===e.id)));
 assert.equal(out.allowedIds.length,12,
   'research audit can still count all source-qualified rows, beyond display cap');
 const previouslyTruncated={...state,lists:{...state.lists,usBuy:all.slice(0,10)}};
 assert.equal(currentPagePublication(previouslyTruncated,lanes).lists.usBuy.length,0,
   'old top-ten selection before source proof makes this new chance invisible');
});
test('producer passes the full in-memory research pool before current-page top-ten truncation',()=>{
 const source=readFileSync(new URL('../scripts/run-public-scanner-cycle.ts',import.meta.url),'utf8');
 assert.match(source,/maxCandidatesPerList:Math\.max\(1,inputs\.length\)/u,
   'do not rank out real current candidates behind stale retained rows');
 assert.match(source,/currentPagePublication\(baseSnapshot, coverage\)/u);
 assert.match(source,/lists: publication\.lists/u,
   'only post-source-proof lists may persist');
});
