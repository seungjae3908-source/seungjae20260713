import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync, writeFileSync, readFileSync, statSync, existsSync,
  mkdirSync, chmodSync, symlinkSync, rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { digestPITMembershipRowsV1 } from
  "../src/historical-pit-venue-universe-gate-v1.js";
import { auditHistoricalPITMinuteArchiveChunkV1 as audit } from
  "../src/four-market-pit-minute-archive-join-v1.js";
import { planPITNativeMinuteSourceGapsV1 as plan } from
  "../src/four-market-pit-minute-gap-queue-v1.js";
import { runPlannedPITMinuteSourceTaskV1 as execute } from
  "../src/pit-minute-source-task-executor-v1.js";
import { persistResearchMinuteSessionV1 as persist,
  deriveArchivedResearchTimeframesV1 as derive,
  listArchivedResearchMinuteSessionsV1 as listArchive } from
  "../src/research-minute-archive-v1.js";
import {runFourMarketOriginalMinuteBatchV1 as batch}
  from "../src/four-market-original-minute-batch-v1.js";
import { parsePITMinuteTaskArgsV1 as parse,
  runPITMinuteTaskCliV1 as cli } from
  "../scripts/run-pit-minute-gap-task-v1.mjs";

const DAY=86_400_000,MIN=60_000,MIB=1024*1024;
const START=Date.parse("2026-09-18T00:00:00Z");
const NOW=Date.parse("2026-10-11T00:00:00Z");
const SHA="a".repeat(64);
const temp=()=>mkdtempSync(join(tmpdir(),"pit-native-gap-task-"));
const sha=rows=>createHash("sha256").update(JSON.stringify(rows)).digest("hex");
const statfsHealthy=async()=>({bsize:1,bavail:6*1024*MIB});
const statfsFull=async()=>({bsize:1,bavail:0});
function symbol(market,i){
  return market==="CRYPTO_SPOT"?"KRW-S"+(i+1):"S"+(i+1)+"USDT";
}
function makeManifest(market,count=2){
  const rows=Array.from({length:count},(_,i)=>({
    symbol:symbol(market,i),listedAtMs:START-200*DAY,
    removedAtMs:null,halts:[],
    sourceId:"SOURCE_ATTESTED_FOR_OFFLINE_TEST_ONLY",
    evidenceSha256:SHA,
  }));
  rows.push({symbol:"ENDED",listedAtMs:START-300*DAY,
    removedAtMs:START-30*DAY,halts:[],
    sourceId:"SOURCE_ATTESTED_FOR_OFFLINE_TEST_ONLY",evidenceSha256:SHA});
  return {
    schemaVersion:"historical-venue-pit-roster-v1",
    sourceClass:"EXCHANGE_DATED_ARCHIVE",market,
    venue:market==="CRYPTO_SPOT"?"UPBIT_KRW":"BITGET_USDT_FUTURES",
    sourceId:"SOURCE_ATTESTED_FOR_OFFLINE_TEST_ONLY",
    allListedAndRemovedAttested:true,
    suspensionsAttested:true,relistedIdentifiersResolved:true,
    coverageStartMs:START-400*DAY,coverageEndMs:START+DAY,
    retrievedAtMs:START+2*DAY,memberships:rows,
    rawMembershipDigestSha256:digestPITMembershipRowsV1(rows),
  };
}
async function makePageReceipts(root,market,manifest){
  const pages=[];
  const n=manifest.memberships.length-1;
  for(let offset=0;offset<n;offset+=20){
    const page=await audit({
      root,market,day:"2026-09-18",manifest,
      expectedRosterDigestSha256:manifest.rawMembershipDigestSha256,
      offset,limit:20,
    });
    assert.equal(page.pitGateStatus,"SOURCE_ATTESTED_PIT_COHORT_ONLY");
    pages.push(page);
  }
  return pages;
}
async function setup(market="CRYPTO_SPOT",members=2){
  const root=temp(),manifest=makeManifest(market,members),
    pages=await makePageReceipts(root,market,manifest);
  const planning=plan({
    market,day:"2026-09-18",manifest,pages,taskPageIndex:0,
  });
  assert.equal(planning.status,"PLANNED_EXPLICIT_PUBLIC_READ_ONLY");
  return {root,market,manifest,pages,planning};
}
function request(t,more={}){
  return {
    root:t.root,market:t.market,day:"2026-09-18",
    manifest:t.manifest,pages:t.pages,taskPageIndex:0,taskIndex:0,
    expectedTaskDigestSha256:t.planning.candidateTaskDigestSha256,
    allowPublicReadOnlyFetch:false,nowImpl:()=>NOW,
    statfsImpl:statfsHealthy,...more,
  };
}
function upbitFetch(calls){
  return async(url,opt)=>{
    calls.push({url,method:opt?.method??"GET"});
    const selected=new URL(url).searchParams.get("market");
    const row=t=>({market:selected,
      candle_date_time_utc:new Date(t).toISOString().slice(0,19),
      opening_price:100,high_price:104,low_price:99,
      trade_price:102,candle_acc_trade_volume:5});
    return {ok:true,status:200,json:async()=>[
      row(START+2*MIN),row(START+MIN),row(START),row(START-MIN),
    ]};
  };
}
function bitget(calls) {
  return {get:async(path,params)=>{
    calls.push({path,params});
    const row=t=>[String(t),"100","104","99","102","5"];
    return {code:"00000",data:[
      row(START+2*MIN),row(START+MIN),row(START),row(START-MIN),
    ]};
  }};
}
function retainedOriginal(market,sym){
  const venue=market==="CRYPTO_SPOT"?"UPBIT_KRW":"BITGET_USDT_FUTURES";
  const sourceId="PREEXISTING_PROVIDER_NATIVE_1M";
  const minuteBars=Array.from({length:3},(_,i)=>({
    market,venue,symbol:sym,sourceId,
    timestampMs:START+i*MIN,availableAtMs:START+(i+1)*MIN,
    open:100,high:101,low:99,close:100,volume:2,
  }));
  return {market,venue,symbol:sym,sourceId,
    session:{startMs:START,endMs:START+DAY,kind:"UTC_24H",
      timeZone:"UTC",calendarSourceId:"TEST_UNVERIFIED_NATIVE_UTC_DAY"},
    minuteBars,sourceMinuteRowsSha256:sha(minuteBars),
    asOfMs:START+3*MIN};
}
test("dry run revalidates full PIT receipts, one chosen task, zero GET",async()=>{
  const t=await setup("CRYPTO_SPOT",24),calls=[];
  try{
    assert.equal(t.pages.length,2);
    const r=await execute(request(t,{upbitFetchImpl:upbitFetch(calls)}));
    assert.equal(r.status,"BLOCKED_DATA");
    assert.equal(r.reason,"EXPLICIT_PUBLIC_READ_ONLY_OPT_IN_REQUIRED");
    assert.equal(r.plannedSymbol,t.planning.candidateTasks[0].symbol);
    assert.equal(r.maxTasksThisInvocation,1);
    assert.equal(r.executionAuthority,"NONE");
    assert.equal(calls.length,0);
    assert.equal(existsSync(join(t.root,".pit-native-minute-task.lock")),false);
  }finally{rmSync(t.root,{recursive:true,force:true});}
});
test("one Upbit PIT source gap task persists retrospectively without false history-as-of",async()=>{
  const t=await setup("CRYPTO_SPOT",2),calls=[];
  try{
    const r=await execute(request(t,{
      allowPublicReadOnlyFetch:true,upbitFetchImpl:upbitFetch(calls),
    }));
    assert.equal(r.status,"RETROSPECTIVE_SOURCE_STORED_WITHIN_LOCAL_BUDGET");
    assert.equal(r.retainedMinuteRows,3);
    assert.equal(r.providerReadAuthorized,true);
    assert.equal(r.fullMarketOpportunityDenominatorVerified,false);
    assert.equal(r.historicalScannerAvailabilityProven,false);
    assert.equal(r.realOrders,false);
    assert.equal(calls.length,1);
    assert.equal(calls[0].method,"GET");
    assert.equal(existsSync(join(t.root,".pit-native-minute-task.lock")),false);
    const sym=t.planning.candidateTasks[0].symbol;
    const stored=await derive({
      root:t.root,market:t.market,symbol:sym,
      sessionStartMs:START,asOfMs:NOW,timeframes:["1m"],
    });
    assert.equal(stored.sourceMinuteRows,3);
    const past=await derive({
      root:t.root,market:t.market,symbol:sym,
      sessionStartMs:START,asOfMs:START+DAY,timeframes:["1m"],
    });
    assert.equal(past.intervalData["1m"].completeBarCount,0);
    const again=await execute(request(t,{
      allowPublicReadOnlyFetch:true,upbitFetchImpl:upbitFetch(calls),
    }));
    assert.equal(again.status,"BLOCKED_DATA");
    assert.equal(again.reason,"EXISTING_PARTIAL_SOURCE_NEEDS_EXPLICIT_RETRY");
    assert.equal(calls.length,1);
  }finally{rmSync(t.root,{recursive:true,force:true});}
});
test("stale proposed GET cannot redownload full retrospective original 1m source",async()=>{
  const t=await setup("CRYPTO_SPOT",2),calls=[];
  try{
    const symbol=t.planning.candidateTasks[0].symbol;
    const source=retainedOriginal(t.market,symbol);
    source.minuteBars=Array.from({length:1440},(_,i)=>({
      ...source.minuteBars[0],
      timestampMs:START+i*MIN,
      availableAtMs:NOW,
    }));
    source.sourceMinuteRowsSha256=sha(source.minuteBars);
    source.asOfMs=NOW;
    await persist({root:t.root,source});
    // The previous page proposal still says "missing"; the native archive
    // itself is rechecked under the exclusive writer lock before GET.
    const response=await execute(request(t,{
      allowPublicReadOnlyFetch:true,upbitFetchImpl:upbitFetch(calls),
    }));
    assert.equal(response.status,"BLOCKED_DATA");
    assert.equal(response.reason,"ALREADY_RETAINED_COMPLETE_1M_SOURCE");
    assert.equal(calls.length,0);
    assert.equal(response.executionAuthority,"NONE");
    const old=await derive({root:t.root,market:t.market,symbol,
      sessionStartMs:START,asOfMs:START+DAY,timeframes:["1m"]});
    assert.equal(old.intervalData["1m"].completeBarCount,0);
    assert.equal(existsSync(join(t.root,".pit-native-minute-task.lock")),false);
  }finally{rmSync(t.root,{recursive:true,force:true});}
});
test("Bitget USDT futures gap executes the Bitget native public 1m collector only",async()=>{
  const t=await setup("CRYPTO_FUTURES",2),calls=[];
  try{
    const r=await execute(request(t,{
      allowPublicReadOnlyFetch:true,bitgetClient:bitget(calls),
    }));
    assert.equal(r.status,"RETROSPECTIVE_SOURCE_STORED_WITHIN_LOCAL_BUDGET");
    assert.equal(calls.length,1);
    assert.equal(calls[0].path,"/api/v2/mix/market/history-candles");
    assert.equal(calls[0].params.productType,"usdt-futures");
    assert.equal(calls[0].params.granularity,"1m");
    assert.equal(calls[0].params.symbol,t.planning.candidateTasks[0].symbol);
    assert.equal(r.retainedMinuteRows,3);
    assert.equal(r.actualFillCount,null);
  }finally{rmSync(t.root,{recursive:true,force:true});}
});
test("task page SHA, altered PIT roster, wrong page or index prevent any provider GET",async()=>{
  const t=await setup("CRYPTO_SPOT",22),calls=[];
  try{
    const upbitFetchImpl=upbitFetch(calls);
    const wrong=await execute(request(t,{allowPublicReadOnlyFetch:true,
      expectedTaskDigestSha256:"f".repeat(64),upbitFetchImpl}));
    assert.equal(wrong.reason,"SELECTED_TASK_PAGE_SHA_CHANGED");
    const secondPlan=plan({
      market:t.market,day:"2026-09-18",
      manifest:t.manifest,pages:t.pages,taskPageIndex:1,
    });
    const noTask=await execute(request(t,{
      allowPublicReadOnlyFetch:true,taskPageIndex:1,taskIndex:19,
      expectedTaskDigestSha256:secondPlan.candidateTaskDigestSha256,
      upbitFetchImpl,
    }));
    assert.equal(noTask.status,"BLOCKED_DATA");
    assert.equal(noTask.reason,"SELECTED_TASK_NOT_ELIGIBLE");
    const changed=structuredClone(t.pages);
    changed[0].pitRosterDigestSha256="f".repeat(64);
    const denied=await execute(request(t,{
      allowPublicReadOnlyFetch:true,pages:changed,upbitFetchImpl,
    }));
    assert.equal(denied.reason,"NO_VERIFIED_PUBLIC_SOURCE_TASK");
    const missing=await execute(request(t,{
      allowPublicReadOnlyFetch:true,pages:[t.pages[0]],upbitFetchImpl,
    }));
    assert.equal(missing.reason,"NO_VERIFIED_PUBLIC_SOURCE_TASK");
    assert.equal(calls.length,0);
  }finally{rmSync(t.root,{recursive:true,force:true});}
});
test("full-disk, local quota, unsafe archive and existing writer lock block BEFORE GET",async()=>{
  const t=await setup("CRYPTO_SPOT",2),calls=[];
  try{
    const opts={allowPublicReadOnlyFetch:true,upbitFetchImpl:upbitFetch(calls)};
    const full=await execute(request(t,{...opts,statfsImpl:statfsFull}));
    assert.equal(full.reason,"ARCHIVE_MINIMUM_FREE_SPACE_NOT_MET");
    assert.equal(existsSync(join(t.root,".pit-native-minute-task.lock")),false);
    await persist({root:t.root,source:retainedOriginal(t.market,"KRW-NOT-IN-ROSTER")});
    const quota=await execute(request(t,{...opts,maxLocalBytes:3*MIB}));
    assert.equal(quota.reason,"ARCHIVE_LOCAL_QUOTA_EXCEEDED");
    writeFileSync(join(t.root,".pit-native-minute-task.lock"),"held",
      {mode:0o600,flag:"wx"});
    const held=await execute(request(t,opts));
    assert.equal(held.reason,"ARCHIVE_WRITER_LOCK_HELD");
    rmSync(join(t.root,".pit-native-minute-task.lock"));
    assert.equal(calls.length,0);
  }finally{rmSync(t.root,{recursive:true,force:true});}
});
test("one lock prevents concurrent real provider read attempts for the same private archive",async()=>{
  const t=await setup("CRYPTO_SPOT",2),calls=[];
  let began,finish;
  const started=new Promise(resolve=>{began=resolve;});
  const suspended=new Promise(resolve=>{finish=resolve;});
  try{
    const first=execute(request(t,{
      allowPublicReadOnlyFetch:true,
      upbitFetchImpl:async (url,options)=>{
        began();
        await suspended;
        return upbitFetch(calls)(url,options);
      },
    }));
    await started;
    const second=await execute(request(t,{
      allowPublicReadOnlyFetch:true,upbitFetchImpl:upbitFetch(calls),
    }));
    assert.equal(second.reason,"ARCHIVE_WRITER_LOCK_HELD");
    assert.equal(calls.length,0);
    finish();
    const accepted=await first;
    assert.equal(accepted.status,"RETROSPECTIVE_SOURCE_STORED_WITHIN_LOCAL_BUDGET");
    assert.equal(calls.length,1);
    assert.equal(existsSync(join(t.root,".pit-native-minute-task.lock")),false);
  }finally{
    finish?.();
    rmSync(t.root,{recursive:true,force:true});
  }
});
test("CLI private receipts, fixed SHA, dry-run, opt-in and duplicate output safety",async()=>{
  const t=await setup("CRYPTO_SPOT",2),calls=[];
  try{
    const manifestPath=join(t.root,"pit.json"),indexPath=join(t.root,"index.json");
    const pagePath=join(t.root,"page-0.json"),output=join(t.root,"dry.json");
    writeFileSync(manifestPath,JSON.stringify(t.manifest),{mode:0o600});
    writeFileSync(pagePath,JSON.stringify(t.pages[0]),{mode:0o600});
    writeFileSync(indexPath,JSON.stringify({pageReceiptFiles:[pagePath]}),
      {mode:0o600});
    const args=["--market",t.market,"--day","2026-09-18",
      "--manifest",manifestPath,"--page-index",indexPath,
      "--root",t.root,"--task-page-index","0","--task-index","0",
      "--expected-task-digest",t.planning.candidateTaskDigestSha256,
      "--output",output];
    const blocked=await cli(parse(args),{
      nowImpl:()=>NOW,statfsImpl:statfsHealthy,upbitFetchImpl:upbitFetch(calls),
    });
    assert.equal(blocked.status,"BLOCKED_DATA");
    assert.equal(blocked.reason,"EXPLICIT_PUBLIC_READ_ONLY_OPT_IN_REQUIRED");
    assert.equal(calls.length,0);
    assert.equal(statSync(output).mode&0o077,0);
    await assert.rejects(()=>cli(parse(args),{}),
      /PIT_MINUTE_TASK_CLI_OUTPUT_EXISTS/);
    const liveArgs=[...args.slice(0,-2),"--output",join(t.root,"real.json"),"--read-public"];
    const accepted=await cli(parse(liveArgs),{
      nowImpl:()=>NOW,statfsImpl:statfsHealthy,upbitFetchImpl:upbitFetch(calls),
    });
    assert.equal(accepted.status,"RETROSPECTIVE_SOURCE_STORED_WITHIN_LOCAL_BUDGET");
    assert.equal(calls.length,1);
    const saved=JSON.parse(readFileSync(join(t.root,"real.json"),"utf8"));
    assert.equal(saved.executionAuthority,"NONE");
    assert.equal(saved.fullMarketOpportunityDenominatorVerified,false);
    assert.throws(()=>parse([...args,"--read-public","--read-public"]),
      /PIT_MINUTE_TASK_CLI_DUPLICATE_READ_FLAG/);
    chmodSync(pagePath,0o644);
    const privateErr=[...args.slice(0,-2),"--output",join(t.root,"private-fail.json")];
    await assert.rejects(()=>cli(parse(privateErr)),
      /PIT_MINUTE_TASK_CLI_PRIVATE_FILE_REQUIRED/);
  }finally{rmSync(t.root,{recursive:true,force:true});}
});



test("public-GET fixture -> immutable archive index -> offline 4-market batch refuses partial Upbit/Bitget 1m",async()=>{
  for(const market of ["CRYPTO_SPOT","CRYPTO_FUTURES"]){
    const t=await setup(market,2),calls=[];
    try{
      const fetchOptions=market==="CRYPTO_SPOT"
        ?{upbitFetchImpl:upbitFetch(calls)}:{bitgetClient:bitget(calls)};
      // No provider call may occur without an explicit per-task opt-in.
      const noConsent=await execute(request(t,fetchOptions));
      assert.equal(noConsent.reason,"EXPLICIT_PUBLIC_READ_ONLY_OPT_IN_REQUIRED");
      assert.equal(calls.length,0);
      const collected=await execute(request(t,{
        ...fetchOptions,allowPublicReadOnlyFetch:true,
      }));
      assert.equal(collected.status,"RETROSPECTIVE_SOURCE_STORED_WITHIN_LOCAL_BUDGET");
      assert.equal(calls.length,1);
      const symbol=t.planning.candidateTasks[0].symbol;
      const index=await listArchive({root:t.root,market,symbol,
        researchWindow:{startDate:"2026-09-18",endDate:"2026-09-18"},
      });
      assert.equal(index.status,"LOCAL_ORIGINAL_SESSION_INDEX_PAGE_ONLY");
      assert.equal(index.sessionCount,1);
      assert.equal(index.sourceSessions[0].nativeMinuteSlotInventoryComplete,false);
      assert.equal(index.trueMarketWideRecall,null);
      const replayPage=await batch({
        root:t.root,market,manifest:t.manifest,
        researchWindow:{startDate:"2026-09-18",endDate:"2026-09-18"},
        sourceSessions:[],discoverArchivedSessions:true,asOfMs:NOW,
        direction:"LONG",timeframe:"5m",leverage:1,
        fxRateKRWPerQuote:market==="CRYPTO_FUTURES"?1300:null,
      });
      assert.equal(replayPage.status,"BLOCKED_DATA");
      assert.equal(replayPage.sourceTasksRequested,2);
      assert.equal(replayPage.blockedSourceTasks,2);
      assert.equal(replayPage.sourceOnlyModeledTradeCount,null);
      assert.equal(replayPage.sourceOnlyEventLabels,null);
      assert.equal(replayPage.actualMarketWideOpportunityCount,null);
      assert.equal(replayPage.profitabilityProven,false);
      assert.equal(replayPage.paperAdmissionAllowed,false);
      assert.equal(replayPage.executionAuthority,"NONE");
      assert.equal(replayPage.providerGETCount,0);
      // The BATCH readback itself must never perform another provider GET.
      assert.equal(calls.length,1);
    }finally{rmSync(t.root,{recursive:true,force:true});}
  }
});

test("planned PIT native source task retry requires the reviewed existing SHA before any GET",async()=>{
 const t=await setup("CRYPTO_SPOT",2),calls=[];
 try{
   const initial=await execute(request(t,{
     allowPublicReadOnlyFetch:true,upbitFetchImpl:upbitFetch(calls),
   }));
   assert.equal(initial.status,"RETROSPECTIVE_SOURCE_STORED_WITHIN_LOCAL_BUDGET");
   assert.equal(calls.length,1);
   await assert.rejects(()=>execute(request(t,{
     allowPublicReadOnlyFetch:true,retryPartialSource:true,
     upbitFetchImpl:upbitFetch(calls),
   })),/PIT_MINUTE_TASK_ARGUMENT_INVALID/);
   assert.equal(calls.length,1);
   const old=await derive({
     root:t.root,market:t.market,symbol:t.planning.candidateTasks[0].symbol,
     sessionStartMs:START,asOfMs:NOW,timeframes:["1m"],
   });
   const wrong=await execute(request(t,{
     allowPublicReadOnlyFetch:true,retryPartialSource:true,
     expectedExistingSourceDigestSha256:SHA,
     upbitFetchImpl:upbitFetch(calls),
   }));
   assert.equal(wrong.status,"BLOCKED_DATA");
   assert.equal(wrong.reason,"RETRY_SOURCE_REVISION_DIGEST_MISMATCH");
   assert.equal(calls.length,1);
   const review=await execute(request(t,{
     allowPublicReadOnlyFetch:true,retryPartialSource:true,
     expectedExistingSourceDigestSha256:old.archiveSourceDigestSha256,
     upbitFetchImpl:upbitFetch(calls),
   }));
   assert.equal(review.reason,"RETRY_NO_ADDITIONAL_ORIGINAL_MINUTES");
   assert.equal(review.status,"BLOCKED_DATA");
   assert.equal(calls.length,2);
 }finally{rmSync(t.root,{recursive:true,force:true});}
});
test("PIT task CLI retry cannot execute without explicit previous SHA and public consent",async()=>{
 const t=await setup("CRYPTO_SPOT",2);
 try{
   const args=["--market",t.market,"--day","2026-09-18",
     "--manifest",join(t.root,"pit.json"),
     "--page-index",join(t.root,"index.json"),
     "--root",t.root,"--task-page-index","0","--task-index","0",
     "--expected-task-digest",t.planning.candidateTaskDigestSha256,
     "--output",join(t.root,"result.json")];
   assert.throws(()=>parse([...args,"--retry-partial"]),
     /PIT_MINUTE_TASK_CLI_SCOPE_INVALID/);
   assert.throws(()=>parse([...args,"--read-public","--retry-partial"]),
     /PIT_MINUTE_TASK_CLI_SCOPE_INVALID/);
   assert.throws(()=>parse([...args,"--expected-existing-sha",SHA]),
     /PIT_MINUTE_TASK_CLI_SCOPE_INVALID/);
   const reviewed=parse([...args,"--read-public","--retry-partial",
     "--expected-existing-sha",SHA]);
   assert.equal(reviewed.retryPartialSource,true);
   assert.equal(reviewed.expectedExistingSourceDigestSha256,SHA);
   assert.equal(reviewed.allowPublicReadOnlyFetch,true);
 }finally{rmSync(t.root,{recursive:true,force:true});}
});
