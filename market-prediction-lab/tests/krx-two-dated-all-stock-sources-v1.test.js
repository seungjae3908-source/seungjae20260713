import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {collectKrxTwoDatedFullStockDailySourcesV1 as collect,
  KRX_TWO_DATED_SESSION_PRICE_POLICY_V1 as policy}
 from "../src/krx-two-dated-all-stock-sources-v1.js";
const current="20250210",prior="20250207",KEY="TEST-KRX-READ-ONLY";
const board=url=>url.includes("/stk_")?"KOSPI":
  url.includes("/ksq_")?"KOSDAQ":url.includes("/knx_")?"KONEX":null;
const base={
 KOSPI:{ISU_CD:"KR7005930003",ISU_SRT_CD:"005930",
  LIST_DD:"19880101"},
 KOSDAQ:{ISU_CD:"KR7035420009",ISU_SRT_CD:"035420",
  LIST_DD:"20020101"},
 KONEX:{ISU_CD:"KR7278990005",ISU_SRT_CD:"278990",
  LIST_DD:"20180101"},
};
function fake({newListing=false,missingQuoteBoard=null,
 oldTickerReused=false}={}){
 return async(url,opts)=>{
  const u=new URL(url),day=u.searchParams.get("basDd");
  const marketBoard=board(url);
  assert.equal(u.hostname,"data-dbg.krx.co.kr");
  assert.equal(opts.method,"GET");
  assert.equal(opts.headers.AUTH_KEY,KEY);
  assert.ok([current,prior].includes(day));
  assert.ok(marketBoard);
  const rows=[{...base[marketBoard]}];
  if(marketBoard==="KOSPI"&&day===current&&newListing)
    rows.push({ISU_CD:"KR7000660001",ISU_SRT_CD:"000660",
      LIST_DD:current});
  if(url.includes("_isu_base_info"))
    return {ok:true,status:200,async json(){
      return {OutBlock_1:rows.map(x=>({
        ...x,MKT_TP_NM:marketBoard,SECUGRP_NM:"STOCK",
      }))};
    }};
  if(url.includes("_bydd_trd")){
    if(marketBoard===missingQuoteBoard&&day===current)
      return {ok:false,status:403};
    return {ok:true,status:200,async json(){
      return {OutBlock_1:rows.map(x=>{
        const open=day===current?"10,000":"9,000";
        const close=day===current?"10,500":"9,400";
        const rawCode=oldTickerReused&&marketBoard==="KOSPI"&&day===prior
          ?x.ISU_SRT_CD:x.ISU_CD;
        return {BAS_DD:day,ISU_CD:rawCode,
          TDD_OPNPRC:open,TDD_HGPRC:day===current?"11,000":"9,800",
          TDD_LWPRC:"8,900",TDD_CLSPRC:close,
          ACC_TRDVOL:"1,000",ACC_TRDVAL:"9,500,000"};
      })};
    }};
  }
  throw Error("unexpected KRX endpoint");
 };
}
test("missing approved KRX key makes zero requests for both listed stocks and OHLC",async()=>{
 let count=0;
 const a=await collect({currentDateYmd:current,priorTradingDateYmd:prior,
  fetchImpl:async()=>{count++;throw Error("unsafe")}});
 assert.equal(count,0);
 assert.equal(a.status,"BLOCKED_MARKET_DATA_ENTITLEMENT");
 assert.equal(a.authorizedKRXDailyGETs,0);
 assert.equal(a.trueMarketWideRecall,null);
 assert.equal(a.records,null);
 assert.equal(a.executionAuthority,"NONE");
});
test("two chosen historical KRX source dates join all three boards and no weekend fake bar",async()=>{
 const seen=[],sleeps=[];
 const a=await collect({currentDateYmd:current,priorTradingDateYmd:prior,
  authKey:KEY,fetchImpl:async(url,opts)=>{
    seen.push({url,opts});return fake()(url,opts);
  },sleepImpl:async ms=>sleeps.push(ms)});
 assert.equal(a.status,"SOURCE_LIMITED_TWO_KRX_DATES_JOINED_ONLY");
 assert.equal(a.authorizedKRXDailyGETs,12);
 assert.equal(seen.length,12);
 assert.deepEqual(sleeps,Array(11).fill(150));
 assert.equal(a.observedCurrentSymbols,3);
 assert.equal(a.joinedPriorPriceSymbols,3);
 assert.equal(a.missingPreviousPriceCount,0);
 assert.equal(a.records.length,3);
 assert.equal(a.records.find(x=>x.symbol==="005930").priorClose,9400);
 assert.equal(a.records.find(x=>x.symbol==="005930").close,10500);
 assert.equal(a.records.find(x=>x.symbol==="005930").priorCandidateTradingDateYmd,prior);
 assert.equal(a.records.find(x=>x.symbol==="005930").currentTradingDateYmd,current);
 assert.match(a.recordSha256,/^[a-f0-9]{64}$/);
 assert.equal(a.joinedSourceRowsSha256,
   createHash("sha256").update(JSON.stringify(a.records)).digest("hex"));
 assert.equal(a.officialAdjacentTradingSessionCalendarVerified,false);
 assert.equal(a.corporateActionsAdjustedAndVerified,false);
 assert.equal(a.fullMarketOpportunityDenominatorVerified,false);
 assert.equal(a.trueMarketWideRecall,null);
 assert.equal(a.profitabilityProven,false);
 assert.equal(JSON.stringify(a).includes(KEY),false);
 assert.equal(a.realOrders,false);
});
test("newly listed current-day stock has missing prior price, cannot be scored as a zero move",async()=>{
 const a=await collect({currentDateYmd:current,priorTradingDateYmd:prior,
  authKey:KEY,fetchImpl:fake({newListing:true}),sleepImpl:async()=>{}});
 assert.equal(a.status,"PARTIAL_PRIOR_SESSION_STOCK_SOURCE_BLOCKED");
 assert.equal(a.observedCurrentSymbols,4);
 assert.equal(a.joinedPriorPriceSymbols,3);
 assert.equal(a.missingPreviousPriceCount,1);
 assert.equal(a.unmatchedPriorISINsPreview[0].symbol,"000660");
 assert.equal(a.actualMarketWideOpportunityCount,null);
 assert.equal(a.trueMarketWideRecall,null);
});
test("KRX daily quote HTTP failure preserves blocked date and stage, not missing opportunity",async()=>{
 const a=await collect({currentDateYmd:current,priorTradingDateYmd:prior,
  authKey:KEY,fetchImpl:fake({missingQuoteBoard:"KOSDAQ"}),
  sleepImpl:async()=>{}});
 assert.equal(a.status,"BLOCKED_DATA");
 assert.equal(a.reason,"KRX_DAILY_QUOTE_HTTP_BLOCKED");
 assert.equal(a.sourceFailureStage,"DATED_THREE_BOARD_OHLC");
 assert.equal(a.sourceFailureDate,current);
 assert.ok(a.authorizedKRXDailyGETs<=12);
 assert.equal(a.trueMarketWideRecall,null);
});
test("invalid earlier session range and unverified impossible dates are rejected",async()=>{
 for(const [currentDay,priorDay] of [
  ["20250230",prior],["20250210","20250210"],
  ["20250210","20250211"],["20250210","20250110"],
 ]){
  await assert.rejects(()=>collect({
    currentDateYmd:currentDay,priorTradingDateYmd:priorDay,
  }),/KRX_TWO_DAY_WINDOW_OR_PRIOR_SESSION_CLAIM_INVALID/);
 }
 await assert.rejects(()=>collect({
  currentDateYmd:current,priorTradingDateYmd:prior,
  minGapMs:0,
 }),/KRX_TWO_DAY_SOURCE_IO_POLICY_INVALID/);
 assert.equal(policy.maxPublicReadOnlyGETs,12);
 assert.equal(policy.maxDates,2);
 assert.equal(policy.previousOfficialSessionProven,false);
});
test("six-symbol altcoin QA and current-only catalog never establish entire historical stock universe",async()=>{
 const a=await collect({currentDateYmd:current,priorTradingDateYmd:prior,
  authKey:KEY,fetchImpl:fake(),sleepImpl:async()=>{}});
 assert.equal(a.status,"SOURCE_LIMITED_TWO_KRX_DATES_JOINED_ONLY");
 assert.equal(a.fullMarketHistoricDelistedUniverseVerified,false);
 assert.equal(a.venueNativeIntradayEvidenceAvailable,false);
 assert.equal(a.officialAdjacentTradingSessionCalendarVerified,false);
 assert.equal(a.corporateActionsAdjustedAndVerified,false);
 assert.equal(a.actualFillCount,null);
});
