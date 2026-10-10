import test from "node:test";
import assert from "node:assert/strict";
import {collectKrxDatedRosterV1}
 from "../src/krx-dated-roster-public-read-v1.js";
import {collectKrxThreeBoardDatedOHLCV1 as collect,
 KRX_DATED_ALL_STOCK_PRICE_POLICY_V1 as policy}
 from "../src/krx-dated-all-stock-ohlcv-v1.js";

const dateYmd="20250203",K="TEST-ONLY-APPROVED-KRX-MARKET-DATA-KEY";
const stock={
  KOSPI:[
    {ISU_CD:"KR7005930003",ISU_SRT_CD:"005930",LIST_DD:"19880101"},
    {ISU_CD:"KR7000660001",ISU_SRT_CD:"000660",LIST_DD:"19961226"},
  ],
  KOSDAQ:[
    {ISU_CD:"KR7035420009",ISU_SRT_CD:"035420",LIST_DD:"20020101"},
  ],
  KONEX:[
    {ISU_CD:"KR7278990005",ISU_SRT_CD:"278990",LIST_DD:"20180101"},
  ],
};
const boardFor=url=>{
  if(url.includes("stk_"))return"KOSPI";
  if(url.includes("ksq_"))return"KOSDAQ";
  if(url.includes("knx_"))return"KONEX";
  return null;
};
async function roster(){
 return collectKrxDatedRosterV1({
  dateYmd,authKey:K,
  fetchImpl:async(url)=>{
   const board=boardFor(url);
   assert.ok(board);
   assert.ok(url.includes("_isu_base_info"));
   return {ok:true,status:200,async json(){
    return {OutBlock_1:stock[board].map(x=>({
      ...x,MKT_TP_NM:board,SECUGRP_NM:"STOCK",
    }))};
   }};
  },
 });
}
function source(overrides={},onGet=()=>{}){
 return async(url,req)=>{
   onGet(url,req);
   const board=boardFor(url);
   assert.ok(url.endsWith("basDd="+dateYmd));
   assert.equal(req.method,"GET");
   assert.equal(req.headers.AUTH_KEY,K);
   assert.ok(url.includes("_bydd_trd"));
   const data=stock[board].map((x,i)=>({
     BAS_DD:dateYmd,
     ISU_CD:i===0&&board==="KOSPI"?x.ISU_CD:x.ISU_SRT_CD,
     ISU_NM:"RESEARCH_SYNTHETIC",
     TDD_OPNPRC:"10,000",TDD_HGPRC:"11,000",
     TDD_LWPRC:"9,000",TDD_CLSPRC:"10,500",
     ACC_TRDVOL:"1,000",ACC_TRDVAL:"10,500,000",
   }));
   if(typeof overrides[board]==="function"){
     return {ok:true,status:200,async json(){
       return {OutBlock_1:overrides[board](data)};
     }};
   }
   if(overrides[board]==="HTTP_403")return {ok:false,status:403};
   return {ok:true,status:200,async json(){return {OutBlock_1:data}}};
 };
}
test("no KRX key or missing date-roster: no network, no fictional market coverage",async()=>{
  let calls=0;
  const f=async()=>{calls++;throw Error("SHOULD_NOT_CALL")};
  const valid=await roster();
  const noKey=await collect({dateYmd,datedRoster:valid,fetchImpl:f});
  const noRoster=await collect({dateYmd,authKey:K,fetchImpl:f});
  assert.equal(calls,0);
  assert.equal(noKey.status,"BLOCKED_DATA");
  assert.equal(noKey.reason,"KRX_OHLC_MARKET_DATA_AUTH_REQUIRED");
  assert.equal(noRoster.reason,"KRX_DATED_THREE_BOARD_ROSTER_NOT_ATTESTED");
  assert.equal(noRoster.rows,null);
  assert.equal(noKey.trueMarketWideRecall,null);
  assert.equal(noKey.executionAuthority,"NONE");
});
test("whole dated KOSPI/KOSDAQ/KONEX OHLCV cross-joins all listed IDs",async()=>{
  const valid=await roster(),seen=[],sleeps=[];
  assert.equal(valid.status,"OBSERVED_KRX_DAY_ROSTER_ONLY");
  assert.equal(valid.dateScopedSymbolCount,4);
  const a=await collect({dateYmd,datedRoster:valid,authKey:K,
    fetchImpl:source({},(url,req)=>seen.push([url,req])),
    sleepImpl:async ms=>{sleeps.push(ms)},
  });
  assert.equal(a.status,"SOURCE_LIMITED_DATED_QUOTES_MATCHED_ONLY");
  assert.equal(a.observedDatedRosterSymbols,4);
  assert.equal(a.observedQuoteRows,4);
  assert.equal(a.observedUsableDailyBars,4);
  assert.equal(a.rows.length,4);
  assert.deepEqual(sleeps,[150,150]);
  assert.equal(seen.length,3);
  assert.deepEqual(Object.keys(a.boardsReturnedRows).sort(),
    ["KONEX","KOSDAQ","KOSPI"]);
  assert.equal(a.rows.find(x=>x.symbol==="005930").marketBoard,"KOSPI");
  assert.equal(a.rows.find(x=>x.symbol==="005930").open,10000);
  assert.equal(a.rows.find(x=>x.symbol==="005930").high,11000);
  assert.equal(a.rows.find(x=>x.symbol==="005930").volume,1000);
  assert.ok(a.rows.every(x=>x.venue==="KRX"&&x.market==="KR_STOCK"));
  assert.match(a.sourceDailyRowsSha256,/^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(a).includes(K),false);
  assert.equal(a.predecessorTradingSessionVerified,false);
  assert.equal(a.corporateActionsAdjustedAndVerified,false);
  assert.equal(a.independentlyCompleteHistoricalPITPopulationVerified,false);
  assert.equal(a.fullMarketOpportunityDenominatorVerified,false);
  assert.equal(a.trueMarketWideRecall,null);
  assert.equal(a.profitabilityProven,false);
  assert.equal(a.executionAuthority,"NONE");
  assert.equal(a.realOrders,false);
});
test("missing listed stock daily OHLC never becomes zero opportunity",async()=>{
 const valid=await roster();
 const a=await collect({dateYmd,datedRoster:valid,authKey:K,
  fetchImpl:source({KOSDAQ:rows=>[]}),sleepImpl:async()=>{}});
 assert.equal(a.status,"BLOCKED_DATA");
 assert.equal(a.reason,"KRX_DAILY_QUOTE_BOARD_ROWS_INVALID");
 assert.equal(a.actualMarketWideOpportunityCount,null);
});
test("partial traded universe remains PARTIAL even if provider returns 200",async()=>{
 const valid=await roster();
 const a=await collect({dateYmd,datedRoster:valid,authKey:K,
  fetchImpl:source({KOSPI:rows=>rows.slice(0,1)}),
  sleepImpl:async()=>{}});
 assert.equal(a.status,"PARTIAL_DATED_QUOTES_BLOCKED");
 assert.equal(a.reason,"MISSING_LISTED_QUOTE_OR_NONTRADED_SECURITY");
 assert.equal(a.observedDatedRosterSymbols,4);
 assert.equal(a.observedUsableDailyBars,3);
 assert.deepEqual(a.missingRosterSymbols,["000660"]);
 assert.equal(a.fullMarketOpportunityDenominatorVerified,false);
});
test("zero-volume/halting share is not counted as a tradable daily bar",async()=>{
 const valid=await roster();
 const a=await collect({dateYmd,datedRoster:valid,authKey:K,
  fetchImpl:source({KOSDAQ:rows=>[{...rows[0],ACC_TRDVOL:"0"}]}),
  sleepImpl:async()=>{}});
 assert.equal(a.status,"PARTIAL_DATED_QUOTES_BLOCKED");
 assert.deepEqual(a.untradedSymbols,["035420"]);
 assert.equal(a.observedUsableDailyBars,3);
 assert.equal(a.actualMarketWideOpportunityCount,null);
});
test("unauthorized board 403 fails closed; never recodes delisted prices as nonexistent",async()=>{
 const valid=await roster();
 const a=await collect({dateYmd,datedRoster:valid,authKey:K,
  fetchImpl:source({KOSDAQ:"HTTP_403"}),
  sleepImpl:async()=>{}});
 assert.equal(a.status,"BLOCKED_DATA");
 assert.equal(a.reason,"KRX_DAILY_QUOTE_HTTP_BLOCKED");
 assert.equal(a.blockedBoard,"KOSDAQ");
 assert.equal(a.httpStatus,403);
 assert.equal(a.sourceKeyPersisted,false);
});
test("wrong historical date and unknown/duplicate code are rejected",async()=>{
 const valid=await roster();
 for(const changed of [
  {KOSPI:rows=>[{...rows[0],BAS_DD:"20250204"},rows[1]]},
  {KOSPI:rows=>[{...rows[0],ISU_CD:"999999"},rows[1]]},
  {KOSPI:rows=>[{...rows[0],ISU_CD:rows[1].ISU_CD},rows[1]]},
 ]){
  const a=await collect({dateYmd,datedRoster:valid,authKey:K,
   fetchImpl:source(changed),sleepImpl:async()=>{}});
  assert.equal(a.status,"BLOCKED_DATA");
  assert.ok(["KRX_DAILY_QUOTE_DATE_OR_CODE_INVALID",
    "KRX_DATED_ROSTER_AND_QUOTES_IDENTITY_CONFLICT"].includes(a.reason),a.reason);
  assert.equal(a.trueMarketWideRecall,null);
 }
});
test("fake or current-only snapshot cannot pass exact source-digest binding",async()=>{
 let hits=0;
 const valid=await roster();
 for(const changed of [
  {...valid,sourceSha256:"a".repeat(64)},
  {...valid,status:"CURRENT_SNAPSHOT"},
  {...valid,dateYmd:"20250204"},
  {...valid,markets:{KOSPI:3,KOSDAQ:1,KONEX:1}},
 ]){
  const a=await collect({dateYmd,datedRoster:changed,authKey:K,
   fetchImpl:async()=>{hits++;throw Error("SHOULD_NOT_CALL")}});
  assert.equal(a.reason,"KRX_DATED_THREE_BOARD_ROSTER_NOT_ATTESTED");
 }
 assert.equal(hits,0);
});
test("invalid traded OHLC price, no silent acceptance",async()=>{
 const valid=await roster();
 const a=await collect({dateYmd,datedRoster:valid,authKey:K,
  fetchImpl:source({KONEX:rows=>[{...rows[0],TDD_HGPRC:"8,000"}]}),
  sleepImpl:async()=>{}});
 assert.equal(a.reason,"KRX_DAILY_QUOTE_OHLC_INVALID");
 assert.equal(a.status,"BLOCKED_DATA");
});
test("bounded authorized KRX day collection rejects invalid dates and unsafe throttle",async()=>{
 const v=await roster();
 for(const invalid of ["20250230","2025-02-03","20100105"]){
  await assert.rejects(()=>collect({dateYmd:invalid,datedRoster:v,authKey:K}),
   /KRX_OHLC_DATE_INVALID/);
 }
 await assert.rejects(()=>collect({dateYmd,datedRoster:v,authKey:K,
  minGapMs:0}),/KRX_OHLC_IO_POLICY_INVALID/);
 assert.equal(policy.maxRequests,3);
 assert.equal(policy.minGapMs,150);
});
