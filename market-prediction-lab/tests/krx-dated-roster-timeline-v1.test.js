import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {auditKrxDatedRosterTimelineV1 as audit}
  from "../src/krx-dated-roster-timeline-v1.js";
const D=["20250203","20250204","20250205"];
const row=(marketBoard,isin,shortCode)=>({
  marketBoard,isin,shortCode,listedYmd:"20200101",
  marketType:marketBoard,securityGroup:"STOCK",
});
const SAM=row("KOSPI","KR7005930003","005930");
const NAV=row("KOSDAQ","KR7035420009","035420");
const KON=row("KONEX","KR7278990005","278990");
const NEW=row("KOSDAQ","KR7068270008","068270");
const members=[SAM,NAV,KON];
function snapshot(dateYmd,symbols=members) {
 const sorted=[...symbols].sort((a,b)=>a.marketBoard.localeCompare(b.marketBoard)
   ||a.shortCode.localeCompare(b.shortCode));
 const markets={KOSPI:0,KOSDAQ:0,KONEX:0};
 for(const r of sorted)markets[r.marketBoard]++;
 const sourceSha256=createHash("sha256").update(JSON.stringify({
   dateYmd,markets,symbols:sorted,
 })).digest("hex");
 return {
   schemaVersion:"krx-public-dated-security-roster-v1",
   status:"OBSERVED_KRX_DAY_ROSTER_ONLY",
   source:"KRX_OPENAPI_ISSUE_BASE_INFO",
   dateYmd,markets,dateScopedSymbolCount:sorted.length,
   symbols:sorted,sourceSha256,
   executionAuthority:"NONE",realOrders:false,profitabilityProven:false,
   delistedHistoryVerified:false,entireDatePITUniverseProven:false,
   fullMarketOpportunityDenominatorVerified:false,trueMarketWideRecall:null,
 };
}
function go(dates=D,records=dates.map(d=>snapshot(d))){
 return audit({requestedTradingDates:dates,datedReceipts:records});
}
test("no authenticated KRX dates gives NULL market census, not zero",()=>{
 const r=go(D,[]);
 assert.equal(r.status,"PARTIAL_REQUESTED_DATE_SNAPSHOTS");
 assert.deepEqual(r.missingRequestedDates,D);
 assert.equal(r.observedDateCount,0);
 assert.equal(r.lastObservedDateCount,null);
 assert.equal(r.confirmedDelistingCount,null);
 assert.equal(r.trueMarketWideRecall,null);
 assert.equal(r.historicalFullMarketPITVerified,false);
 assert.equal(r.executionAuthority,"NONE");
});
test("complete requested dates are NOT proof of full 3-year PIT history",()=>{
 const r=go(D.slice(0,2));
 assert.equal(r.status,"OBSERVED_REQUESTED_DATES_ONLY");
 assert.equal(r.observedDateCount,2);
 assert.equal(r.lastObservedDateCount,3);
 assert.equal(r.transitions.length,0);
 assert.equal(r.confirmedDelistingCount,null);
 assert.equal(r.fullMarketOpportunityDenominatorVerified,false);
 assert.equal(r.independentlyVerifiedTradingCalendar,false);
});
test("disappearance means NOT RETURNED, and subsequent return is REAPPEARED",()=>{
 const mid=[SAM,NEW,KON];
 const r=go(D,[snapshot(D[0]),snapshot(D[1],mid),snapshot(D[2])]);
 assert.equal(r.status,"OBSERVED_REQUESTED_DATES_ONLY");
 assert.equal(r.transitionCounts.NOT_RETURNED_NEXT_REQUESTED_DATE,2);
 assert.equal(r.transitionCounts.FIRST_SEEN_IN_REQUESTED_SERIES,1);
 assert.equal(r.transitionCounts.REAPPEARED_AFTER_DATED_ABSENCE,1);
 assert.equal(r.observedDisappearancesNotDelistings,2);
 assert.ok(r.transitions.filter(e=>e.type==="NOT_RETURNED_NEXT_REQUESTED_DATE")
   .every(e=>e.confirmedDelisted===false&&e.absenceReason==="UNKNOWN"));
 assert.equal(r.confirmedDelistingCount,null);
});
test("a missing requested date blocks cross-gap delisting inference",()=>{
 const r=go(D,[snapshot(D[0]),snapshot(D[2],[SAM,NEW,KON])]);
 assert.equal(r.status,"PARTIAL_REQUESTED_DATE_SNAPSHOTS");
 assert.deepEqual(r.missingRequestedDates,[D[1]]);
 assert.equal(r.transitions.length,0);
 assert.equal(r.requestedSnapshotCoverage,2/3);
 assert.equal(r.lastObservedDateCount,3);
 assert.equal(r.trueMarketWideRecall,null);
});
test("same-ISIN board change is not a confirmed removal",()=>{
 const moved={...NAV,marketBoard:"KOSPI"};
 const r=go(D.slice(0,2),[snapshot(D[0]),snapshot(D[1],[SAM,moved,KON,NEW])]);
 assert.equal(r.transitionCounts.SAME_ISIN_MARKET_BOARD_CHANGE,1);
 assert.equal(r.transitions.find(e=>e.type==="SAME_ISIN_MARKET_BOARD_CHANGE")
   .officiallyApprovedTransfer,null);
});
test("same-ISIN shortcode change is distinct from a new company",()=>{
 const changed={...NAV,shortCode:"035421"};
 const r=go(D.slice(0,2),[snapshot(D[0]),snapshot(D[1],[SAM,changed,KON])]);
 assert.equal(r.transitionCounts.SAME_ISIN_SHORT_CODE_CHANGE,1);
 assert.equal(r.transitionCounts.FIRST_SEEN_IN_REQUESTED_SERIES,undefined);
});
test("reused six-digit short code with a new ISIN requires review",()=>{
 const recycled={...NEW,shortCode:"035420"};
 const r=go(D.slice(0,2),[snapshot(D[0]),snapshot(D[1],[SAM,recycled,KON])]);
 assert.equal(r.transitionCounts.SHORT_CODE_REUSED_DIFFERENT_ISIN,1);
 assert.equal(r.transitions.find(e=>e.type==="SHORT_CODE_REUSED_DIFFERENT_ISIN")
   .independentIdentityResolutionRequired,true);
});
test("tampered source receipt hash stops the entire transition report",()=>{
 const s=snapshot(D[0]);
 s.symbols[0].shortCode="999999";
 const r=go(D.slice(0,2),[s,snapshot(D[1])]);
 assert.equal(r.status,"BLOCKED_DATA");
 assert.equal(r.reason,"KRX_DATED_SOURCE_INTEGRITY_FAILED");
 assert.equal(r.transitions,null);
});
test("missing KOSDAQ board data cannot be treated as complete",()=>{
 const r=go(D.slice(0,2),[snapshot(D[0],[SAM,KON]),snapshot(D[1])]);
 assert.equal(r.status,"BLOCKED_DATA");
 assert.equal(r.confirmedDelistingCount,null);
});
test("future issue-listing date on historical day fails closed",()=>{
 const s=snapshot(D[0],[SAM,{...NAV,listedYmd:"20270203"},KON]);
 assert.equal(go(D.slice(0,2),[s,snapshot(D[1])]).status,"BLOCKED_DATA");
});
test("duplicate supplied date cannot double-count membership",()=>{
 const r=go(D.slice(0,2),[snapshot(D[0]),snapshot(D[0])]);
 assert.equal(r.reason,"DUPLICATE_OR_UNREQUESTED_DATED_SNAPSHOT");
});
test("invalid date ordering, pre-KONEX date, oversize request fail closed",()=>{
 assert.throws(()=>go(["20121205","20121206"],[]),/REQUESTED_TRADING_DATE_SET_INVALID/);
 assert.throws(()=>go([...D].reverse(),[]),/REQUESTED_TRADING_DATE_SET_INVALID/);
 assert.throws(()=>go(Array(33).fill("20250203"),[]),/REQUESTED_TRADING_DATE_SET_INVALID/);
});
test("fake profitable or live receipt is rejected",()=>{
 const s=snapshot(D[0]);s.realOrders=true;
 const r=go(D.slice(0,2),[s,snapshot(D[1])]);
 assert.equal(r.reason,"KRX_DATED_SOURCE_INTEGRITY_FAILED");
 assert.equal(r.executionAuthority,"NONE");
 assert.equal(r.profitabilityProven,false);
});
