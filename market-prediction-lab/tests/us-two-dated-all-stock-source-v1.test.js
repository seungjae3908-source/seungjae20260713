import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {collectUSTwoDatedAsOfAllStockPricesV1 as collect}
  from "../src/us-two-dated-all-stock-source-v1.js";
const CURRENT="2025-02-03",PRIOR="2025-01-31",K="ONLY-UNIT-TEST-APPROVED-KEY";
const FIGI={
 A:"BBG001SCTQY4",ABC:"BBG001SCTQY5",
 DEAD:"BBG001SCTQY6",IPO:"BBG001SCTQY7",
 OLD:"BBG001SCTQY8",NEW:"BBG001SCTQY8",
};
const defaults=["A","ABC","DEAD"];
function symbol(ticker,overrides={}){
 return {ticker,active:true,market:"stocks",locale:"us",
   primary_exchange:"XNYS",type:"CS",
   share_class_figi:FIGI[ticker],
   delisted_utc:ticker==="DEAD"?"2025-04-18":undefined,
   ...overrides};
}
const localMidnight=date=>Date.parse(date+"T05:00:00Z");
function agg(name,date,pct=0){
 return {T:name,t:localMidnight(date),o:100,h:110+pct,l:90,
   c:105+pct,v:100000};
}
function fixture({priorNames=defaults,currentNames=defaults,
                  priorOverrides={},currentOverrides={},
                  priorBars=null,currentBars=null,
                  blockDate=null}={}){
 const calls=[];
 const fn=async(url,opts)=>{
   const u=new URL(url);
   calls.push(url);
   assert.equal(u.hostname,"api.massive.com");
   assert.equal(u.searchParams.has("apiKey"),false);
   assert.equal(opts.headers.Authorization,"Bearer "+K);
   assert.equal(opts.method,"GET");
   const isRoster=u.pathname==="/v3/reference/tickers";
   const day=isRoster?u.searchParams.get("date"):u.pathname.split("/").at(-1);
   assert.ok([CURRENT,PRIOR].includes(day));
   if(blockDate===day)return {ok:false,status:403};
   const names=day===PRIOR?priorNames:currentNames;
   const overrides=day===PRIOR?priorOverrides:currentOverrides;
   return {ok:true,status:200,async json(){
     if(isRoster){
       assert.equal(u.searchParams.get("market"),"stocks");
       assert.equal(u.searchParams.get("active"),"true");
       return {status:"OK",results:names.map(name=>symbol(name,overrides[name]))};
     }
     assert.equal(u.searchParams.get("adjusted"),"false");
     const values=day===PRIOR?priorBars:currentBars;
     return {status:"OK",adjusted:false,results:values??names.map(name=>agg(name,day))};
   }};
 };
 return {fetchImpl:fn,calls};
}
test("no vendor entitlement means US 2-date full-market source makes zero GETs",async()=>{
 let count=0;
 const r=await collect({currentDate:CURRENT,priorCandidateTradingDate:PRIOR,
   fetchImpl:async()=>{count++;throw Error("unsafe");}});
 assert.equal(count,0);
 assert.equal(r.reason,"US_PROVIDER_HISTORICAL_AUTH_NOT_CONNECTED");
 assert.equal(r.readOnlyProviderGETs,0);
 assert.equal(r.joinedPriorDailyPriceCount,null);
 assert.equal(r.trueMarketWideRecall,null);
 assert.equal(r.executionAuthority,"NONE");
});
test("actual FRIDAY-MONDAY source dates use genuine ET daily prices and do not invent weekend candles",async()=>{
 const mocked=fixture(),delays=[];
 const r=await collect({
   currentDate:CURRENT,priorCandidateTradingDate:PRIOR,
   apiKey:K,fetchImpl:mocked.fetchImpl,
   sleepImpl:async ms=>{delays.push(ms)},
 });
 assert.equal(r.status,"SOURCE_LIMITED_TWO_US_ASOF_DATES_JOINED_ONLY");
 assert.equal(r.readOnlyProviderGETs,4);
 assert.deepEqual(delays,[150,150,150]);
 assert.equal(mocked.calls.length,4);
 assert.equal(r.observedCurrentAsOfTickerCount,3);
 assert.equal(r.joinedPriorDailyPriceCount,3);
 assert.equal(r.missingPriorPriceOrIdentityCount,0);
 assert.deepEqual(r.rows.map(x=>x.symbol),["A","ABC","DEAD"]);
 assert.equal(r.rows[0].priorCandidateTradingDate,PRIOR);
 assert.equal(r.rows[0].asOfDate,CURRENT);
 assert.equal(r.rows[0].priorClose,105);
 assert.equal(r.rows[0].currentBarUSLocalDate,CURRENT);
 assert.equal(r.rows[0].priorBarUSLocalDate,PRIOR);
 assert.equal(r.adjacentStockTradingSessionsAuthenticated,false);
 assert.equal(r.permanentShareClassIdentityComplete,false);
 assert.equal(r.twoDatedSourceShareClassIdentityMatched,true);
 assert.equal(r.corporateActionsAndTickerChangesCanonicallyResolved,false);
 assert.equal(r.fullThreeYearListedAndDelistedRosterVerified,false);
 assert.equal(r.actualMarketWideOpportunityCount,null);
 assert.equal(r.trueMarketWideRecall,null);
 assert.equal(r.profitabilityProven,false);
 assert.equal(JSON.stringify(r).includes(K),false);
 assert.match(r.sourceRowsSha256,/^[0-9a-f]{64}$/);
 assert.equal(r.joinedSourceRowsSha256,
   createHash("sha256").update(JSON.stringify(r.rows)).digest("hex"));
});
test("new listing is not a zero move; missing last historical as-of active symbol is visible",async()=>{
 const mocked=fixture({
   currentNames:[...defaults,"IPO"],
 });
 const r=await collect({currentDate:CURRENT,priorCandidateTradingDate:PRIOR,
   apiKey:K,fetchImpl:mocked.fetchImpl,
   sleepImpl:async()=>{},
 });
 assert.equal(r.status,"PARTIAL_US_PRIOR_PRICE_OR_LIFECYCLE_BLOCKED");
 assert.equal(r.observedCurrentAsOfTickerCount,4);
 assert.equal(r.joinedPriorDailyPriceCount,3);
 assert.equal(r.missingPriorPriceOrIdentityCount,1);
 assert.deepEqual(r.symbolsNeedingPriorReviewPreview,[{
   symbol:"IPO",reason:"NO_PRIOR_ACTIVE_LISTING_OR_NEW_STOCK",
 }]);
 assert.equal(r.fullMarketOpportunityDenominatorVerified,false);
 assert.equal(r.trueMarketWideRecall,null);
});
test("ticker reuse with different share-class FIGI fails even when price fields look complete",async()=>{
 const mocked=fixture({
  priorOverrides:{A:{share_class_figi:"BBG001SCTQY9"}},
 });
 const r=await collect({currentDate:CURRENT,priorCandidateTradingDate:PRIOR,
   apiKey:K,fetchImpl:mocked.fetchImpl,
 });
 assert.equal(r.status,"PARTIAL_US_PRIOR_PRICE_OR_LIFECYCLE_BLOCKED");
 assert.equal(r.identityBlockerCounts.REUSED_TICKER_OR_CHANGED_STABLE_ID,1);
 assert.equal(r.joinedPriorDailyPriceCount,2);
 assert.equal(r.actualFillCount,null);
});
test("renamed ticker with same FIGI needs explicit historical corporate-action link",async()=>{
 const mocked=fixture({
   priorNames:["OLD"],currentNames:["NEW"],
 });
 const r=await collect({currentDate:CURRENT,priorCandidateTradingDate:PRIOR,
   apiKey:K,fetchImpl:mocked.fetchImpl,
 });
 assert.equal(r.status,"PARTIAL_US_PRIOR_PRICE_OR_LIFECYCLE_BLOCKED");
 assert.equal(r.identityBlockerCounts.TICKER_RENAME_REQUIRES_LIFECYCLE_MAPPING,1);
 assert.equal(r.joinedPriorDailyPriceCount,0);
 assert.equal(r.corporateActionsAndTickerChangesCanonicallyResolved,false);
});
test("provider missing GROUPED price in prior day blocks entire previous data, no retrospective guessing",async()=>{
 const mocked=fixture({priorBars:[agg("A",PRIOR),agg("ABC",PRIOR)]});
 const r=await collect({currentDate:CURRENT,priorCandidateTradingDate:PRIOR,
   apiKey:K,fetchImpl:mocked.fetchImpl,
 });
 assert.equal(r.status,"BLOCKED_DATA");
 assert.equal(r.reason,"US_PRIOR_DAY_ALL_NAME_SOURCE_NOT_COMPLETE");
 assert.equal(r.priorDaySourceStatus,"PARTIAL_ASOF_ROSTER_PRICE_DATA_BLOCKED");
 assert.equal(r.joinedPriorDailyPriceCount,null);
 assert.equal(r.actualMarketWideOpportunityCount,null);
});
test("provider HTTP failure on requested historical current date is blocked, not zero outcome",async()=>{
 const mocked=fixture({blockDate:CURRENT});
 const r=await collect({currentDate:CURRENT,priorCandidateTradingDate:PRIOR,
   apiKey:K,fetchImpl:mocked.fetchImpl,
 });
 assert.equal(r.status,"BLOCKED_DATA");
 assert.equal(r.reason,"US_CURRENT_DAY_ALL_NAME_SOURCE_NOT_COMPLETE");
 assert.equal(r.currentDaySourceStatus,"BLOCKED_DATA");
 assert.equal(r.trueMarketWideRecall,null);
});
test("pairing two arbitrary dates is not an official stock-session calendar",async()=>{
 for(const args of [
   {currentDate:"2025-02-30",priorCandidateTradingDate:PRIOR},
   {currentDate:CURRENT,priorCandidateTradingDate:CURRENT},
   {currentDate:CURRENT,priorCandidateTradingDate:"2025-02-04"},
   {currentDate:CURRENT,priorCandidateTradingDate:"2024-12-01"},
 ]){
   await assert.rejects(()=>collect(args),/US_TWO_DATED_SESSION_WINDOW_INVALID/);
 }
 const mock=fixture();
 const a=await collect({currentDate:CURRENT,priorCandidateTradingDate:PRIOR,
   apiKey:K,fetchImpl:mock.fetchImpl,
 });
 assert.equal(a.adjacentStockTradingSessionsAuthenticated,false);
 assert.equal(a.fullMarketOpportunityDenominatorVerified,false);
 assert.equal(a.OOSPassCount,0);
 assert.equal(a.realOrders,false);
});
