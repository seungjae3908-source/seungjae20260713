import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {persistResearchMinuteSessionV1} from "../src/research-minute-archive-v1.js";
import {digestPITMembershipRowsV1} from "../src/historical-pit-venue-universe-gate-v1.js";
import {runFourMarketOriginalMinuteBatchV1 as batch}
  from "../src/four-market-original-minute-batch-v1.js";

const DAY=86_400_000,MIN=60_000;
const D=Date.parse("2026-09-18T00:00:00Z");
const MARKETS={
  KR_STOCK:{venue:"KRX",zone:"Asia/Seoul",start:D,
    symbols:["005930","000660"],kind:"REGULAR",length:120},
  US_STOCK:{venue:"US_SIP",zone:"America/New_York",
    start:Date.parse("2026-09-18T13:30:00Z"),
    symbols:["AAPL","MSFT"],kind:"REGULAR",length:120},
  CRYPTO_SPOT:{venue:"UPBIT_KRW",zone:"UTC",
    start:D,symbols:["KRW-BTC","KRW-ETH"],kind:"UTC_24H",length:1440},
  CRYPTO_FUTURES:{venue:"BITGET_USDT_FUTURES",zone:"UTC",
    start:D,symbols:["BTCUSDT","ETHUSDT"],kind:"UTC_24H",length:1440},
};
const sha=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const temp=()=>mkdtempSync(join(tmpdir(),"original-minute-batch-v1-"));
function session(market,symbol){
 const p=MARKETS[market],sourceId="TEST_NATIVE_ORIGINAL_MINUTE_BATCH";
 const minuteBars=Array.from({length:p.length},(_,i)=>{
   const open=i===80?100:100;
   const close=i===80?111:100;
   return {market,venue:p.venue,symbol,sourceId,
     timestampMs:p.start+i*MIN,availableAtMs:p.start+(i+1)*MIN,
     open,close,high:Math.max(open,close)+0.1,
     low:Math.min(open,close)-0.1,volume:100+i};
 });
 return {market,venue:p.venue,symbol,sourceId,
   session:{startMs:p.start,endMs:p.start+p.length*MIN,
     kind:p.kind,timeZone:p.zone,
     calendarSourceId:"TEST_HISTORICAL_EXCHANGE_SESSION"},
   minuteBars,sourceMinuteRowsSha256:sha(minuteBars),
   asOfMs:p.start+p.length*MIN};
}
function input(market,root,sessionSymbols=MARKETS[market].symbols){
 const p=MARKETS[market],members=p.symbols.map(symbol=>({
   symbol,listedAtMs:D-150*DAY,removedAtMs:null,halts:[],
   sourceId:"TEST_HISTORIC_FULL_ROSTER",evidenceSha256:"a".repeat(64),
 }));
 members.push({symbol:"DELISTED",listedAtMs:D-350*DAY,
   removedAtMs:D-140*DAY,halts:[],
   sourceId:"TEST_HISTORIC_FULL_ROSTER",evidenceSha256:"a".repeat(64)});
 const manifest={schemaVersion:"historical-venue-pit-roster-v1",
   market,venue:p.venue,sourceClass:"TEST_FIXTURE",testOnly:true,
   coverageStartMs:D-400*DAY,coverageEndMs:D+31*DAY,
   retrievedAtMs:D+32*DAY,sourceId:"TEST_HISTORIC_FULL_ROSTER",
   allListedAndRemovedAttested:true,suspensionsAttested:true,
   relistedIdentifiersResolved:true,members,
   memberships:members,
   rawMembershipDigestSha256:digestPITMembershipRowsV1(members),
 };
 const stockCalendar=market.endsWith("STOCK")
   ?{market,tradingDates:["2015-01-05","2026-09-18","2028-01-03"],
     sessions:[{
       tradingDateLocal:"2026-09-18",
       startMs:p.start,endMs:p.start+p.length*MIN,
       kind:p.kind,timeZone:p.zone,
     }]}:null;
 return {
   root,market,manifest,stockCalendar,
   stockTradingDates:stockCalendar?.tradingDates??null,
   researchWindow:{startDate:"2026-09-18",endDate:"2026-09-18"},
   sourceSessions:sessionSymbols.map(symbol=>({
     market,symbol,date:"2026-09-18",
     startMs:p.start,endMs:p.start+p.length*MIN,
     kind:p.kind,zone:p.zone,
   })),
   asOfMs:D+40*DAY,timeframe:"5m",direction:"LONG",
   fxRateKRWPerQuote:market==="US_STOCK"||market==="CRYPTO_FUTURES"
     ?1300:null,
   initialCapitalKRW:1_000_000,
   leverage:market==="CRYPTO_FUTURES"?7:1,
   costModel:{entryFeeRate:0.0006,exitFeeRate:0.0006,spreadRate:0.0004,
     slippageRate:0.0005,latencyRate:0.0001,taxRate:0,fundingRatePerSession:0},
   strategy:{kind:"EMA_TREND",fast:2,slow:5,stopPercent:1,targetPercent:2},
 };
}
test("full PIT page -> immutable source -> modeled replay -> T-minus prices in four venues; no Paper authority",async()=>{
 const folder=temp();
 try{
   for(const market of Object.keys(MARKETS)){
     const cfg=input(market,folder);
     await persistResearchMinuteSessionV1({
       root:folder,source:session(market,MARKETS[market].symbols[0]),
     });
     const partial=await batch(cfg);
     assert.equal(partial.status,"BLOCKED_DATA",market);
     assert.equal(partial.sourceTasksRequested,2,market);
     assert.equal(partial.blockedSourceTasks,1,market);
     assert.equal(partial.sourceOnlyModeledTradeCount,null,market);
     assert.equal(partial.sourceOnlyEventLabels,null,market);
     assert.equal(partial.actualMarketWideOpportunityCount,null,market);
     await persistResearchMinuteSessionV1({
       root:folder,source:session(market,MARKETS[market].symbols[1]),
     });
     const done=await batch(cfg);
     assert.equal(done.status,"SOURCE_ONLY_REPLAY_PAGE_INSPECTED",market);
     assert.equal(done.sourceTasksRequested,2,market);
     assert.equal(done.inspectedSourceTasks,2,market);
     assert.equal(done.blockedSourceTasks,0,market);
     assert.equal(done.sourceOnlyEventLabels,6,market);
     assert.equal(done.taskRows.length,2,market);
     assert.equal(done.sourceTaskPageDigestSha256.length,64,market);
     assert.ok(done.taskRows.every(row=>row.sourceLineageSha256?.length===64),market);
     assert.equal(done.historicalAsOfScannerSignalVerified,false,market);
     assert.equal(done.fullMarketOpportunityDenominatorVerified,false,market);
     assert.equal(done.actualFillCount,null,market);
     assert.equal(done.actualNetProfitPercent,null,market);
     assert.equal(done.profitabilityProven,false,market);
     assert.equal(done.executionAuthority,"NONE",market);
     assert.equal(done.paperAdmissionAllowed,false,market);
     assert.equal(done.realOrders,false,market);
     assert.equal(done.providerGETCount,0,market);
     const automaticIndex=await batch({...cfg,
       sourceSessions:[],discoverArchivedSessions:true});
     assert.equal(automaticIndex.status,"SOURCE_ONLY_REPLAY_PAGE_INSPECTED",market);
     assert.equal(automaticIndex.inspectedSourceTasks,2,market);
     assert.equal(automaticIndex.blockedSourceTasks,0,market);
     assert.equal(automaticIndex.sourceOnlyEventLabels,6,market);
     assert.equal(automaticIndex.paperAdmissionAllowed,false,market);
     assert.equal(automaticIndex.providerGETCount,0,market);
   }
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("the planned page is bounded; no huge date times member fanout or fake completed count",async()=>{
 const folder=temp();
 try{
   const market="CRYPTO_SPOT",cfg=input(market,folder);
   const tooWide=await batch({...cfg,chunkCalendarDays:31,
     researchWindow:{startDate:"2026-09-18",endDate:"2026-10-10"}});
   assert.equal(tooWide.status,"BLOCKED_DATA");
   assert.equal(tooWide.reason,"SOURCE_TASK_PAGE_EXCEEDS_SAFE_EXECUTION_BUDGET");
   assert.equal(tooWide.inspectedSourceTasks,0);
   assert.equal(tooWide.sourceOnlyEventLabels,null);
   assert.equal(tooWide.actualMarketWideOpportunityCount,null);
   assert.equal(tooWide.paperAdmissionAllowed,false);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("malformed duplicated or mismatched source session index and cash SHORT fail before source replay",async()=>{
 const folder=temp();
 try{
   const cfg=input("KR_STOCK",folder);
   await assert.rejects(()=>batch({...cfg,direction:"SHORT"}),
     /ORIGINAL_BATCH_SCOPE_OR_SIDE_INVALID/);
   await assert.rejects(()=>batch({...cfg,discoverArchivedSessions:true}),
     /ORIGINAL_BATCH_SCOPE_OR_SIDE_INVALID/);
   await assert.rejects(()=>batch({...cfg,sourceSessions:[
     cfg.sourceSessions[0],cfg.sourceSessions[0],
   ]}),/ORIGINAL_BATCH_DUPLICATE_SESSION_INDEX/);
   await assert.rejects(()=>batch({...cfg,sourceSessions:[{
     ...cfg.sourceSessions[0],market:"CRYPTO_FUTURES",
   }]}),/ORIGINAL_BATCH_SESSION_INDEX_INVALID/);
   const empty=await batch({...cfg,sourceSessions:[]});
   assert.equal(empty.status,"BLOCKED_DATA");
   assert.equal(empty.blockedSourceTasks,2);
   assert.equal(empty.sourceOnlyModeledTradeCount,null);
   assert.equal(empty.profitabilityProven,false);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("absent historical PIT plan retains unknown, not fictitious zero-return or discovered coins",async()=>{
 const folder=temp();
 try{
   const cfg=input("CRYPTO_FUTURES",folder);
   const missing=await batch({...cfg,manifest:null});
   assert.equal(missing.status,"BLOCKED_DATA");
   assert.equal(missing.sourceTasksRequested,null);
   assert.equal(missing.blockedSourceTasks,null);
   assert.equal(missing.sourceOnlyEventLabels,null);
   assert.equal(missing.actualMarketWideOpportunityCount,null);
   assert.equal(missing.profitabilityProven,false);
   assert.equal(missing.executionAuthority,"NONE");
 }finally{rmSync(folder,{recursive:true,force:true});}
});
