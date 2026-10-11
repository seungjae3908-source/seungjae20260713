import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,writeFileSync,readFileSync,statSync,chmodSync,rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { digestPITMembershipRowsV1 as rosterDigest } from
  "../src/historical-pit-venue-universe-gate-v1.js";
import { persistResearchMinuteSessionV1 as store } from
  "../src/research-minute-archive-v1.js";
import { auditHistoricalPITMinuteArchiveChunkV1 as auditPage } from
  "../src/four-market-pit-minute-archive-join-v1.js";
import { summarizeHistoricalPITMinuteDayPagesV1 as dayLedger } from
  "../src/four-market-pit-minute-day-ledger-v1.js";
import {
  sealPITMinuteDayCompactReceiptV1 as seal,
  auditCompactPITMinuteSelectedWindowChunkV1 as range,
} from "../src/four-market-pit-minute-compact-selected-window-v1.js";
import {
  parsePITMinuteCompactArgsV1 as parse,
  runPITMinuteCompactCliV1 as cli,
} from "../scripts/report-pit-minute-compact-period-v1.mjs";

const MIN=60_000,DAY=86_400_000,START=Date.parse("2026-09-18T00:00:00Z");
const SOURCE_ID="FIXTURE_PRIVATE_HISTORIC_PIT_SOURCE";
const HIST=Date.parse("2026-10-11T02:00:00Z");
const HASH="a".repeat(64);
const CONFIG=Object.freeze({
  KR_STOCK:{venue:"KRX",zone:"Asia/Seoul",symbols:["005930","000660"]},
  US_STOCK:{venue:"US_SIP",zone:"America/New_York",symbols:["AAPL","MSFT"]},
  CRYPTO_SPOT:{venue:"UPBIT_KRW",zone:"UTC",symbols:["KRW-BTC","KRW-ETH"]},
  CRYPTO_FUTURES:{venue:"BITGET_USDT_FUTURES",zone:"UTC",symbols:["BTCUSDT","ETHUSDT"]},
});
const h=v=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const folder=()=>mkdtempSync(join(tmpdir(),"pit-compact-minute-period-"));
const start=date=>Date.parse(date+"T00:00:00Z");
const isStock=market=>market.endsWith("STOCK");
const tradingDates=market=>isStock(market)
  ?["2026-09-18","2026-09-21"]:null;
function manifest(market,{fixture=true,sourceId=SOURCE_ID,count=2}={}){
  const syms=Array.from({length:count},(_,i)=>
    CONFIG[market].symbols[i]??(market==="US_STOCK"
      ?"U"+String(i).padStart(5,"0"):
      market==="CRYPTO_SPOT"?"KRW-S"+String(i)
      :market==="KR_STOCK"?String(i).padStart(6,"0")
      :"S"+String(i)+"USDT"));
  const memberships=syms.map(symbol=>({
    symbol,listedAtMs:START-90*DAY,removedAtMs:null,
    halts:[],sourceId,evidenceSha256:HASH,
  }));
  memberships.push({symbol:"DELISTED",listedAtMs:START-500*DAY,
    removedAtMs:START-200*DAY,halts:[],sourceId,evidenceSha256:HASH});
  return {
    schemaVersion:"historical-venue-pit-roster-v1",
    sourceClass:fixture?"TEST_FIXTURE":"EXCHANGE_DATED_ARCHIVE",
    ...(fixture?{testOnly:true}:{}),
    market,venue:CONFIG[market].venue,sourceId,
    coverageStartMs:START-600*DAY,coverageEndMs:START+60*DAY,
    retrievedAtMs:START+61*DAY,
    allListedAndRemovedAttested:true,suspensionsAttested:true,
    relistedIdentifiersResolved:true,memberships,
    rawMembershipDigestSha256:rosterDigest(memberships),
  };
}
function stockSessions(market,date){
  if(!isStock(market)) return null;
  const s=start(date)+(market==="US_STOCK"?13.5*60*MIN:0);
  return {market,sessions:[{tradingDateLocal:date,
    startMs:s,endMs:s+30*MIN,kind:"REGULAR",
    timeZone:CONFIG[market].zone}]};
}
function minuteSource(market,symbol,date,retrospective=false){
  const c=stockSessions(market,date);
  const s=c?.sessions[0].startMs??start(date);
  const count=c?30:1440;
  const venue=CONFIG[market].venue,sourceId="TEST_LOCAL_NATIVE_OHLCV";
  const bars=Array.from({length:count},(_,i)=>({
    market,venue,symbol,sourceId,timestampMs:s+i*MIN,
    availableAtMs:retrospective?HIST:s+(i+1)*MIN,
    open:100,high:101,low:99,close:100,volume:1,
  }));
  return {market,venue,symbol,sourceId,
    session:{startMs:s,endMs:s+(c?30*MIN:DAY),
      kind:c?"REGULAR":"UTC_24H",timeZone:CONFIG[market].zone,
      calendarSourceId:"DATE_SPECIFIC_TEST_CALENDAR_NOT_PROVIDER_SIGNED"},
    minuteBars:bars,sourceMinuteRowsSha256:h(bars),
    asOfMs:retrospective?HIST:s+count*MIN,
  };
}
async function oneDay(root,market,date,pit,{
  retain=true,skipSymbol=null,retrospective=false,limit=20,
}={}){
  const symbols=pit.memberships
    .filter(row=>row.removedAtMs===null).map(row=>row.symbol);
  if(retain){
    for(const sym of symbols){
      if(sym===skipSymbol)continue;
      await store({root,source:minuteSource(market,sym,date,retrospective)});
    }
  }
  const pages=[],cal=stockSessions(market,date);
  for(let offset=0;offset<symbols.length;offset+=limit){
    const receipt=await auditPage({
      root,market,day:date,manifest:pit,stockCalendar:cal,
      offset,limit,expectedRosterDigestSha256:pit.rawMembershipDigestSha256,
    });
    pages.push(receipt);
  }
  const summary=dayLedger({market,day:date,manifest:pit,
    stockCalendar:cal,pages});
  assert.equal(summary.completeDayPageAudit,true);
  return {summary,manifest:pit,receipt:seal({summary,manifest:pit}),pages};
}
function query(market,dayReceipts,other={}){
  return range({market,researchWindow:{startDate:"2026-09-18",
    endDate:isStock(market)?"2026-09-21":"2026-09-19"},
    stockTradingDates:tradingDates(market),chunkCalendarDays:31,
    dayReceipts,...other});
}
test("four markets retain a day summary and stream only compact receipt dates",async()=>{
  for(const market of Object.keys(CONFIG)){
    const root=folder(),pit=manifest(market);
    try{
      const dates=tradingDates(market)??["2026-09-18","2026-09-19"];
      const a=await oneDay(root,market,dates[0],pit);
      const b=await oneDay(root,market,dates[1],pit,{retrospective:true});
      const result=query(market,[a.receipt,b.receipt]);
      assert.equal(result.status,"TEST_FIXTURE_COMPACT_SOURCE_CHUNK_ONLY");
      assert.equal(result.expectedHistoricalTradingDays,2);
      assert.equal(result.checkedCompactDayReceipts,2);
      assert.equal(result.loadedSourcePageReceiptsAtPeriodLevel,0);
      assert.equal(result.locallyCompleteMinuteSourceDays,2);
      assert.equal(result.missingSourceDays,0);
      assert.equal(result.partialSourceDays,0);
      assert.equal(result.retrospectiveSourceDayCount,1);
      assert.equal(result.completeDateReceiptInventory,true);
      assert.equal(result.sourceLineageConsistentForCheckedDates,true);
      assert.equal(result.fullMarketOpportunityDenominatorVerified,false);
      assert.equal(result.trueMarketWideRecall,null);
      assert.equal(result.actualFillCount,null);
      assert.equal(result.profitabilityProven,false);
      assert.equal(result.executionAuthority,"NONE");
      assert.equal(result.nextCursorDate,null);
      assert.match(a.receipt.receiptSha256,/^[a-f0-9]{64}$/);
      assert.equal(a.receipt.originalDayPagesWereValidated,true);
      assert.equal(a.receipt.historicalAllSymbolPITIndependentlyVerified,false);
    }finally{rmSync(root,{recursive:true,force:true});}
  }
});
test("missing one day + incomplete adjacent day is unknown, never a zero opportunity",async()=>{
  const root=folder(),market="CRYPTO_SPOT",pit=manifest(market);
  try{
    const d=await oneDay(root,market,"2026-09-18",pit,{
      skipSymbol:"KRW-ETH",
    });
    const r=query(market,[d.receipt]);
    assert.equal(r.status,"INCOMPLETE_OR_BLOCKED_COMPACT_PIT_MINUTE_DATE_CHUNK");
    assert.equal(r.missingSourceDays,1);
    assert.equal(r.partialSourceDays,1);
    assert.equal(r.locallyCompleteMinuteSourceDays,0);
    assert.equal(r.dailyReadiness[1].originalMinuteRows,null);
    assert.equal(r.dailyReadiness[1].historicalMemberCount,null);
    assert.equal(r.monthlyCoverage["2026-09"].missingSourceDays,1);
    assert.equal(r.memberSourceCount,undefined);
    assert.equal(r.actualMarketWideOpportunityCount,null);
    assert.equal(r.trueMarketWideRecall,null);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("5,140 historical US symbols over 257 page receipts need only ONE compact day file at period level",async()=>{
  const root=folder(),market="US_STOCK",date="2026-09-18",
    pit=manifest(market,{count:5140});
  try{
    // All source minute files are intentionally ABSENT; this is an offline
    // large-roster fixture, not provider-supplied 1m or trade opportunity proof.
    const day=await oneDay(root,market,date,pit,{retain:false});
    assert.equal(day.pages.length,257);
    assert.equal(day.summary.archiveReceiptPageCount,257);
    assert.equal(day.summary.inspectedPITMemberCount,5140);
    assert.equal(day.summary.missingSourceMembers,5140);
    assert.equal(day.receipt.archiveReceiptPageCount,257);
    const report=range({market,researchWindow:{
      startDate:date,endDate:date},
      stockTradingDates:[date],dayReceipts:[day.receipt]});
    assert.equal(report.checkedCompactDayReceipts,1);
    assert.equal(report.loadedSourcePageReceiptsAtPeriodLevel,0);
    assert.equal(report.expectedHistoricalTradingDays,1);
    assert.equal(report.missingSourceDays,0);
    assert.equal(report.partialSourceDays,1);
    assert.equal(report.missingSourceMembers,5140);
    assert.equal(report.actualMarketWideOpportunityCount,null);
    assert.equal(report.fullMarketOpportunityDenominatorVerified,false);
    assert.equal(report.profitabilityProven,false);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("tampered, renamed, duplicate, out-of-window and padded receipts fail closed",async()=>{
  const root=folder(),market="CRYPTO_FUTURES",pit=manifest(market);
  try{
    const d=await oneDay(root,market,"2026-09-18",pit);
    const original=d.receipt;
    const corrupt=structuredClone(original);
    corrupt.sourceMinuteRows++;
    const expected="COMPACT_DAY_RECEIPT_DUPLICATE_WRONG_DATE_OR_TAMPERED";
    assert.equal(query(market,[corrupt]).reason,expected);
    const extra={...original,profitPass:true};
    assert.equal(query(market,[extra]).reason,expected);
    assert.equal(query(market,[original,original]).reason,expected);
    const date={...original,tradingDate:"2026-09-19"};
    assert.equal(query(market,[date]).reason,expected);
    assert.equal(range({market:"CRYPTO_SPOT",
      researchWindow:{startDate:"2026-09-18",endDate:"2026-09-18"},
      dayReceipts:[original]}).reason,expected);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("10-year selected window advances in <=31-day chunks without source-page memory",()=>{
  const window={startDate:"2016-01-01",endDate:"2025-12-31"};
  const first=range({market:"CRYPTO_FUTURES",researchWindow:window,
    chunkCalendarDays:31,dayReceipts:[]});
  assert.equal(first.inspectedStartDate,"2016-01-01");
  assert.equal(first.inspectedEndDate,"2016-01-31");
  assert.equal(first.nextCursorDate,"2016-02-01");
  assert.equal(first.missingSourceDays,31);
  assert.equal(first.loadedSourcePageReceiptsAtPeriodLevel,0);
  assert.equal(first.dailyReadiness[30].historicalMemberCount,null);
  assert.equal(first.trueMarketWideRecall,null);
  const next=range({market:"CRYPTO_FUTURES",researchWindow:window,
    cursorDate:first.nextCursorDate,chunkCalendarDays:31,dayReceipts:[]});
  assert.equal(next.inspectedStartDate,"2016-02-01");
  assert.equal(next.nextCursorDate,"2016-03-03");
  assert.throws(()=>range({market:"CRYPTO_SPOT",researchWindow:window,
    cursorDate:"2026-01-01",dayReceipts:[]}),
    /PIT_COMPACT_WINDOW_CURSOR_OUTSIDE_SELECTED_RANGE/);
});
test("PIT lineage revisions cannot claim fully source-attested historical span",async()=>{
  const root=folder(),market="CRYPTO_SPOT",oldPit=manifest(market,{fixture:false});
  try{
    const a=await oneDay(root,market,"2026-09-18",oldPit);
    const otherPit=manifest(market,{fixture:false,sourceId:"CHANGED_VENUE_ARCHIVE_ID"});
    const b=await oneDay(root,market,"2026-09-19",otherPit);
    const report=query(market,[a.receipt,b.receipt]);
    assert.equal(report.status,"SOURCE_LINEAGE_OR_SELECTED_SPAN_UNATTESTED");
    assert.equal(report.reason,"PIT_MEMBERSHIP_SOURCE_LINEAGE_CHANGED");
    assert.equal(report.sourceLineageConsistentForCheckedDates,false);
    assert.equal(report.historicalPITUniverseIndependentlyAuthenticated,false);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("stock without independently supplied local session dates does not certify no trading",()=>{
  const x=range({market:"US_STOCK",researchWindow:{
    startDate:"2026-09-18",endDate:"2026-09-21"},dayReceipts:[]});
  assert.equal(x.status,"BLOCKED_DATA");
  assert.equal(x.expectedHistoricalTradingDays,null);
  assert.equal(x.reason,"STOCK_EXCHANGE_LOCAL_DATES_NOT_CONNECTED_OR_EMPTY");
  assert.equal(x.actualFillCount,null);
  assert.throws(()=>range({market:"KR_STOCK",researchWindow:{
    startDate:"2026-09-18",endDate:"2026-09-21"},
    stockTradingDates:["2026-09-21","2026-09-18"],dayReceipts:[]}),
    /PIT_COMPACT_STOCK_DATES_INVALID/);
  assert.throws(()=>range({market:"CRYPTO_SPOT",researchWindow:{
    startDate:"2026-09-18",endDate:"2026-09-21"},
    stockTradingDates:["2026-09-18"],dayReceipts:[]}),
    /PIT_COMPACT_CRYPTO_STOCK_DATES_FORBIDDEN/);
});
test("offline CLI seals verified 1-day file, reads compact multi-day index, never raw pages",async()=>{
  const root=folder(),market="CRYPTO_SPOT",pit=manifest(market);
  try{
    const first=await oneDay(root,market,"2026-09-18",pit);
    const second=await oneDay(root,market,"2026-09-19",pit);
    const manifestPath=join(root,"roster.json");
    writeFileSync(manifestPath,JSON.stringify(pit),{mode:0o600});
    const receiptFiles=[];
    for(const [i,d] of [first,second].entries()){
      const dayReportPath=join(root,"day-report-"+i+".json");
      const receiptPath=join(root,"compact-"+i+".json");
      writeFileSync(dayReportPath,JSON.stringify(d.summary),{mode:0o600});
      const args=["--mode","seal","--market",market,"--day",
        d.summary.tradingDate,"--day-report",dayReportPath,
        "--manifest",manifestPath,"--output",receiptPath];
      const out=cli(parse(args));
      assert.equal(out.mode,"seal");
      assert.equal(out.executionAuthority,"NONE");
      assert.equal(statSync(receiptPath).mode&0o077,0);
      receiptFiles.push(receiptPath);
    }
    const dayIndexPath=join(root,"compact-index.json"),windowPath=join(root,"result.json");
    writeFileSync(dayIndexPath,
      JSON.stringify({compactDayReceiptFiles:receiptFiles}),{mode:0o600});
    const tokens=["--mode","window","--market",market,
      "--start-date","2026-09-18","--end-date","2026-09-19",
      "--day-index",dayIndexPath,"--chunk-days","2","--output",windowPath];
    const output=cli(parse(tokens));
    assert.equal(output.status,"TEST_FIXTURE_COMPACT_SOURCE_CHUNK_ONLY");
    assert.equal(output.expectedHistoricalTradingDays,2);
    assert.equal(output.loadedSourcePageReceiptsAtPeriodLevel,0);
    assert.equal(output.trueMarketWideRecall,null);
    const saved=JSON.parse(readFileSync(windowPath,"utf8"));
    assert.equal(saved.checkedCompactDayReceipts,2);
    assert.equal(saved.sourceReadinessOnly,true);
    assert.equal(saved.originalScannerAsOfEvidenceVerified,false);
    assert.equal(statSync(windowPath).mode&0o077,0);
    assert.throws(()=>cli(parse(tokens)),/PIT_COMPACT_CLI_OUTPUT_ALREADY_EXISTS/);
    chmodSync(receiptFiles[1],0o644);
    assert.throws(()=>cli(parse(tokens.map(v=>v===windowPath
      ?join(root,"unsafe.json"):v))),
      /PIT_COMPACT_CLI_PRIVATE_INPUT_REQUIRED/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("source day summary seal rejects forged profitability or wrong manifest SHA",async()=>{
  const root=folder(),market="CRYPTO_SPOT",pit=manifest(market);
  try{
    const d=await oneDay(root,market,"2026-09-18",pit);
    assert.throws(()=>seal({summary:{...d.summary,profitabilityProven:true},
      manifest:pit}),/PIT_COMPACT_ORIGINAL_DAY_NOT_ACCEPTABLE/);
    assert.throws(()=>seal({summary:d.summary,
      manifest:{...pit,rawMembershipDigestSha256:"f".repeat(64)}}),
      /PIT_COMPACT_ORIGINAL_DAY_NOT_ACCEPTABLE/);
    const c={...d.summary,sourceMinuteRows:9999999};
    assert.throws(()=>seal({summary:c,manifest:pit}),
      /PIT_COMPACT_ORIGINAL_DAY_NOT_ACCEPTABLE/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
