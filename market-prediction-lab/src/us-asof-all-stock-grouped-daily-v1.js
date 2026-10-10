import {createHash} from "node:crypto";

/**
 * Historic US all-stock as-of active roster + same-date ALL-STOCKS grouped OHLCV.
 *
 * Official Massive (formerly Polygon) REST sources:
 * GET /v3/reference/tickers?market=stocks&date=YYYY-MM-DD&active=true
 * GET /v2/aggs/grouped/locale/us/market/stocks/YYYY-MM-DD?adjusted=false
 *
 * Explicit authorized key via Bearer header only. NO key in URL/log/output,
 * no environment/secret reads, no provider account/order/private trading API.
 * An as-of retrospective provider snapshot and daily OHLC are NEVER proof
 * of the original scanner watchlist or full historical security lifecycle.
 *
 * Unlike a current Nasdaq directory or a preselected six-name watchlist,
 * every page of the provider's date-scoped roster is considered. Missing
 * daily prices, OTC/outside-roster rows, ticker identity conflicts, holidays,
 * late corrections, split/merge/rename, or unknown research licenses do not
 * become zero-event observations or a profitable historical trading signal.
 */
const BASE="https://api.massive.com";
const TICKER_PATH="/v3/reference/tickers";
const GROUPED_PREFIX="/v2/aggs/grouped/locale/us/market/stocks/";
const MAX_PAGES=64,MAX_GROUP_PAGES=8,MAX_NAMES=80000;
const EASTERN_DATE_FORMAT=new Intl.DateTimeFormat("en-US",{
  timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",
});
const SYMBOL=/^[A-Z0-9][A-Z0-9.\-:]{0,39}$/;
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const dayOk=d=>{
 if(typeof d!=="string"||!DATE.test(d)||d<"2003-09-10")return false;
 const t=Date.parse(d+"T00:00:00.000Z");
 return Number.isSafeInteger(t)&&new Date(t).toISOString().slice(0,10)===d;
};
const digest=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const delay=ms=>new Promise(ok=>setTimeout(ok,ms));
const clean=x=>String(x??"").trim().toUpperCase();
const safe=(date,extra={})=>Object.freeze({
 schemaVersion:"us-historical-asof-active-grouped-daily-source-v1",
 market:"US_STOCK",venue:"US_SIP",date,
 status:"BLOCKED_DATA",reason:"UNKNOWN",
 authorizedProvider:"MASSIVE_STOCKS_ASOF_PLUS_GROUPED",
 providerReadOnlyGETs:0,providerKeyPersisted:false,
 providerKeyTransmittedInURL:false,privateTradingApiUsed:false,
 asOfProviderTickerCount:null,asOfProviderRosterPages:null,
 asOfRosterSha256:null,datedRoster:null,
 groupedProviderDailyBars:null,groupedDailyBarsMatched:null,
 matchedPriceRows:null,missingAsOfSymbolsCount:null,
 missingAsOfSymbolsPreview:null,unmatchedProviderPriceSymbolsCount:null,
 unmatchedProviderPriceSymbolsPreview:null,
 providerHistoryOriginallyAsOfScannerAvailable:false,
 historicalSurvivorshipAndTickerChangeFullyProven:false,
 fullHistoricSecurityMasterAuthenticated:false,
 dailyDateIsETNotUTC:true,
 stockCorporateActionsAndDelistingReturnsModeled:false,
 marketWideDailyOpportunityDenominatorVerified:false,
 fullMarketOpportunityDenominatorVerified:false,
 trueMarketWideRecall:null,actualMarketWideOpportunityCount:null,
 historicalScannerLeadMs:null,actualFillCount:null,netProfitPct:null,
 OOSPassCount:0,profitabilityProven:false,
 executionAuthority:"NONE",liveTrading:false,autoTrading:false,
 realOrders:false,rawMarketDataPublicationAuthorized:false,
 ...extra,
});
export const US_ALL_LISTED_ASOF_PRICE_POLICY_V1=Object.freeze({
 provider:"MASSIVE",
 rosterEndpoint:TICKER_PATH,groupedEndpoint:GROUPED_PREFIX+"{date}",
 oneProviderRosterPageLimit:1000,
 maxRosterPages:MAX_PAGES,maxGroupedPages:MAX_GROUP_PAGES,
 maximumTickerIdentities:MAX_NAMES,
 minRequestGapMs:150,authMethod:"BEARER_HEADER_ONLY",
 originalScannerAvailabilityVerified:false,
});
function etDay(timestamp){
 if(!Number.isSafeInteger(timestamp)||timestamp<=0)return null;
 const values=EASTERN_DATE_FORMAT.formatToParts(new Date(timestamp));
 const part=type=>values.find(x=>x.type===type)?.value;
 const year=part("year"),month=part("month"),day=part("day");
 return year&&month&&day?year+"-"+month+"-"+day:null;
}
function safeCursor(next,requiredPath,date){
 if(next==null||next==="")return {cursor:null};
 if(typeof next!=="string"||next.length>12000)
   return {error:"US_DATED_PROVIDER_PAGINATION_URL_INVALID"};
 let url;
 try{url=new URL(next);}catch{
   return {error:"US_DATED_PROVIDER_PAGINATION_URL_INVALID"};
 }
 if(url.protocol!=="https:"||url.host!=="api.massive.com"||
    url.pathname!==requiredPath||url.username||url.password||url.hash||
    url.searchParams.has("apiKey")||url.searchParams.has("Authorization"))
   return {error:"US_DATED_PROVIDER_PAGINATION_HOST_OR_SCOPE_MISMATCH"};
 for(const [name,expected] of [["date",date],["market","stocks"],["active","true"]]){
   if(url.searchParams.has(name) && (
     url.searchParams.getAll(name).length!==1 ||
     url.searchParams.get(name)!==expected))
     return {error:"US_DATED_PROVIDER_PAGINATION_FILTER_CHANGED"};
 }
 const cursors=url.searchParams.getAll("cursor");
 if(cursors.length!==1||cursors[0].length<1||cursors[0].length>8000)
   return {error:"US_DATED_PROVIDER_PAGINATION_CURSOR_INVALID"};
 return {cursor:cursors[0]};
}
function decodeTicker(row){
 const ticker=clean(row?.ticker);
 if(!SYMBOL.test(ticker)||row?.active!==true||
    row?.market!=="stocks"||row?.locale!=="us")
   return null;
 const figi=row?.share_class_figi??null;
 const composite=row?.composite_figi??null;
 if(figi!=null&&!/^[A-Z0-9]{12}$/.test(figi)||
    composite!=null&&!/^[A-Z0-9]{12}$/.test(composite))
   return null;
 const primary=clean(row.primary_exchange);
 const type=clean(row.type);
 return {ticker,market:"US_STOCK",venue:"US_SIP",activeAsOfDate:true,
   primaryExchangeMIC:primary||null,securityType:type||null,
   compositeFIGI:composite,shareClassFIGI:figi,
   delistedUTC:typeof row.delisted_utc==="string"?row.delisted_utc:null};
}
function barForDate(x,date){
 const symbol=clean(x?.T);
 if(!SYMBOL.test(symbol)||!Number.isSafeInteger(x?.t)
    ||etDay(x.t)!==date)return null;
 const values=[x?.o,x?.h,x?.l,x?.c,x?.v];
 if(!values.every(v=>typeof v==="number"&&Number.isFinite(v)&&v>0)
    ||x.h<Math.max(x.o,x.c)||x.l>Math.min(x.o,x.c)
    ||x.l<=0||x.h<x.l)return null;
 return {symbol,market:"US_STOCK",venue:"US_SIP",
   usEasternTradingDate:date,sourceTimestampMs:x.t,
   open:x.o,high:x.h,low:x.l,close:x.c,volume:x.v,
   sourcePriceConvention:"UNADJUSTED_US_EQUITY_DAILY",
   normalizedUTCDateNotAssumed:true};
}
export async function collectUSAsOfActiveGroupedDailyV1({
 date,apiKey=null,fetchImpl=globalThis.fetch,
 sleepImpl=delay,minIntervalMs=150,maxRosterPages=MAX_PAGES,
 maxGroupedPages=MAX_GROUP_PAGES,
}={}){
 if(!dayOk(date))throw new TypeError("US_ASOF_TRADING_DATE_INVALID");
 if(typeof fetchImpl!=="function"||typeof sleepImpl!=="function"||
    !Number.isInteger(minIntervalMs)||minIntervalMs<150||minIntervalMs>2000||
    !Number.isInteger(maxRosterPages)||maxRosterPages<1||
    maxRosterPages>MAX_PAGES||
    !Number.isInteger(maxGroupedPages)||maxGroupedPages<1||
    maxGroupedPages>MAX_GROUP_PAGES)
   throw new TypeError("US_ASOF_SOURCE_POLICY_INVALID");
 if(typeof apiKey!=="string"||!apiKey.trim())
   return safe(date,{reason:"US_PROVIDER_HISTORICAL_AUTH_NOT_CONNECTED"});
 if(apiKey.length>256)throw new TypeError("US_PROVIDER_AUTH_KEY_LENGTH_INVALID");
 let requests=0;
 const issue=async(url)=>{
   if(requests>0)await sleepImpl(minIntervalMs);
   requests++;
   let res,payload;
   try{
     res=await fetchImpl(url.toString(),{
       method:"GET",headers:{
         Authorization:"Bearer "+apiKey.trim(),Accept:"application/json",
       },signal:AbortSignal.timeout(12000),
       redirect:"error",
     });
     if(!res?.ok)
       return {error:"US_PROVIDER_PUBLIC_HISTORY_HTTP_OR_ENTITLEMENT_BLOCKED",
         status:Number.isInteger(res?.status)?res.status:null};
     payload=await res.json();
   }catch{
     return {error:"US_PROVIDER_PUBLIC_HISTORY_NETWORK_OR_JSON_BLOCKED"};
   }
   if(!payload||payload.status!=="OK"||!Array.isArray(payload.results))
     return {error:"US_PROVIDER_PUBLIC_HISTORY_RESPONSE_INVALID"};
   return {payload};
 };
 const base=()=>({providerReadOnlyGETs:requests});
 const names=[],seenNames=new Set(),seenFIGI=new Map(),types={};
 let cursor=null,rosterPages=0;
 const seenCursors=new Set();
 for(;;){
   if(rosterPages>=maxRosterPages)return safe(date,{
     ...base(),reason:"US_ASOF_ROSTER_PAGE_BUDGET_EXHAUSTED",
   });
   const url=new URL(TICKER_PATH,BASE);
   for(const [k,v] of Object.entries({
     market:"stocks",date,active:"true",order:"asc",sort:"ticker",limit:"1000",
   }))url.searchParams.set(k,v);
   if(cursor)url.searchParams.set("cursor",cursor);
   const {payload,error,status}=await issue(url);
   if(error)return safe(date,{...base(),reason:error,sourceStatusCode:status??null});
   const page=payload.results;
   if(!page.length||page.length>1000)return safe(date,{
     ...base(),reason:"US_ASOF_ROSTER_PAGE_EMPTY_OR_OVERSIZED",
   });
   for(const raw of page){
     const item=decodeTicker(raw);
     if(!item)return safe(date,{...base(),reason:"US_ASOF_ROSTER_SECURITY_IDENTITY_INVALID"});
     if(seenNames.has(item.ticker))return safe(date,{
       ...base(),reason:"US_ASOF_ROSTER_DUPLICATE_TICKER",
     });
     seenNames.add(item.ticker);
     if(item.shareClassFIGI){
       const prior=seenFIGI.get(item.shareClassFIGI);
       if(prior && prior!==item.ticker)return safe(date,{
         ...base(),reason:"US_ASOF_ROSTER_AMBIGUOUS_STABLE_ID",
       });
       seenFIGI.set(item.shareClassFIGI,item.ticker);
     }
     names.push(item);
     types[item.securityType??"UNKNOWN"]=(types[item.securityType??"UNKNOWN"]??0)+1;
   }
   rosterPages++;
   if(names.length>MAX_NAMES)return safe(date,{
     ...base(),reason:"US_ASOF_ROSTER_TOO_MANY_IDENTITIES",
   });
   const n=safeCursor(payload.next_url,TICKER_PATH,date);
   if(n.error)return safe(date,{...base(),reason:n.error});
   if(n.cursor==null)break;
   if(seenCursors.has(n.cursor))return safe(date,{
     ...base(),reason:"US_ASOF_ROSTER_CURSOR_CYCLE",
   });
   seenCursors.add(n.cursor);cursor=n.cursor;
 }
 // One historical all-U.S.-stocks GROUPED endpoint, not thousands of
 // per-ticker daily calls. This aggregates qualifying trades; symbols with
 // no qualifying trades can have NO bar, never a proven zero-price event.
 const groupedPath=GROUPED_PREFIX+date;
 let groupedCursor=null,groupedPages=0;
 const groupCursors=new Set(),bars=[],seenBars=new Set();
 for(;;){
   if(groupedPages>=maxGroupedPages)return safe(date,{
     ...base(),reason:"US_GROUPED_DAY_PAGE_BUDGET_EXHAUSTED",
   });
   const u=new URL(groupedPath,BASE);
   u.searchParams.set("adjusted","false");
   if(groupedCursor)u.searchParams.set("cursor",groupedCursor);
   const {payload,error,status}=await issue(u);
   if(error)return safe(date,{...base(),reason:error,sourceStatusCode:status??null});
   if(payload.adjusted!==false||payload.results.length>100000)
     return safe(date,{...base(),reason:"US_GROUPED_OHLC_ADJUSTMENT_OR_SIZE_UNATTESTED"});
   for(const item of payload.results){
     const row=barForDate(item,date);
     if(!row)return safe(date,{...base(),reason:"US_GROUPED_OHLC_ET_DATE_OR_BAR_INVALID"});
     if(seenBars.has(row.symbol))return safe(date,{
       ...base(),reason:"US_GROUPED_OHLC_DUPLICATE_SECURITY",
     });
     seenBars.add(row.symbol);
     bars.push(row);
   }
   groupedPages++;
   const n=safeCursor(payload.next_url,groupedPath,date);
   if(n.error)return safe(date,{...base(),reason:n.error});
   if(n.cursor==null)break;
   if(groupCursors.has(n.cursor))return safe(date,{...base(),reason:"US_GROUPED_OHLC_CURSOR_CYCLE"});
   groupCursors.add(n.cursor);groupedCursor=n.cursor;
 }
 if(!bars.length)return safe(date,{...base(),reason:"US_GROUPED_OHLC_DAY_EMPTY_OR_UNLICENSED"});
 const outsiders=bars.filter(b=>!seenNames.has(b.symbol)).map(x=>x.symbol);
 if(outsiders.length)return safe(date,{
   ...base(),reason:"US_GROUPED_PRICE_OUTSIDE_ASOF_ACTIVE_ROSTER",
   unmatchedProviderPriceSymbolsCount:outsiders.length,
   unmatchedProviderPriceSymbolsPreview:outsiders.slice(0,25),
 });
 const priceBySymbol=new Map(bars.map(b=>[b.symbol,b]));
 const missing=names.filter(item=>!priceBySymbol.has(item.ticker))
   .map(item=>item.ticker);
 names.sort((a,b)=>a.ticker.localeCompare(b.ticker));
 bars.sort((a,b)=>a.symbol.localeCompare(b.symbol));
 const full=missing.length===0;
 return safe(date,{
   ...base(),status:full?
     "SOURCE_LIMITED_ASOF_ROSTER_GROUPED_PRICES_JOIN_ONLY":
     "PARTIAL_ASOF_ROSTER_PRICE_DATA_BLOCKED",
   reason:full?
     "RETROSPECTIVE_SOURCE_AND_CORPORATE_ACTIONS_NOT_INDEPENDENTLY_VERIFIED":
     "ASOF_ACTIVE_STOCK_WITHOUT_QUALIFYING_DAILY_BAR_OR_SOURCE_GAP",
   asOfProviderTickerCount:names.length,asOfProviderRosterPages:rosterPages,
   asOfRosterSha256:digest({date,names}),datedRoster:Object.freeze(names),
   securityTypesCounts:types,
   stableShareClassFIGIMissingCount:names.filter(x=>!x.shareClassFIGI).length,
   groupedProviderDailyBars:bars.length,groupedDailyBarsMatched:bars.length,
   matchedPriceRows:Object.freeze(bars),
   missingAsOfSymbolsCount:missing.length,
   missingAsOfSymbolsPreview:missing.slice(0,25),
   unmatchedProviderPriceSymbolsCount:0,
   unmatchedProviderPriceSymbolsPreview:[],
   groupedDailySourceSha256:digest({date,bars}),
   asOfProviderSourceFetchedAfterHistoricalDay:true,
   stockCorporateActionsAndDelistingReturnsModeled:false,
   historicalSurvivorshipAndTickerChangeFullyProven:false,
   fullMarketOpportunityDenominatorVerified:false,
   trueMarketWideRecall:null,
   actualMarketWideOpportunityCount:null,
   profitabilityProven:false,executionAuthority:"NONE",
 });
}
