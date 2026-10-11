import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync,
  statSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { digestPITMembershipRowsV1 } from "../src/historical-pit-venue-universe-gate-v1.js";
import { auditHistoricalPITMinuteArchiveChunkV1 as chunk } from
  "../src/four-market-pit-minute-archive-join-v1.js";
import { summarizeHistoricalPITMinuteDayPagesV1 as ledger } from
  "../src/four-market-pit-minute-day-ledger-v1.js";
import { planPITNativeMinuteSourceGapsV1 as plan } from
  "../src/four-market-pit-minute-gap-queue-v1.js";
import { persistResearchMinuteSessionV1 as store } from
  "../src/research-minute-archive-v1.js";
import { parsePITMinuteGapPlanArgsV1 as parse,
  runPITMinuteGapPlanCliV1 as cli } from
  "../scripts/plan-four-market-pit-minute-gaps-v1.mjs";

const DAY=86_400_000,MIN=60_000;
const D=Date.parse("2026-09-18T00:00:00Z");
const temp=()=>mkdtempSync(join(tmpdir(),"pit-gap-queue-"));
const SHA="a".repeat(64);
const VENUE={
  CRYPTO_SPOT:"UPBIT_KRW",CRYPTO_FUTURES:"BITGET_USDT_FUTURES",
  KR_STOCK:"KRX",US_STOCK:"US_SIP",
};
function symbol(market,i) {
  if(market==="KR_STOCK")return String(i+1).padStart(6,"0");
  if(market==="US_STOCK")return "U"+String(i+1);
  if(market==="CRYPTO_SPOT")return "KRW-S"+String(i+1);
  return "S"+String(i+1)+"USDT";
}
function make(market,n=126,fixture=false) {
  const memberships=Array.from({length:n},(_,i)=>({
    symbol:symbol(market,i),listedAtMs:D-200*DAY,
    removedAtMs:null,halts:[],sourceId:"TEST_ONLY_PIT_ARCHIVE",
    evidenceSha256:SHA,
  }));
  memberships.push({
    symbol:"DELISTED",listedAtMs:D-500*DAY,
    removedAtMs:D-300*DAY,halts:[],
    sourceId:"TEST_ONLY_PIT_ARCHIVE",evidenceSha256:SHA,
  });
  return {
    schemaVersion:"historical-venue-pit-roster-v1",
    sourceClass:fixture?"TEST_FIXTURE":"EXCHANGE_DATED_ARCHIVE",
    ...(fixture?{testOnly:true}:{}),
    market,venue:VENUE[market],sourceId:"TEST_ONLY_PIT_ARCHIVE",
    coverageStartMs:D-550*DAY,coverageEndMs:D+DAY,
    retrievedAtMs:D+2*DAY,allListedAndRemovedAttested:true,
    suspensionsAttested:true,relistedIdentifiersResolved:true,
    memberships,rawMembershipDigestSha256:digestPITMembershipRowsV1(memberships),
  };
}
function calendar(market) {
  if(market.startsWith("CRYPTO_"))return null;
  const timeZone=market==="KR_STOCK"?"Asia/Seoul":"America/New_York";
  const startMs=market==="KR_STOCK"?D:Date.parse("2026-09-18T13:30:00Z");
  return {market,sessions:[{tradingDateLocal:"2026-09-18",
    startMs,endMs:startMs+30*MIN,kind:"REGULAR",timeZone}]};
}
async function pageAll(root,market,manifest,stockCalendar=calendar(market)) {
  const pages=[];
  for(let offset=0;offset<manifest.memberships.length-1;offset+=20) {
    pages.push(await chunk({
      root,market,day:"2026-09-18",manifest,stockCalendar,
      expectedRosterDigestSha256:manifest.rawMembershipDigestSha256,
      offset,limit:20,
    }));
  }
  return pages;
}
function input(market,manifest,pages,extra={}) {
  return {market,day:"2026-09-18",manifest,
    stockCalendar:calendar(market),pages,...extra};
}
function tenMinuteSource(market,sym){
  const sourceId="TEST_ONLY_NATIVE_BAR_SOURCE",venue=VENUE[market];
  const minuteBars=Array.from({length:10},(_,i)=>({
    market,venue,symbol:sym,sourceId,
    timestampMs:D+i*MIN,availableAtMs:D+(i+1)*MIN,
    open:100,high:101,low:99,close:100,volume:1,
  }));
  return {market,venue,symbol:sym,sourceId,
    session:{startMs:D,endMs:D+DAY,kind:"UTC_24H",timeZone:"UTC",
      calendarSourceId:"TEST_ONLY_UTC_CALENDAR"},
    minuteBars,sourceMinuteRowsSha256:createHash("sha256")
      .update(JSON.stringify(minuteBars)).digest("hex"),
    asOfMs:D+10*MIN,
  };
}
test("126 PIT crypto members -> 7 verified pages, later missing tasks beyond preview 100",async()=>{
  const root=temp(),market="CRYPTO_SPOT",manifest=make(market);
  try{
    const pages=await pageAll(root,market,manifest);
    const day=ledger(input(market,manifest,pages));
    assert.equal(pages.length,7);
    assert.equal(day.missingSourceSessionCount,126);
    assert.equal(day.missingSourcePlanPreview.length,100);
    assert.equal(day.omittedMissingSourcePlanItems,26);
    const sixth=plan(input(market,manifest,pages,{taskPageIndex:5}));
    assert.equal(sixth.status,"PLANNED_EXPLICIT_PUBLIC_READ_ONLY");
    assert.equal(sixth.completeDayPageAudit,true);
    assert.equal(sixth.taskPageIndex,5);
    assert.equal(sixth.nextTaskPageIndex,6);
    assert.equal(sixth.totalMissingSourceSessions,126);
    assert.equal(sixth.candidateTasks.length,20);
    assert.equal(sixth.candidateTasks[0].symbol,pages[5].memberSourceStatuses[0].symbol);
    assert.equal(sixth.candidateTasks.every(x=>x.proposedProvider==="UPBIT_PUBLIC_REST"),true);
    assert.equal(sixth.candidateTasks.every(x=>x.sourceReadRequiresExplicitConsent),true);
    assert.equal(sixth.providerGETCount,0);
    assert.equal(sixth.providerReadAuthorized,false);
    assert.equal(sixth.autoExecuteAllowed,false);
    assert.equal(sixth.fullMarketOpportunityDenominatorVerified,false);
    assert.equal(sixth.trueMarketWideRecall,null);
    assert.equal(sixth.executionAuthority,"NONE");
    const last=plan(input(market,manifest,pages,{taskPageIndex:6}));
    assert.equal(last.candidateTasks.length,6);
    assert.equal(last.nextTaskPageIndex,null);
    assert.equal(last.totalMissingSourceSessions,126);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("source-attested Bitget PIT queue targets BITGET only and uses no exchange GET",async()=>{
  const root=temp(),market="CRYPTO_FUTURES",manifest=make(market,3);
  try{
    const pages=await pageAll(root,market,manifest);
    const r=plan(input(market,manifest,pages));
    assert.equal(r.status,"PLANNED_EXPLICIT_PUBLIC_READ_ONLY");
    assert.equal(r.candidateTasks.length,3);
    assert.equal(r.candidateTasks[0].proposedProvider,"BITGET_PUBLIC_V2");
    assert.equal(r.candidateTasks[0].venue,"BITGET_USDT_FUTURES");
    assert.equal(r.candidateTasks[0].dayUtc,undefined);
    assert.equal(r.candidateTasks[0].utcDay,"2026-09-18");
    assert.equal(r.providerGETCount,0);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("fixture PIT and KR/US stock candidates never become public provider tasks",async()=>{
  for(const market of ["CRYPTO_SPOT","CRYPTO_FUTURES","KR_STOCK","US_STOCK"]){
    const root=temp(),fixture=market.startsWith("CRYPTO_");
    try{
      const manifest=make(market,3,fixture);
      const pages=await pageAll(root,market,manifest);
      const x=plan(input(market,manifest,pages));
      assert.equal(x.candidateTasks.length,0);
      assert.equal(x.unsupportedOrFixtureTaskCount,3);
      assert.equal(x.status,fixture
        ?"BLOCKED_FIXTURE_PIT_PUBLIC_COLLECTION"
        :"BLOCKED_LICENSED_STOCK_ONE_MINUTE_SOURCE");
      assert.equal(x.longTermServerStorageConfigured,false);
      assert.equal(x.providerGETCount,0);
      assert.equal(x.executionAuthority,"NONE");
    }finally{rmSync(root,{recursive:true,force:true});}
  }
});
test("incomplete, reversed, duplicate, changed roster and malformed pages cannot create tasks",async()=>{
  const root=temp(),market="CRYPTO_SPOT",m=make(market,25);
  try{
    const p=await pageAll(root,market,m);
    for(const pages of [[p[0]],[p[1],p[0]],[p[0],p[0]]]){
      const x=plan(input(market,m,pages));
      assert.equal(x.status,"BLOCKED_DAY_SOURCE_LEDGER");
      assert.deepEqual(x.candidateTasks,[]);
      assert.equal(x.providerGETCount,0);
    }
    const mutated=structuredClone(p);
    mutated[1].pitRosterDigestSha256="f".repeat(64);
    assert.equal(plan(input(market,m,mutated)).status,
      "BLOCKED_DAY_SOURCE_LEDGER");
    assert.throws(()=>plan(input(market,m,p,{taskPageIndex:2})),
      /PIT_MINUTE_GAP_QUEUE_ARGUMENTS_INVALID/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("partial retained 1m is manual review; missing other member still proposed",async()=>{
  const root=temp(),market="CRYPTO_SPOT",m=make(market,3);
  try{
    await store({root,source:tenMinuteSource(market,symbol(market,0))});
    const p=await pageAll(root,market,m);
    const x=plan(input(market,m,p));
    assert.equal(x.status,"PLANNED_MISSING_SOURCES_WITH_MANUAL_REVIEW");
    assert.equal(x.manualReviewMemberCount,1);
    assert.equal(x.blockedMemberReview[0].symbol,symbol(market,0));
    assert.equal(x.blockedMemberReview[0].sourceStatus,
      "SOURCE_LIMITED_MINUTE_INTERVALS");
    assert.equal(x.candidateTasks.length,2);
    assert.equal(x.totalMissingSourceSessions,2);
    assert.equal(x.providerGETCount,0);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("physically complete retrospective 1m archive is not scheduled for redundant GET",async()=>{
  const root=temp(),market="CRYPTO_SPOT",m=make(market,2);
  const retrievedAtMs=Date.parse("2026-10-11T02:00:00Z");
  try{
    const saved=tenMinuteSource(market,symbol(market,0));
    saved.minuteBars=Array.from({length:1440},(_,i)=>({
      ...saved.minuteBars[0],
      timestampMs:D+i*MIN,availableAtMs:retrievedAtMs,
    }));
    saved.sourceMinuteRowsSha256=createHash("sha256")
      .update(JSON.stringify(saved.minuteBars)).digest("hex");
    saved.asOfMs=retrievedAtMs;
    await store({root,source:saved});
    const p=await pageAll(root,market,m);
    assert.equal(p[0].sourceLimitedMembers,0);
    assert.equal(p[0].retrospectiveSourceMembers,1);
    assert.equal(p[0].retrospectiveMinuteRows,1440);
    const queue=plan(input(market,m,p));
    assert.equal(queue.candidateTasks.length,1);
    assert.equal(queue.candidateTasks[0].symbol,symbol(market,1));
    assert.equal(queue.manualReviewMemberCount,0);
    assert.equal(queue.totalMissingSourceSessions,1);
    assert.equal(queue.providerGETCount,0);
    assert.equal(queue.autoExecuteAllowed,false);
    assert.equal(queue.trueMarketWideRecall,null);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("private CLI builds selected task page, rejects overwrite and insecure receipts",async()=>{
  const root=temp(),market="CRYPTO_SPOT",m=make(market,25);
  try{
    const pages=await pageAll(root,market,m);
    const manifest=join(root,"manifest.json"),index=join(root,"index.json");
    const output=join(root,"gap-plan.json");
    writeFileSync(manifest,JSON.stringify(m),{mode:0o600});
    const files=pages.map((page,i)=>{
      const path=join(root,"page-"+i+".json");
      writeFileSync(path,JSON.stringify(page),{mode:0o600});
      return path;
    });
    writeFileSync(index,JSON.stringify({pageReceiptFiles:files}),{mode:0o600});
    const args=["--market",market,"--day","2026-09-18",
      "--manifest",manifest,"--page-index",index,
      "--task-page-index","1","--output",output];
    const cmd=parse(args);
    const res=cli(cmd);
    assert.equal(res.proposedTasks,5);
    assert.equal(res.nextTaskPageIndex,null);
    assert.equal(res.providerGETCount,0);
    const disk=JSON.parse(readFileSync(output,"utf8"));
    assert.equal(disk.candidateTasks.length,5);
    assert.equal(disk.candidateTasks[0].sourceReadRequiresExplicitConsent,true);
    assert.equal(disk.venuePITIndependentlyAuthenticated,false);
    assert.equal(statSync(output).mode&0o077,0);
    assert.throws(()=>cli(cmd),/PIT_GAP_PLAN_OUTPUT_ALREADY_EXISTS/);
    chmodSync(files[0],0o644);
    assert.throws(()=>cli(parse(args.map(x=>x===output
      ?join(root,"other.json"):x))),/PIT_GAP_PLAN_PRIVATE_INPUT_REQUIRED/);
    assert.throws(()=>parse([...args,"--task-page-index","1"]),
      /PIT_GAP_PLAN_CLI_(?:ARGUMENTS|OPTION)_INVALID/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
