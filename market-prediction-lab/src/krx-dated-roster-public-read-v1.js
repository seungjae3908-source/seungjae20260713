import {createHash} from "node:crypto";
/**
 * Read-only KRX market-data API adapter for daily issue base information.
 * A single historical daily roster is NOT a 3-year PIT listing/delisting
 * archive or proof a signal/scanner/fill existed at the event time.
 * No secret/env persistence, private brokerage API, Paper/OMS, orders or DB.
 */
const API=Object.freeze({
  KOSPI:"/svc/apis/sto/stk_isu_base_info",
  KOSDAQ:"/svc/apis/sto/ksq_isu_base_info",
  KONEX:"/svc/apis/sto/knx_isu_base_info",
});
const START=Object.freeze({KOSPI:"20100104",KOSDAQ:"20100104",KONEX:"20130701"});
const YMD=/^\d{8}$/;
function validDate(s){
 if(typeof s!=="string"||!YMD.test(s))return false;
 const y=+s.slice(0,4),m=+s.slice(4,6),d=+s.slice(6);
 const dt=new Date(Date.UTC(y,m-1,d));
 return dt.toISOString().slice(0,10).replace(/-/g,"")===s;
}
function hold(dateYmd,reason,details={}){
 return Object.freeze({
   schemaVersion:"krx-public-dated-security-roster-v1",
   status:"BLOCKED_DATA",dateYmd,reason,details,
   markets:null,dateScopedSymbolCount:null,symbols:null,sourceSha256:null,
   delistedHistoryVerified:false,entireDatePITUniverseProven:false,
   fullMarketOpportunityDenominatorVerified:false,trueMarketWideRecall:null,
   historicalScannerOriginalCaptureVerified:false,actualFillCount:null,
   costAdjustedNetReturnPct:null,profitabilityProven:false,
   executionAuthority:"NONE",realOrders:false,privateProviderTradeApi:false,
 });
}
export async function collectKrxDatedRosterV1({
  dateYmd,boards=["KOSPI","KOSDAQ","KONEX"],authKey=null,fetchImpl=globalThis.fetch,
}={}){
 if(!validDate(dateYmd)||dateYmd<"20100104")throw new TypeError("KRX_DATE_INVALID");
 if(!Array.isArray(boards)||!boards.length||boards.length>3
   ||boards.some(b=>!Object.hasOwn(API,b))||new Set(boards).size!==boards.length)
   throw new TypeError("KRX_BOARD_SET_INVALID");
 if(typeof fetchImpl!=="function")throw new TypeError("KRX_HTTP_CLIENT_INVALID");
 const unsupported=boards.find(b=>dateYmd<START[b]);
 if(unsupported)return hold(dateYmd,"KRX_BOARD_NOT_HISTORICALLY_AVAILABLE",{board:unsupported});
 if(typeof authKey!=="string"||!authKey.trim())
   return hold(dateYmd,"KRX_READONLY_MARKET_DATA_AUTH_REQUIRED");
 if(authKey.length>256)throw new TypeError("KRX_KEY_TOO_LONG");
 const listed=[],boardsCount={},seen=new Set();
 for(const board of boards){
   const url="https://data-dbg.krx.co.kr"+API[board]+"?basDd="+dateYmd;
   let payload;
   try{
     const res=await fetchImpl(url,{
       method:"GET",headers:{AUTH_KEY:authKey.trim(),Accept:"application/json"},
       signal:AbortSignal.timeout(12_000),
     });
     if(!res?.ok)return hold(dateYmd,"KRX_MARKET_DATA_HTTP_UNAVAILABLE",{
       board,httpStatus:Number.isInteger(res?.status)?res.status:null,
     });
     payload=await res.json();
   }catch{
     return hold(dateYmd,"KRX_MARKET_DATA_NETWORK_OR_JSON_ERROR",{board});
   }
   const rows=payload?.OutBlock_1;
   if(!Array.isArray(rows)||rows.length<1||rows.length>10000)
     return hold(dateYmd,"KRX_DAY_BOARD_ROSTER_MISSING",{board});
   for(const [i,row] of rows.entries()){
     const isin=String(row?.ISU_CD??"").trim().toUpperCase();
     const shortCode=String(row?.ISU_SRT_CD??"").trim().toUpperCase();
     const listedYmd=String(row?.LIST_DD??"").replace(/-/g,"");
     if(!/^[A-Z0-9]{12}$/.test(isin)||!/^[A-Z0-9]{6}$/.test(shortCode)
       ||!validDate(listedYmd)||listedYmd>dateYmd
       ||seen.has(shortCode)){
       return hold(dateYmd,"KRX_ISSUE_ID_DATE_OR_DUPLICATE_INVALID",{board,rowIndex:i});
     }
     seen.add(shortCode);
     listed.push({
       marketBoard:board,isin,shortCode,listedYmd,
       marketType:String(row?.MKT_TP_NM??"").trim(),
       securityGroup:String(row?.SECUGRP_NM??"").trim(),
     });
   }
   boardsCount[board]=rows.length;
 }
 listed.sort((a,b)=>a.marketBoard.localeCompare(b.marketBoard)||a.shortCode.localeCompare(b.shortCode));
 const digest=createHash("sha256").update(JSON.stringify({
   dateYmd,markets:boardsCount,symbols:listed,
 })).digest("hex");
 return Object.freeze({
   schemaVersion:"krx-public-dated-security-roster-v1",
   status:"OBSERVED_KRX_DAY_ROSTER_ONLY",
   dateYmd,source:"KRX_OPENAPI_ISSUE_BASE_INFO",
   markets:boardsCount,dateScopedSymbolCount:listed.length,
   symbols:listed,sourceSha256:digest,
   // Roster fetched now is retrospective, NOT the original as-of scanner list.
   delistedHistoryVerified:false,entireDatePITUniverseProven:false,
   fullMarketOpportunityDenominatorVerified:false,trueMarketWideRecall:null,
   historicalScannerOriginalCaptureVerified:false,actualFillCount:null,
   costAdjustedNetReturnPct:null,profitabilityProven:false,
   executionAuthority:"NONE",realOrders:false,privateProviderTradeApi:false,
   authKeyPersisted:false,
 });
}
