import test from "node:test";
import assert from "node:assert/strict";
import {
 collectKrxDatedRosterBatchV1 as collect,
 KRX_ARCHIVE_BATCH_POLICY_V1 as policy,
} from "../src/krx-readonly-archive-batch-v1.js";

const dates=["20250203","20250204","20250205"];
const fakeKey="UNIT-TEST-KRX-MARKET-DATA-ONLY";
const records={
 KOSPI:{ISU_CD:"KR7005930003",ISU_SRT_CD:"005930",
   LIST_DD:"19880101",MKT_TP_NM:"KOSPI",SECUGRP_NM:"STOCK"},
 KOSDAQ:{ISU_CD:"KR7035420009",ISU_SRT_CD:"035420",
   LIST_DD:"20020101",MKT_TP_NM:"KOSDAQ",SECUGRP_NM:"STOCK"},
 KONEX:{ISU_CD:"KR7278990005",ISU_SRT_CD:"278990",
   LIST_DD:"20180101",MKT_TP_NM:"KONEX",SECUGRP_NM:"STOCK"},
};
const endpointBoard=u=>u.includes("/stk_isu_base_info")?"KOSPI":
  u.includes("/ksq_isu_base_info")?"KOSDAQ":
  u.includes("/knx_isu_base_info")?"KONEX":null;

function fakeFetch({badDay=null,badBoard=null,invalidIdentity=false,
  onRequest=()=>{}}={}){
 return async(url,opts)=>{
   onRequest(url,opts);
   const board=endpointBoard(url),day=new URL(url).searchParams.get("basDd");
   if(!board)throw new Error("UNKNOWN_KRX_PATH");
   if(day===badDay&&board===badBoard)return {ok:false,status:403};
   const row={...records[board]};
   if(invalidIdentity&&day===dates[1]&&board==="KOSDAQ")row.LIST_DD="20290101";
   return {ok:true,status:200,async json(){return {OutBlock_1:[row]}}};
 };
}

test("no authorized KRX market-data key: zero requests, no invented historical denominator",async()=>{
 let called=0,sleeps=0;
 const r=await collect({
   requestedTradingDates:dates,
   fetchImpl:async()=>{called++;throw Error("SHOULD_NOT_CONTACT_KRX")},
   sleepImpl:async()=>{sleeps++;},
 });
 assert.equal(r.status,"BLOCKED_MARKET_DATA_ENTITLEMENT");
 assert.equal(r.requestsPerformed,0);
 assert.equal(called,0);
 assert.equal(sleeps,0);
 assert.equal(r.observedDateCount,0);
 assert.equal(r.missingDateCount,3);
 assert.deepEqual(r.historicalIdentityTimeline.missingRequestedDates,dates);
 assert.equal(r.historicalIdentityTimeline.confirmedDelistingCount,null);
 assert.equal(r.trueMarketWideRecall,null);
 assert.equal(r.netProfitPct,null);
 assert.equal(r.profitabilityProven,false);
 assert.equal(r.executionAuthority,"NONE");
 assert.equal(r.sourceKeyPersisted,false);
});

test("3 fully obtained dated KRX records: 9 GET calls, full 3-board daily integrity",async()=>{
 const urls=[],intervals=[];
 const r=await collect({
   requestedTradingDates:dates,authKey:fakeKey,
   fetchImpl:fakeFetch({onRequest:(url,opts)=>urls.push({url,opts})}),
   sleepImpl:async(ms)=>{intervals.push(ms);},
 });
 assert.equal(r.status,"SOURCE_LIMITED_DATED_SNAPSHOTS_ONLY");
 assert.equal(r.requestsPerformed,9);
 assert.equal(r.observedDateCount,3);
 assert.equal(r.missingDateCount,0);
 assert.equal(r.sourceDayReceipts.length,3);
 assert.equal(r.blockedDateReceipts.length,0);
 assert.equal(r.historicalIdentityTimeline.status,"OBSERVED_REQUESTED_DATES_ONLY");
 assert.equal(r.historicalIdentityTimeline.transitions.length,0);
 assert.equal(r.historicalIdentityTimeline.confirmedDelistingCount,null);
 assert.equal(r.requestedDatesAreIndependentlyAuthenticatedTradingCalendar,false);
 assert.equal(r.fullMarketOpportunityDenominatorVerified,false);
 assert.deepEqual(intervals,Array(8).fill(150));
 assert.ok(urls.every(x=>
   new URL(x.url).hostname==="data-dbg.krx.co.kr"
   &&x.opts.method==="GET"&&x.opts.headers.AUTH_KEY===fakeKey
   &&dates.includes(new URL(x.url).searchParams.get("basDd"))
 ));
 assert.equal(JSON.stringify(r).includes(fakeKey),false);
 assert.equal(r.sourceReceiptsSha256.length,64);
});

test("market-data rejection on middle day is blocked and DOES NOT infer a delisting",async()=>{
 const r=await collect({
   requestedTradingDates:dates,authKey:fakeKey,
   fetchImpl:fakeFetch({badDay:dates[1],badBoard:"KOSDAQ"}),
   sleepImpl:async()=>{},
 });
 assert.equal(r.status,"PARTIAL_DATED_SNAPSHOTS_BLOCKED");
 assert.equal(r.observedDateCount,2);
 assert.equal(r.missingDateCount,1);
 assert.equal(r.blockedDateReceipts.length,1);
 assert.equal(r.blockedDateReceipts[0].dateYmd,dates[1]);
 assert.equal(r.blockedDateReceipts[0].reason,"KRX_MARKET_DATA_HTTP_UNAVAILABLE");
 assert.equal(r.historicalIdentityTimeline.transitions.length,0);
 assert.deepEqual(r.historicalIdentityTimeline.missingRequestedDates,[dates[1]]);
 assert.equal(r.historicalIdentityTimeline.confirmedDelistingCount,null);
 assert.equal(r.trueMarketWideRecall,null);
});

test("one invalid future-listing record is treated as source-date failure",async()=>{
 const r=await collect({
   requestedTradingDates:dates,authKey:fakeKey,
   fetchImpl:fakeFetch({invalidIdentity:true}),
   sleepImpl:async()=>{},
 });
 assert.equal(r.observedDateCount,2);
 assert.equal(r.blockedDateReceipts[0].reason,"KRX_ISSUE_ID_DATE_OR_DUPLICATE_INVALID");
 assert.equal(r.historicalIdentityTimeline.transitions.length,0);
 assert.equal(r.historicalIdentityTimeline.trueMarketWideRecall,null);
});

test("only bounded 6 dates and no more than 18 official market-data GETs allowed",async()=>{
 const days=Array.from({length:7},(_,i)=>"202502"+String(i+3).padStart(2,"0"));
 await assert.rejects(()=>collect({requestedTradingDates:days,authKey:fakeKey}),
   /KRX_BATCH_DATE_RANGE_INVALID/);
 assert.equal(policy.maxDates,6);
 assert.equal(policy.maxPublicMarketDataRequests,18);
});

test("nonconsecutive or unverified trading dates are not silently sorted",async()=>{
 await assert.rejects(()=>collect({
   requestedTradingDates:[dates[1],dates[0]],authKey:fakeKey,
 }),/KRX_BATCH_DATE_RANGE_INVALID/);
 await assert.rejects(()=>collect({
   requestedTradingDates:[dates[0],dates[0]],authKey:fakeKey,
 }),/KRX_BATCH_DATE_RANGE_INVALID/);
 await assert.rejects(()=>collect({
   requestedTradingDates:["20250229","20250301"],authKey:fakeKey,
 }),/KRX_BATCH_DATE_RANGE_INVALID/);
});

test("partial single board request cannot masquerade as full KRX market listing",async()=>{
 await assert.rejects(()=>collect({
   requestedTradingDates:dates,authKey:fakeKey,boards:["KOSPI"],
 }),/KRX_BATCH_MARKETS_REQUIRE_ALL_THREE/);
 await assert.rejects(()=>collect({
   requestedTradingDates:dates,authKey:fakeKey,boards:["KOSPI","KOSPI","KONEX"],
 }),/KRX_BATCH_MARKETS_REQUIRE_ALL_THREE/);
});

test("malicious public GET policy relaxation and invalid io callbacks are rejected",async()=>{
 for(const minIntervalMs of [0,149,2001]){
   await assert.rejects(()=>collect({
     requestedTradingDates:dates,authKey:fakeKey,minIntervalMs,
   }),/KRX_BATCH_PUBLIC_IO_POLICY_INVALID/);
 }
 await assert.rejects(()=>collect({
   requestedTradingDates:dates,authKey:fakeKey,fetchImpl:"not a function",
 }),/KRX_BATCH_PUBLIC_IO_POLICY_INVALID/);
 await assert.rejects(()=>collect({
   requestedTradingDates:dates,authKey:fakeKey,sleepImpl:123,
 }),/KRX_BATCH_PUBLIC_IO_POLICY_INVALID/);
});

test("missing key is not supplied through env or credentials in output",async()=>{
 const r=await collect({requestedTradingDates:dates,authKey:null});
 assert.equal(r.sourceKeyInMemoryOnly,true);
 assert.equal(r.sourceKeyPersisted,false);
 assert.equal(r.privateProviderTradeApi,false);
 assert.equal(r.realOrders,false);
 assert.equal(r.liveTrading,false);
 assert.equal(r.autoTrading,false);
 assert.equal(r.OOSPassCount,0);
});
