import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  auditCompactPITMinuteSelectedWindowChunkV1,
} from "./four-market-pit-minute-compact-selected-window-v1.js";
import {
  resolveSelectedResearchWindowV1, UTC_DAY_MS_V1 as DAY,
} from "./research-selected-window-v1.js";

/**
 * Admin-only HTTP read helper: exposes only completed compact DAY source
 * receipt summaries from a SERVER-CONFIGURED private root, never raw OHLCV.
 *
 * Layout, populated separately via the OFFLINE compact-day CLI:
 *   <root>/<market>/YYYY-MM-DD.json
 *   <root>/<stock-market>/stock-trading-dates.json
 *
 * No supplied source paths, no GET to providers, no DB, secrets or trading.
 * The file digests are self-checks only: NOT independent PIT/vendor attestation
 * or historical scanner as-of proof. No readiness => no profit PASS.
 */
const VENUES=Object.freeze({
  KR_STOCK:"KRX",US_STOCK:"US_SIP",
  CRYPTO_SPOT:"UPBIT_KRW",CRYPTO_FUTURES:"BITGET_USDT_FUTURES",
});
const STOCK=new Set(["KR_STOCK","US_STOCK"]);
const MAX_DAYS=31,DAY_FILE_LIMIT=128*1024,CALENDAR_LIMIT=1024*1024;
const iso=n=>new Date(n).toISOString().slice(0,10);
const fail=code=>{throw new TypeError(code);};
const unavailable=(market,reason)=>Object.freeze({
  schemaVersion:"research-pit-minute-coverage-readonly-v1",
  available:false,status:"BLOCKED_DATA",reason,market,
  report:null,privateSourceFileCount:0,
  providerGETCount:0,financialMutationCount:0,
  originalScannerAsOfAvailabilityVerified:false,
  historicalPITUniverseIndependentlyAuthenticated:false,
  fullMarketOpportunityDenominatorVerified:false,
  trueMarketWideRecall:null,actualFillCount:null,netProfitPct:null,
  profitabilityProven:false,executionAuthority:"NONE",
  liveTrading:false,autoTrading:false,realOrders:false,
});
async function noSymlinkAncestors(path) {
  let at=path;
  while(true) {
    try{
      const st=await lstat(at);
      if(st.isSymbolicLink()||!st.isDirectory())
        fail("PIT_MINUTE_COVERAGE_UNSAFE_DIRECTORY");
    }catch(e){if(e?.code!=="ENOENT")throw e;}
    const parent=dirname(at);if(parent===at)break;at=parent;
  }
}
async function privateDir(path,create=false){
  const st=await lstat(path);
  if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0)
    fail("PIT_MINUTE_COVERAGE_PRIVATE_DIRECTORY_REQUIRED");
}
async function readOnlyPrivateJson(path,maxBytes,optional=false){
  let h;
  try{h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);}
  catch(e){if(optional&&e?.code==="ENOENT")return null;throw e;}
  try{
    const st=await h.stat();
    if(!st.isFile()||st.nlink!==1||(st.mode&0o077)!==0
      ||st.size<2||st.size>maxBytes)
      fail("PIT_MINUTE_COVERAGE_PRIVATE_FILE_INVALID");
    let result;
    try{result=JSON.parse(await h.readFile("utf8"));}
    catch{fail("PIT_MINUTE_COVERAGE_PRIVATE_JSON_INVALID");}
    return result;
  }finally{await h.close();}
}
function dateValue(value,required) {
  if(!required&&value==null)return null;
  if(typeof value!=="string"
    ||!/^\d{4}-\d{2}-\d{2}$/u.test(value))
    fail("PIT_MINUTE_COVERAGE_DATE_INVALID");
  const ms=Date.parse(value+"T00:00:00.000Z");
  if(!Number.isSafeInteger(ms)||iso(ms)!==value)
    fail("PIT_MINUTE_COVERAGE_DATE_INVALID");
  return ms;
}
export async function readResearchPITMinuteCoverageV1({
  root,market,startDate,endDate,cursorDate=null,chunkDays=7,
}={}) {
  if(!Object.hasOwn(VENUES,market)
    ||!Number.isSafeInteger(chunkDays)||chunkDays<1||chunkDays>MAX_DAYS)
    fail("PIT_MINUTE_COVERAGE_SELECTION_INVALID");
  const requestedStart=dateValue(startDate,true),requestedEnd=dateValue(endDate,true);
  const period=resolveSelectedResearchWindowV1({startDate,endDate});
  const start=cursorDate==null?period.startMs:dateValue(cursorDate,true);
  if(start<period.startMs||start>=period.endExclusiveMs)
    fail("PIT_MINUTE_COVERAGE_CURSOR_OUTSIDE_SELECTION");
  const end=Math.min(period.endExclusiveMs,start+chunkDays*DAY);
  if(typeof root!=="string"||!root.trim()||!isAbsolute(root)
    ||resolve(root)!==root)
    return unavailable(market,"SERVER_REPORT_ROOT_NOT_CONFIGURED");
  await noSymlinkAncestors(root);
  try{await privateDir(root);}
  catch(e){
    if(e?.code==="ENOENT")
      return unavailable(market,"SERVER_REPORT_ROOT_NOT_PRESENT");
    throw e;
  }
  const venueDir=join(root,market);
  try{await privateDir(venueDir);}
  catch(e){
    if(e?.code==="ENOENT")
      return unavailable(market,"MARKET_COMPACT_REPORTS_NOT_PRESENT");
    throw e;
  }
  let stockTradingDates=null;
  if(STOCK.has(market)) {
    const index=await readOnlyPrivateJson(
      join(venueDir,"stock-trading-dates.json"),CALENDAR_LIMIT,true);
    if(index!=null){
      if(!index||typeof index!=="object"||Array.isArray(index)
        ||Object.keys(index).length!==2||index.market!==market
        ||!Array.isArray(index.tradingDates))
        fail("PIT_MINUTE_COVERAGE_STOCK_CALENDAR_INVALID");
      stockTradingDates=index.tradingDates;
    }
  }
  const receipts=[];
  for(let dateMs=start;dateMs<end;dateMs+=DAY){
    const day=iso(dateMs);
    // This is a date-key only; arbitrary filepaths never cross the HTTP
    // boundary and are never echoed to the browser.
    const receipt=await readOnlyPrivateJson(
      join(venueDir,day+".json"),DAY_FILE_LIMIT,true);
    if(receipt!=null)receipts.push(receipt);
  }
  const report=auditCompactPITMinuteSelectedWindowChunkV1({
    market,researchWindow:{startDate,endDate},cursorDate,
    chunkCalendarDays:chunkDays,stockTradingDates,
    dayReceipts:receipts,
  });
  return Object.freeze({
    schemaVersion:"research-pit-minute-coverage-readonly-v1",
    available:true,market,venue:VENUES[market],
    status:report.status,reason:report.reason??null,
    report,privateSourceFileCount:receipts.length,
    providerGETCount:0,financialMutationCount:0,
    originalScannerAsOfAvailabilityVerified:false,
    historicalPITUniverseIndependentlyAuthenticated:false,
    fullMarketOpportunityDenominatorVerified:false,
    trueMarketWideRecall:null,actualFillCount:null,netProfitPct:null,
    profitabilityProven:false,executionAuthority:"NONE",
    liveTrading:false,autoTrading:false,realOrders:false,
  });
}
