import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyPublicTwoCycleContinuity} from '../src/public-cycle-continuity.mjs';
const HEAD='a'.repeat(40),start=Date.parse('2026-10-11T02:00:00Z');
const markets=['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES'];
const strategies=['SCALPING','SWING','MID_LONG'];
function fixture(offset=0) {
 const lanes=markets.flatMap(market=>strategies.map((strategy,i)=>{
  const id=market+'_'+strategy+'_1D';
  const before=offset===0?0:20;
  return {laneId:id,market,strategy,timeframe:'1D',
    cursorBefore:before,cursorAfter:before+20,
    status:market==='KR_STOCK'?'BLOCKED_DATA':'VALID_NO_TRADE',
    cursorRotatedBlockedOnly:market==='KR_STOCK',
    providerErrors:0,timeouts:0,rosterVerified:true};
 }));
 return {
  snapshot:{serviceSha:HEAD,publicDataOnly:true,
    safety:{executionAuthority:'NONE'},profile:{surface:'MEMBER_UI'},
    generatedAt:new Date(start+offset*1000).toISOString(),coverage:lanes},
  state:{serviceSha:HEAD,profileMode:'MEMBER_UI',
    cursors:Object.fromEntries(lanes.map(l=>[l.laneId,l.cursorAfter]))},
 };
}
test('two real public-source cycles have same lane identities and exact carried cursor without claiming 24h',()=>{
 const first=fixture(),second=fixture(20);
 const v=verifyPublicTwoCycleContinuity({
  firstSnapshot:first.snapshot,firstState:first.state,
  secondSnapshot:second.snapshot,secondState:second.state,
  head:HEAD,
 });
 assert.equal(v.lanes.length,12);
 assert.equal(v.markets.KR_STOCK.blocked,3);
 assert.equal(v.markets.CRYPTO_FUTURES.advanced,3);
 assert.equal(v.exactCursorContinuationVerified,true);
 assert.equal(v.realContinuous24hProven,false);
 assert.equal(v.completeSourceIndexAcrossMarketsProven,false);
 assert.equal(v.economicalOosPassProven,false);
 assert.equal(v.executionAuthority,'NONE');
 assert.equal(v.ordersSent,false);
});
test('cursor skip, state mismatch, fake candidate on blocked page and network skip fail closed',()=>{
 const f=fixture(),s=fixture(20);
 s.snapshot.coverage[0].cursorBefore=21;
 assert.throws(()=>verifyPublicTwoCycleContinuity({firstSnapshot:f.snapshot,
  firstState:f.state,secondSnapshot:s.snapshot,secondState:s.state,head:HEAD}),/CURSOR_MISMATCH/);
 s.snapshot.coverage[0].cursorBefore=20;
 s.state.cursors[s.snapshot.coverage[0].laneId]=70;
 assert.throws(()=>verifyPublicTwoCycleContinuity({firstSnapshot:f.snapshot,
  firstState:f.state,secondSnapshot:s.snapshot,secondState:s.state,head:HEAD}),/LANE_OR_STATE_INVALID/);
 s.state.cursors[s.snapshot.coverage[0].laneId]=40;
 s.snapshot.coverage[0].status='CANDIDATES_AVAILABLE';
 assert.throws(()=>verifyPublicTwoCycleContinuity({firstSnapshot:f.snapshot,
  firstState:f.state,secondSnapshot:s.snapshot,secondState:s.state,head:HEAD}),/CANDIDATE_ON_BLOCKED_PAGE/);
 s.snapshot.coverage[0].status='BLOCKED_DATA';
 s.snapshot.coverage[0].providerErrors=1;
 assert.throws(()=>verifyPublicTwoCycleContinuity({firstSnapshot:f.snapshot,
  firstState:f.state,secondSnapshot:s.snapshot,secondState:s.state,head:HEAD}),/NETWORK_FAILURE_SKIPPED/);
});
test('roster digest reset to index zero is observed as reset, not as a full market scan',()=>{
 const f=fixture(),s=fixture(20);
 s.snapshot.coverage[0].status='SEARCH_FAILURE';
 s.snapshot.coverage[0].error='ROSTER_DIGEST_CHANGED_RESET';
 s.snapshot.coverage[0].cursorAfter=0;
 s.state.cursors[s.snapshot.coverage[0].laneId]=0;
 const v=verifyPublicTwoCycleContinuity({firstSnapshot:f.snapshot,
  firstState:f.state,secondSnapshot:s.snapshot,secondState:s.state,head:HEAD});
 assert.equal(v.markets.KR_STOCK.reset,1);
 assert.equal(v.completeSourceIndexAcrossMarketsProven,false);
});
test('wrong head, different timeframes, live authority and out-of-order observations are refused',()=>{
 const f=fixture(),s=fixture(20);
 s.snapshot.serviceSha='b'.repeat(40);
 assert.throws(()=>verifyPublicTwoCycleContinuity({firstSnapshot:f.snapshot,
  firstState:f.state,secondSnapshot:s.snapshot,secondState:s.state,head:HEAD}),/UNTRUSTED_SNAPSHOT/);
 s.snapshot.serviceSha=HEAD;
 s.snapshot.safety.executionAuthority='LIVE';
 assert.throws(()=>verifyPublicTwoCycleContinuity({firstSnapshot:f.snapshot,
  firstState:f.state,secondSnapshot:s.snapshot,secondState:s.state,head:HEAD}),/UNTRUSTED_SNAPSHOT/);
 s.snapshot.safety.executionAuthority='NONE';
 s.snapshot.coverage[0].timeframe='5m';
 assert.throws(()=>verifyPublicTwoCycleContinuity({firstSnapshot:f.snapshot,
  firstState:f.state,secondSnapshot:s.snapshot,secondState:s.state,head:HEAD}),/CURSOR_MISMATCH/);
 s.snapshot.coverage[0].timeframe='1D';
 s.snapshot.generatedAt=new Date(start-1000).toISOString();
 assert.throws(()=>verifyPublicTwoCycleContinuity({firstSnapshot:f.snapshot,
  firstState:f.state,secondSnapshot:s.snapshot,secondState:s.state,head:HEAD}),/CLOCK_OR_DELAY/);
});
