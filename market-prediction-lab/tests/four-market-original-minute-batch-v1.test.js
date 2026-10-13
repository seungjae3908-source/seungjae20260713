import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {persistResearchMinuteSessionV1} from "../src/research-minute-archive-v1.js";
import {digestPITMembershipRowsV1} from "../src/historical-pit-venue-universe-gate-v1.js";
import {runFourMarketOriginalMinuteReplayV1 as rawReplay}
  from "../src/four-market-original-minute-replay-v1.js";
import {runFourMarketOriginalMinuteBatchV1 as batch}
  from "../src/four-market-original-minute-batch-v1.js";
import {runFourMarketOriginalMinutePeriodV1 as period,
  ORIGINAL_MINUTE_PERIOD_LIMITS_V1 as PERIOD_LIMITS}
  from "../src/four-market-original-minute-period-v1.js";
import {runFourMarketOriginalMinuteSweepV1 as sweep}
  from "../src/four-market-original-minute-sweep-v1.js";

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
     for(const row of done.taskRows){
       assert.equal(row.modeledStageOnlyNotIndependentOOS,true);
       assert.deepEqual(Object.keys(row.modeledTrainValidationTestDiagnostics),
         ["train","validation","test"]);
       assert.equal(
         row.modeledTrainValidationTestDiagnostics.test.paperCandidatePASS,false);
       assert.equal(
         row.modeledTrainValidationTestDiagnostics.validation.independentOOSProven,false);
       assert.equal(row.paperAdmissionAllowed,false);
     }
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


test("all 4 markets discover native private 1m for one full user-selected research period",async()=>{
 const folder=temp();
 try{
   for(const market of Object.keys(MARKETS)){
     const cfg=input(market,folder);
     const source=session(market,MARKETS[market].symbols[0]);
     await persistResearchMinuteSessionV1({root:folder,source});
     const {sourceSessions,discoverArchivedSessions,...args}=cfg;
     const result=await period({...args,symbol:MARKETS[market].symbols[0]});
     assert.equal(result.status,"SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY",market);
     assert.equal(result.sessionIndexPagesRead,1,market);
     assert.equal(result.indexedPrivateSessions,1,market);
     assert.equal(result.verifiedNativeMinuteSessions,1,market);
     assert.equal(result.sourceSessionIndexDigestSha256.length,64,market);
     assert.equal(result.sourceSessionsRead,1,market);
     assert.equal(result.historicalPITAndCalendarIndependentProof,false,market);
     assert.equal(result.independentOOSAndForwardProven,false,market);
     assert.equal(result.actualFillCount,null,market);
     assert.equal(result.actualMarketWideOpportunityCount,null,market);
     assert.equal(result.OOSPassCount,0,market);
     assert.equal(result.profitabilityProven,false,market);
     assert.equal(result.paperAdmissionAllowed,false,market);
     assert.equal(result.automaticPaperExecution,false,market);
     assert.equal(result.executionAuthority,"NONE",market);
     assert.equal(result.providerGETCount,0,market);
   }
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("two-day single-symbol replay cannot turn one absent day into a zero-return or PASS",async()=>{
 const folder=temp(),market="CRYPTO_SPOT",cfg=input(market,folder);
 const symbol=MARKETS[market].symbols[0];
 const {sourceSessions,discoverArchivedSessions,...args}=cfg;
 const selected={...args,symbol,researchWindow:{
   startDate:"2026-09-18",endDate:"2026-09-19",
 }};
 try{
   const first=session(market,symbol);
   await persistResearchMinuteSessionV1({root:folder,source:first});
   const incomplete=await period(selected);
   assert.equal(incomplete.status,"BLOCKED_DATA");
   assert.equal(incomplete.indexedPrivateSessions,1);
   assert.equal(incomplete.reason,"PIT_SESSION_OR_CALENDAR_DATES_MISSING");
   assert.equal(incomplete.modeledReturnPercent,null);
   assert.equal(incomplete.actualFillCount,null);
   assert.equal(incomplete.paperAdmissionAllowed,false);
   const second=structuredClone(first);
   second.session.startMs+=DAY;
   second.session.endMs+=DAY;
   second.asOfMs+=DAY;
   second.minuteBars=second.minuteBars.map(row=>({
     ...row,timestampMs:row.timestampMs+DAY,
     availableAtMs:row.availableAtMs+DAY,
   }));
   second.sourceMinuteRowsSha256=sha(second.minuteBars);
   await persistResearchMinuteSessionV1({root:folder,source:second});
   const complete=await period(selected);
   assert.equal(complete.status,"SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY");
   assert.equal(complete.indexedPrivateSessions,2);
   assert.equal(complete.verifiedNativeMinuteSessions,2);
   assert.equal(complete.sourceSessionsRead,2);
   assert.equal(complete.independentOOSAndForwardProven,false);
   assert.equal(complete.profitabilityProven,false);
   assert.equal(complete.executionAuthority,"NONE");
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("per-symbol whole-period archive refuses manually spoofed source indexes and expired or absent immutable roots",async()=>{
 const folder=temp(),market="CRYPTO_FUTURES",cfg=input(market,folder);
 const {sourceSessions,discoverArchivedSessions,...args}=cfg;
 try{
   await assert.rejects(()=>period({...args,
     symbol:MARKETS[market].symbols[0],sourceSessions:[]}),
     /PRIVATE_PERIOD_REPLAY_SOURCE_SCOPE_INVALID/);
   const none=await period({...args,symbol:MARKETS[market].symbols[0]});
   assert.equal(none.status,"BLOCKED_DATA");
   assert.equal(none.modeledReturnPercent,null);
   assert.equal(none.profitabilityProven,false);
   assert.equal(none.executionAuthority,"NONE");
 }finally{rmSync(folder,{recursive:true,force:true});}
});


test("whole-venue PIT page sweep resumes exactly across old delisted and 2 active source symbols",async()=>{
 const folder=temp(),market="CRYPTO_SPOT",cfg=input(market,folder);
 const {sourceSessions,discoverArchivedSessions,...base}=cfg;
 try{
   for(const symbol of MARKETS[market].symbols)
     await persistResearchMinuteSessionV1({root:folder,
       source:session(market,symbol)});
   const args={...base,sourceSessions:[],discoverArchivedSessions:true,
     pageBudget:1,memberPageSize:2};
   const first=await sweep(args);
   assert.equal(first.status,"BLOCKED_DATA");
   assert.equal(first.localPageTraversalReachedEnd,false);
   assert.equal(first.pageCountSelfAttested,1);
   assert.equal(first.sourceOnlyCompletePages,1);
   assert.equal(first.sourceBlockedPages,0);
   assert.equal(first.sourceOnlyObservedPriceEventLabels,null);
   assert.equal(first.nextCursorDate,"2026-09-18");
   assert.equal(first.nextMemberOffset,2);
   assert.equal(first.resume.previousPageCount,1);
   assert.equal(first.resume.previousSourceEventCount,3);
   assert.equal(first.actualMarketWideOpportunityCount,null);
   assert.equal(first.profitabilityProven,false);
   assert.equal(first.executionAuthority,"NONE");
   const second=await sweep({...args,resume:first.resume});
   assert.equal(second.status,"LOCAL_HISTORIC_SOURCE_PAGES_TRAVERSED_RESEARCH_ONLY");
   assert.equal(second.localPageTraversalReachedEnd,true);
   assert.equal(second.pageCountSelfAttested,2);
   assert.equal(second.sourceOnlyCompletePages,2);
   assert.equal(second.sourceBlockedPages,0);
   assert.equal(second.sourceTasksSelfAttested,2);
   assert.equal(second.sourceOnlyObservedPriceEventLabels,6);
   assert.equal(second.nextCursorDate,null);
   assert.equal(second.nextMemberOffset,null);
   assert.equal(second.resume,null);
   assert.equal(second.fullPeriodEconomicReturnPercent,null);
   assert.equal(second.fullPeriodNetPnlKRW,null);
   assert.equal(second.actualFillCount,null);
   assert.equal(second.trueMarketWideRecall,null);
   assert.equal(second.profitabilityProven,false);
   assert.equal(second.paperAdmissionAllowed,false);
   assert.equal(second.providerGETCount,0);
   assert.equal(second.executionAuthority,"NONE");
   await assert.rejects(()=>sweep({...args,resume:first.resume,
     memberPageSize:1}),/ORIGINAL_SWEEP_RESUME_SCOPE_OR_COUNTER_INVALID/);
   await assert.rejects(()=>sweep({...args,resume:first.resume,
     costModel:{...cfg.costModel,entryFeeRate:0.003}}),
     /ORIGINAL_SWEEP_RESUME_SCOPE_OR_COUNTER_INVALID/);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("sweep visits later PIT pages but nulls all aggregate opportunities if one source is absent",async()=>{
 const folder=temp(),market="CRYPTO_SPOT",cfg=input(market,folder);
 const {sourceSessions,discoverArchivedSessions,...base}=cfg;
 try{
   await persistResearchMinuteSessionV1({root:folder,
     source:session(market,MARKETS[market].symbols[0])});
   const result=await sweep({...base,sourceSessions:[],
     discoverArchivedSessions:true,pageBudget:8,memberPageSize:2});
   assert.equal(result.status,"BLOCKED_DATA");
   assert.equal(result.localPageTraversalReachedEnd,true);
   assert.equal(result.pageCountSelfAttested,2);
   assert.equal(result.sourceOnlyCompletePages,1);
   assert.equal(result.sourceBlockedPages,1);
   assert.equal(result.sourceOnlyObservedPriceEventLabels,null);
   assert.equal(result.fullPeriodEconomicReturnPercent,null);
   assert.equal(result.actualMarketWideOpportunityCount,null);
   assert.equal(result.resume,null);
   assert.equal(result.profitabilityProven,false);
   assert.equal(result.executionAuthority,"NONE");
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("stock weekend-like calendar gaps never synthesize 1m bars or pretend an all-market source PASS",async()=>{
 const folder=temp(),market="KR_STOCK",cfg=input(market,folder);
 const {sourceSessions,discoverArchivedSessions,...base}=cfg;
 try{
   const result=await sweep({...base,sourceSessions:[],
     discoverArchivedSessions:true,
     researchWindow:{startDate:"2026-09-18",endDate:"2026-09-20"},
     pageBudget:8,memberPageSize:20});
   assert.equal(result.status,"BLOCKED_DATA");
   assert.equal(result.localPageTraversalReachedEnd,true);
   assert.equal(result.pageCountSelfAttested,3);
   assert.equal(result.sourceBlockedPages,3);
   assert.equal(result.sourceOnlyObservedPriceEventLabels,null);
   assert.equal(result.actualMarketWideOpportunityCount,null);
   assert.equal(result.trueMarketWideRecall,null);
   assert.equal(result.profitabilityProven,false);
   assert.equal(result.paperAdmissionAllowed,false);
   assert.equal(result.executionAuthority,"NONE");
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("missing independent roster stops a bounded sweep rather than spinning on one cursor",async()=>{
 const folder=temp(),market="CRYPTO_FUTURES",cfg=input(market,folder);
 const {sourceSessions,discoverArchivedSessions,...base}=cfg;
 try{
   const result=await sweep({...base,manifest:null,
     sourceSessions:[],discoverArchivedSessions:true,pageBudget:6});
   assert.equal(result.status,"BLOCKED_DATA");
   assert.equal(result.reason,"UNRESUMABLE_HISTORIC_PIT_OR_CALENDAR_SOURCE_MISSING");
   assert.equal(result.visitedPagesThisInvocation,1);
   assert.equal(result.localPageTraversalReachedEnd,false);
   assert.equal(result.resume,null);
   assert.equal(result.sourceOnlyObservedPriceEventLabels,null);
   assert.equal(result.profitabilityProven,false);
   await assert.rejects(()=>sweep({...base,pageBudget:9}),
     /ORIGINAL_SWEEP_PAGE_RESOURCE_BUDGET_INVALID/);
 }finally{rmSync(folder,{recursive:true,force:true});}
});


test("historic delisted crypto member needs native minutes ONLY while listed, not every subsequent selected day",async()=>{
 const folder=temp(),market="CRYPTO_SPOT",cfg=input(market,folder);
 const symbol=MARKETS[market].symbols[0];
 const {sourceSessions,discoverArchivedSessions,...base}=cfg;
 try{
   await persistResearchMinuteSessionV1({
     root:folder,source:session(market,symbol)});
   const memberships=cfg.manifest.memberships.map(row=>
     row.symbol===symbol?{...row,removedAtMs:D+DAY}:row);
   const manifest={...cfg.manifest,memberships,
     rawMembershipDigestSha256:digestPITMembershipRowsV1(memberships)};
   const args={...base,manifest,symbol,
     researchWindow:{startDate:"2026-09-18",endDate:"2026-09-19"}};
   const result=await period(args);
   assert.equal(result.status,"SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY");
   assert.equal(result.indexedPrivateSessions,1);
   assert.equal(result.sourceSessionsRead,1);
   assert.equal(result.requestedTradingDays,1);
   assert.equal(result.historicalLifecycleExcludedTradingDates,1);
   assert.equal(result.historicalMemberLifespanSelfAttestedNotIndependentlyVerified,true);
   assert.equal(result.profitabilityProven,false);
   assert.equal(result.actualFillCount,null);
   assert.equal(result.paperAdmissionAllowed,false);
   assert.equal(result.executionAuthority,"NONE");
   const reused=[...memberships,{...memberships[0],
     listedAtMs:D+3*DAY,removedAtMs:null}];
   const reusedManifest={...manifest,memberships:reused,
     rawMembershipDigestSha256:digestPITMembershipRowsV1(reused)};
   await assert.rejects(()=>rawReplay({...cfg,market,symbol,
     manifest:reusedManifest,
     researchWindow:{startDate:"2026-09-18",endDate:"2026-09-18"},
     sessionSources:cfg.sourceSessions.filter(x=>x.symbol===symbol)}),
     /PRIVATE_REPLAY_SYMBOL_LIFECYCLE_MISSING_OR_AMBIGUOUS/);
   const halted=memberships.map(row=>row.symbol===symbol?{
     ...row,halts:[{startMs:D+60*MIN,endMs:D+80*MIN}],
   }:row);
   const haltedManifest={...manifest,memberships:halted,
     rawMembershipDigestSha256:digestPITMembershipRowsV1(halted)};
   await assert.rejects(()=>rawReplay({...cfg,symbol,
     manifest:haltedManifest,
     researchWindow:{startDate:"2026-09-18",endDate:"2026-09-18"},
     sessionSources:cfg.sourceSessions.filter(x=>x.symbol===symbol)}),
     /PRIVATE_REPLAY_HALT_INTERVAL_SOURCE_REQUIRED/);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("newly listed crypto requires source only AFTER listing; an unproven first day stays excluded",async()=>{
 const folder=temp(),market="CRYPTO_SPOT",cfg=input(market,folder);
 const symbol=MARKETS[market].symbols[0];
 const {sourceSessions,discoverArchivedSessions,...base}=cfg;
 try{
   const next=session(market,symbol);
   next.session.startMs+=DAY;
   next.session.endMs+=DAY;
   next.asOfMs+=DAY;
   next.minuteBars=next.minuteBars.map(x=>({
     ...x,timestampMs:x.timestampMs+DAY,
     availableAtMs:x.availableAtMs+DAY,
   }));
   next.sourceMinuteRowsSha256=sha(next.minuteBars);
   await persistResearchMinuteSessionV1({root:folder,source:next});
   const memberships=cfg.manifest.memberships.map(row=>row.symbol===symbol
     ?{...row,listedAtMs:D+DAY}:row);
   const manifest={...cfg.manifest,memberships,
     rawMembershipDigestSha256:digestPITMembershipRowsV1(memberships)};
   const r=await period({...base,manifest,symbol,
     researchWindow:{startDate:"2026-09-18",endDate:"2026-09-19"}});
   assert.equal(r.status,"SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY");
   assert.equal(r.indexedPrivateSessions,1);
   assert.equal(r.sourceSessionsRead,1);
   assert.equal(r.historicalLifecycleExcludedTradingDates,1);
   assert.equal(r.profitabilityProven,false);
   assert.equal(r.executionAuthority,"NONE");
 }finally{rmSync(folder,{recursive:true,force:true});}
});


test("explicit 10-year stock PRE/REGULAR/AFTER archive count fits bounded index memory budget",()=>{
  assert.equal(PERIOD_LIMITS.indexPageSize,31);
  assert.ok(PERIOD_LIMITS.maxSessionsPerSymbol>=10*260*4);
  assert.ok(PERIOD_LIMITS.maxIndexPages*PERIOD_LIMITS.indexPageSize
    >=PERIOD_LIMITS.maxSessionsPerSymbol);
  assert.ok(PERIOD_LIMITS.maxSessionsPerSymbol<=40_000);
});
