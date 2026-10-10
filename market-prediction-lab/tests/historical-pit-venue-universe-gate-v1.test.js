import test from "node:test";
import assert from "node:assert/strict";
import {digestPITMembershipRowsV1,auditHistoricalPITVenueUniverseV1 as audit,
 reportFourMarketPITRosterReadinessV1 as report} from "../src/historical-pit-venue-universe-gate-v1.js";
const UTC=86_400_000,START=Date.parse("2025-02-03T00:00:00Z"),END=START+UTC;
const SHA="a".repeat(64);
function selected(symbol="KRW-ETH",status="OBSERVED_SELECTED_SYMBOL_DAY") {
  return [{market:"CRYPTO_SPOT",venue:"UPBIT_KRW",
    symbol,status,observedDayCrossingCount:status==="BLOCKED_DATA"?null:1}];
}
function rows(){
  return [
    {symbol:"KRW-ETH",listedAtMs:START-500*UTC,removedAtMs:null,
      halts:[],sourceId:"fixture-archive",evidenceSha256:SHA},
    {symbol:"KRW-OLD",listedAtMs:START-800*UTC,removedAtMs:START-100*UTC,
      halts:[],sourceId:"fixture-archive",evidenceSha256:SHA},
  ];
}
function fixture(memberships=rows(),overrides={}){
  const raw={
    schemaVersion:"historical-venue-pit-roster-v1",
    sourceClass:"TEST_FIXTURE",testOnly:true,
    market:"CRYPTO_SPOT",venue:"UPBIT_KRW",
    coverageStartMs:START-1000*UTC,coverageEndMs:END,
    retrievedAtMs:START+100*UTC,
    sourceId:"test-only-pit-roster",
    allListedAndRemovedAttested:true,suspensionsAttested:true,
    relistedIdentifiersResolved:true,
    memberships,
    rawMembershipDigestSha256:digestPITMembershipRowsV1(memberships),
    ...overrides,
  };
  return raw;
}
const eval1=(manifest,selectedRows=selected())=>audit({
  market:"CRYPTO_SPOT",dayStartMs:START,dayEndMs:END,selectedRows,manifest,
});
function sourceSummary() {
  return {
    schemaVersion:"native-selected-historical-utc-day-1m-pilot-v1",
    executionAuthority:"NONE",profitabilityProven:false,
    historicalPointInTimeUniverseVerified:false,trueMarketWideRecall:null,
    sample:{endMs:END},
    markets:{KR_STOCK:{status:"BLOCKED_DATA"},US_STOCK:{status:"BLOCKED_DATA"},
      CRYPTO_SPOT:selected(),CRYPTO_FUTURES:[
        {market:"CRYPTO_FUTURES",venue:"BITGET_USDT_FUTURES",symbol:"BTCUSDT",
          status:"OBSERVED_SELECTED_SYMBOL_DAY",observedDayCrossingCount:1},
      ]},
  };
}
test("current-listed selected price data has no PIT population denominator",()=>{
  const a=report({nativeSelectedSummary:sourceSummary()});
  assert.equal(a.observedSelectedSymbolDays,2);
  assert.equal(a.totalHistoricActiveMarketSymbols,null);
  for(const market of Object.keys(a.markets)){
    assert.equal(a.markets[market].status,"BLOCKED_PIT_UNIVERSE");
    assert.equal(a.markets[market].reason,"DATED_HISTORICAL_PIT_ROSTER_NOT_CONNECTED");
    assert.equal(a.markets[market].verifiedHistoricalMarketDenominator,null);
  }
  assert.equal(a.fullMarketOpportunityDenominatorVerified,false);
  assert.equal(a.trueMarketWideRecall,null);
  assert.equal(a.profitabilityProven,false);
  assert.equal(a.executionAuthority,"NONE");
});
test("current exchange markets and inferred candle appearance are NOT archived complete roster",()=>{
  for(const cls of ["CURRENT_SNAPSHOT","CANDLE_PRESENCE_INFERRED"]){
    const r=eval1({sourceClass:cls});
    assert.equal(r.status,"BLOCKED_PIT_UNIVERSE");
    assert.equal(r.survivorBiasExcluded,true);
    assert.equal(r.trueMarketWideRecall,null);
  }
});
test("point-in-time fixture with delisted symbol can pass CONTRACT ONLY",()=>{
  const a=eval1(fixture());
  assert.equal(a.status,"TEST_FIXTURE_ONLY");
  assert.equal(a.dayActiveArchivedMembers,1);
  assert.equal(a.archivedEndedInThreeYears,1);
  assert.equal(a.archivedMembersNotInSelectedCandleCohort,0);
  assert.equal(a.observedSelectedRosterMatched,1);
  assert.equal(a.independentlyAuthenticArchiveVerified,false);
  assert.equal(a.verifiedHistoricalMarketDenominator,null);
  assert.equal(a.executionAuthority,"NONE");
});
test("declared removed names with no actual archived exit rows are BLOCKED",()=>{
  const a=eval1(fixture(rows().filter(x=>x.removedAtMs==null)));
  assert.equal(a.reason,"PIT_REMOVED_NAMES_EVIDENCE_MISSING");
});
test("same-symbol overlaps cannot hide behind interleaved symbols",()=>{
  const r=rows();
  r.splice(1,0,{...r[0],listedAtMs:START-550*UTC,removedAtMs:START-100*UTC});
  const a=eval1(fixture(r));
  assert.equal(a.reason,"PIT_OVERLAPPING_SAME_SYMBOL_INTERVALS");
});
test("selected candles for delisted-before-day symbol must fail closed",()=>{
  const a=eval1(fixture(),selected("KRW-OLD"));
  assert.equal(a.reason,"HISTORIC_PRICE_BARS_OUTSIDE_LISTED_MEMBERSHIP");
  assert.deepEqual(a.conflictingSymbols,["KRW-OLD"]);
});
test("missing selected symbol membership cannot be counted as no opportunity",()=>{
  const a=eval1(fixture(),selected("KRW-NEW"));
  assert.equal(a.status,"BLOCKED_PIT_UNIVERSE");
  assert.equal(a.reason,"HISTORIC_PRICE_BARS_OUTSIDE_LISTED_MEMBERSHIP");
  assert.equal(a.netProfitPct,null);
});
test("full minute source conflicts with reported intraday trading halt",()=>{
  const r=rows();r[0]={...r[0],halts:[
    {startMs:START+2*60_000,endMs:START+4*60_000,reason:"EXCHANGE_HALT"}]};
  const a=eval1(fixture(r));
  assert.equal(a.reason,"OBSERVED_FULL_DAY_TRADES_DURING_REPORTED_HALT");
});
test("selected full day candles cannot predate listing start",()=>{
  const r=rows();r[0]={...r[0],listedAtMs:START+UTC/2};
  const a=eval1(fixture(r));
  assert.equal(a.reason,"FULL_DAY_BARS_BEFORE_LISTING");
});
test("selected full day candles cannot exceed removal within day",()=>{
  const r=rows();r[0]={...r[0],removedAtMs:START+UTC/2};
  const a=eval1(fixture(r));
  assert.equal(a.reason,"FULL_DAY_BARS_AFTER_DELISTING");
});
test("tampered or future-incomplete archive provenance is rejected",()=>{
  const f=fixture();
  const damaged={...f,memberships:f.memberships.slice(1)};
  assert.equal(eval1(damaged).reason,"PIT_ARCHIVE_SOURCE_ATTESTATION_INVALID");
  const range=fixture(rows(),{coverageEndMs:START+60_000});
  assert.equal(eval1(range).reason,"PIT_ARCHIVE_SOURCE_ATTESTATION_INVALID");
});
test("unverified archived member has no source bars so NO zero-trade assumption",()=>{
  const r=rows();
  r.push({symbol:"KRW-OTHER",listedAtMs:START-60*UTC,
    removedAtMs:null,halts:[],sourceId:"fixture-archive",evidenceSha256:SHA});
  const a=eval1(fixture(r));
  assert.equal(a.status,"TEST_FIXTURE_ONLY");
  assert.equal(a.dayActiveArchivedMembers,2);
  assert.equal(a.archivedMembersNotInSelectedCandleCohort,1);
  assert.equal(a.archivedMembersWithoutPriceNotAssumedZero,true);
});
test("safeguards cannot interpret archived collection as real scanner as-of history",()=>{
  const r=eval1(fixture(rows(),{retrievedAtMs:START+365*UTC}));
  assert.equal(r.archiveRetrospectiveNotScannerAvailableAt,true);
  assert.equal(r.fullMarketOpportunityDenominatorVerified,false);
  assert.equal(r.trueMarketWideRecall,null);
});
test("bad market and day window are rejected",()=>{
  assert.throws(()=>audit({market:"FOREX",dayStartMs:START,dayEndMs:END}),/PIT_MARKET_INVALID/);
  assert.throws(()=>audit({market:"CRYPTO_SPOT",dayStartMs:START+60_000,
    dayEndMs:END}),/PIT_DAY_WINDOW_INVALID/);
});
test("wrong or contaminated selected venue doesn't become PIT evidence",()=>{
  const r=eval1(null,[{market:"CRYPTO_SPOT",venue:"BITGET_USDT_FUTURES",
    symbol:"KRW-ETH",status:"OBSERVED_SELECTED_SYMBOL_DAY"}]);
  assert.equal(r.reason,"SELECTED_SOURCE_COHORT_CONTRACT_INVALID");
});
test("source receipt with profitability marked proven is refused",()=>{
  const f=sourceSummary();f.profitabilityProven=true;
  assert.throws(()=>report({nativeSelectedSummary:f}),/PIT_SOURCE_RECEIPT_INVALID/);
});

test("early PIT session with zero AS-OF removals can use a full later-delisting archive",()=>{
 const members=rows();
 members[1]={...members[1],removedAtMs:START+30*UTC};
 const full=fixture(members,{
   coverageEndMs:START+31*UTC,
   retrievedAtMs:START+40*UTC,
 });
 const result=eval1(full);
 assert.equal(result.status,"TEST_FIXTURE_ONLY");
 assert.equal(result.dayActiveArchivedMembers,2);
 assert.equal(result.archivedEndedInThreeYears,0);
 assert.equal(result.archivedRemovedAcrossSourceWindow,1);
 assert.equal(result.actualFillCount,null);
 assert.equal(result.trueMarketWideRecall,null);
 assert.equal(result.fullMarketOpportunityDenominatorVerified,false);
});
test("an archival roster cannot be certified complete through a date in its future",()=>{
 const future=fixture(rows(),{retrievedAtMs:START});
 const r=eval1(future);
 assert.equal(r.status,"BLOCKED_PIT_UNIVERSE");
 assert.equal(r.reason,"PIT_ARCHIVE_SOURCE_ATTESTATION_INVALID");
 assert.equal(r.trueMarketWideRecall,null);
});
