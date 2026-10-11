import test from "node:test";
import assert from "node:assert/strict";
import {reviewOriginalMinuteForCanonicalPaperV1 as review}
  from "../src/four-market-original-minute-candidate-review-v1.js";

const DATE="2026-09-18",NOW=Date.parse("2026-10-11T00:00:00Z");
const markets={
  KR_STOCK:"005930",US_STOCK:"AAPL",
  CRYPTO_SPOT:"KRW-BTC",CRYPTO_FUTURES:"BTCUSDT",
};
const period=(market,symbol)=>({
  schemaVersion:"four-market-original-minute-period-v1",
  market,symbol,selectedStartDate:DATE,selectedEndDate:DATE,
  status:"SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY",
  sourceSessionIndexDigestSha256:"a".repeat(64),
  indexedPrivateSessions:1,verifiedNativeMinuteSessions:1,
  modeledTradeCount:12,modeledNetPnlKRW:32500,
  modeledReturnPercent:3.25,
  fullMarketOpportunityDenominatorVerified:false,
  actualMarketWideOpportunityCount:null,
  trueMarketWideRecall:null,
  actualFillCount:null,OOSPassCount:0,
  profitabilityProven:false,paperAdmissionAllowed:false,
  executionAuthority:"NONE",orderSubmitted:false,
  realOrders:false,liveTrading:false,autoTrading:false,
});
const sweep=market=>({
  schemaVersion:"four-market-original-minute-sweep-v1",
  market,selectedStartDate:DATE,selectedEndDate:DATE,
  status:"LOCAL_HISTORIC_SOURCE_PAGES_TRAVERSED_RESEARCH_ONLY",
  pageChainSha256:"b".repeat(64),
  pageCountSelfAttested:12,sourceOnlyCompletePages:12,
  sourceBlockedPages:0,sourceOnlyObservedPriceEventLabels:19,
  localPageTraversalReachedEnd:true,
  fullMarketOpportunityDenominatorVerified:false,
  actualMarketWideOpportunityCount:null,trueMarketWideRecall:null,
  actualFillCount:null,OOSPassCount:0,
  profitabilityProven:false,paperAdmissionAllowed:false,
  executionAuthority:"NONE",orderSubmitted:false,
  realOrders:false,liveTrading:false,autoTrading:false,
});
test("four-market native minute model and full local sweep reach REAL canonical gates but never Paper",()=>{
 for(const [market,symbol] of Object.entries(markets)){
  const args={market,symbol,nowMs:NOW,
    periodResult:period(market,symbol),sweepResult:sweep(market)};
  const first=review(args);
  const again=review(args);
  assert.deepEqual(first,again);
  assert.equal(first.status,"RESEARCH_HOLD");
  assert.equal(first.periodStatus,"SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY");
  assert.equal(first.sweepStatus,"LOCAL_HISTORIC_SOURCE_PAGES_TRAVERSED_RESEARCH_ONLY");
  assert.match(first.diagnosticFingerprint,/^[0-9a-f]{64}$/);
  assert.equal(first.canonicalProfitabilityStatus,"RESEARCH_HOLD");
  assert.equal(first.canonicalProfitabilityEligible,false);
  assert.ok(first.canonicalProfitabilityBlockers.includes("policy:not_empirically_calibrated"));
  assert.ok(first.canonicalProfitabilityBlockers.includes("selection_bias:missing_evidence"));
  assert.ok(first.canonicalProfitabilityBlockers.includes("paper:missing_evidence"));
  assert.equal(first.canonicalPaperBridgeStatus,"BLOCKED");
  assert.equal(first.canonicalPaperEvidenceReady,false);
  assert.ok(first.canonicalPaperBridgeBlockers.includes("ADMISSION_EVIDENCE_BUNDLE_REQUIRED"));
  assert.ok(first.blockers.includes("INDEPENDENT_WHOLE_VENUE_HISTORICAL_PIT_ROSTER_MISSING"));
  assert.ok(first.blockers.includes("FROZEN_STRATEGY_AND_INDEPENDENT_OOS_UNVERIFIED"));
  assert.ok(first.blockers.includes("FUTURE_PROSPECTIVE_SIGNAL_UNVERIFIED"));
  assert.equal(first.paperCandidate,null);
  assert.equal(first.sampleExecutionReady,false);
  assert.equal(first.paperAdmissionAllowed,false);
  assert.equal(first.paperOrderSubmitted,false);
  assert.equal(first.providerGETCount,0);
  assert.equal(first.financialMutationCount,0);
  assert.equal(first.actualFillCount,null);
  assert.equal(first.OOSPassCount,0);
  assert.equal(first.profitabilityProven,false);
  assert.equal(first.executionAuthority,"NONE");
  assert.equal(first.privateTradingApiAllowed,false);
 }
});
test("an offline source-only model without independent full PIT sweep receives exact missing-evidence blockers",()=>{
 const market="US_STOCK",symbol=markets[market];
 const only=review({market,symbol,periodResult:period(market,symbol),nowMs:NOW});
 assert.equal(only.status,"RESEARCH_HOLD");
 assert.ok(only.blockers.includes("HISTORIC_WHOLE_VENUE_PIT_SWEEP_REQUIRED"));
 assert.equal(only.sweepStatus,"NOT_CONNECTED");
 assert.equal(only.paperAdmissionAllowed,false);
 const missing=review({market,symbol,nowMs:NOW});
 assert.ok(missing.blockers.includes("ORIGINAL_ONE_MINUTE_PERIOD_REPORT_REQUIRED"));
 assert.ok(missing.blockers.includes("HISTORIC_WHOLE_VENUE_PIT_SWEEP_REQUIRED"));
 assert.equal(missing.modelOnly,true);
 assert.equal(missing.canonicalProfitabilityEligible,false);
});
test("a modeled plus-100000% return cannot become an OOS or simulated fill",()=>{
 const market="CRYPTO_FUTURES",symbol=markets[market];
 const unrealistic=period(market,symbol);
 unrealistic.modeledReturnPercent=100000;
 unrealistic.modeledNetPnlKRW=1_000_000_000;
 const result=review({market,symbol,periodResult:unrealistic,
   sweepResult:sweep(market),nowMs:NOW});
 assert.equal(result.status,"RESEARCH_HOLD");
 assert.equal(result.profitabilityProven,false);
 assert.equal(result.actualFillCount,null);
 assert.equal(result.paperAdmissionAllowed,false);
 assert.equal(result.canonicalPaperBridgeStatus,"BLOCKED");
});
test("malicious LIVE, actual fill, OOS success, fake whole market and wrong identity are refused before review",()=>{
 const market="CRYPTO_SPOT",symbol=markets[market];
 for(const modified of [
  {executionAuthority:"LIVE"},
  {profitabilityProven:true},
  {paperAdmissionAllowed:true},
  {actualFillCount:10},
  {OOSPassCount:1},
  {realOrders:true},
  {liveTrading:true},
  {trueMarketWideRecall:1},
  {actualMarketWideOpportunityCount:100},
  {fullMarketOpportunityDenominatorVerified:true},
  {market:"US_STOCK"},
  {symbol:"KRW-ETH"},
  {selectedEndDate:"2026-02-30"},
 ]){
  assert.throws(()=>review({market,symbol,nowMs:NOW,
    periodResult:{...period(market,symbol),...modified},
    sweepResult:sweep(market),
  }),/ORIGINAL_MODEL_PAPER_REVIEW_PERIOD_UNSAFE/);
 }
 for(const modified of [
  {executionAuthority:"LIVE"},{profitabilityProven:true},
  {status:"UNKNOWN"},{actualFillCount:1},
  {paperAdmissionAllowed:true},{market:"US_STOCK"},
 ]){
  assert.throws(()=>review({market,symbol,nowMs:NOW,
    periodResult:period(market,symbol),
    sweepResult:{...sweep(market),...modified},
  }),/ORIGINAL_MODEL_PAPER_REVIEW_SWEEP_UNSAFE/);
 }
});
test("period/sweep selected date mismatch and missing immutable lineage are blockers rather than zero market opportunity",()=>{
 const market="KR_STOCK",symbol=markets[market];
 const different={...sweep(market),
  selectedStartDate:"2026-09-19",selectedEndDate:"2026-09-19"};
 const r=review({market,symbol,
  periodResult:period(market,symbol),sweepResult:different,nowMs:NOW});
 assert.ok(r.blockers.includes("PERIOD_SWEEP_SELECTED_DATE_WINDOW_MISMATCH"));
 assert.equal(r.trueMarketWideRecall,null);
 const badPeriod={...period(market,symbol),
   sourceSessionIndexDigestSha256:"wrong"};
 const badSweep={...sweep(market),pageChainSha256:"bad"};
 const x=review({market,symbol,periodResult:badPeriod,
   sweepResult:badSweep,nowMs:NOW});
 assert.ok(x.blockers.includes("ORIGINAL_ONE_MINUTE_MODEL_LINEAGE_OR_COUNTER_UNVERIFIED"));
 assert.ok(x.blockers.includes("HISTORIC_PIT_SWEEP_LINEAGE_OR_COMPLETENESS_UNVERIFIED"));
 assert.equal(x.canonicalProfitabilityEligible,false);
});
test("source blocked remains unknown and canonical gates forbid Paper without calibration, original source and forward",()=>{
 const market="US_STOCK",symbol=markets[market];
 const r=review({market,symbol,
  periodResult:{...period(market,symbol),status:"BLOCKED_DATA",
    modeledReturnPercent:null,modeledNetPnlKRW:null},
  sweepResult:{...sweep(market),status:"BLOCKED_DATA",
    sourceOnlyObservedPriceEventLabels:null},
  nowMs:NOW});
 assert.ok(r.blockers.includes("ORIGINAL_ONE_MINUTE_PERIOD_SOURCE_BLOCKED"));
 assert.ok(r.blockers.includes("HISTORIC_WHOLE_VENUE_PIT_SWEEP_BLOCKED"));
 assert.equal(r.canonicalProfitabilityEligible,false);
 assert.equal(r.paperAdmissionAllowed,false);
 assert.equal(r.actualFillCount,null);
 assert.equal(r.profitabilityProven,false);
 assert.equal(r.executionAuthority,"NONE");
});
