import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,writeFileSync,readFileSync,statSync,chmodSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {parseStockDailyEvidenceArgsV1,runStockSourceLimitedDailyInputCliV1}
 from "../scripts/prepare-stock-source-limited-daily-evidence-v1.mjs";
import {prepareStockSourceLimitedDailyEvidenceV1 as pack}
 from "../src/stock-source-limited-daily-evidence-v1.js";

const priorKR="20250207",nowKR="20250210";
const priorUS="2025-01-31",nowUS="2025-02-03";
const usBefore=Date.parse("2025-01-31T21:00:00Z");
const usAfter=Date.parse("2025-02-03T21:00:00Z");
const H="a".repeat(64);
const krSym=i=>String(100000+i).padStart(6,"0");
const krISIN=i=>"KR"+String(i+1).padStart(10,"0");
const usSym=i=>"TEST"+String(i+1);
const usFigi=i=>"BBG"+String(i+1).padStart(9,"0");
const krRow=i=>({
 market:"KR_STOCK",venue:"KRX",symbol:krSym(i),isin:krISIN(i),
 marketBoard:i%2===0?"KOSPI":"KOSDAQ",
 currentTradingDateYmd:nowKR,priorCandidateTradingDateYmd:priorKR,
 priorOpen:100,priorHigh:103,priorLow:98,priorClose:101,priorVolume:500,
 open:104,high:120,low:102,close:110,volume:300,
 sourceIdentity:"KRX_OFFICIAL_DATED_TRADING_INFO",
 automaticCorporateActionAdjustmentApplied:false,
});
const usRow=i=>({
 market:"US_STOCK",venue:"US_SIP",symbol:usSym(i),
 shareClassFIGI:usFigi(i),
 asOfDate:nowUS,priorCandidateTradingDate:priorUS,
 primaryExchangeMIC:"XNYS",securityType:"CS",
 priorBarSourceTimestampMs:usBefore,priorBarUSLocalDate:priorUS,
 priorOpen:100,priorHigh:104,priorLow:99,priorClose:101,
 priorVolume:400,
 currentBarSourceTimestampMs:usAfter,
 currentBarUSLocalDate:nowUS,
 open:103,high:120,low:102,close:110,volume:1000,
 venueTimeZone:"America/New_York",
 sourceAdjustedForSplits:false,
 corporateActionAdjustmentAuthenticated:false,
 previousSessionCalendarAuthenticated:false,
});
function receipt(market,n=2){
 const kr=market==="KR_STOCK",rows=Array.from({length:n},(_,i)=>kr?krRow(i):usRow(i));
 return {
  schemaVersion:kr?"krx-authorized-two-session-all-stock-intake-v1":
    "us-two-dated-asof-all-stocks-price-source-v1",
  market,venue:kr?"KRX":"US_SIP",
  status:kr?"SOURCE_LIMITED_TWO_KRX_DATES_JOINED_ONLY":
   "SOURCE_LIMITED_TWO_US_ASOF_DATES_JOINED_ONLY",
  executionAuthority:"NONE",profitabilityProven:false,
  trueMarketWideRecall:null,actualMarketWideOpportunityCount:null,
  fullMarketOpportunityDenominatorVerified:false,
  requestedTradingDates:kr?[priorKR,nowKR]:[priorUS,nowUS],
  ...(kr?{
   recordSha256:H,records:rows,
   observedCurrentSymbols:n,joinedPriorPriceSymbols:n,
   missingPreviousPriceCount:0,
   officialAdjacentTradingSessionCalendarVerified:false,
   corporateActionsAdjustedAndVerified:false,
   fullMarketHistoricDelistedUniverseVerified:false,
  }:{
   sourceRowsSha256:H,rows,
   observedCurrentAsOfTickerCount:n,joinedPriorDailyPriceCount:n,
   missingPriorPriceOrIdentityCount:0,
   adjacentStockTradingSessionsAuthenticated:false,
   corporateActionsAndTickerChangesCanonicallyResolved:false,
   fullThreeYearListedAndDelistedRosterVerified:false,
   permanentShareClassIdentityComplete:false,
   twoDatedSourceShareClassIdentityMatched:true,
  }),
 };
}
const mutate=(r,key,value)=>({...r,[key]:value});
test("KR all-name KRX source emits 2 real nominated stock sessions, not a candidate or zero signal",()=>{
 const r=pack({market:"KR_STOCK",source:receipt("KR_STOCK"),testFixtureOnly:true});
 assert.equal(r.status,"TEST_FIXTURE_TWO_DATED_STOCK_PRICE_BARS_ONLY");
 assert.equal(r.venue,"KRX");
 assert.equal(r.date,"2025-02-10");
 assert.equal(r.priorCandidateDate,"2025-02-07");
 assert.equal(r.sourceAttestedNameCount,2);
 assert.equal(r.rows[0].priorClose,101);
 assert.equal(r.rows[0].high,120);
 assert.equal(r.rows[0].stableIssueId,krISIN(0));
 assert.equal(r.priorCandidateIsOfficialPreviousSessionVerified,false);
 assert.equal(r.fullMarketOpportunityDenominatorVerified,false);
 assert.equal(r.sourceObservedDailyEvents,null);
 assert.equal(r.trueMarketWideRecall,null);
 assert.equal(r.executionAuthority,"NONE");
 assert.equal(createHash("sha256").update(r.canonicalRowsJSON).digest("hex"),
  r.sourceRowsSha256);
});
test("US as-of stock receipts respect ET market dates and exact share-class FIGI",()=>{
 const r=pack({market:"US_STOCK",source:receipt("US_STOCK"),testFixtureOnly:true});
 assert.equal(r.status,"TEST_FIXTURE_TWO_DATED_STOCK_PRICE_BARS_ONLY");
 assert.equal(r.venue,"US_SIP");
 assert.equal(r.date,"2025-02-03");
 assert.equal(r.priorCandidateDate,"2025-01-31");
 assert.equal(r.rows[0].stableIssueId,usFigi(0));
 assert.equal(r.rows[0].sourcePriorCandidateDate,priorUS);
 assert.equal(r.rows[0].open,103);
 assert.equal(r.corporateActionAdjustmentVerified,false);
 assert.equal(r.fullMarketOpportunityDenominatorVerified,false);
 assert.equal(r.actualMarketWideOpportunityCount,null);
});
test("No six-ticker restriction: retain the entire 25-name as-of source set without ranking",()=>{
 for(const market of ["KR_STOCK","US_STOCK"]){
  const r=pack({market,source:receipt(market,25),testFixtureOnly:true});
  assert.equal(r.rows.length,25);
  assert.equal(r.sourceAttestedNameCount,25);
  assert.ok(r.rows.some(x=>x.symbol===(market==="KR_STOCK"?krSym(24):usSym(24))));
  assert.equal(r.sourceObservedDailyEvents,null);
  assert.equal(r.profitabilityProven,false);
 }
});
test("No prior date / split or identity evidence means block, never promote a day into zero events",()=>{
 const tests=[
  [receipt("KR_STOCK"),"observedCurrentSymbols",3,"STOCK_KRX_PREVIOUS_SESSION_OR_ALL_NAMES_NOT_ATTESTED"],
  [receipt("US_STOCK"),"missingPriorPriceOrIdentityCount",1,"STOCK_US_PREVIOUS_SESSION_OR_STABLE_ID_NOT_ATTESTED"],
  [receipt("US_STOCK"),"adjacentStockTradingSessionsAuthenticated",true,"STOCK_US_PREVIOUS_SESSION_OR_STABLE_ID_NOT_ATTESTED"],
 ];
 for(const [src,key,bad,reason] of tests){
  const result=pack({market:src.market,source:mutate(src,key,bad)});
  assert.equal(result.status,"BLOCKED_DATA");
  assert.equal(result.reason,reason);
  assert.equal(result.sourceObservedDailyEvents,null);
  assert.equal(result.trueMarketWideRecall,null);
 }
});
test("Changed KRX short code or share-class FIGI cannot hide in a whole-market same-day batch",()=>{
 const kr=receipt("KR_STOCK");
 kr.records[1].symbol=kr.records[0].symbol;
 assert.equal(pack({market:"KR_STOCK",source:kr}).reason,
  "STOCK_DAILY_BAR_OR_STABLE_ID_INVALID");
 const us=receipt("US_STOCK");
 us.rows[1].shareClassFIGI=us.rows[0].shareClassFIGI;
 assert.equal(pack({market:"US_STOCK",source:us}).reason,
  "STOCK_DAILY_BAR_OR_STABLE_ID_INVALID");
});
test("Previous-session date and ET DST-boundary are verified on all US rows",()=>{
 for(const change of [
  r=>{r.rows[0].priorBarUSLocalDate="2025-02-01";},
  r=>{r.rows[0].currentBarSourceTimestampMs=Date.parse("2025-02-04T12:00:00Z");},
  r=>{r.rows[0].sourceAdjustedForSplits=true;},
  r=>{r.rows[0].previousSessionCalendarAuthenticated=true;},
 ]){
  const s=receipt("US_STOCK");change(s);
  const result=pack({market:"US_STOCK",source:s});
  assert.equal(result.reason,"STOCK_US_ET_SOURCE_OR_ADJUSTMENT_INVALID");
  assert.equal(result.trueMarketWideRecall,null);
 }
});
test("KR corrupt OHLC and claimed corporate-action adjustment cannot be accepted",()=>{
 const s=receipt("KR_STOCK");
 s.records[0].high=99;
 assert.equal(pack({market:"KR_STOCK",source:s}).reason,
   "STOCK_DAILY_BAR_OR_STABLE_ID_INVALID");
 const fake=receipt("KR_STOCK");
 fake.records[0].automaticCorporateActionAdjustmentApplied=true;
 assert.equal(pack({market:"KR_STOCK",source:fake}).reason,
   "STOCK_KRX_HISTORIC_DATE_VENUE_OR_ADJUSTMENT_INVALID");
});
test("No historical source / wrong market never turns into a 0-denominator PASSED sample",()=>{
 const r=pack({market:"US_STOCK"});
 assert.equal(r.status,"BLOCKED_DATA");
 assert.equal(r.sourceAttestedNameCount,null);
 assert.equal(r.sourceObservedDailyEvents,null);
 assert.equal(r.actualMarketWideOpportunityCount,null);
 assert.equal(r.trueMarketWideRecall,null);
 assert.throws(()=>pack({market:"CRYPTO_SPOT"}),/STOCK_DAILY_MARKET_INVALID/);
});
test("An apparently complete source is still only source-attested, never full 3-year PIT profit evidence",()=>{
 for(const market of ["KR_STOCK","US_STOCK"]){
  const r=pack({market,source:receipt(market,1)});
  assert.equal(r.status,"SOURCE_ATTESTED_TWO_DATED_STOCK_PRICE_BARS_ONLY");
  assert.equal(r.officialAdjacentSessionsVerified,false);
  assert.equal(r.independentlyAuthenticHistoricPITAndDelistings,false);
  assert.equal(r.profitabilityProven,false);
  assert.equal(r.actualFillCount,null);
  assert.equal(r.trueMarketWideRecall,null);
 }
});

test("offline private-file KR/US stock source translation works and never emits a counted event itself",()=>{
 for(const market of ["KR_STOCK","US_STOCK"]){
  const folder=mkdtempSync(join(tmpdir(),"stock-evidence-offline-"));
  const sourceFile=join(folder,"two-date-source.json");
  const evidenceFile=join(folder,"stock-evidence.json");
  writeFileSync(sourceFile,JSON.stringify(receipt(market,2)),{mode:0o600});
  const cfg=parseStockDailyEvidenceArgsV1([
   "--market",market,"--input",sourceFile,"--output",evidenceFile,
   "--test-fixture",
  ]);
  const report=runStockSourceLimitedDailyInputCliV1(cfg);
  assert.equal(report.status,"TEST_FIXTURE_TWO_DATED_STOCK_PRICE_BARS_ONLY");
  assert.equal(report.sourceObservedDailyEvents,null);
  assert.equal(report.fullMarketOpportunityDenominatorVerified,false);
  assert.equal(report.trueMarketWideRecall,null);
  assert.equal(report.executionAuthority,"NONE");
  assert.equal(statSync(evidenceFile).mode&0o077,0);
  const data=JSON.parse(readFileSync(evidenceFile,"utf8"));
  assert.equal(data.sourceAttestedNameCount,2);
  assert.equal(data.status,"TEST_FIXTURE_TWO_DATED_STOCK_PRICE_BARS_ONLY");
  assert.equal(createHash("sha256").update(data.canonicalRowsJSON).digest("hex"),
   data.sourceRowsSha256);
  assert.deepEqual(JSON.parse(data.canonicalRowsJSON),data.rows);
  assert.throws(()=>runStockSourceLimitedDailyInputCliV1(cfg),/EEXIST/);
 }
});
test("offline stock event intake does not read a group-readable source or accept a current catalog",()=>{
 const folder=mkdtempSync(join(tmpdir(),"stock-evidence-block-"));
 const sourceFile=join(folder,"source.json"),outputFile=join(folder,"out.json");
 writeFileSync(sourceFile,JSON.stringify(receipt("US_STOCK")),{mode:0o600});
 chmodSync(sourceFile,0o644);
 const cfg=parseStockDailyEvidenceArgsV1([
  "--market","US_STOCK","--input",sourceFile,"--output",outputFile,
 ]);
 assert.throws(()=>runStockSourceLimitedDailyInputCliV1(cfg),
   /STOCK_EVIDENCE_PRIVATE_INPUT_UNSAFE/);
 chmodSync(sourceFile,0o600);
 writeFileSync(sourceFile,JSON.stringify({currentTickerCatalog:true}),{mode:0o600,flag:"w"});
 const result=runStockSourceLimitedDailyInputCliV1(cfg);
 assert.equal(result.status,"BLOCKED_DATA");
 assert.equal(result.sourceObservedDailyEvents,null);
 assert.equal(result.sourceAttestedNameCount,null);
 assert.equal(result.actualMarketWideOpportunityCount,undefined);
 assert.equal(result.executionAuthority,"NONE");
 const row=JSON.parse(readFileSync(outputFile,"utf8"));
 assert.equal(row.trueMarketWideRecall,null);
 assert.equal(row.actualMarketWideOpportunityCount,null);
});
test("CLI refuses to use a stock source as its own output or fill missing arguments",()=>{
 assert.throws(()=>parseStockDailyEvidenceArgsV1([
  "--market","KR_STOCK","--input","/tmp/evidence.json",
  "--output","/tmp/evidence.json",
 ]),/STOCK_EVIDENCE_CLI_SOURCE_DESTINATION_IDENTICAL/);
 assert.throws(()=>parseStockDailyEvidenceArgsV1([
  "--market","CRYPTO_SPOT","--input","/tmp/a.json",
  "--output","/tmp/b.json",
 ]),/STOCK_EVIDENCE_CLI_PRIVATE_INPUT_OUTPUT_REQUIRED/);
});

test("Receipt schema must match historical KR/US adapter, not a foreign or omitted source",()=>{
 for(const market of ["KR_STOCK","US_STOCK"]){
  const missing=receipt(market);
  delete missing.schemaVersion;
  assert.equal(pack({market,source:missing}).reason,
    "STOCK_ALL_NAME_TWO_DATE_SOURCE_NOT_COMPLETE");
  const foreign=receipt(market);
  foreign.schemaVersion="unrelated-provider-schema";
  assert.equal(pack({market,source:foreign}).status,"BLOCKED_DATA");
 }
});
