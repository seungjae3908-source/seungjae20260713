import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { digestPITMembershipRowsV1, auditHistoricalPITVenueUniverseV1 as audit }
  from "../src/historical-pit-venue-universe-gate-v1.js";
import { planFourMarketPITReplayWorkV1 as plan }
  from "../src/four-market-pit-replay-work-queue-v1.js";
import { collectPITNativeCryptoMinuteSourceV1 as collect,
  normalizeRetrospectiveCryptoMinuteSourceV1 as normalize }
  from "../src/pit-native-crypto-minute-backfill-v1.js";
import { runFourMarketOriginalMinuteReplayV1 as replay }
  from "../src/four-market-original-minute-replay-v1.js";
import { reviewOriginalMinuteForCanonicalPaperV1 as review }
  from "../src/four-market-original-minute-candidate-review-v1.js";
import { validateAndSanitizeOriginalMinuteDiagnosticV1 as sanitize }
  from "../src/research-original-minute-diagnostic-readonly-v1.js";

const DAY=86_400_000, START=Date.parse("2025-01-02T00:00:00Z"), SHA="a".repeat(64);
const venues={KR_STOCK:"KRX",US_STOCK:"US_SIP",CRYPTO_SPOT:"UPBIT_KRW",
  CRYPTO_FUTURES:"BITGET_USDT_FUTURES"};
function fixture(symbol,market="CRYPTO_FUTURES") {
  const memberships=[{symbol,listedAtMs:START-10*DAY,removedAtMs:null,
    halts:[],sourceId:"TEST_ONLY_NOT_PROVIDER_AUTHENTICATION",evidenceSha256:SHA},
  {symbol:"OLD-DELST",listedAtMs:START-30*DAY,removedAtMs:START-20*DAY,
    halts:[],sourceId:"TEST_ONLY_NOT_PROVIDER_AUTHENTICATION",evidenceSha256:SHA}];
  return {schemaVersion:"historical-venue-pit-roster-v1",sourceClass:"TEST_FIXTURE",
    testOnly:true,market,venue:venues[market],memberships,
    coverageStartMs:START-40*DAY,coverageEndMs:START+DAY,retrievedAtMs:START+2*DAY,
    sourceId:"TEST_ONLY_NOT_PROVIDER_AUTHENTICATION",allListedAndRemovedAttested:true,
    suspensionsAttested:true,relistedIdentifiersResolved:true,
    rawMembershipDigestSha256:digestPITMembershipRowsV1(memberships)};
}
function selected(symbol,market="CRYPTO_FUTURES") {
  return [{symbol,market,venue:venues[market],status:"OBSERVED_SELECTED_SYMBOL_DAY",
    observedDayCrossingCount:1}];
}
const evaluate=(symbol,manifest=fixture(symbol),market="CRYPTO_FUTURES")=>audit({
  market,dayStartMs:START,dayEndMs:START+DAY,selectedRows:selected(symbol,market),manifest});

test("Han Bitget native symbols survive PIT membership and selected identity checks, contract only",()=>{
  for(const symbol of ["龙虾USDT","牛来USDT","哈基米USDT","FUSDT"]) {
    const result=evaluate(symbol);
    assert.equal(result.status,"TEST_FIXTURE_ONLY",symbol);
    assert.equal(result.observedSelectedRosterMatched,1);
    assert.equal(result.independentlyAuthenticArchiveVerified,false);
    assert.equal(result.verifiedHistoricalMarketDenominator,null);
    assert.equal(result.OOSPassCount,0);
    assert.equal(result.profitabilityProven,false);
    assert.equal(result.executionAuthority,"NONE");
  }
});

test("whole-roster planning retains Han native identities without silently omitting members",()=>{
  for(const symbol of ["龙虾USDT","FUSDT"]) {
    const result=plan({market:"CRYPTO_FUTURES",manifest:fixture(symbol),
      researchWindow:{startDate:"2025-01-02",endDate:"2025-01-02"}});
    assert.equal(result.status,"SOURCE_ONLY_PIT_WORK_PAGINATED");
    assert.equal(result.historicRosterMemberCount,2);
    assert.deepEqual(result.candidateTasks.map(x=>x.symbol),[symbol]);
    assert.equal(result.originalMarketMinuteSourceVerified,false);
    assert.equal(result.paperAdmissionAllowed,false);
    assert.equal(result.profitabilityProven,false);
  }
});

test("native backfill accepts Han and one-character bases but still rejects fixtures before I/O",async()=>{
  let requests=0;
  for(const symbol of ["龙虾USDT","牛来USDT","FUSDT"]) {
    const manifest=fixture(symbol);
    const result=await collect({root:"NOT_ACCESSED",market:"CRYPTO_FUTURES",symbol,
      dayStartMs:START,manifest,expectedRosterDigestSha256:manifest.rawMembershipDigestSha256,
      allowPublicReadOnlyFetch:true,nowImpl:()=>START+3*DAY,
      bitgetClient:{get:async()=>{requests++;throw Error("must not fetch fixture");}}});
    assert.equal(result.reason,"PIT_FIXTURE_NOT_ELIGIBLE_FOR_PUBLIC_SOURCE_BACKFILL");
    assert.equal(result.realOrders,false);
    assert.equal(result.profitabilityProven,false);
  }
  assert.equal(requests,0);
});

test("Han identity compatibility never substitutes current/candle-inferred lists or missing PIT",()=>{
  for(const symbol of ["龙虾USDT","FUSDT"]) {
    for(const [manifest,reason] of [[null,"DATED_HISTORICAL_PIT_ROSTER_NOT_CONNECTED"],
      [{sourceClass:"CURRENT_SNAPSHOT"},"CURRENT_SURVIVOR_LIST_NOT_HISTORICAL_PIT"],
      [{sourceClass:"CANDLE_PRESENCE_INFERRED"},"CANDLE_EXISTENCE_NOT_FULL_LISTING"]]) {
      const result=evaluate(symbol,manifest);
      assert.equal(result.status,"BLOCKED_PIT_UNIVERSE");
      assert.equal(result.reason,reason);
      assert.equal(result.fullMarketOpportunityDenominatorVerified,false);
      assert.equal(result.profitabilityProven,false);
    }
  }
});

test("Han extension is futures-specific; unsafe scripts, separators and native sizes stay rejected",async()=>{
  for(const market of ["KR_STOCK","US_STOCK","CRYPTO_SPOT"]) {
    assert.equal(evaluate("龙虾USDT",fixture("龙虾USDT",market),market).reason,
      "SELECTED_SOURCE_COHORT_CONTRACT_INVALID");
  }
  for(const symbol of ["龙虾/USDT","龙虾\\USDT","龙虾\u0000USDT","🐉USDT","БTCUSDT",
    "USDT","龙虾USDC","龙虾-usdt","A".repeat(27)+"USDT",""]) {
    assert.equal(normalize({market:"CRYPTO_FUTURES",symbol}).error,"NATIVE_1M_SOURCE_IDENTITY_INVALID");
    await assert.rejects(collect({root:"NOT_ACCESSED",market:"CRYPTO_FUTURES",symbol,
      dayStartMs:START,expectedRosterDigestSha256:SHA,allowPublicReadOnlyFetch:false,
      nowImpl:()=>START+3*DAY}),/PIT_NATIVE_MINUTE_BACKFILL_ARGUMENTS_INVALID/);
  }
});

test("historical Han replay accepts identity and preserves cancellation before archive access",async()=>{
  const controller=new AbortController();controller.abort();
  const symbol="龙虾USDT";
  const result=await replay({root:resolve("NOT_ACCESSED"),market:"CRYPTO_FUTURES",symbol,
    manifest:fixture(symbol),researchWindow:{startDate:"2025-01-02",endDate:"2025-01-02"},
    asOfMs:START+3*DAY,signal:controller.signal});
  assert.equal(result.reason,"ORIGINAL_MINUTE_REPLAY_CANCELLED");
  assert.equal(result.symbol,symbol);
  assert.equal(result.sourceMinuteRowsRead,0);
  assert.equal(result.profitabilityProven,false);
  assert.equal(result.executionAuthority,"NONE");
});

test("historical Han result readback and canonical review remain blocked, never OOS or Paper PASS",()=>{
  const market="CRYPTO_FUTURES",symbol="龙虾USDT";
  const raw={schemaVersion:"four-market-original-minute-period-v1",market,symbol,
    selectedStartDate:"2025-01-02",selectedEndDate:"2025-01-02",status:"BLOCKED_DATA",
    reason:"ORIGINAL_ONE_MINUTE_SOURCE_MISSING",modeledReturnPercent:null,
    executionAuthority:"NONE",profitabilityProven:false,actualFillCount:null,
    trueMarketWideRecall:null,actualMarketWideOpportunityCount:null,netProfitPct:null,
    fullMarketOpportunityDenominatorVerified:false,OOSPassCount:0,
    paperAdmissionAllowed:false,realOrders:false,liveTrading:false,autoTrading:false};
  assert.equal(sanitize(raw,market),null,"missing source remains unavailable, not zero-return data");
  const result=sanitize({...raw,status:"SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY",
    reason:"TEST_ONLY_MODELED_DIAGNOSTIC",indexedPrivateSessions:1,verifiedNativeMinuteSessions:1,
    modeledTradeCount:0,modeledReturnPercent:0,modeledNetPnlKRW:0,
    sourceSessionIndexDigestSha256:SHA},market);
  assert.equal(result.symbol,symbol);
  assert.equal(result.profitabilityProven,false);
  assert.equal(result.independentOOSProven,false);
  const verdict=review({market,symbol,periodResult:raw});
  assert.equal(verdict.status,"RESEARCH_HOLD");
  assert.equal(verdict.independentBacktestAndOOSPASS,false);
  assert.equal(verdict.paperAdmissionAllowed,false);
  assert.equal(verdict.paperCandidate,null);
  assert.ok(verdict.blockers.includes("FROZEN_STRATEGY_AND_INDEPENDENT_OOS_UNVERIFIED"));
  assert.ok(verdict.blockers.includes("ORIGINAL_ONE_MINUTE_PERIOD_SOURCE_BLOCKED"));
  assert.throws(()=>sanitize({...raw,profitabilityProven:true},market),/CONTRACT_INVALID/);
  assert.throws(()=>sanitize({...raw,OOSPassCount:1},market),/CONTRACT_INVALID/);
});
