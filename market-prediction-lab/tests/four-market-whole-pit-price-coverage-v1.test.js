import test from "node:test";
import assert from "node:assert/strict";
import {digestPITMembershipRowsV1} from "../src/historical-pit-venue-universe-gate-v1.js";
import {mkdtempSync,writeFileSync,readFileSync,statSync,chmodSync,existsSync,rmSync}
 from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {fixedHistoricalCryptoUtcDatesV1,THREE_YEAR_UTC_DATE_SCOPE_V1,
 reportFourWholePITReadinessV1} from "../scripts/report-four-market-whole-pit-readiness-v1.mjs";
import {
  FOUR_MARKET_WHOLE_SCOPE_V1 as SCOPE,
  digestWholeVenueDailyRowsV1,WHOLE_MARKET_BENCHMARK_WINDOW_V1,
  auditWholeVenuePITDailyCoverageV1 as audit,
  auditFourMarketHistoricalWholeUniverseV1 as four,
} from "../src/four-market-whole-pit-price-coverage-v1.js";
const D=86_400_000,START=Date.parse("2025-02-03T00:00:00Z");
const END=START+D,H="a".repeat(64);
const ACTIVE={KR_STOCK:"005930",US_STOCK:"ACME",CRYPTO_SPOT:"KRW-ABC",
  CRYPTO_FUTURES:"ABCUSDT"};
function source(market,{omit=false,addOutside=false,venue=null,split=false,
  futurePrior=false,partial=false,sourceClass="TEST_FIXTURE"}={}){
 const symbol=ACTIVE[market],v=venue??SCOPE[market].venue;
 const rows=[{symbol,market,venue:v,timestampMs:START,
  open:104,high:115,low:100,close:106,volume:100,
  priorClose:100,priorCloseAsOfMs:futurePrior?START+1:START-D,
  evidenceSha256:H,sourceId:"fixture-daily"}];
 if(omit)rows.pop();
 if(addOutside)rows.push({...rows[0],symbol:"OUTSIDE"});
 const membership=[
  {symbol,listedAtMs:partial?START+3600000:START-500*D,
   removedAtMs:null,halts:[],sourceId:"fixture-pit",evidenceSha256:H},
  {symbol:"DELISTED",listedAtMs:START-800*D,
   removedAtMs:START-200*D,halts:[],sourceId:"fixture-pit",
   evidenceSha256:H},
 ];
 const manifest={schemaVersion:"historical-venue-pit-roster-v1",
  sourceClass:"TEST_FIXTURE",testOnly:true,market,venue:SCOPE[market].venue,
  coverageStartMs:START-900*D,coverageEndMs:END,
  retrievedAtMs:END+D,sourceId:"fixture-pit",
  allListedAndRemovedAttested:true,suspensionsAttested:true,
  relistedIdentifiersResolved:true,memberships:membership,
  rawMembershipDigestSha256:digestPITMembershipRowsV1(membership)};
 const dailySource={schemaVersion:"venue-native-historical-all-names-daily-v1",
  market,venue:v,sourceClass,sourceId:"fixture-daily",
  dayStartMs:START,dayEndMs:END,retrievedAtMs:END+D,
  exhaustiveActiveSymbolsRequested:true,priceSelectionUsedFutureDayOHLC:false,
  corporateActionAdjustmentEvidenceAttached:!split,
  sourcePriceConvention:"NATIVE_UNADJUSTED",
  rows,rowsSha256:digestWholeVenueDailyRowsV1(rows)};
 return {manifest,dailySource};
}
test("all four target markets, actual venues, LONG-only except futures LONG/SHORT",()=>{
 assert.deepEqual(Object.keys(SCOPE),
  ["KR_STOCK","US_STOCK","CRYPTO_SPOT","CRYPTO_FUTURES"]);
 assert.equal(SCOPE.CRYPTO_SPOT.venue,"UPBIT_KRW");
 assert.equal(SCOPE.CRYPTO_FUTURES.venue,"BITGET_USDT_FUTURES");
 assert.deepEqual(SCOPE.CRYPTO_SPOT.directions,["LONG"]);
 assert.deepEqual(SCOPE.CRYPTO_FUTURES.directions,["LONG","SHORT"]);
 for(const market of Object.keys(SCOPE)){
  assert.deepEqual(SCOPE[market].thresholdsPct,[5,10,20]);
  const r=audit({market,dayStartMs:START,...source(market)});
  assert.equal(r.status,"TEST_FIXTURE_FULL_NAME_DAILY_JOIN_ONLY");
  assert.equal(r.sourceAttestedHistoricalActiveSymbols,1);
  assert.equal(r.sourceAttestedDailyBars,1);
  assert.equal(r.existingOpportunityEngineInputEligible,true);
  assert.equal(r.actualMarketWideOpportunityCount,null);
  assert.equal(r.actualMarketWideRecall,null);
  assert.equal(r.profitabilityProven,false);
  assert.equal(r.executionAuthority,"NONE");
 }
});
test("no provider roster or dates blocks real whole-market denominator, not zero",()=>{
 const r=four();
 assert.equal(r.allMarketsSourceAttestedPriceJoined,false);
 for(const value of Object.values(r.markets)){
  assert.equal(value.status,"BLOCKED_WHOLE_MARKET_COVERAGE");
  assert.equal(value.requestedTradingDays,null);
  assert.equal(value.actualMarketWideOpportunityCount,null);
 }
 assert.equal(r.historicalFullMarketOpportunityDenominatorVerified,false);
});
test("all four explicitly supplied session dates can be source-attested but not independently verified",()=>{
 const dates=Object.fromEntries(Object.keys(SCOPE).map(m=>[m,[START]]));
 const data=Object.fromEntries(Object.keys(SCOPE).map(m=>[m,
  {[String(START)]:source(m)}]));
 const r=four({requestedTradingDaysByMarket:dates,dailyReceiptsByMarket:data});
 assert.equal(r.allMarketsSourceAttestedPriceJoined,true);
 for(const x of Object.values(r.markets)){
  assert.equal(x.sourceAttestedPriceJoinedDays,1);
  assert.equal(x.days[0].status,"TEST_FIXTURE_FULL_NAME_DAILY_JOIN_ONLY");
  assert.equal(x.days[0].sourceAttestedActiveMembers,1);
 }
 assert.equal(r.trueMarketWideRecall,null);
 assert.equal(r.historicalFullMarketOpportunityDenominatorVerified,false);
});
test("survivor/current snapshot masquerading as history never passes PIT",()=>{
 const s=source("CRYPTO_SPOT");
 s.manifest={sourceClass:"CURRENT_SNAPSHOT"};
 const r=audit({market:"CRYPTO_SPOT",dayStartMs:START,...s});
 assert.equal(r.status,"BLOCKED_WHOLE_MARKET_COVERAGE");
 assert.match(r.reason,/CURRENT_SURVIVOR_LIST_NOT_HISTORICAL_PIT/);
 assert.equal(r.actualMarketWideOpportunityCount,null);
});
test("missing active historical name is visible, not recorded as zero opportunity",()=>{
 const s=source("KR_STOCK",{omit:true});
 const r=audit({market:"KR_STOCK",dayStartMs:START,...s});
 assert.equal(r.reason,"PIT_ACTIVE_NAMES_MISSING_VENUE_DAILY_PRICES");
 assert.equal(r.missingDailyBarCount,1);
 assert.deepEqual(r.missingDailyBarSymbolsPreview,["005930"]);
 assert.equal(r.existingOpportunityEngineInputEligible,false);
 assert.equal(r.actualMarketWideOpportunityCount,null);
});
test("Binance spot/futures prices cannot substitute Upbit or Bitget",()=>{
 for(const market of ["CRYPTO_SPOT","CRYPTO_FUTURES"]){
  const s=source(market,{venue:"BINANCE_USDT"});
  const r=audit({market,dayStartMs:START,...s});
  assert.equal(r.reason,"FULL_DAILY_SOURCE_PROVENANCE_OR_CORPORATE_ACTION_INVALID");
  assert.equal(r.actualMarketWideRecall,null);
 }
});
test("source digest, hindsight baseline, corporate actions and mixed identity fail closed",()=>{
 const r=source("US_STOCK",{futurePrior:true});
 assert.equal(audit({market:"US_STOCK",dayStartMs:START,...r}).reason,
  "PRIOR_CLOSE_NOT_AVAILABLE_AT_DECISION_TIME");
 const s=source("US_STOCK",{split:true});
 assert.equal(audit({market:"US_STOCK",dayStartMs:START,...s}).reason,
  "FULL_DAILY_SOURCE_PROVENANCE_OR_CORPORATE_ACTION_INVALID");
 const tampered=source("CRYPTO_SPOT");
 tampered.dailySource.rows[0].high=1000;
 assert.equal(audit({market:"CRYPTO_SPOT",dayStartMs:START,...tampered}).reason,
  "FULL_DAILY_SOURCE_PROVENANCE_OR_CORPORATE_ACTION_INVALID");
 const outside=source("CRYPTO_FUTURES",{addOutside:true});
 assert.equal(audit({market:"CRYPTO_FUTURES",dayStartMs:START,...outside}).reason,
  "VENUE_PRICE_OUTSIDE_HISTORICAL_PIT_MEMBERSHIP");
});
test("intraday new listing needs its own session/baseline proof, not silent exclusion",()=>{
 const s=source("CRYPTO_SPOT",{partial:true});
 const r=audit({market:"CRYPTO_SPOT",dayStartMs:START,...s});
 assert.equal(r.reason,"PIT_INTRADAY_LISTING_DELISTING_OR_HALT_NEEDS_SESSION_PROOF");
 assert.equal(r.partialSessionMemberCount,1);
 assert.equal(r.actualMarketWideOpportunityCount,null);
});
test("one market ready does not promote other missing markets or absent trading days",()=>{
 const r=four({
  requestedTradingDaysByMarket:{
    KR_STOCK:[START],US_STOCK:[START],CRYPTO_SPOT:[START,START+D],
    CRYPTO_FUTURES:[START],
  },
  dailyReceiptsByMarket:{CRYPTO_SPOT:{[String(START)]:source("CRYPTO_SPOT")}},
 });
 assert.equal(r.allMarketsSourceAttestedPriceJoined,false);
 assert.equal(r.markets.CRYPTO_SPOT.sourceAttestedPriceJoinedDays,1);
 assert.equal(r.markets.CRYPTO_SPOT.blockedOrIncompleteDays,1);
 assert.equal(r.markets.US_STOCK.days[0].sourceAttestedActiveMembers,null);
 assert.equal(r.historicalScannerRecall,null);
});
test("bad market, non-date and invented calendar order do not get as-of credit",()=>{
 assert.throws(()=>audit({market:"toString",dayStartMs:START}),/WHOLE_PIT_MARKET_INVALID/);
 assert.throws(()=>audit({market:"KR_STOCK",dayStartMs:START+60_000}),/WHOLE_PIT_DAY_INVALID/);
 const r=four({requestedTradingDaysByMarket:{KR_STOCK:[START,START]}});
 assert.equal(r.markets.KR_STOCK.requestedTradingDays,null);
 assert.equal(r.markets.KR_STOCK.status,"BLOCKED_WHOLE_MARKET_COVERAGE");
});

test("three-year crypto days cover the entire FIXED benchmark, not a chosen day",()=>{
 const dates=fixedHistoricalCryptoUtcDatesV1();
 assert.equal(dates.CRYPTO_SPOT.length,1096);
 assert.equal(dates.CRYPTO_FUTURES.length,1096);
 assert.equal(dates.CRYPTO_SPOT[0],THREE_YEAR_UTC_DATE_SCOPE_V1.startMs);
 assert.equal(dates.CRYPTO_SPOT.at(-1),
  THREE_YEAR_UTC_DATE_SCOPE_V1.endExclusiveMs-D);
 assert.deepEqual(dates.CRYPTO_FUTURES,dates.CRYPTO_SPOT);
 assert.ok(dates.CRYPTO_SPOT.every((day,i)=>
  i===0||day===dates.CRYPTO_SPOT[i-1]+D));
 const r=reportFourWholePITReadinessV1();
 assert.equal(r.markets.CRYPTO_SPOT.requestedTradingDays,1096);
 assert.equal(r.markets.CRYPTO_FUTURES.requestedTradingDays,1096);
 assert.equal(r.markets.CRYPTO_SPOT.sourceAttestedPriceJoinedDays,0);
 assert.equal(r.markets.CRYPTO_SPOT.days[0].reason,
  "PIT_DATED_HISTORICAL_PIT_ROSTER_NOT_CONNECTED");
 assert.equal(r.markets.CRYPTO_FUTURES.days.at(-1).reason,
  "PIT_DATED_HISTORICAL_PIT_ROSTER_NOT_CONNECTED");
 assert.equal(r.markets.KR_STOCK.requestedTradingDays,null);
 assert.equal(r.markets.US_STOCK.requestedTradingDays,null);
 assert.equal(r.trueMarketWideRecall,null);
 assert.equal(r.profitabilityProven,false);
});

test("two non-overlapping lives of one ticker within the same date cannot collapse into one eligible daily bar",()=>{
 const sample=source("CRYPTO_SPOT");
 const active=sample.manifest.memberships[0];
 sample.manifest.memberships[0]={...active,removedAtMs:START+2*3600_000};
 sample.manifest.memberships.push({
   ...active,listedAtMs:START+3*3600_000,removedAtMs:null,
 });
 sample.manifest.rawMembershipDigestSha256=digestPITMembershipRowsV1(
  sample.manifest.memberships);
 const r=audit({market:"CRYPTO_SPOT",dayStartMs:START,...sample});
 assert.equal(r.status,"BLOCKED_WHOLE_MARKET_COVERAGE");
 assert.equal(r.reason,"PIT_SAME_DAY_IDENTIFIER_REUSE_REQUIRES_SESSION_PROOF");
 assert.equal(r.actualMarketWideOpportunityCount,null);
 assert.equal(r.trueMarketWideRecall,null);
});

test("one dated price snapshot cannot replace 1096 crypto benchmark days",()=>{
 const r=reportFourWholePITReadinessV1({
   requestedTradingDaysByMarket:{
     CRYPTO_SPOT:[START],CRYPTO_FUTURES:[START],
     KR_STOCK:[START],US_STOCK:[START],
   },
   dailyReceiptsByMarket:{CRYPTO_SPOT:{[String(START)]:source("CRYPTO_SPOT")}},
 });
 assert.equal(r.markets.CRYPTO_SPOT.requestedTradingDays,1096);
 assert.equal(r.markets.CRYPTO_FUTURES.requestedTradingDays,1096);
 assert.equal(r.markets.CRYPTO_SPOT.sourceAttestedPriceJoinedDays,1);
 assert.equal(r.markets.CRYPTO_SPOT.fixtureJoinedDays,1);
 assert.equal(r.markets.CRYPTO_SPOT.blockedOrIncompleteDays,1095);
 assert.equal(r.markets.CRYPTO_SPOT.benchmarkCalendarStatus,"FULL_1096_UTC_DAYS");
 assert.equal(r.markets.CRYPTO_SPOT.benchmarkPeriodSourceAttestedPriceJoined,false);
 assert.equal(r.markets.US_STOCK.benchmarkCalendarStatus,
   "STOCK_EXCHANGE_SESSION_CALENDAR_UNVERIFIED");
 assert.equal(r.allMarketsFullBenchmarkPeriodSourceAttestedPriceJoined,false);
 assert.equal(r.partialCallerCryptoCalendarIgnored.CRYPTO_SPOT,true);
 assert.equal(r.partialCallerCryptoCalendarIgnored.CRYPTO_FUTURES,true);
 assert.equal(r.trueMarketWideRecall,null);
 assert.equal(r.profitabilityProven,false);
});
test("monthly source gap ledger retains missing days as BLOCKED, never zero events",()=>{
 const x=reportFourWholePITReadinessV1();
 for(const market of ["CRYPTO_SPOT","CRYPTO_FUTURES"]){
  const m=x.markets[market];
  assert.equal(m.sourceAttestedPriceJoinedDays,0);
  assert.equal(m.benchmarkPeriodSourceAttestedPriceJoined,false);
  assert.equal(m.fullBenchmarkDateCoverage,true);
  assert.equal(m.blockedReasonCounts.PIT_DATED_HISTORICAL_PIT_ROSTER_NOT_CONNECTED,1096);
  assert.equal(m.sourceAttestedMonthlyCoverage["2023-09"].requestedDays,5);
  assert.equal(m.sourceAttestedMonthlyCoverage["2026-09"].requestedDays,25);
  assert.equal(m.incompleteDaysPreview.length,15);
  assert.equal(m.incompleteDaysPreview[0].dateUtc,"2023-09-26");
  assert.equal(m.actualMarketWideOpportunityCount,null);
 }
 assert.equal(WHOLE_MARKET_BENCHMARK_WINDOW_V1.expectedCryptoUtcDayCount,1096);
 assert.equal(x.allMarketsFullBenchmarkPeriodSourceAttestedPriceJoined,false);
});
test("outside fixed 3-year window cannot enter denominator",()=>{
 const other=Date.parse("2026-10-09T00:00:00Z");
 const r=four({requestedTradingDaysByMarket:{CRYPTO_SPOT:[other]}});
 assert.equal(r.markets.CRYPTO_SPOT.reason,
   "REQUESTED_DATE_OUTSIDE_FIXED_THREE_YEAR_BENCHMARK");
 assert.equal(r.markets.CRYPTO_SPOT.requestedTradingDays,null);
 assert.equal(r.markets.CRYPTO_SPOT.actualMarketWideOpportunityCount,null);
});
test("PIT readiness file inputs are private, report is immutable create-only",()=>{
 const folder=mkdtempSync(join(tmpdir(),"pit-benchmark-readiness-"));
 try{
  const input=join(folder,"source.json"),output=join(folder,"report.json");
  writeFileSync(input,JSON.stringify({
   requestedTradingDaysByMarket:{CRYPTO_SPOT:[START]},
   dailyReceiptsByMarket:{},
  }),{mode:0o600});
  const cli=resolve(dirname(fileURLToPath(import.meta.url)),
   "../scripts/report-four-market-whole-pit-readiness-v1.mjs");
  const run=()=>spawnSync(process.execPath,[cli,input,output],{
    encoding:"utf8",maxBuffer:3*1024*1024,timeout:20000,
  });
  chmodSync(input,0o644);
  let res=run();
  assert.notEqual(res.status,0);
  assert.match(res.stderr,/PIT_CHUNK_PRIVATE_INPUT_UNSAFE/);
  assert.equal(existsSync(output),false);
  chmodSync(input,0o600);
  res=run();
  assert.equal(res.status,0,res.stderr);
  const report=JSON.parse(readFileSync(output,"utf8"));
  assert.equal(report.markets.CRYPTO_SPOT.requestedTradingDays,1096);
  assert.equal(report.markets.CRYPTO_SPOT.sourceAttestedPriceJoinedDays,0);
  assert.equal(report.allMarketsFullBenchmarkPeriodSourceAttestedPriceJoined,false);
  assert.equal(statSync(output).mode&0o077,0);
  const before=readFileSync(output);
  res=run();
  assert.notEqual(res.status,0);
  assert.match(res.stderr,/EEXIST/);
  assert.deepEqual(readFileSync(output),before);
 }finally{rmSync(folder,{recursive:true,force:true});}
});

function fullCryptoSourceAttestedBenchmarkV1(){
 const benchmark=WHOLE_MARKET_BENCHMARK_WINDOW_V1;
 const dates=fixedHistoricalCryptoUtcDatesV1().CRYPTO_SPOT;
 const example=source("CRYPTO_SPOT"),manifest=example.manifest;
 manifest.sourceClass="EXCHANGE_DATED_ARCHIVE";
 delete manifest.testOnly;
 manifest.sourceId="TEST_ARCHIVE_LICENSED_PIT_HISTORY";
 manifest.coverageStartMs=benchmark.startMs;
 manifest.coverageEndMs=benchmark.endExclusiveMs;
 manifest.retrievedAtMs=benchmark.endExclusiveMs+D;
 manifest.memberships=manifest.memberships.map(row=>({
   ...row,sourceId:manifest.sourceId,
 }));
 manifest.rawMembershipDigestSha256=digestPITMembershipRowsV1(manifest.memberships);
 const archived=(date,pit=manifest)=>{
  const venue="UPBIT_KRW",market="CRYPTO_SPOT";
  const rows=pit.memberships.filter(x=>
    x.listedAtMs<date+D&&(x.removedAtMs??Infinity)>date).map(x=>({
    symbol:x.symbol,market,venue,timestampMs:date,
    open:104,high:115,low:100,close:106,volume:100,
    priorClose:100,priorCloseAsOfMs:date,
    evidenceSha256:H,sourceId:"native-day-"+date,
  }));
  const dailySource={
    schemaVersion:"venue-native-historical-all-names-daily-v1",
    market,venue,sourceClass:"VENUE_NATIVE_DAILY_ARCHIVE",
    sourceId:"native-day-"+date,
    dayStartMs:date,dayEndMs:date+D,
    retrievedAtMs:benchmark.endExclusiveMs+D,
    exhaustiveActiveSymbolsRequested:true,
    priceSelectionUsedFutureDayOHLC:false,
    corporateActionAdjustmentEvidenceAttached:false,
    sourcePriceConvention:"NATIVE_UNADJUSTED",
    rows,rowsSha256:digestWholeVenueDailyRowsV1(rows),
  };
  return {manifest:pit,dailySource};
 };
 const receipts=Object.fromEntries(dates.map(date=>[String(date),archived(date)]));
 return {dates,manifest,receipts};
}
test("1096 complete source-attested days with a single full-span lifecycle archive pass only the source stage",()=>{
 const {dates,receipts}=fullCryptoSourceAttestedBenchmarkV1();
 const report=four({
  requestedTradingDaysByMarket:{CRYPTO_SPOT:dates},
  dailyReceiptsByMarket:{CRYPTO_SPOT:receipts},
 });
 const market=report.markets.CRYPTO_SPOT;
 assert.equal(market.requestedTradingDays,1096);
 assert.equal(market.sourceAttestedPriceJoinedDays,1096);
 assert.equal(market.fixtureJoinedDays,0);
 assert.equal(market.blockedOrIncompleteDays,0);
 assert.equal(market.lifecycleArchiveDigestCount,1);
 assert.equal(market.lifecycleArchiveSourceIdentityCount,1);
 assert.equal(market.lifecycleSourceLineageConsistent,true);
 assert.equal(market.lifecycleArchiveFullWindowAttested,true);
 assert.equal(market.lifecycleArchiveStatus,"SOURCE_ATTESTED_FULL_3Y_LIFECYCLE_ONLY");
 assert.equal(market.benchmarkPeriodSourceAttestedPriceJoined,true);
 assert.equal(market.independentlyAuthenticatedPITAndPriceEvidence,false);
 assert.equal(market.actualMarketWideOpportunityCount,null);
 assert.equal(market.trueMarketWideRecall,null);
 assert.equal(report.allMarketsFullBenchmarkPeriodSourceAttestedPriceJoined,false);
 assert.equal(report.historicalFullMarketOpportunityDenominatorVerified,false);
 assert.equal(report.profitabilityProven,false);
 assert.equal(report.executionAuthority,"NONE");
});
test("mixing two distinct PIT source identities across 1096 otherwise complete days blocks promotion",()=>{
 const {dates,receipts,manifest}=fullCryptoSourceAttestedBenchmarkV1();
 const altered={...manifest,sourceId:"ANOTHER_PIT_ARCHIVE_PROVIDER"};
 receipts[String(dates[600])]={...receipts[String(dates[600])],manifest:altered};
 const report=four({
  requestedTradingDaysByMarket:{CRYPTO_SPOT:dates},
  dailyReceiptsByMarket:{CRYPTO_SPOT:receipts},
 });
 const result=report.markets.CRYPTO_SPOT;
 assert.equal(result.sourceAttestedPriceJoinedDays,1096);
 assert.equal(result.lifecycleArchiveSourceIdentityCount,2);
 assert.equal(result.lifecycleArchiveStatus,
   "LIFECYCLE_SOURCE_ID_OR_DIGEST_CHANGED_ACROSS_DAYS");
 assert.equal(result.benchmarkPeriodSourceAttestedPriceJoined,false);
 assert.equal(result.actualMarketWideOpportunityCount,null);
 assert.equal(result.trueMarketWideRecall,null);
});
test("one short-span PIT archive substituted into full 1096-day series never proves 3y continuity",()=>{
 const {dates,receipts,manifest}=fullCryptoSourceAttestedBenchmarkV1();
 const date=dates[700];
 receipts[String(date)]={...receipts[String(date)],
   manifest:{...manifest,coverageStartMs:WHOLE_MARKET_BENCHMARK_WINDOW_V1.startMs,
     coverageEndMs:date+D}};
 const report=four({
  requestedTradingDaysByMarket:{CRYPTO_SPOT:dates},
  dailyReceiptsByMarket:{CRYPTO_SPOT:receipts},
 });
 const result=report.markets.CRYPTO_SPOT;
 assert.equal(result.sourceAttestedPriceJoinedDays,1096);
 assert.equal(result.lifecycleArchiveSourceIdentityCount,1);
 assert.equal(result.lifecycleArchiveDigestCount,1);
 assert.equal(result.lifecycleSourceLineageConsistent,true);
 assert.equal(result.lifecycleArchiveStatus,
   "LIFECYCLE_SOURCE_ARCHIVE_SPAN_TOO_SHORT");
 assert.equal(result.lifecycleArchiveFullWindowAttested,false);
 assert.equal(result.lifecycleArchiveSpanGapPreview[0].dateUtc,
   new Date(date).toISOString().slice(0,10));
 assert.equal(result.benchmarkPeriodSourceAttestedPriceJoined,false);
 assert.equal(result.actualMarketWideOpportunityCount,null);
 assert.equal(result.trueMarketWideRecall,null);
});

test("user-selected 5 UTC days including leap-day replace the old fixed 3y crypto calendar",()=>{
 const picked={startDate:"2020-02-27",endDate:"2020-03-02"};
 const r=reportFourWholePITReadinessV1({researchWindow:picked,
   requestedTradingDaysByMarket:{CRYPTO_SPOT:[START]}});
 assert.equal(r.selectedResearchStartUtc,"2020-02-27");
 assert.equal(r.selectedResearchEndInclusiveUtc,"2020-03-02");
 assert.equal(r.selectedResearchUtcDayCount,5);
 assert.equal(r.researchRangeSelectionMode,"USER_SELECTED");
 for(const m of ["CRYPTO_SPOT","CRYPTO_FUTURES"]){
  assert.equal(r.markets[m].requestedTradingDays,5);
  assert.equal(r.markets[m].sourceAttestedPriceJoinedDays,0);
  assert.equal(r.markets[m].blockedReasonCounts
   .PIT_DATED_HISTORICAL_PIT_ROSTER_NOT_CONNECTED,5);
  assert.equal(r.markets[m].benchmarkCalendarStatus,"FULL_SELECTED_UTC_DAYS");
  assert.equal(r.markets[m].actualMarketWideOpportunityCount,null);
 }
 assert.equal(r.partialCallerCryptoCalendarIgnored.CRYPTO_SPOT,true);
 assert.equal(r.markets.KR_STOCK.requestedTradingDays,null);
 assert.equal(r.trueMarketWideRecall,null);
 assert.equal(r.profitabilityProven,false);
});
test("calendar selection outside 3-year example is allowed, no invented history",()=>{
 const r=reportFourWholePITReadinessV1({
  researchWindow:{startDate:"2027-01-01",endDate:"2027-01-02"},
 });
 assert.equal(r.selectedResearchUtcDayCount,2);
 assert.equal(r.markets.CRYPTO_SPOT.requestedTradingDays,2);
 assert.equal(r.markets.CRYPTO_FUTURES.requestedTradingDays,2);
 assert.equal(r.markets.CRYPTO_SPOT.sourceAttestedPriceJoinedDays,0);
 assert.equal(r.actualFillCount,null);
 assert.equal(r.historicalFullMarketOpportunityDenominatorVerified,false);
});
test("custom one-day real research scope does not become 3-year proof from fixture",()=>{
 const period={startDate:"2025-02-03",endDate:"2025-02-03"};
 const a=four({
  researchWindow:period,
  requestedTradingDaysByMarket:{CRYPTO_SPOT:[START]},
  dailyReceiptsByMarket:{
    CRYPTO_SPOT:{[String(START)]:source("CRYPTO_SPOT")},
  },
 });
 assert.equal(a.markets.CRYPTO_SPOT.requestedTradingDays,1);
 assert.equal(a.markets.CRYPTO_SPOT.sourceAttestedPriceJoinedDays,1);
 assert.equal(a.markets.CRYPTO_SPOT.fixtureJoinedDays,1);
 assert.equal(a.markets.CRYPTO_SPOT.benchmarkCalendarStatus,"FULL_SELECTED_UTC_DAYS");
 assert.equal(a.markets.CRYPTO_SPOT.benchmarkPeriodSourceAttestedPriceJoined,false);
 assert.equal(a.selectedResearchStartUtc,period.startDate);
 assert.equal(a.selectedResearchEndInclusiveUtc,period.endDate);
 assert.equal(a.actualFillCount,null);
 assert.equal(a.trueMarketWideRecall,null);
});
test("selected source-attested 1-day research is not called 3 years or real-market PASS",()=>{
  const day=START,period={startDate:"2025-02-03",endDate:"2025-02-03"};
  const historical=fullCryptoSourceAttestedBenchmarkV1();
  const receipt=historical.receipts[String(day)];
  assert.ok(receipt,"fixture day must be present in legacy history");
  const r=four({researchWindow:period,
    requestedTradingDaysByMarket:{CRYPTO_SPOT:[day]},
    dailyReceiptsByMarket:{CRYPTO_SPOT:{[String(day)]:receipt}},
  });
  const result=r.markets.CRYPTO_SPOT;
  assert.equal(result.requestedTradingDays,1);
  assert.equal(result.sourceAttestedPriceJoinedDays,1);
  assert.equal(result.lifecycleArchiveStatus,
    "SOURCE_ATTESTED_FULL_SELECTED_WINDOW_LIFECYCLE_ONLY");
  assert.equal(result.benchmarkPeriodSourceAttestedPriceJoined,true);
  assert.equal(result.independentlyAuthenticatedPITAndPriceEvidence,false);
  assert.equal(result.actualMarketWideOpportunityCount,null);
  assert.equal(result.trueMarketWideRecall,null);
  assert.equal(r.profitabilityProven,false);
  const outside=four({researchWindow:period,
    requestedTradingDaysByMarket:{US_STOCK:[day+D]}});
  assert.equal(outside.markets.US_STOCK.reason,
    "REQUESTED_DATE_OUTSIDE_SELECTED_RESEARCH_WINDOW");
  assert.equal(outside.markets.US_STOCK.benchmarkCalendarStatus,
    "REQUESTED_DATES_OUTSIDE_SELECTED_WINDOW");
});

test("invalid date / inverted range / half-supplied range cannot run the scanner",()=>{
 for(const range of [
  {startDate:"2025-02-30",endDate:"2025-03-01"},
  {startDate:"2025-03-01",endDate:"2025-02-28"},
  {startDate:"2025-01-01"},
  {endDate:"2025-01-01"},
 ]){
  assert.throws(()=>reportFourWholePITReadinessV1({researchWindow:range}),
    /RESEARCH_WINDOW/);
 }
});
