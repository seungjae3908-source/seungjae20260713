import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync,
  symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sealPITMinuteDayCompactReceiptV1 } from
  "../src/four-market-pit-minute-compact-selected-window-v1.js";
import { readResearchPITMinuteCoverageV1 as read } from
  "../src/research-pit-minute-coverage-readonly-v1.js";

const START=Date.parse("2026-09-18T00:00:00Z");
const DAY=86_400_000;
const SHA="a".repeat(64);
const makeRoot=()=>mkdtempSync(join(tmpdir(),"private-pit-minute-ui-reader-"));
const market="CRYPTO_SPOT";
const validArgs=(root,extra={})=>({
  root,market,startDate:"2026-09-18",
  endDate:"2026-09-19",chunkDays:7,...extra,
});
function compact(mkt,date="2026-09-18") {
  const venue=mkt==="CRYPTO_SPOT"?"UPBIT_KRW":"BITGET_USDT_FUTURES";
  const status="INCOMPLETE_SOURCE_ATTESTED_DAY_MINUTE_INVENTORY";
  const sourceId="TEST_PRIVATE_HISTORIC_PIT_ARCHIVE";
  const manifest={
    sourceClass:"TEST_FIXTURE",sourceId,rawMembershipDigestSha256:SHA,
    coverageStartMs:START-100*DAY,coverageEndMs:START+100*DAY,
  };
  const summary={
    market:mkt,venue,tradingDate:date,dateBasis:"UTC_CRYPTO_DAY",
    status,reason:"HISTORICAL_MEMBER_MINUTE_SOURCE_MISSING_PARTIAL_OR_BLOCKED",
    pitRosterDigestSha256:SHA,pitRosterSourceId:sourceId,
    pitGateStatus:"TEST_FIXTURE_ONLY",sourceStatus:"TEST_FIXTURE_ONLY",
    sessionCalendarDigestSha256:"b".repeat(64),
    pageReceiptDigestsSha256:"c".repeat(64),
    inspectedPITMemberCount:2,archiveReceiptPageCount:1,
    archivedMembers:0,missingSourceMembers:2,sourceLimitedMembers:0,
    revisedSourceMembers:0,unreadableMembers:0,lifecycleBlockedMembers:0,
    sourceMinuteRows:0,sourceSessionsCovered:0,
    retrospectiveSourceMembers:0,retrospectiveMinuteRows:0,
    missingSourceSessionCount:2,
    localArchiveRowsPresentForEverySelectedPITMember:false,
    completeDayPageAudit:true,
    historicallyDelistedMembersPreservedInManifest:true,
    checkedArchiveSourcesOnly:true,profitabilityProven:false,
    executionAuthority:"NONE",trueMarketWideRecall:null,
    actualFillCount:null,liveTrading:false,autoTrading:false,
    realOrders:false,stockCalendarIndependentlyAuthenticated:false,
    retrospectiveMinutesAreNotAsOfScannerEvidence:true,
    fullMarketOpportunityDenominatorVerified:false,
  };
  return sealPITMinuteDayCompactReceiptV1({summary,manifest});
}
function install(root,mkt,date,receipt) {
  const dir=join(root,mkt);
  mkdirSync(dir,{mode:0o700,recursive:true});
  writeFileSync(join(dir,date+".json"),JSON.stringify(receipt),
    {mode:0o600});
}
test("read-only source coverage validates day receipt and leaves missing date UNKNOWN",async()=>{
  const root=makeRoot();
  try{
    install(root,market,"2026-09-18",compact(market));
    const x=await read(validArgs(root));
    assert.equal(x.available,true);
    assert.equal(x.providerGETCount,0);
    assert.equal(x.financialMutationCount,0);
    assert.equal(x.privateSourceFileCount,1);
    assert.equal(x.report.expectedHistoricalTradingDays,2);
    assert.equal(x.report.missingSourceDays,1);
    assert.equal(x.report.partialSourceDays,1);
    assert.equal(x.report.dailyReadiness[1].originalMinuteRows,null);
    assert.equal(x.report.dailyReadiness[1].historicalMemberCount,null);
    assert.equal(x.report.loadedSourcePageReceiptsAtPeriodLevel,0);
    assert.equal(x.originalScannerAsOfAvailabilityVerified,false);
    assert.equal(x.historicalPITUniverseIndependentlyAuthenticated,false);
    assert.equal(x.trueMarketWideRecall,null);
    assert.equal(x.profitabilityProven,false);
    assert.equal(x.executionAuthority,"NONE");
    assert.equal(Object.keys(x).some(k=>/filePath|rootPath/i.test(k)),false);
    assert.equal(JSON.stringify(x).includes(root),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("missing server root or market folder is BLOCKED, never real 0-profitability",async()=>{
  const root=makeRoot();
  try{
    const missing=await read(validArgs(""));
    assert.equal(missing.available,false);
    assert.equal(missing.reason,"SERVER_REPORT_ROOT_NOT_CONFIGURED");
    const noMarket=await read(validArgs(root));
    assert.equal(noMarket.available,false);
    assert.equal(noMarket.reason,"MARKET_COMPACT_REPORTS_NOT_PRESENT");
    assert.equal(noMarket.actualMarketWideOpportunityCount,null);
    assert.equal(noMarket.executionAuthority,"NONE");
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("stock without caller-provided dated calendar fails closed despite a report file",async()=>{
  const root=makeRoot();
  try{
    mkdirSync(join(root,"KR_STOCK"),{mode:0o700});
    const x=await read({...validArgs(root),market:"KR_STOCK"});
    assert.equal(x.available,true);
    assert.equal(x.status,"BLOCKED_DATA");
    assert.equal(x.report.expectedHistoricalTradingDays,null);
    assert.equal(x.report.reason,
      "STOCK_EXCHANGE_LOCAL_DATES_NOT_CONNECTED_OR_EMPTY");
    assert.equal(x.trueMarketWideRecall,null);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("invalid market, range, cursor and day bounds reject without hitting any provider",async()=>{
  const root=makeRoot();
  try{
    for (const extra of [
      {market:"../../etc"}, {chunkDays:32},
      {startDate:"2026-02-30"}, {cursorDate:"2026-09-22"},
      {endDate:"2026-09-17"},
    ]){
      await assert.rejects(()=>read(validArgs(root,extra)));
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("tampered receipt becomes blocked evidence, not trusted source coverage",async()=>{
  const root=makeRoot();
  try{
    const forged={...compact(market),archiveReceiptPageCount:2500};
    install(root,market,"2026-09-18",forged);
    const x=await read(validArgs(root));
    assert.equal(x.status,"BLOCKED_DATA");
    assert.equal(x.report.reason,
      "COMPACT_DAY_RECEIPT_DUPLICATE_WRONG_DATE_OR_TAMPERED");
    assert.equal(x.profitabilityProven,false);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("private mode, symlink, and corrupted JSON are rejected before source is shown",async()=>{
  const root=makeRoot(),outside=makeRoot();
  try{
    install(root,market,"2026-09-18",compact(market));
    const path=join(root,market,"2026-09-18.json");
    chmodSync(path,0o644);
    await assert.rejects(()=>read(validArgs(root)),
      /PIT_MINUTE_COVERAGE_PRIVATE_FILE_INVALID/);
    rmSync(path);
    symlinkSync(join(outside,"secret.json"),path);
    await assert.rejects(()=>read(validArgs(root)));
    rmSync(path);
    writeFileSync(path,"{\"corrupt\":",{mode:0o600});
    await assert.rejects(()=>read(validArgs(root)),
      /PIT_MINUTE_COVERAGE_PRIVATE_JSON_INVALID/);
    chmodSync(root,0o755);
    await assert.rejects(()=>read(validArgs(root)),
      /PIT_MINUTE_COVERAGE_PRIVATE_DIRECTORY_REQUIRED/);
  }finally{
    rmSync(root,{recursive:true,force:true});
    rmSync(outside,{recursive:true,force:true});
  }
});
test("next cursor scans 31-day max without materializing many raw symbol pages",async()=>{
  const root=makeRoot();
  try{
    install(root,market,"2026-09-18",compact(market));
    const first=await read(validArgs(root,{
      endDate:"2026-10-30",chunkDays:31,
    }));
    assert.equal(first.available,true);
    assert.equal(first.report.expectedHistoricalTradingDays,31);
    assert.equal(first.report.missingSourceDays,30);
    assert.equal(first.report.nextCursorDate,"2026-10-19");
    const following=await read(validArgs(root,{
      endDate:"2026-10-30",chunkDays:31,cursorDate:first.report.nextCursorDate,
    }));
    assert.equal(following.report.inspectedStartDate,"2026-10-19");
    assert.equal(following.report.nextCursorDate,null);
    assert.equal(following.report.sourceReadinessOnly,true);
    assert.equal(following.report.executionAuthority,"NONE");
  }finally{rmSync(root,{recursive:true,force:true});}
});
