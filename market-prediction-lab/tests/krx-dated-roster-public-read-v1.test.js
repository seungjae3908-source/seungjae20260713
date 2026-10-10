import test from "node:test";
import assert from "node:assert/strict";
import {collectKrxDatedRosterV1 as collect} from "../src/krx-dated-roster-public-read-v1.js";
const dateYmd="20250203",KEY="test-only-key";
const inBoard={KOSPI:"005930",KOSDAQ:"035420",KONEX:"278990"};
const isin={KOSPI:"KR7005930003",KOSDAQ:"KR7035420009",KONEX:"KR7278990005"};
const body=(board,listing="19880101")=>({
  OutBlock_1:[{
    ISU_CD:isin[board],ISU_SRT_CD:inBoard[board],
    LIST_DD:listing,MKT_TP_NM:board,SECUGRP_NM:"STOCK",
  }],
});
test("missing market-data entitlement makes NO network call and stays BLOCKED",async()=>{
 let networkCalls=0;
 const x=await collect({dateYmd,fetchImpl:async()=>{networkCalls++;throw Error("unexpected")}});
 assert.equal(networkCalls,0);
 assert.equal(x.status,"BLOCKED_DATA");
 assert.equal(x.reason,"KRX_READONLY_MARKET_DATA_AUTH_REQUIRED");
 assert.equal(x.dateScopedSymbolCount,null);
 assert.equal(x.trueMarketWideRecall,null);
 assert.equal(x.executionAuthority,"NONE");
});
test("fixed KRX KOSPI, KOSDAQ, KONEX daily endpoints are GET market data only",async()=>{
 const seen=[];
 const result=await collect({dateYmd,authKey:KEY,fetchImpl:async(url,opts)=>{
   seen.push([url,opts]);
   const board=Object.keys(inBoard).find(b=>url.includes(
     b==="KOSPI"?"stk_isu_base_info":b==="KOSDAQ"?"ksq_isu_base_info":"knx_isu_base_info"));
   return {ok:true,status:200,async json(){return body(board)}};
 }});
 assert.equal(result.status,"OBSERVED_KRX_DAY_ROSTER_ONLY");
 assert.equal(result.dateScopedSymbolCount,3);
 assert.equal(seen.length,3);
 assert.ok(seen.every(([url,opts])=>new URL(url).hostname==="data-dbg.krx.co.kr"
   &&new URL(url).searchParams.get("basDd")===dateYmd
   &&opts.method==="GET"&&opts.headers.AUTH_KEY===KEY));
 assert.deepEqual(Object.keys(result.markets).sort(),["KONEX","KOSDAQ","KOSPI"]);
 assert.match(result.sourceSha256,/^[0-9a-f]{64}$/);
 assert.equal(JSON.stringify(result).includes(KEY),false);
 assert.equal(result.entireDatePITUniverseProven,false);
 assert.equal(result.fullMarketOpportunityDenominatorVerified,false);
 assert.equal(result.authKeyPersisted,false);
 assert.equal(result.realOrders,false);
});
test("market data API HTTP rejection cannot fabricate empty market",async()=>{
 const v=await collect({dateYmd,authKey:KEY,boards:["KOSPI"],
   fetchImpl:async()=>({ok:false,status:403})});
 assert.equal(v.status,"BLOCKED_DATA");
 assert.equal(v.reason,"KRX_MARKET_DATA_HTTP_UNAVAILABLE");
 assert.equal(v.details.httpStatus,403);
 assert.equal(v.dateScopedSymbolCount,null);
});
test("one missing board invalidates all requested market roster completeness",async()=>{
 const v=await collect({dateYmd,authKey:KEY,boards:["KOSPI","KOSDAQ"],
   fetchImpl:async url=>({ok:true,async json(){return url.includes("stk_isu")?body("KOSPI"):{OutBlock_1:[]}}})});
 assert.equal(v.reason,"KRX_DAY_BOARD_ROSTER_MISSING");
 assert.equal(v.symbols,null);
});
test("duplicated short code across boards rejected",async()=>{
 const v=await collect({dateYmd,authKey:KEY,boards:["KOSPI","KOSDAQ"],
   fetchImpl:async()=>({ok:true,async json(){return body("KOSPI")}})});
 assert.equal(v.reason,"KRX_ISSUE_ID_DATE_OR_DUPLICATE_INVALID");
});
test("future listing cannot be admitted in 2025 research date",async()=>{
 const v=await collect({dateYmd,authKey:KEY,boards:["KOSPI"],
   fetchImpl:async()=>({ok:true,async json(){return body("KOSPI","20260203")}})});
 assert.equal(v.reason,"KRX_ISSUE_ID_DATE_OR_DUPLICATE_INVALID");
});
test("bad dates and impossible 2012 KONEX archive are blocked",async()=>{
 await assert.rejects(()=>collect({dateYmd:"20250230"}),/KRX_DATE_INVALID/);
 const v=await collect({dateYmd:"20121205",authKey:KEY,
   fetchImpl:async()=>{throw Error("do not call")}});
 assert.equal(v.reason,"KRX_BOARD_NOT_HISTORICALLY_AVAILABLE");
 assert.equal(v.details.board,"KONEX");
});
test("network fault is not proof a stock never existed",async()=>{
 const v=await collect({dateYmd,authKey:KEY,boards:["KOSPI"],
   fetchImpl:async()=>{throw Error("offline")}});
 assert.equal(v.reason,"KRX_MARKET_DATA_NETWORK_OR_JSON_ERROR");
 assert.equal(v.dateScopedSymbolCount,null);
});
test("duplicate or unknown board selection stops before requests",async()=>{
 await assert.rejects(()=>collect({dateYmd,boards:["KOSPI","KOSPI"]}),/KRX_BOARD_SET_INVALID/);
 await assert.rejects(()=>collect({dateYmd,boards:["UPBIT"]}),/KRX_BOARD_SET_INVALID/);
});
