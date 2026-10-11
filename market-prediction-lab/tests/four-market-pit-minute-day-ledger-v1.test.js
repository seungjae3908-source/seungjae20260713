import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, statSync, chmodSync,
  rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { digestPITMembershipRowsV1 } from "../src/historical-pit-venue-universe-gate-v1.js";
import { persistResearchMinuteSessionV1 as store } from "../src/research-minute-archive-v1.js";
import { auditHistoricalPITMinuteArchiveChunkV1 as chunk } from
  "../src/four-market-pit-minute-archive-join-v1.js";
import { summarizeHistoricalPITMinuteDayPagesV1 as ledger } from
  "../src/four-market-pit-minute-day-ledger-v1.js";
import { parsePITMinuteDayArgsV1 as parse, runPITMinuteDayCliV1 as cli }
  from "../scripts/report-four-market-pit-minute-day-v1.mjs";

const DAY = 86_400_000, MINUTE=60_000;
const D = Date.parse("2026-09-18T00:00:00Z");
const HASH = "a".repeat(64);
const POLICY = Object.freeze({
  KR_STOCK: ["KRX","Asia/Seoul"],
  US_STOCK: ["US_SIP","America/New_York"],
  CRYPTO_SPOT: ["UPBIT_KRW","UTC"],
  CRYPTO_FUTURES: ["BITGET_USDT_FUTURES","UTC"],
});
const hash = s => createHash("sha256").update(JSON.stringify(s)).digest("hex");
const temp = () => mkdtempSync(join(tmpdir(),"pit-minute-day-ledger-"));
const symbol = (market,i) => ({
  KR_STOCK: () => String(i+1).padStart(6,"0"),
  US_STOCK: () => "U"+String(i+1),
  CRYPTO_SPOT: () => "KRW-X"+String(i+1),
  CRYPTO_FUTURES: () => "X"+String(i+1)+"USDT",
})[market]();
function make(market,count=25) {
  const memberships = Array.from({length:count},(_,i)=>({
    symbol:symbol(market,i),listedAtMs:D-300*DAY,removedAtMs:null,
    halts:[],sourceId:"PRIVATE_MOCK_PIT_SOURCE",evidenceSha256:HASH,
  }));
  memberships.push({
    symbol:"DELISTED",listedAtMs:D-360*DAY,
    removedAtMs:D-100*DAY,halts:[],
    sourceId:"PRIVATE_MOCK_PIT_SOURCE",evidenceSha256:HASH,
  });
  return {
    schemaVersion:"historical-venue-pit-roster-v1",
    sourceClass:"TEST_FIXTURE",testOnly:true,
    market,venue:POLICY[market][0],sourceId:"PRIVATE_MOCK_PIT_SOURCE",
    coverageStartMs:D-400*DAY,coverageEndMs:D+40*DAY,
    retrievedAtMs:D+41*DAY,allListedAndRemovedAttested:true,
    suspensionsAttested:true,relistedIdentifiersResolved:true,
    memberships,rawMembershipDigestSha256:digestPITMembershipRowsV1(memberships),
  };
}
function dateSessions(market) {
  if(market.startsWith("CRYPTO_"))return null;
  const startMs=market==="US_STOCK"
    ?Date.parse("2026-09-18T13:30:00Z"):D;
  return {market,sessions:[{tradingDateLocal:"2026-09-18",
    startMs,endMs:startMs+30*MINUTE,kind:"REGULAR",
    timeZone:POLICY[market][1]}]};
}
function minuteSource(market,sym,count=10) {
  const cal=dateSessions(market),start=cal?.sessions[0].startMs??D;
  const venue=POLICY[market][0],sourceId="OFFLINE_MOCK_1M_SOURCE";
  const bars=Array.from({length:count},(_,i)=>({
    market,venue,symbol:sym,sourceId,
    timestampMs:start+i*MINUTE,availableAtMs:start+(i+1)*MINUTE,
    open:100+i,high:102+i,low:99+i,close:101+i,volume:10+i,
  }));
  return {market,venue,symbol:sym,sourceId,
    session:{startMs:start,endMs:start+(cal?30*MINUTE:DAY),
      kind:cal?"REGULAR":"UTC_24H",
      timeZone:POLICY[market][1],
      calendarSourceId:"TEST_DATED_CALENDAR_NOT_INDEPENDENTLY_AUTHENTICATED"},
    minuteBars:bars,sourceMinuteRowsSha256:hash(bars),
    asOfMs:start+count*MINUTE};
}
async function pages(root,market,manifest,calendar=dateSessions(market),limit=20){
  const result=[];
  for(let offset=0;offset<manifest.memberships.length-1;offset+=limit){
    result.push(await chunk({
      root,market,day:"2026-09-18",manifest,stockCalendar:calendar,
      expectedRosterDigestSha256:manifest.rawMembershipDigestSha256,
      offset,limit,
    }));
  }
  return result;
}
function aggregate(market,manifest,receipts,calendar=dateSessions(market)){
  return ledger({market,day:"2026-09-18",manifest,stockCalendar:calendar,pages:receipts});
}
test("4 markets, 25 PIT members, source-only 20+5 pages aggregate without inventing data",async()=>{
  for(const market of Object.keys(POLICY)){
    const root=temp(),manifest=make(market);
    try{
      await store({root,source:minuteSource(market,symbol(market,0))});
      const receipts=await pages(root,market,manifest);
      assert.equal(receipts.length,2);
      assert.equal(receipts[0].nextOffset,20);
      assert.equal(receipts[1].nextOffset,null);
      assert.equal(receipts[0].sessionCalendarDigestSha256,
        receipts[1].sessionCalendarDigestSha256);
      const report=aggregate(market,manifest,receipts);
      assert.equal(report.status,"INCOMPLETE_SOURCE_ATTESTED_DAY_MINUTE_INVENTORY");
      assert.equal(report.completeDayPageAudit,true);
      assert.equal(report.archiveSourceCompletenessEstablished,false);
      assert.equal(report.sourceStatus,"TEST_FIXTURE_ONLY");
      assert.equal(report.inspectedPITMemberCount,25);
      assert.equal(report.archiveReceiptPageCount,2);
      assert.equal(report.archivedMembers,1);
      assert.equal(report.sourceLimitedMembers,1);
      assert.equal(report.missingSourceMembers,24);
      assert.equal(report.sourceMinuteRows,10);
      assert.equal(report.sourceSessionsCovered,1);
      assert.equal(report.missingSourceSessionCount,24);
      assert.equal(report.missingSourcePlanPreview.length,24);
      assert.equal(report.historicallyDelistedMembersPreservedInManifest,true);
      assert.equal(report.historicalFullMarketPopulationIndependentlyVerified,false);
      assert.equal(report.actualMarketWideOpportunityCount,null);
      assert.equal(report.trueMarketWideRecall,null);
      assert.equal(report.actualFillCount,null);
      assert.equal(report.profitabilityProven,false);
      assert.equal(report.executionAuthority,"NONE");
    }finally{rmSync(root,{recursive:true,force:true});}
  }
});
test("complete 1440m spot per symbol is local source-only, never canonical full market PASS",async()=>{
  const root=temp(),market="CRYPTO_SPOT",manifest=make(market,1);
  try{
    await store({root,source:minuteSource(market,symbol(market,0),1440)});
    const ps=await pages(root,market,manifest);
    const report=aggregate(market,manifest,ps);
    assert.equal(report.status,"SOURCE_ATTESTED_DAY_MINUTE_INVENTORY_ONLY");
    assert.equal(report.archiveSourceCompletenessEstablished,true);
    assert.equal(report.sourceMinuteRows,1440);
    assert.equal(report.missingSourceSessionCount,0);
    assert.equal(report.sourceStatus,"TEST_FIXTURE_ONLY");
    assert.equal(report.sourceManifestAndMinuteRowsIndependentlyAuthenticated,false);
    assert.equal(report.fullMarketOpportunityDenominatorVerified,false);
    assert.equal(report.trueMarketWideRecall,null);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("out-of-order, skipped, duplicate and swapped manifest pages fail closed",async()=>{
  const root=temp(),market="CRYPTO_FUTURES",manifest=make(market);
  try{
    const ps=await pages(root,market,manifest);
    assert.equal(aggregate(market,manifest,[ps[1],ps[0]]).reason,
      "PIT_MINUTE_DAY_PAGE_IDENTITY_OR_SEQUENCE_INVALID");
    assert.equal(aggregate(market,manifest,[ps[0]]).reason,
      "PIT_MINUTE_DAY_PAGE_COVERAGE_GAP");
    assert.equal(aggregate(market,manifest,[ps[0],ps[0]]).reason,
      "PIT_MINUTE_DAY_PAGE_IDENTITY_OR_SEQUENCE_INVALID");
    const newer=structuredClone(manifest);
    newer.memberships[0].listedAtMs+=DAY;
    newer.rawMembershipDigestSha256=digestPITMembershipRowsV1(newer.memberships);
    assert.equal(aggregate(market,newer,ps).reason,
      "PIT_MINUTE_DAY_PAGE_IDENTITY_OR_SEQUENCE_INVALID");
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("changed stock calendar, page status, member counters and missing plan never combine",async()=>{
  const root=temp(),market="KR_STOCK",manifest=make(market,2);
  try{
    const cal=dateSessions(market),p=(await pages(root,market,manifest,cal))[0];
    const alter=(mutate)=>{
      const page=structuredClone(p);mutate(page);
      return aggregate(market,manifest,[page],cal);
    };
    assert.equal(alter(x=>x.sessionCalendarDigestSha256="f".repeat(64)).reason,
      "PIT_MINUTE_DAY_PAGE_IDENTITY_OR_SEQUENCE_INVALID");
    assert.equal(alter(x=>x.missingSourceMembers+=1).reason,
      "PIT_MINUTE_DAY_PAGE_COUNTER_CONTRADICTION");
    assert.equal(alter(x=>x.memberSourceStatuses[0].status="SOURCE_MINUTE_SESSIONS_PRESENT_ONLY").reason,
      "PIT_MINUTE_DAY_MEMBER_SOURCE_CONTRADICTION");
    assert.equal(alter(x=>x.missingSourcePlan[0].symbol="WRONG").reason,
      "PIT_MINUTE_DAY_MISSING_PLAN_INVALID");
    assert.equal(alter(x=>x.executionAuthority="LIVE").reason,
      "PIT_MINUTE_DAY_PAGE_IDENTITY_OR_SEQUENCE_INVALID");
    assert.equal(alter(x=>x.nextOffset=1).reason,
      "PIT_MINUTE_DAY_NEXT_CURSOR_INVALID");
    const changed=structuredClone(cal);
    changed.sessions[0].endMs+=MINUTE;
    const calendarChange=aggregate(market,manifest,[p],changed);
    assert.equal(calendarChange.reason,"PIT_MINUTE_DAY_PAGE_IDENTITY_OR_SEQUENCE_INVALID");
    const noCalendar=ledger({market,day:"2026-09-18",manifest,pages:[p]});
    assert.equal(noCalendar.reason,"STOCK_DATED_SESSION_CALENDAR_REQUIRED");
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("private CLI day ledger handles complete index, file privacy and immutable result",async()=>{
  const root=temp(),market="CRYPTO_SPOT",manifest=make(market,3);
  try{
    const ps=await pages(root,market,manifest);
    const manifestPath=join(root,"manifest.json");
    const pagePath=join(root,"page-0.json");
    const indexPath=join(root,"index.json");
    const outputPath=join(root,"daily.json");
    writeFileSync(manifestPath,JSON.stringify(manifest),{mode:0o600});
    writeFileSync(pagePath,JSON.stringify(ps[0]),{mode:0o600});
    writeFileSync(indexPath,JSON.stringify({pageReceiptFiles:[pagePath]}),
      {mode:0o600});
    const args=["--market",market,"--day","2026-09-18",
      "--manifest",manifestPath,"--page-index",indexPath,
      "--output",outputPath];
    const cmd=parse(args),result=cli(cmd);
    assert.equal(result.status,"INCOMPLETE_SOURCE_ATTESTED_DAY_MINUTE_INVENTORY");
    assert.equal(result.completeDayPageAudit,true);
    assert.equal(result.inspectedPITMemberCount,3);
    assert.equal(result.missingSourceMembers,3);
    assert.equal(result.executionAuthority,"NONE");
    const written=JSON.parse(readFileSync(outputPath,"utf8"));
    assert.equal(written.sourceStatus,"TEST_FIXTURE_ONLY");
    assert.equal(written.trueMarketWideRecall,null);
    assert.equal(statSync(outputPath).mode&0o077,0);
    assert.throws(()=>cli(cmd),/PIT_MINUTE_DAY_OUTPUT_ALREADY_EXISTS/);
    chmodSync(pagePath,0o644);
    const other=parse(args.map(x=>x===outputPath?join(root,"other.json"):x));
    assert.throws(()=>cli(other),/PIT_MINUTE_DAY_PRIVATE_INPUT_REQUIRED/);
    assert.throws(()=>parse([...args,"--output",join(root,"no.json")]),
      /PIT_MINUTE_DAY_CLI_OPTION_INVALID/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
