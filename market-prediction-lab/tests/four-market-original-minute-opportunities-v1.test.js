import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {persistResearchMinuteSessionV1} from "../src/research-minute-archive-v1.js";
import {digestPITMembershipRowsV1} from "../src/historical-pit-venue-universe-gate-v1.js";
import {auditFourMarketOriginalMinuteOpportunityV1 as audit}
  from "../src/four-market-original-minute-opportunities-v1.js";

const D=Date.parse("2026-09-18T00:00:00Z"),MIN=60_000,DAY=86_400_000;
const POLICY={
 KR_STOCK:{venue:"KRX",symbol:"005930",zone:"Asia/Seoul",
   start:D,minutes:120,kind:"REGULAR"},
 US_STOCK:{venue:"US_SIP",symbol:"AAPL",zone:"America/New_York",
   start:Date.parse("2026-09-18T13:30:00Z"),minutes:120,kind:"REGULAR"},
 CRYPTO_SPOT:{venue:"UPBIT_KRW",symbol:"KRW-BTC",zone:"UTC",
   start:D,minutes:1440,kind:"UTC_24H"},
 CRYPTO_FUTURES:{venue:"BITGET_USDT_FUTURES",symbol:"BTCUSDT",zone:"UTC",
   start:D,minutes:1440,kind:"UTC_24H"},
};
const sha=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
function source(market,side="LONG",partial=false){
 const p=POLICY[market],sourceId="TEST_ONLY_MINUTE_PRICE_EVENT";
 const minuteBars=Array.from({length:p.minutes},(_,i)=>{
   const close=i===80?(side==="LONG"?111:89):100;
   const open=100;
   return {market,venue:p.venue,symbol:p.symbol,sourceId,
     timestampMs:p.start+i*MIN,availableAtMs:p.start+(i+1)*MIN,
     open,close,high:Math.max(open,close)+0.5,
     low:Math.min(open,close)-0.5,volume:10};
 });
 if(partial)minuteBars.splice(25,1);
 const memberships=[
   {symbol:p.symbol,listedAtMs:D-180*DAY,removedAtMs:null,
     halts:[],sourceId:"TEST_HISTORIC_PIT",evidenceSha256:"a".repeat(64)},
   {symbol:"DELISTED",listedAtMs:D-300*DAY,removedAtMs:D-150*DAY,
     halts:[],sourceId:"TEST_HISTORIC_PIT",evidenceSha256:"a".repeat(64)},
 ];
 const manifest={schemaVersion:"historical-venue-pit-roster-v1",
   market,venue:p.venue,sourceClass:"TEST_FIXTURE",testOnly:true,
   coverageStartMs:D-400*DAY,coverageEndMs:D+30*DAY,
   retrievedAtMs:D+31*DAY,sourceId:"TEST_HISTORIC_PIT",
   allListedAndRemovedAttested:true,suspensionsAttested:true,
   relistedIdentifiersResolved:true,memberships,
   rawMembershipDigestSha256:digestPITMembershipRowsV1(memberships)};
 const original={market,venue:p.venue,symbol:p.symbol,sourceId,
   session:{startMs:p.start,endMs:p.start+p.minutes*MIN,
     kind:p.kind,timeZone:p.zone,calendarSourceId:"TEST_SESSION_ONLY"},
   minuteBars,sourceMinuteRowsSha256:sha(minuteBars),
   asOfMs:p.start+p.minutes*MIN};
 const opts=root=>({root,market,symbol:p.symbol,day:"2026-09-18",
   sessionStartMs:p.start,sessionEndMs:p.start+p.minutes*MIN,
   sessionKind:p.kind,sessionTimeZone:p.zone,
   manifest,side,thresholdPercents:[3,5,10],asOfMs:D+40*DAY});
 return {original,opts};
}
test("4 venues label the earliest minute containing a retrospective +3/+5/+10% move",async()=>{
 const root=mkdtempSync(join(tmpdir(),"pit-price-events-"));
 try{
   for(const market of Object.keys(POLICY)){
     const {original,opts}=source(market);
     await persistResearchMinuteSessionV1({root,source:original});
     const r=await audit(opts(root));
     assert.equal(r.status,"SOURCE_ONLY_OBSERVED_PRICE_EVENTS",market);
     assert.equal(r.retrospectiveEventCount,3,market);
     assert.equal(r.observedPriceEvents.length,3,market);
     assert.equal(r.observedPriceEvents[0].thresholdPercent,3,market);
     assert.equal(r.observedPriceEvents[0].firstObservedCrossingMinuteStartMs,
       original.session.startMs+80*MIN,market);
     const one=r.observedPriceEvents[0];
     assert.equal(one.tickCrossingTime,null);
     assert.ok(one.snapshots["T-60"].lastClosedMinuteEndMs
       <=one.firstObservedCrossingMinuteStartMs-60*MIN);
     assert.ok(one.snapshots["T-5"].lastClosedMinuteEndMs
       <=one.firstObservedCrossingMinuteStartMs-5*MIN);
     assert.ok(one.snapshots["T-0"].lastClosedMinuteEndMs
       <=one.firstObservedCrossingMinuteStartMs);
     assert.equal(one.snapshots["T-0"].originalProviderPublicationProven,false);
     assert.equal(r.firstCrossingTickTimeEstablished,false);
     assert.equal(r.originalScannerAsOfSignalVerified,false);
     assert.equal(r.actualMarketWideOpportunityCount,null);
     assert.equal(r.trueMarketWideRecall,null);
     assert.equal(r.earlyDetectionRecall,null);
     assert.equal(r.actualFillCount,null);
     assert.equal(r.profitabilityProven,false);
     assert.equal(r.executionAuthority,"NONE");
     assert.equal(r.paperAdmissionAllowed,false);
   }
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("futures may inspect first downward minute labels; cash and spot SHORT remain forbidden",async()=>{
 const root=mkdtempSync(join(tmpdir(),"pit-price-events-"));
 try{
   const {original,opts}=source("CRYPTO_FUTURES","SHORT");
   await persistResearchMinuteSessionV1({root,source:original});
   const r=await audit(opts(root));
   assert.equal(r.status,"SOURCE_ONLY_OBSERVED_PRICE_EVENTS");
   assert.equal(r.retrospectiveEventCount,3);
   assert.equal(r.observedPriceEvents[0].side,"SHORT");
   assert.equal(r.trueMarketWideRecall,null);
   for(const market of ["KR_STOCK","US_STOCK","CRYPTO_SPOT"]){
     const f=source(market);
     await assert.rejects(()=>audit({...f.opts(root),side:"SHORT"}),
       /PIT_ORIGINAL_PRICE_EVENT_INPUT_INVALID/);
   }
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("missing raw minute bars block event labels instead of claiming no opportunities",async()=>{
 const root=mkdtempSync(join(tmpdir(),"pit-price-events-"));
 try{
   const f=source("KR_STOCK","LONG",true);
   await persistResearchMinuteSessionV1({root,source:f.original});
   const r=await audit(f.opts(root));
   assert.equal(r.status,"BLOCKED_DATA");
   assert.equal(r.reason,"NATIVE_ONE_MINUTE_SESSION_MISSING_OR_UNVERIFIED");
   assert.equal(r.retrospectiveEventCount,0);
   assert.equal(r.actualMarketWideOpportunityCount,null);
   assert.equal(r.actualFillCount,null);
   assert.equal(r.executionAuthority,"NONE");
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("unverified PIT membership blocks even physically present 1-minute prices",async()=>{
 const root=mkdtempSync(join(tmpdir(),"pit-price-events-"));
 try{
   const f=source("US_STOCK");
   await persistResearchMinuteSessionV1({root,source:f.original});
   const v=f.opts(root);
   const bad=await audit({...v,
     manifest:{...v.manifest,rawMembershipDigestSha256:"f".repeat(64)}});
   assert.equal(bad.status,"BLOCKED_DATA");
   assert.equal(bad.reason,"HISTORICAL_PIT_ROSTER_ABSENT_OR_CHANGED");
   assert.equal(bad.actualMarketWideOpportunityCount,null);
 }finally{rmSync(root,{recursive:true,force:true});}
});
