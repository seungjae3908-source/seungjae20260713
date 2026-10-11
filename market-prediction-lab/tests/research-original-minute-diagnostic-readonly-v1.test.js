import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,chmodSync,symlinkSync,
  rmSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {readResearchOriginalMinuteDiagnosticV1 as read}
  from "../src/research-original-minute-diagnostic-readonly-v1.js";

const root=()=>mkdtempSync(join(tmpdir(),"original-minute-readback-v1-"));
const market="CRYPTO_SPOT";
const period=()=>({
  schemaVersion:"four-market-original-minute-period-v1",
  market,symbol:"KRW-BTC",timeframe:"5m",
  selectedStartDate:"2025-10-01",selectedEndDate:"2026-09-30",
  status:"SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY",
  reason:"PRIVATE_ORIGINAL_1M_MULTI_SESSION_RESEARCH_ONLY_NOT_OOS",
  sourceSessionsRead:350,verifiedNativeMinuteSessions:350,
  indexedPrivateSessions:350,
  modeledTradeCount:12,modeledReturnPercent:3.25,
  modeledNetPnlKRW:32500,
  executionAuthority:"NONE",profitabilityProven:false,
  actualFillCount:null,trueMarketWideRecall:null,OOSPassCount:0,
  actualMarketWideOpportunityCount:null,netProfitPct:null,
  fullMarketOpportunityDenominatorVerified:false,
  paperAdmissionAllowed:false,realOrders:false,
  liveTrading:false,autoTrading:false,
});
const sweep=()=>({
  schemaVersion:"four-market-original-minute-sweep-v1",
  market,selectedStartDate:"2025-10-01",selectedEndDate:"2026-09-30",
  status:"LOCAL_HISTORIC_SOURCE_PAGES_TRAVERSED_RESEARCH_ONLY",
  reason:"RETROSPECTIVE_LOCAL_PAGES_NOT_INDEPENDENT_PIT_OOS_OR_FILL",
  pageCountSelfAttested:45,sourceOnlyCompletePages:45,
  sourceBlockedPages:0,sourceTasksSelfAttested:270,
  sourceOnlyObservedPriceEventLabels:123,
  localPageTraversalReachedEnd:true,
  executionAuthority:"NONE",profitabilityProven:false,
  actualFillCount:null,trueMarketWideRecall:null,OOSPassCount:0,
  actualMarketWideOpportunityCount:null,netProfitPct:null,
  fullMarketOpportunityDenominatorVerified:false,
  paperAdmissionAllowed:false,realOrders:false,
  liveTrading:false,autoTrading:false,
});
function save(root,body,name=market+".json"){
  const file=join(root,name);
  writeFileSync(file,JSON.stringify(body),{mode:0o600});
  chmodSync(file,0o600);
  return file;
}
test("only period model summary is returned; secrets, original bars, paths and Paper authority never leak",async()=>{
  const folder=root();
  try{
    const raw={...period(),
      sourceRoot:"/root/private/secret",
      apiKey:"SHOULD_NOT_SHOW",
      sourceMinuteBars:[{timestampMs:1,close:100}],
      internalStrategyParameters:{fast:3,slow:15},
    };
    save(folder,raw);
    const r=await read({root:folder,market});
    assert.equal(r.available,true);
    assert.equal(r.status,"SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY");
    assert.equal(r.report.kind,"PERIOD");
    assert.equal(r.report.modeledReturnPercent,3.25);
    assert.equal(r.report.sourceSessionsVerified,350);
    assert.equal(r.report.modeledTradeCount,12);
    assert.equal(r.report.independentOOSProven,false);
    assert.equal(r.report.originalHistoricalSignalVerified,false);
    assert.equal(r.report.paperCandidatePASS,false);
    assert.equal(r.report.executionAuthority,"NONE");
    assert.equal(r.report.canonicalPaperResearchReview.status,"RESEARCH_HOLD");
    assert.equal(r.report.canonicalPaperResearchReview.canonicalProfitabilityStatus,"RESEARCH_HOLD");
    assert.equal(r.report.canonicalPaperResearchReview.canonicalPaperBridgeStatus,"BLOCKED");
    assert.equal(r.report.canonicalPaperResearchReview.paperAdmissionAllowed,false);
    assert.equal(r.report.canonicalPaperResearchReview.executionAuthority,"NONE");
    assert.ok(r.report.canonicalPaperResearchReview.blockers.includes(
      "HISTORIC_WHOLE_VENUE_PIT_SWEEP_REQUIRED"));
    assert.ok(r.report.canonicalPaperResearchReview.canonicalPaperBridgeBlockers
      .includes("ADMISSION_EVIDENCE_BUNDLE_REQUIRED"));
    assert.equal(r.profitabilityProven,false);
    assert.equal(r.actualFillCount,null);
    assert.equal(r.financialMutationCount,0);
    assert.equal(r.providerGETCount,0);
    const serialized=JSON.stringify(r);
    assert.doesNotMatch(serialized,/SHOULD_NOT_SHOW|private\/secret|sourceMinuteBars|internalStrategyParameters/);
  }finally{rmSync(folder,{recursive:true,force:true});}
});
test("read-only sweep result exposes ONLY retrospective local event labels, not actual market recall or fills",async()=>{
  const folder=root();
  try{
    save(folder,sweep());
    const r=await read({root:folder,market});
    assert.equal(r.available,true);
    assert.equal(r.report.kind,"SWEEP");
    assert.equal(r.report.sourceOnlyObservedPriceEventLabels,123);
    assert.equal(r.report.pageCountSelfAttested,45);
    assert.equal(r.report.actualMarketWideOpportunityCount,null);
    assert.equal(r.report.independentOOSProven,false);
    assert.equal(r.report.paperCandidatePASS,false);
    assert.equal(r.actualFillCount,null);
    assert.equal(r.profitabilityProven,false);
  }finally{rmSync(folder,{recursive:true,force:true});}
});
test("missing private source and missing report return UNKNOWN BLOCKED, not numerical zero",async()=>{
  const folder=root();
  try{
    const missing=await read({root:folder,market});
    assert.equal(missing.available,false);
    assert.equal(missing.status,"BLOCKED_DATA");
    assert.equal(missing.actualMarketWideOpportunityCount,null);
    assert.equal(missing.report,null);
    const invalidRoot=await read({root:"",market});
    assert.equal(invalidRoot.available,false);
    assert.equal(invalidRoot.reason,"PRIVATE_MODEL_REPORT_ROOT_NOT_CONFIGURED");
  }finally{rmSync(folder,{recursive:true,force:true});}
});
test("wrong venue identity, fabricated PASS/trading, wrong dates, positive BLOCKED model or rogue costs fail closed",async()=>{
  const folder=root();
  try{
    for(const modified of [
      {market:"CRYPTO_FUTURES"},
      {executionAuthority:"LIVE"},
      {profitabilityProven:true},
      {paperAdmissionAllowed:true},
      {actualFillCount:1},
      {OOSPassCount:1},
      {trueMarketWideRecall:0.99},
      {actualMarketWideOpportunityCount:12},
      {netProfitPct:20},
      {fullMarketOpportunityDenominatorVerified:true},
      {realOrders:true},
      {liveTrading:true},
      {selectedEndDate:"2026-02-30"},
      {modeledReturnPercent:Number.NaN},
      {modeledNetPnlKRW:Infinity},
      {status:"BLOCKED_DATA"},
      {status:"LOCAL_HISTORIC_SOURCE_PAGES_TRAVERSED_RESEARCH_ONLY"},
      {sourceModelDigestSha256:"BAD_SHA"},
    ]){
      save(folder,{...period(),...modified});
      await assert.rejects(()=>read({root:folder,market}),
        /NATIVE_DIAGNOSTIC_PRIVATE_MODEL_CONTRACT_INVALID|NATIVE_DIAGNOSTIC_PERIOD_VALUES_INVALID|NATIVE_DIAGNOSTIC_PERIOD_STATUS_SCHEMA_MISMATCH/);
    }
    for(const modified of [
      {sourceBlockedPages:1},
      {localPageTraversalReachedEnd:false},
      {sourceOnlyObservedPriceEventLabels:-1},
      {status:"SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY"},
      {status:"BLOCKED_DATA"},
    ]){
      save(folder,{...sweep(),...modified});
      await assert.rejects(()=>read({root:folder,market}),
        /NATIVE_DIAGNOSTIC_PRIVATE_MODEL_CONTRACT_INVALID|NATIVE_DIAGNOSTIC_SWEEP_VALUES_INVALID|NATIVE_DIAGNOSTIC_SWEEP_STATUS_SCHEMA_MISMATCH/);
    }
  }finally{rmSync(folder,{recursive:true,force:true});}
});
test("unsafe permissions and symlinked report files are never read",async()=>{
  const folder=root();
  try{
    const file=save(folder,period());
    chmodSync(file,0o644);
    await assert.rejects(()=>read({root:folder,market}),
      /NATIVE_DIAGNOSTIC_PRIVATE_FILE_INVALID/);
    rmSync(file);
    const outside=join(folder,"untrusted-original.json");
    save(folder,period(),"untrusted-original.json");
    symlinkSync(outside,file);
    await assert.rejects(()=>read({root:folder,market}));
    rmSync(file);
    chmodSync(folder,0o755);
    await assert.rejects(()=>read({root:folder,market}),
      /NATIVE_DIAGNOSTIC_PRIVATE_ROOT_REQUIRED/);
  }finally{rmSync(folder,{recursive:true,force:true});}
});

test("paired PERIOD + SWEEP report across four venues uses both read-only receipts without any Paper permission",async()=>{
  for(const marketName of ["KR_STOCK","US_STOCK","CRYPTO_SPOT","CRYPTO_FUTURES"]){
    const folder=root();
    try{
      const symbols={KR_STOCK:"005930",US_STOCK:"AAPL",
        CRYPTO_SPOT:"KRW-BTC",CRYPTO_FUTURES:"BTCUSDT"};
      const p={...period(),market:marketName,symbol:symbols[marketName],
        sourceSessionIndexDigestSha256:"a".repeat(64)};
      const all={...sweep(),market:marketName,pageChainSha256:"b".repeat(64)};
      const first=join(folder,marketName+".json");
      const second=join(folder,marketName+".SWEEP.json");
      writeFileSync(first,JSON.stringify(p),{mode:0o600});
      writeFileSync(second,JSON.stringify({...all,apiKey:"PAIR_PRIVATE_TOKEN",
        rawMinuteCandles:[1]}),{mode:0o600});
      const out=await read({root:folder,market:marketName});
      assert.equal(out.available,true);
      assert.equal(out.report.kind,"PERIOD");
      assert.equal(out.supplementarySweepReport.kind,"SWEEP");
      assert.equal(out.supplementarySweepWindowMatches,true);
      const review=out.report.canonicalPaperResearchReview;
      assert.equal(review.status,"RESEARCH_HOLD");
      assert.equal(review.blockers.includes(
        "HISTORIC_WHOLE_VENUE_PIT_SWEEP_REQUIRED"),false);
      assert.equal(review.blockers.includes(
        "HISTORIC_PIT_SWEEP_LINEAGE_OR_COMPLETENESS_UNVERIFIED"),false);
      assert.equal(review.blockers.includes(
        "ORIGINAL_ONE_MINUTE_MODEL_LINEAGE_OR_COUNTER_UNVERIFIED"),false);
      assert.ok(review.blockers.includes(
        "FROZEN_STRATEGY_AND_INDEPENDENT_OOS_UNVERIFIED"));
      assert.equal(review.paperAdmissionAllowed,false);
      assert.equal(out.profitabilityProven,false);
      assert.equal(out.actualFillCount,null);
      assert.doesNotMatch(JSON.stringify(out),/PAIR_PRIVATE_TOKEN|rawMinuteCandles/);
      writeFileSync(second,JSON.stringify({...all,selectedStartDate:"2025-09-01"}),{mode:0o600});
      const mismatched=await read({root:folder,market:marketName});
      assert.equal(mismatched.supplementarySweepWindowMatches,false);
      assert.ok(mismatched.report.canonicalPaperResearchReview.blockers
        .includes("PERIOD_SWEEP_SELECTED_DATE_WINDOW_MISMATCH"));
      chmodSync(second,0o644);
      await assert.rejects(()=>read({root:folder,market:marketName}),
        /NATIVE_DIAGNOSTIC_PRIVATE_FILE_INVALID/);
    }finally{rmSync(folder,{recursive:true,force:true});}
  }
});
test("a fixed SWEEP sidecar alone shows historical price-label evidence but never market recall",async()=>{
  const folder=root();
  try{
    save(folder,sweep(),market+".SWEEP.json");
    const out=await read({root:folder,market});
    assert.equal(out.report.kind,"SWEEP");
    assert.equal(out.supplementarySweepReport,null);
    assert.equal(out.paperAdmissionAllowed,false);
    assert.equal(out.actualMarketWideOpportunityCount,null);
  }finally{rmSync(folder,{recursive:true,force:true});}
});
