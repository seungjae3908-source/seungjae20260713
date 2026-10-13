import test from "node:test";
import assert from "node:assert/strict";
import {digestPITMembershipRowsV1} from "../src/historical-pit-venue-universe-gate-v1.js";
import {planFourMarketPITReplayWorkV1 as plan} from
  "../src/four-market-pit-replay-work-queue-v1.js";

const D=Date.parse("2026-09-18T00:00:00Z"),DAY=86_400_000;
const VENUE={
 KR_STOCK:"KRX",US_STOCK:"US_SIP",
 CRYPTO_SPOT:"UPBIT_KRW",CRYPTO_FUTURES:"BITGET_USDT_FUTURES",
};
function fixture(market,count=3){
 const memberships=Array.from({length:count},(_,i)=>({
   symbol:market==="KR_STOCK"?String(i+1).padStart(6,"0")
     :market==="US_STOCK"?"US"+String(i+1).padStart(5,"0")
       :market==="CRYPTO_SPOT"?"KRW-ALT"+String(i+1)
         :"ALT"+String(i+1)+"USDT",
   listedAtMs:D-150*DAY,removedAtMs:null,halts:[],
   sourceId:"TEST_FULL_PIT_SOURCE",evidenceSha256:"a".repeat(64),
 }));
 memberships.push({symbol:"DELISTED",listedAtMs:D-300*DAY,
   removedAtMs:D-100*DAY,halts:[],
   sourceId:"TEST_FULL_PIT_SOURCE",evidenceSha256:"a".repeat(64)});
 return {
   schemaVersion:"historical-venue-pit-roster-v1",
   sourceClass:"TEST_FIXTURE",testOnly:true,
   market,venue:VENUE[market],
   coverageStartMs:D-400*DAY,coverageEndMs:D+60*DAY,
   retrievedAtMs:D+61*DAY,sourceId:"TEST_FULL_PIT_SOURCE",
   allListedAndRemovedAttested:true,suspensionsAttested:true,
   relistedIdentifiersResolved:true,
   memberships,rawMembershipDigestSha256:digestPITMembershipRowsV1(memberships),
 };
}
test("4 markets page every archived historical PIT name and preserve full source-only blockers",()=>{
 for(const market of Object.keys(VENUE)){
   const stock=market.endsWith("STOCK"),m=fixture(market);
   const result=plan({
     market,manifest:m,
     researchWindow:{startDate:"2026-09-18",endDate:"2026-09-19"},
     ...(stock?{stockTradingDates:[
       "2015-01-05","2026-09-18","2028-01-03",
     ]}:{}),
   });
   assert.equal(result.status,"SOURCE_ONLY_PIT_WORK_PAGINATED",market);
   assert.equal(result.historicRosterMemberCount,4);
   assert.equal(result.requestedTradingDates,stock?1:2);
   assert.equal(result.historicRosterActiveMemberDaysSelfAttested,stock?3:6);
   assert.equal(result.candidateTaskCount,stock?3:6);
   assert.equal(result.nextMemberOffset,null);
   assert.equal(result.sourceOnlyPlanning,true);
   assert.equal(result.fixtureOnly,true);
   assert.equal(result.actualMarketWideOpportunityCount,null);
   assert.equal(result.trueMarketWideRecall,null);
   assert.equal(result.fullMarketOpportunityDenominatorVerified,false);
   assert.equal(result.profitabilityProven,false);
   assert.equal(result.paperAdmissionAllowed,false);
   assert.equal(result.executionAuthority,"NONE");
   assert.equal(result.providerGETCount,0);
 }
});
test("5,140 US active symbols paginate in 20-member batches with no six-symbol cap",()=>{
 const market="US_STOCK",m=fixture(market,5140);
 const opts={market,manifest:m,
   researchWindow:{startDate:"2026-09-18",endDate:"2026-09-18"},
   stockTradingDates:["2015-01-05","2026-09-18","2028-01-03"],
   memberPageSize:20};
 const first=plan(opts);
 assert.equal(first.historicRosterMemberCount,5141);
 assert.equal(first.historicRosterActiveMemberDaysSelfAttested,5140);
 assert.equal(first.selectedPageMemberCount,20);
 assert.equal(first.nextMemberOffset,20);
 assert.equal(first.nextCursorDate,"2026-09-18");
 assert.ok(first.candidateTaskCount<=20);
 const edge=plan({...opts,memberOffset:5120});
 assert.equal(edge.selectedPageMemberCount,20);
 assert.equal(edge.nextMemberOffset,5140);
 const last=plan({...opts,memberOffset:5140});
 assert.equal(last.selectedPageMemberCount,1);
 assert.equal(last.nextMemberOffset,null);
 assert.equal(last.nextCursorDate,null);
 assert.equal(last.actualMarketWideOpportunityCount,null);
 assert.equal(last.profitabilityProven,false);
});
test("10-year selected range advances in <=31-day chunks and retains selected roster identity",()=>{
 const market="CRYPTO_SPOT",m=fixture(market);
 const cfg={market,manifest:m,
   researchWindow:{startDate:"2016-01-01",endDate:"2025-12-31"},
   chunkCalendarDays:31};
 const a=plan(cfg);
 // Fixture archive does not cover 2016: do not infer zero source days.
 assert.equal(a.status,"BLOCKED_DATA");
 assert.equal(a.plannedMemberDays,null);
 assert.equal(a.actualMarketWideOpportunityCount,null);
});
test("source absence or conflicting calendar never becomes profitable candidate",()=>{
 const market="KR_STOCK",m=fixture(market);
 const opts={market,manifest:m,
   researchWindow:{startDate:"2026-09-18",endDate:"2026-09-21"}};
 assert.throws(()=>plan(opts),/PIT_REPLAY_EXCHANGE_DATES_MISSING_OR_INVALID/);
 const empty=plan({...opts,stockTradingDates:[]});
 assert.equal(empty.status,"BLOCKED_DATA");
 assert.equal(empty.actualFillCount,null);
 assert.throws(()=>plan({...opts,stockTradingDates:[
   "2026-09-21","2026-09-18"]}),
   /PIT_REPLAY_EXCHANGE_DATES_DUPLICATED_OR_UNSORTED/);
 const broken={...m,rawMembershipDigestSha256:"f".repeat(64)};
 assert.throws(()=>plan({...opts,stockTradingDates:["2026-09-18"],
   manifest:broken}),/PIT_REPLAY_HISTORIC_ROSTER_INVALID/);
});
test("historic relisting without security identity is blocked, not silently deduplicated",()=>{
 const market="CRYPTO_FUTURES",m=fixture(market);
 const reuse={...m,memberships:[...m.memberships,m.memberships[0]]};
 reuse.rawMembershipDigestSha256=digestPITMembershipRowsV1(reuse.memberships);
 const r=plan({market,manifest:reuse,
   researchWindow:{startDate:"2026-09-18",endDate:"2026-09-18"}});
 assert.equal(r.status,"BLOCKED_DATA");
 assert.equal(r.reason,"PIT_TICKER_REUSE_UNRESOLVED_STABLE_ID");
 assert.equal(r.plannedMemberDays,null);
 assert.equal(r.actualMarketWideOpportunityCount,null);
});
test("member-page size and cursor cannot bypass resource safety",()=>{
 const market="US_STOCK",m=fixture(market);
 const opt={market,manifest:m,stockTradingDates:["2026-09-18"],
   researchWindow:{startDate:"2026-09-18",endDate:"2026-09-18"}};
 assert.throws(()=>plan({...opt,memberPageSize:21}),/PIT_REPLAY_PLANNER_SCOPE_INVALID/);
 assert.throws(()=>plan({...opt,chunkCalendarDays:32}),/PIT_REPLAY_PLANNER_SCOPE_INVALID/);
 assert.throws(()=>plan({...opt,memberOffset:100}),
   /PIT_REPLAY_MEMBER_CURSOR_OUTSIDE_ROSTER/);
 assert.throws(()=>plan({...opt,cursorDate:"2026-09-17"}),
   /PIT_REPLAY_CURSOR_OUTSIDE_SELECTED_WINDOW/);
});
