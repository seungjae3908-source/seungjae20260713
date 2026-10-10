import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtempSync,readFileSync,writeFileSync,statSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";

/**
 * Real local-file translation boundary:
 * source provider-shaped two-date JSON -> Node CLI -> canonical JSON ->
 * existing Python opportunity_coverage_audit_v1.py -> retrospective label.
 *
 * Twenty-five synthetic symbols are a CONTRACT FIXTURE, NOT an actual
 * historical market denominator, original scanner observation, or profit.
 * Network/provider credentials/orders and Replit are never accessed.
 */
const lab=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const nodeCli=join(lab,"scripts","prepare-stock-source-limited-daily-evidence-v1.mjs");
const pythonCli=join(lab,"scripts","report-stock-source-limited-daily-opportunity-v1.py");
const digest=createHash("sha256").update("file-fixture-only").digest("hex");

function receipt(market, count=25){
 const kr=market==="KR_STOCK";
 const prior=kr?"20250207":"2025-01-31";
 const current=kr?"20250210":"2025-02-03";
 const rows=Array.from({length:count},(_,i)=>{
  const symbol=kr?String(100000+i):"SAMPLE"+String(i).padStart(3,"0");
  const currentHigh=i===0?122:i===1?115:i===2?108:104;
  const prices={
   priorOpen:99,priorHigh:103,priorLow:98,priorClose:100,
   priorVolume:1000,open:101,high:currentHigh,low:100,
   close:102,volume:1000,
  };
  return kr?{
   ...prices,market,venue:"KRX",symbol,
   isin:"KR"+String(i+1).padStart(10,"0"),
   marketBoard:["KOSPI","KOSDAQ","KONEX"][i%3],
   currentTradingDateYmd:current,priorCandidateTradingDateYmd:prior,
   sourceIdentity:"KRX_OFFICIAL_DATED_TRADING_INFO",
   automaticCorporateActionAdjustmentApplied:false,
  }:{
   ...prices,market,venue:"US_SIP",symbol,
   shareClassFIGI:"BBG"+String(i+1).padStart(9,"0"),
   asOfDate:current,priorCandidateTradingDate:prior,
   primaryExchangeMIC:"XNYS",securityType:"CS",
   priorBarSourceTimestampMs:Date.parse("2025-01-31T21:00:00Z"),
   priorBarUSLocalDate:prior,
   currentBarSourceTimestampMs:Date.parse("2025-02-03T21:00:00Z"),
   currentBarUSLocalDate:current,venueTimeZone:"America/New_York",
   sourceAdjustedForSplits:false,
   corporateActionAdjustmentAuthenticated:false,
   previousSessionCalendarAuthenticated:false,
  };
 });
 return {
  schemaVersion:kr?"krx-authorized-two-session-all-stock-intake-v1":
    "us-two-dated-asof-all-stocks-price-source-v1",
  market,venue:kr?"KRX":"US_SIP",
  status:kr?"SOURCE_LIMITED_TWO_KRX_DATES_JOINED_ONLY":
    "SOURCE_LIMITED_TWO_US_ASOF_DATES_JOINED_ONLY",
  requestedTradingDates:[prior,current],
  executionAuthority:"NONE",profitabilityProven:false,
  trueMarketWideRecall:null,actualMarketWideOpportunityCount:null,
  fullMarketOpportunityDenominatorVerified:false,
  joinedSourceRowsSha256:createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
  ...(kr?{
   records:rows,recordSha256:digest,
   observedCurrentSymbols:count,joinedPriorPriceSymbols:count,
   missingPreviousPriceCount:0,
   officialAdjacentTradingSessionCalendarVerified:false,
   corporateActionsAdjustedAndVerified:false,
   fullMarketHistoricDelistedUniverseVerified:false,
  }:{
   rows,sourceRowsSha256:digest,
   observedCurrentAsOfTickerCount:count,
   joinedPriorDailyPriceCount:count,
   missingPriorPriceOrIdentityCount:0,
   adjacentStockTradingSessionsAuthenticated:false,
   corporateActionsAndTickerChangesCanonicallyResolved:false,
   fullThreeYearListedAndDelistedRosterVerified:false,
   permanentShareClassIdentityComplete:false,
   twoDatedSourceShareClassIdentityMatched:true,
  }),
 };
}
function call(program,args){
 const run=spawnSync(program,args,{
  encoding:"utf8",maxBuffer:2*1024*1024,timeout:120000,
  env:{PATH:process.env.PATH??"/usr/bin:/bin",PYTHONDONTWRITEBYTECODE:"1"},
 });
 if(run.error)throw run.error;
 assert.equal(run.status,0,
   program+" exited "+String(run.status)+" stderr: "+run.stderr);
 const lines=run.stdout.trim().split("\n");
 return JSON.parse(lines.at(-1));
}
function inTemp(callback){
 const folder=mkdtempSync(join(tmpdir(),"stock-25-file-chain-"));
 try{return callback(folder);}
 finally{rmSync(folder,{recursive:true,force:true});}
}
function writePrivate(path, value){
 writeFileSync(path,JSON.stringify(value),{mode:0o600,flag:"wx"});
}
function paths(folder,market){
 return {
  input:join(folder,market+"-receipt.json"),
  packed:join(folder,market+"-packed.json"),
  output:join(folder,market+"-events.json"),
 };
}
function prepare(market,p){
 return call(process.execPath,[nodeCli,"--market",market,"--input",p.input,
   "--output",p.packed,"--test-fixture"]);
}
function score(p){
 return call("python3",[pythonCli,"--input",p.packed,"--output",p.output]);
}

test("KR and US 25-name original private receipts traverse both CLI processes without a six-name cap",()=>{
 inTemp(folder=>{
  for(const market of ["KR_STOCK","US_STOCK"]){
   const p=paths(folder,market);
   writePrivate(p.input,receipt(market));
   const startDigest=createHash("sha256").update(readFileSync(p.input)).digest("hex");
   const prep=prepare(market,p);
   assert.equal(prep.status,"TEST_FIXTURE_TWO_DATED_STOCK_PRICE_BARS_ONLY");
   assert.equal(prep.sourceAttestedNameCount,25);
   const packed=JSON.parse(readFileSync(p.packed,"utf8"));
   assert.equal(packed.rows.length,25);
   assert.equal(packed.fullMarketOpportunityDenominatorVerified,false);
   const summary=score(p);
   assert.equal(summary.sourceObservedDailyPriceEventCount,6);
   const out=JSON.parse(readFileSync(p.output,"utf8"));
   assert.equal(out.status,"TEST_FIXTURE_STOCK_DAILY_EVENT_LABEL_ONLY");
   assert.equal(out.sourceAttestedNameCount,25);
   assert.equal(out.sourceObservedDailyPriceEventCount,6);
   assert.deepEqual([5,10,20].map(t=>out.directions.LONG[String(t)].sourceObservedPriceEventCount),
     [3,2,1]);
   assert.equal(out.eventPreview.length,6);
   assert.equal(out.firstCrossingTimestampEstablished,false);
   assert.equal(out.historicalScannerEarlyDetectionCount,null);
   assert.equal(out.actualMarketWideOpportunityCount,null);
   assert.equal(out.trueMarketWideRecall,null);
   assert.equal(out.actualFillCount,null);
   assert.equal(out.netProfitPct,null);
   assert.equal(out.OOSPassCount,0);
   assert.equal(out.profitabilityProven,false);
   assert.equal(out.executionAuthority,"NONE");
   assert.equal(statSync(p.packed).mode&0o077,0);
   assert.equal(statSync(p.output).mode&0o077,0);
   assert.equal(createHash("sha256").update(readFileSync(p.input)).digest("hex"),
     startDigest);
  }
 });
});

test("truncated dated source population is BLOCKED not silently a zero-event day",()=>{
 inTemp(folder=>{
  const market="KR_STOCK",p=paths(folder,market);
  const raw=receipt(market);
  raw.observedCurrentSymbols=26;
  raw.joinedPriorPriceSymbols=26;
  writePrivate(p.input,raw);
  assert.equal(prepare(market,p).status,"BLOCKED_DATA");
  assert.equal(score(p).sourceObservedDailyPriceEventCount,null);
  const outcome=JSON.parse(readFileSync(p.output,"utf8"));
  assert.equal(outcome.status,"BLOCKED_DATA");
  assert.equal(outcome.actualMarketWideOpportunityCount,null);
  assert.equal(outcome.trueMarketWideRecall,null);
 });
});

test("corrupted saved stock price rows fail the Python hash/identity boundary",()=>{
 inTemp(folder=>{
  const market="US_STOCK",p=paths(folder,market);
  writePrivate(p.input,receipt(market));
  prepare(market,p);
  const modified=JSON.parse(readFileSync(p.packed,"utf8"));
  modified.rows[0].high=999;
  writeFileSync(p.packed,JSON.stringify(modified),{mode:0o600,flag:"w"});
  assert.equal(score(p).sourceObservedDailyPriceEventCount,null);
  const outcome=JSON.parse(readFileSync(p.output,"utf8"));
  assert.equal(outcome.reason,"STOCK_SOURCE_SAVED_ROWS_CHANGED");
  assert.equal(outcome.trueMarketWideRecall,null);
  assert.equal(outcome.profitabilityProven,false);
 });
});

test("raw provider shaped receipt prices changed after digest creation fail closed",()=>{
 inTemp(folder=>{
  const market="KR_STOCK",p=paths(folder,market),raw=receipt(market);
  raw.records[0].high=130; // still valid OHLC, but source rows SHA no longer agrees
  writePrivate(p.input,raw);
  const result=prepare(market,p);
  assert.equal(result.status,"BLOCKED_DATA");
  assert.equal(result.reason,"STOCK_JOINED_SOURCE_ROWS_DIGEST_MISSING_OR_CHANGED");
  const scoreResult=score(p);
  assert.equal(scoreResult.sourceObservedDailyPriceEventCount,null);
  const outcome=JSON.parse(readFileSync(p.output,"utf8"));
  assert.equal(outcome.actualMarketWideOpportunityCount,null);
  assert.equal(outcome.profitabilityProven,false);
 });
});
