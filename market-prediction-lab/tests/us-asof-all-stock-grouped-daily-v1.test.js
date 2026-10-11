import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,readFileSync,statSync,chmodSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {parseUSAsOfIntakeArgsV1,runUSAsOfSourceCliV1}
  from "../scripts/run-us-asof-grouped-source-v1.mjs";
import {
  collectUSAsOfActiveGroupedDailyV1 as collect,
  US_ALL_LISTED_ASOF_PRICE_POLICY_V1 as policy,
} from "../src/us-asof-all-stock-grouped-daily-v1.js";

const DATE="2025-02-03",API_KEY="UNIT-TEST-ONLY-APPROVED-STOCKS-KEY";
const NY_MIDNIGHT=Date.parse("2025-02-03T05:00:00Z");
const figis={
 A:"BBG001SCTQY4",ABC:"BBG001SCTQY5",DEAD:"BBG001SCTQY6",
};
const ticker=(name,extra={})=>({
 ticker:name,active:true,market:"stocks",locale:"us",
 name:"test "+name,primary_exchange:"XNYS",type:"CS",
 share_class_figi:figis[name]??null,
 composite_figi:"BBG000BWQYZ5",...extra,
});
const bar=(name,extra={})=>({
 T:name,t:NY_MIDNIGHT,o:100,h:116,l:95,c:108,v:90000,...extra,
});
const urlCursor=(cursor,path="/v3/reference/tickers")=>
  "https://api.massive.com"+path+"?cursor="+encodeURIComponent(cursor);

function fakeSource({
 page1=[ticker("A"),ticker("DEAD",{
   delisted_utc:"2025-05-19",
 }),ticker("ABC")],
 page2=[ticker("ABC")],
 grouped=[bar("A"),bar("ABC"),bar("DEAD")],
 extraPages=false,
 groupedAdjusted=false,
 groupStatus="OK",
 badHttpStage=null,
 onCall=()=>{},
}={}){
 let rosterCalls=0,groupCalls=0;
 return async(url,opts)=>{
   const u=new URL(url);
   assert.equal(u.protocol,"https:");
   assert.equal(u.hostname,"api.massive.com");
   assert.equal(u.searchParams.has("apiKey"),false);
   assert.equal(opts.method,"GET");
   assert.equal(opts.headers.Authorization,"Bearer "+API_KEY);
   assert.equal(opts.redirect,"error");
   onCall(url,opts);
   const ref=u.pathname==="/v3/reference/tickers";
   if(ref){
     assert.equal(u.searchParams.get("date"),DATE);
     assert.equal(u.searchParams.get("active"),"true");
     assert.equal(u.searchParams.get("market"),"stocks");
     assert.equal(u.searchParams.get("limit"),"1000");
     rosterCalls++;
     if(badHttpStage==="roster")return {ok:false,status:403};
     const requestedCursor=u.searchParams.get("cursor");
     if(rosterCalls===1){
       assert.equal(requestedCursor,null);
       return {ok:true,status:200,async json(){return {
         status:"OK",results:extraPages?page1.filter(x=>x.ticker!=="ABC"):page1,
         next_url:extraPages?urlCursor("cursor-first"):null,
       }}};
     }
     assert.equal(requestedCursor,"cursor-first");
     return {ok:true,status:200,async json(){return{
       status:"OK",results:page2,
     }}};
   }
   assert.equal(u.pathname,"/v2/aggs/grouped/locale/us/market/stocks/"+DATE);
   assert.equal(u.searchParams.get("adjusted"),"false");
   groupCalls++;
   if(badHttpStage==="group")return {ok:false,status:429};
   return {ok:true,status:200,async json(){return{
     status:groupStatus,adjusted:groupedAdjusted,
     results:grouped,
   }}};
 };
}
test("missing approved US historical provider key blocks BEFORE any network call",async()=>{
 let calls=0;
 const r=await collect({date:DATE,fetchImpl:async()=>{calls++;throw Error("UNSAFE_CALL")}});
 assert.equal(calls,0);
 assert.equal(r.status,"BLOCKED_DATA");
 assert.equal(r.reason,"US_PROVIDER_HISTORICAL_AUTH_NOT_CONNECTED");
 assert.equal(r.asOfProviderTickerCount,null);
 assert.equal(r.trueMarketWideRecall,null);
 assert.equal(r.profitabilityProven,false);
 assert.equal(r.executionAuthority,"NONE");
});
test("historical date active roster includes FUTURE-DELISTED ticker with full-grouped OHLC, 2 pages",async()=>{
 const seen=[],sleepTimes=[];
 const r=await collect({
   date:DATE,apiKey:API_KEY,
   fetchImpl:fakeSource({
     extraPages:true,onCall:(url,opts)=>seen.push({url,opts}),
   }),
   sleepImpl:async t=>sleepTimes.push(t),
 });
 assert.equal(r.status,"SOURCE_LIMITED_ASOF_ROSTER_GROUPED_PRICES_JOIN_ONLY");
 assert.equal(r.asOfProviderTickerCount,3);
 assert.equal(r.asOfProviderRosterPages,2);
 assert.equal(r.providerReadOnlyGETs,3);
 assert.deepEqual(sleepTimes,[150,150]);
 assert.equal(r.datedRoster.length,3);
 assert.deepEqual(r.datedRoster.map(x=>x.ticker),["A","ABC","DEAD"]);
 assert.equal(r.datedRoster.find(x=>x.ticker==="DEAD").delistedUTC,"2025-05-19");
 assert.equal(r.groupedProviderDailyBars,3);
 assert.equal(r.groupedDailyBarsMatched,3);
 assert.equal(r.missingAsOfSymbolsCount,0);
 assert.equal(r.matchedPriceRows[0].usEasternTradingDate,DATE);
 assert.equal(r.matchedPriceRows[0].sourceTimestampMs,NY_MIDNIGHT);
 assert.equal(r.dailyDateIsETNotUTC,true);
 assert.equal(r.stockCorporateActionsAndDelistingReturnsModeled,false);
 assert.equal(r.fullHistoricSecurityMasterAuthenticated,false);
 assert.equal(r.trueMarketWideRecall,null);
 assert.equal(r.actualMarketWideOpportunityCount,null);
 assert.equal(r.profitabilityProven,false);
 assert.match(r.asOfRosterSha256,/^[0-9a-f]{64}$/);
 assert.match(r.groupedDailySourceSha256,/^[0-9a-f]{64}$/);
 assert.equal(JSON.stringify(r).includes(API_KEY),false);
 assert.ok(seen.every(x=>!x.url.includes(API_KEY)));
});
test("no arbitrary universe size limit of six symbols or favorite preselection",async()=>{
 const names=["A","ABC","DEAD","X1","X2","X3","X4","X5","X6","X7"];
 const r=await collect({date:DATE,apiKey:API_KEY,
   fetchImpl:fakeSource({
     page1:names.map((x,i)=>ticker(x,{
       type:i%3===0?"ETF":"CS",
       share_class_figi:null,
     })),
     grouped:names.map(x=>bar(x)),
   }),
 });
 assert.equal(r.asOfProviderTickerCount,10);
 assert.equal(r.matchedPriceRows.length,10);
 assert.equal(r.securityTypesCounts.ETF,4);
 assert.equal(r.stableShareClassFIGIMissingCount,10);
 assert.equal(r.historicalSurvivorshipAndTickerChangeFullyProven,false);
 assert.equal(r.actualMarketWideOpportunityCount,null);
});
test("active as-of named stock without qualifying provider daily bar is partial, never zero event",async()=>{
 const r=await collect({date:DATE,apiKey:API_KEY,
   fetchImpl:fakeSource({grouped:[bar("A"),bar("DEAD")]}),
 });
 assert.equal(r.status,"PARTIAL_ASOF_ROSTER_PRICE_DATA_BLOCKED");
 assert.equal(r.reason,"ASOF_ACTIVE_STOCK_WITHOUT_QUALIFYING_DAILY_BAR_OR_SOURCE_GAP");
 assert.deepEqual(r.missingAsOfSymbolsPreview,["ABC"]);
 assert.equal(r.missingAsOfSymbolsCount,1);
 assert.equal(r.fullMarketOpportunityDenominatorVerified,false);
 assert.equal(r.trueMarketWideRecall,null);
});
test("US ET daily rollover is not UTC midnight, DST correctly distinguishes ET session",async()=>{
 const r=await collect({date:DATE,apiKey:API_KEY,
   fetchImpl:fakeSource({grouped:[bar("A",{
     t:Date.parse("2025-02-02T23:00:00Z"),
   })]}),
 });
 assert.equal(r.reason,"US_GROUPED_OHLC_ET_DATE_OR_BAR_INVALID");
 assert.equal(r.asOfProviderTickerCount,null);
 const badDate=await collect({date:"2025-02-30",apiKey:API_KEY,
   fetchImpl:fakeSource()}).catch(x=>x);
 assert.match(String(badDate.message),/US_ASOF_TRADING_DATE_INVALID/);
});
test("grouped bar from another symbol triggers explicit market-wide denominator blocker",async()=>{
 const r=await collect({date:DATE,apiKey:API_KEY,
   fetchImpl:fakeSource({grouped:[
     bar("A"),bar("ABC"),bar("DEAD"),bar("OUTSIDER"),
   ]}),
 });
 assert.equal(r.reason,"US_GROUPED_PRICE_OUTSIDE_ASOF_ACTIVE_ROSTER");
 assert.equal(r.unmatchedProviderPriceSymbolsCount,1);
 assert.deepEqual(r.unmatchedProviderPriceSymbolsPreview,["OUTSIDER"]);
 assert.equal(r.actualMarketWideOpportunityCount,null);
});
test("a false active ticker or malformed venue identity cannot disappear silently",async()=>{
 for(const invalid of [
   ticker("A",{active:false}),
   ticker("A",{locale:"global"}),
   ticker("A",{market:"otc"}),
   ticker("INVALID/TICKER"),
   ticker("A",{share_class_figi:"NOT_A_FIGI"}),
 ]){
  const r=await collect({date:DATE,apiKey:API_KEY,
   fetchImpl:fakeSource({page1:[invalid]}),
  });
  assert.equal(r.reason,"US_ASOF_ROSTER_SECURITY_IDENTITY_INVALID");
  assert.equal(r.asOfProviderTickerCount,null);
 }
});
test("ticker duplicate across two pages cannot be treated as two distinct opportunity names",async()=>{
 const r=await collect({date:DATE,apiKey:API_KEY,
   fetchImpl:fakeSource({extraPages:true,page2:[ticker("A")]}),
 });
 assert.equal(r.reason,"US_ASOF_ROSTER_DUPLICATE_TICKER");
});
test("provider as-of pages cannot silently lose the rest of the universe at paging limit",async()=>{
 const r=await collect({date:DATE,apiKey:API_KEY,
   fetchImpl:fakeSource({extraPages:true}),maxRosterPages:1,
 });
 assert.equal(r.reason,"US_ASOF_ROSTER_PAGE_BUDGET_EXHAUSTED");
 assert.equal(r.asOfProviderTickerCount,null);
});
test("grouped adjusted bars, absent provider status or invalid OHLC are not economic evidence",async()=>{
 for(const change of [
   {groupedAdjusted:true},
   {groupStatus:"DELAYED"},
   {grouped:[bar("A",{h:90})]},
   {grouped:[bar("A",{v:0})]},
 ]){
   const r=await collect({date:DATE,apiKey:API_KEY,
     fetchImpl:fakeSource(change),
   });
   assert.equal(r.status,"BLOCKED_DATA");
   assert.equal(r.actualMarketWideOpportunityCount,null);
 }
});
test("external pagination domain, changed filter and repeated cursor fail closed",async()=>{
 const urls=[
  "https://attacker.example/v3/reference/tickers?cursor=abc",
  "https://api.massive.com/v3/reference/tickers?cursor=abc&active=false",
  "http://api.massive.com/v3/reference/tickers?cursor=abc",
  "https://api.massive.com/v3/reference/tickers?cursor=abc&apiKey=LEAK",
  "https://api.massive.com/v3/reference/tickers?market=stocks",
 ];
 for(const next of urls){
  const r=await collect({date:DATE,apiKey:API_KEY,
   fetchImpl:async(url,opts)=>({
     ok:true,status:200,async json(){return{
       status:"OK",results:[ticker("A")],next_url:next,
     }},
   }),
  });
  assert.equal(r.status,"BLOCKED_DATA");
  assert.match(r.reason,/PAGINATION/);
 }
});
test("vendor entitlement 403 or 429 is missing data, not no-trade proof",async()=>{
 for(const stage of ["roster","group"]){
  const r=await collect({date:DATE,apiKey:API_KEY,
    fetchImpl:fakeSource({badHttpStage:stage}),
  });
  assert.equal(r.reason,"US_PROVIDER_PUBLIC_HISTORY_HTTP_OR_ENTITLEMENT_BLOCKED");
  assert.ok([403,429].includes(r.sourceStatusCode));
  assert.equal(r.matchedPriceRows,null);
  assert.equal(r.netProfitPct,null);
  assert.equal(r.realOrders,false);
 }
});
test("wrong trading date cannot be converted into false UTC-aligned opportunity",async()=>{
 await assert.rejects(()=>collect({date:"2025-02-31"}),/US_ASOF_TRADING_DATE_INVALID/);
 await assert.rejects(()=>collect({date:"20250203"}),/US_ASOF_TRADING_DATE_INVALID/);
 await assert.rejects(()=>collect({date:DATE,minIntervalMs:0}),/US_ASOF_SOURCE_POLICY_INVALID/);
 assert.equal(policy.maxRosterPages,64);
 assert.equal(policy.maxGroupedPages,8);
 assert.equal(policy.authMethod,"BEARER_HEADER_ONLY");
});

test("US source CLI offline-by-default writes truthful blocker at 0600 and zero network",async()=>{
 const folder=mkdtempSync(join(tmpdir(),"us-asof-offline-"));
 const output=join(folder,"readiness.json");
 let hits=0;
 const cfg=parseUSAsOfIntakeArgsV1([
  "--date",DATE,"--output",output,
 ]);
 const result=await runUSAsOfSourceCliV1(cfg,{
   fetchImpl:async()=>{hits++;throw Error("unexpected HTTP")},
 });
 assert.equal(hits,0);
 assert.equal(result.status,"BLOCKED_DATA");
 assert.equal(result.reason,"US_PROVIDER_HISTORICAL_AUTH_NOT_CONNECTED");
 assert.equal(result.asOfProviderTickerCount,null);
 assert.equal(result.trueMarketWideRecall,null);
 assert.equal(statSync(output).mode&0o077,0);
 const raw=JSON.parse(readFileSync(output,"utf8"));
 assert.equal(raw.source.asOfProviderTickerCount,null);
 assert.equal(raw.source.realOrders,false);
 assert.equal(raw.historicalWholeMarketProfitabilityProven,false);
 await assert.rejects(()=>runUSAsOfSourceCliV1(cfg),/EEXIST/);
});
test("US source CLI requires explicit authorization and private key file for mock full-market capture",async()=>{
 const folder=mkdtempSync(join(tmpdir(),"us-asof-private-"));
 const key=join(folder,"approved-local-test-token");
 const out=join(folder,"historical-source.json");
 writeFileSync(key,API_KEY,{mode:0o600});
 assert.throws(()=>parseUSAsOfIntakeArgsV1([
  "--date",DATE,"--output",out,"--approved-key-file",key,
 ]),/US_ASOF_CLI_EXPLICIT_READ_AND_KEY_REQUIRED/);
 assert.throws(()=>parseUSAsOfIntakeArgsV1([
  "--date",DATE,"--output",out,"--read-public",
 ]),/US_ASOF_CLI_EXPLICIT_READ_AND_KEY_REQUIRED/);
 const cfg=parseUSAsOfIntakeArgsV1([
  "--date",DATE,"--output",out,"--read-public",
  "--approved-key-file",key,
 ]);
 const result=await runUSAsOfSourceCliV1(cfg,{
  fetchImpl:fakeSource(),
  sleepImpl:async()=>{},
 });
 assert.equal(result.status,"SOURCE_LIMITED_ASOF_ROSTER_GROUPED_PRICES_JOIN_ONLY");
 assert.equal(result.asOfProviderTickerCount,3);
 assert.equal(result.groupedDailyBarsMatched,3);
 assert.equal(result.providerReadOnlyGETs,2);
 assert.equal(statSync(out).mode&0o077,0);
 const saved=JSON.parse(readFileSync(out,"utf8"));
 assert.equal(saved.source.datedRoster.length,3);
 assert.equal(saved.source.sourceKeyPersisted,undefined);
 assert.equal(saved.source.providerKeyPersisted,false);
 assert.equal(saved.source.trueMarketWideRecall,null);
 assert.equal(saved.source.profitabilityProven,false);
 assert.equal(JSON.stringify(saved).includes(API_KEY),false);
 chmodSync(key,0o644);
 await assert.rejects(()=>runUSAsOfSourceCliV1({...cfg,output:join(folder,"bad.json")},{
   fetchImpl:async()=>{throw Error("not authorized")},
 }),/US_ASOF_APPROVED_KEY_FILE_UNSAFE/);
});
