import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,chmodSync,
  symlinkSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {persistResearchMinuteSessionV1} from "../src/research-minute-archive-v1.js";
import {readResearchOriginalMinuteDiagnosticV1 as readAdminSummary}
  from "../src/research-original-minute-diagnostic-readonly-v1.js";
import {digestPITMembershipRowsV1} from "../src/historical-pit-venue-universe-gate-v1.js";
import {parseOriginalReplayArgsV1 as parse,runOriginalReplayPrivateJobV1 as run}
  from "../scripts/run-four-market-original-minute-replay-v1.mjs";

const D=Date.parse("2026-09-18T00:00:00Z"),DAY=86_400_000;
const dir=()=>mkdtempSync(join(tmpdir(),"private-replay-cli-"));
function roster(){
 const memberships=[
  {symbol:"KRW-BTC",listedAtMs:D-40*DAY,removedAtMs:null,
    halts:[],sourceId:"TEST_SOURCE",evidenceSha256:"a".repeat(64)},
  {symbol:"DELISTED",listedAtMs:D-60*DAY,removedAtMs:D-30*DAY,
    halts:[],sourceId:"TEST_SOURCE",evidenceSha256:"a".repeat(64)},
 ];
 return {
  schemaVersion:"historical-venue-pit-roster-v1",market:"CRYPTO_SPOT",
  venue:"UPBIT_KRW",sourceClass:"TEST_FIXTURE",testOnly:true,
  coverageStartMs:D-90*DAY,coverageEndMs:D+3*DAY,retrievedAtMs:D+4*DAY,
  sourceId:"TEST_SOURCE",allListedAndRemovedAttested:true,
  suspensionsAttested:true,relistedIdentifiersResolved:true,
  memberships,rawMembershipDigestSha256:digestPITMembershipRowsV1(memberships),
 };
}
function writePrivate(path,body){
 writeFileSync(path,JSON.stringify(body),{mode:0o600});
 chmodSync(path,0o600);
}
test("private PLAN job produces a create-only, mode 0600 historical work receipt",async()=>{
 const root=dir(),input=join(root,"input.json"),output=join(root,"result.json");
 try{
  writePrivate(input,{mode:"PLAN",market:"CRYPTO_SPOT",
    manifest:roster(),
    researchWindow:{startDate:"2026-09-18",endDate:"2026-09-19"},
  });
  const args=parse(["--input",input,"--output",output]);
  const summary=await run(args);
  assert.equal(summary.status,"SOURCE_ONLY_PIT_WORK_PAGINATED");
  assert.equal(summary.executionAuthority,"NONE");
  assert.equal(statSync(output).mode&0o077,0);
  const result=JSON.parse(readFileSync(output,"utf8"));
  assert.equal(result.historicRosterActiveMemberDaysSelfAttested,2);
  assert.equal(result.candidateTaskCount,2);
  assert.equal(result.actualMarketWideOpportunityCount,null);
  assert.equal(result.profitabilityProven,false);
  assert.equal(result.paperAdmissionAllowed,false);
  const old=readFileSync(output,"utf8");
  await assert.rejects(()=>run(args),/EEXIST/);
  assert.equal(readFileSync(output,"utf8"),old);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("private REPLAY job missing native source records BLOCKED, never zero-profit PASS",async()=>{
 const root=dir(),input=join(root,"input.json"),output=join(root,"result.json");
 try{
  writePrivate(input,{mode:"REPLAY",root,market:"CRYPTO_SPOT",symbol:"KRW-BTC",
    manifest:roster(),
    researchWindow:{startDate:"2026-09-18",endDate:"2026-09-18"},
    sessionSources:[{
      date:"2026-09-18",startMs:D,endMs:D+DAY,zone:"UTC",kind:"UTC_24H",
    }],
    asOfMs:D+5*DAY,timeframe:"5m",
  });
  const status=await run({input,output});
  assert.equal(status.status,"BLOCKED_DATA");
  const data=JSON.parse(readFileSync(output,"utf8"));
  assert.equal(data.modeledReturnPercent,null);
  assert.equal(data.actualFillCount,null);
  assert.equal(data.trueMarketWideRecall,null);
  assert.equal(data.profitabilityProven,false);
  assert.equal(data.executionAuthority,"NONE");
  assert.equal(statSync(output).mode&0o077,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("unsafe source or output path, credential fields, unsupported flags are rejected",async()=>{
 const root=dir(),input=join(root,"input.json"),out=join(root,"out.json");
 try{
  assert.throws(()=>parse(["--input",input,"--exec",out]),
    /RESEARCH_REPLAY_EXACT_INPUT_OUTPUT_ARGS_REQUIRED/);
  assert.throws(()=>parse(["--input",input,"--output",input]),
    /RESEARCH_REPLAY_EXACT_INPUT_OUTPUT_ARGS_REQUIRED/);
  writePrivate(input,{mode:"PLAN",market:"CRYPTO_SPOT",
    manifest:roster(),researchWindow:{startDate:"2026-09-18",endDate:"2026-09-18"},
  });
  chmodSync(input,0o644);
  await assert.rejects(()=>run({input,output:out}),/RESEARCH_REPLAY_PRIVATE_INPUT_REQUIRED/);
  chmodSync(input,0o600);
  writePrivate(input,{mode:"PLAN",apiKey:"SHOULD_NEVER_BE_ACCEPTED",
    market:"CRYPTO_SPOT",manifest:roster(),
    researchWindow:{startDate:"2026-09-18",endDate:"2026-09-18"},
  });
  await assert.rejects(()=>run({input,output:out}),
    /RESEARCH_REPLAY_CREDENTIAL_FIELDS_FORBIDDEN/);
  assert.equal(statSync(input).mode&0o077,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("symlink result destination cannot overwrite other private evidence",async()=>{
 const root=dir(),input=join(root,"input.json"),
   out=join(root,"out.json"),target=join(root,"protected.json");
 try{
  writePrivate(input,{mode:"PLAN",market:"CRYPTO_SPOT",
    manifest:roster(),researchWindow:{startDate:"2026-09-18",endDate:"2026-09-18"},
  });
  writePrivate(target,{guard:"NEVER_OVERWRITE"});
  symlinkSync(target,out);
  await assert.rejects(()=>run({input,output:out}),/EEXIST/);
  assert.deepEqual(JSON.parse(readFileSync(target,"utf8")),{guard:"NEVER_OVERWRITE"});
 }finally{rmSync(root,{recursive:true,force:true});}
});


test("private OPPORTUNITIES mode does not infer price events from absent original 1m files",async()=>{
 const root=dir(),input=join(root,"input.json"),output=join(root,"opportunities.json");
 try{
  writePrivate(input,{mode:"OPPORTUNITIES",root,market:"CRYPTO_SPOT",
    symbol:"KRW-BTC",day:"2026-09-18",sessionStartMs:D,sessionEndMs:D+DAY,
    sessionKind:"UTC_24H",sessionTimeZone:"UTC",manifest:roster(),
    side:"LONG",asOfMs:D+5*DAY,thresholdPercents:[3,5,10]});
  const runResult=await run({input,output});
  assert.equal(runResult.status,"BLOCKED_DATA");
  const evidence=JSON.parse(readFileSync(output,"utf8"));
  assert.equal(evidence.reason,"NATIVE_ONE_MINUTE_SESSION_MISSING_OR_UNVERIFIED");
  assert.equal(evidence.actualMarketWideOpportunityCount,null);
  assert.equal(evidence.earlyDetectionRecall,null);
  assert.equal(evidence.profitabilityProven,false);
  assert.equal(evidence.executionAuthority,"NONE");
  assert.equal(evidence.paperAdmissionAllowed,false);
  assert.equal(statSync(output).mode&0o077,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});



test("private BATCH job checks historical PIT/source work without advancing to Drift, Paper, or provider GET",async()=>{
 const root=dir(),input=join(root,"batch-input.json"),out=join(root,"batch-result.json");
 try{
  writePrivate(input,{mode:"BATCH",root,market:"CRYPTO_SPOT",
    manifest:roster(),
    researchWindow:{startDate:"2026-09-18",endDate:"2026-09-18"},
    sourceSessions:[],asOfMs:D+5*DAY,timeframe:"5m",
    direction:"LONG",initialCapitalKRW:1_000_000,leverage:1,
  });
  const response=await run({input,output:out});
  assert.equal(response.mode,"BATCH");
  assert.equal(response.status,"BLOCKED_DATA");
  const result=JSON.parse(readFileSync(out,"utf8"));
  assert.equal(result.sourceTasksRequested,1);
  assert.equal(result.inspectedSourceTasks,1);
  assert.equal(result.blockedSourceTasks,1);
  assert.equal(result.sourceOnlyModeledTradeCount,null);
  assert.equal(result.actualMarketWideOpportunityCount,null);
  assert.equal(result.executionAuthority,"NONE");
  assert.equal(result.paperAdmissionAllowed,false);
  assert.equal(result.providerGETCount,0);
  assert.equal(result.profitabilityProven,false);
  assert.equal(statSync(out).mode&0o077,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});


test("private BATCH automatically discovers retained 1m sessions without a caller-written source index",async()=>{
 const root=dir(),input=join(root,"auto-input.json"),out=join(root,"auto-batch.json");
 try{
  const sourceId="TEST_NATIVE_PRIVATE_1M";
  const minuteBars=Array.from({length:1440},(_,i)=>{
    const p=i===80?111:100;
    return {market:"CRYPTO_SPOT",venue:"UPBIT_KRW",
      symbol:"KRW-BTC",sourceId,
      timestampMs:D+i*60_000,availableAtMs:D+(i+1)*60_000,
      open:100,high:Math.max(100,p)+0.1,
      low:99.9,close:p,volume:100+i};
  });
  const source={market:"CRYPTO_SPOT",venue:"UPBIT_KRW",symbol:"KRW-BTC",
    sourceId,session:{startMs:D,endMs:D+DAY,
      kind:"UTC_24H",timeZone:"UTC",
      calendarSourceId:"TEST_PRIVATE_UTC_DAY_NOT_INDEPENDENT_PROOF"},
    minuteBars,sourceMinuteRowsSha256:createHash("sha256")
      .update(JSON.stringify(minuteBars)).digest("hex"),
    asOfMs:D+DAY};
  await persistResearchMinuteSessionV1({root,source});
  writePrivate(input,{mode:"BATCH",root,market:"CRYPTO_SPOT",
    manifest:roster(),sourceSessions:[],discoverArchivedSessions:true,
    researchWindow:{startDate:"2026-09-18",endDate:"2026-09-18"},
    asOfMs:D+5*DAY,timeframe:"5m",direction:"LONG",
    thresholdPercents:[3,5,10],
  });
  const result=await run({input,output:out});
  assert.equal(result.mode,"BATCH");
  assert.equal(result.status,"SOURCE_ONLY_REPLAY_PAGE_INSPECTED");
  const report=JSON.parse(readFileSync(out,"utf8"));
  assert.equal(report.inspectedSourceTasks,1);
  assert.equal(report.blockedSourceTasks,0);
  assert.equal(report.sourceOnlyEventLabels,3);
  assert.equal(report.fullMarketOpportunityDenominatorVerified,false);
  assert.equal(report.actualMarketWideOpportunityCount,null);
  assert.equal(report.paperAdmissionAllowed,false);
  assert.equal(report.profitabilityProven,false);
  assert.equal(report.executionAuthority,"NONE");
  assert.equal(statSync(out).mode&0o077,0);
  // Same immutable native archive, one continuous period strategy state.
  const periodInput=join(root,"period-input.json");
  const periodOutput=join(root,"period-output.json");
  writePrivate(periodInput,{mode:"PERIOD",root,
    market:"CRYPTO_SPOT",symbol:"KRW-BTC",manifest:roster(),
    researchWindow:{startDate:"2026-09-18",endDate:"2026-09-18"},
    asOfMs:D+5*DAY,timeframe:"5m",direction:"LONG",
    initialCapitalKRW:1_000_000,
  });
  const periodJob=await run({input:periodInput,output:periodOutput});
  assert.equal(periodJob.status,"SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY");
  const model=JSON.parse(readFileSync(periodOutput,"utf8"));
  assert.equal(model.indexedPrivateSessions,1);
  assert.equal(model.verifiedNativeMinuteSessions,1);
  assert.equal(model.independentOOSAndForwardProven,false);
  assert.equal(model.actualFillCount,null);
  assert.equal(model.trueMarketWideRecall,null);
  assert.equal(model.profitabilityProven,false);
  assert.equal(model.paperAdmissionAllowed,false);
  assert.equal(model.executionAuthority,"NONE");
  assert.equal(statSync(periodOutput).mode&0o077,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});


test("private SWEEP CLI resumably traverses dated PIT identities without fabricating absent native minutes",async()=>{
 const root=dir(),firstIn=join(root,"sweep-1.json"),
   firstOut=join(root,"sweep-1-result.json"),
   secondIn=join(root,"sweep-2.json"),
   secondOut=join(root,"sweep-2-result.json");
 try{
  const scope={mode:"SWEEP",root,market:"CRYPTO_SPOT",
    manifest:roster(),sourceSessions:[],discoverArchivedSessions:true,
    researchWindow:{startDate:"2026-09-18",endDate:"2026-09-18"},
    asOfMs:D+5*DAY,memberPageSize:1,pageBudget:1,
    direction:"LONG",timeframe:"5m"};
  writePrivate(firstIn,scope);
  const job1=await run({input:firstIn,output:firstOut});
  assert.equal(job1.mode,"SWEEP");
  assert.equal(job1.status,"BLOCKED_DATA");
  const first=JSON.parse(readFileSync(firstOut,"utf8"));
  assert.equal(first.pageCountSelfAttested,1);
  assert.equal(first.localPageTraversalReachedEnd,false);
  assert.equal(first.sourceOnlyObservedPriceEventLabels,null);
  assert.equal(first.resume.previousPageCount,1);
  assert.equal(first.resume.nextMemberOffset,1);
  writePrivate(secondIn,{...scope,resume:first.resume});
  const job2=await run({input:secondIn,output:secondOut});
  assert.equal(job2.status,"BLOCKED_DATA");
  const second=JSON.parse(readFileSync(secondOut,"utf8"));
  assert.equal(second.pageCountSelfAttested,2);
  assert.equal(second.sourceBlockedPages,1);
  assert.equal(second.localPageTraversalReachedEnd,true);
  assert.equal(second.resume,null);
  assert.equal(second.sourceOnlyObservedPriceEventLabels,null);
  assert.equal(second.fullPeriodEconomicReturnPercent,null);
  assert.equal(second.actualMarketWideOpportunityCount,null);
  assert.equal(second.actualFillCount,null);
  assert.equal(second.trueMarketWideRecall,null);
  assert.equal(second.profitabilityProven,false);
  assert.equal(second.paperAdmissionAllowed,false);
  assert.equal(second.providerGETCount,0);
  assert.equal(second.executionAuthority,"NONE");
  assert.equal(statSync(firstOut).mode&0o077,0);
  assert.equal(statSync(secondOut).mode&0o077,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});


test("private PERIOD CLI receipt -> explicitly consented PUBLISH CLI -> admin readback, zero Paper authority",async()=>{
 const root=dir(),sourceId="TEST_LOCAL_1M_MODEL_PUBLISH",
   periodInput=join(root,"period-job.json"),
   periodOutput=join(root,"period-job-result.json"),
   adminRoot=join(root,"admin"),
   publishInput=join(root,"publish-job.json"),
   publishOutput=join(root,"publish-job-result.json");
 try{
   const rows=Array.from({length:1440},(_,i)=>{
     const high=i===80?111:101;
     const close=i===80?110:100;
     return {market:"CRYPTO_SPOT",venue:"UPBIT_KRW",
       symbol:"KRW-BTC",sourceId,
       timestampMs:D+i*60_000,availableAtMs:D+(i+1)*60_000,
       open:100,high,low:99,close,volume:1+i};
   });
   const source={
     market:"CRYPTO_SPOT",venue:"UPBIT_KRW",
     symbol:"KRW-BTC",sourceId,
     session:{startMs:D,endMs:D+DAY,
       kind:"UTC_24H",timeZone:"UTC",
       calendarSourceId:"TEST_LOCAL_ORIGINAL_1M"},
     minuteBars:rows,
     sourceMinuteRowsSha256:createHash("sha256")
       .update(JSON.stringify(rows)).digest("hex"),
     asOfMs:D+DAY,
   };
   mkdirSync(adminRoot,{mode:0o700});
   await persistResearchMinuteSessionV1({root,source});
   writePrivate(periodInput,{mode:"PERIOD",root,market:"CRYPTO_SPOT",
     symbol:"KRW-BTC",manifest:roster(),
     researchWindow:{startDate:"2026-09-18",endDate:"2026-09-18"},
     asOfMs:D+5*DAY,direction:"LONG",timeframe:"5m"});
   const model=await run({input:periodInput,output:periodOutput});
   assert.equal(model.status,"SOURCE_ONLY_MULTI_SESSION_PERIOD_REPLAY");
   // Real PERIOD CLI receipt -> canonical profitability and Paper candidate
   // policy inspection; no Paper signal, sample order or registry write.
   const reviewInput=join(root,"candidate-review.json");
   const reviewOutput=join(root,"candidate-review-result.json");
   writePrivate(reviewInput,{mode:"CANDIDATE_REVIEW",
     market:"CRYPTO_SPOT",symbol:"KRW-BTC",
     periodResult:JSON.parse(readFileSync(periodOutput,"utf8"))});
   const reviewed=await run({input:reviewInput,output:reviewOutput});
   assert.equal(reviewed.mode,"CANDIDATE_REVIEW");
   assert.equal(reviewed.readOnly,true);
   assert.equal(reviewed.localOnlyWrite,false);
   assert.equal(reviewed.status,"RESEARCH_HOLD");
   const evidence=JSON.parse(readFileSync(reviewOutput,"utf8"));
   assert.equal(evidence.canonicalProfitabilityStatus,"RESEARCH_HOLD");
   assert.equal(evidence.canonicalProfitabilityEligible,false);
   assert.equal(evidence.canonicalPaperBridgeStatus,"BLOCKED");
   assert.equal(evidence.canonicalPaperEvidenceReady,false);
   assert.equal(evidence.paperCandidate,null);
   assert.equal(evidence.paperAdmissionAllowed,false);
   assert.equal(evidence.orderSubmitted,false);
   assert.equal(evidence.providerGETCount,0);
   assert.equal(evidence.actualFillCount,null);
   assert.equal(evidence.profitabilityProven,false);
   assert.equal(evidence.executionAuthority,"NONE");
   assert.equal(statSync(reviewOutput).mode&0o077,0);
   const before=await readAdminSummary({root:adminRoot,market:"CRYPTO_SPOT"});
   assert.equal(before.available,false);
   assert.equal(before.reason,"PRIVATE_MODEL_REPORT_NOT_FOUND");
   writePrivate(publishInput,{mode:"PUBLISH",
     sourceResultPath:periodOutput,reportRoot:adminRoot,
     market:"CRYPTO_SPOT",
     allowLocalReportPublish:true,allowReplaceExisting:false});
   // A prior CLI output is checked BEFORE the publisher changes anything.
   writePrivate(publishOutput,{status:"PREEXISTING_PRIVATE_AUDIT"});
   await assert.rejects(()=>run({input:publishInput,output:publishOutput}),
     /EEXIST/);
   assert.equal(readFileSync(publishOutput,"utf8")
     .includes("PREEXISTING_PRIVATE_AUDIT"),true);
   const unpublished=await readAdminSummary({
     root:adminRoot,market:"CRYPTO_SPOT"});
   assert.equal(unpublished.available,false);
   rmSync(publishOutput);
   const publishing=await run({input:publishInput,output:publishOutput});
   assert.equal(publishing.mode,"PUBLISH");
   assert.equal(publishing.localOnlyWrite,true);
   assert.equal(publishing.readOnly,false);
   assert.equal(publishing.status,"LOCAL_SANITIZED_DIAGNOSTIC_PUBLISHED");
   const admin=await readAdminSummary({root:adminRoot,market:"CRYPTO_SPOT"});
   assert.equal(admin.available,true);
   assert.equal(admin.report.kind,"PERIOD");
   assert.equal(admin.report.symbol,"KRW-BTC");
   assert.equal(admin.report.sourceSessionsVerified,1);
   assert.equal(admin.report.independentOOSProven,false);
   assert.equal(admin.report.paperCandidatePASS,false);
   assert.equal(admin.actualFillCount,null);
   assert.equal(admin.profitabilityProven,false);
   assert.equal(admin.executionAuthority,"NONE");
   assert.equal(admin.publicationAgeStatus,"LOCAL_PUBLICATION_ONLY");
   assert.equal(statSync(join(adminRoot,"CRYPTO_SPOT.json")).mode&0o077,0);
   assert.equal(statSync(publishOutput).mode&0o077,0);
   const text=readFileSync(join(adminRoot,"CRYPTO_SPOT.json"),"utf8");
   assert.doesNotMatch(text,/modeledTradePreview|minuteBars|privateStrategy|orderInstructions/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
