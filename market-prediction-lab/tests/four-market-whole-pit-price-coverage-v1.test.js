import test from "node:test";
import assert from "node:assert/strict";
import {digestPITMembershipRowsV1} from "../src/historical-pit-venue-universe-gate-v1.js";
import {
  FOUR_MARKET_WHOLE_SCOPE_V1 as SCOPE,
  digestWholeVenueDailyRowsV1,
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
  relistedIdentifiersResolved:true,memberships,
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
