import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync,
  statSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { digestPITMembershipRowsV1 as rosterDigest }
  from "../src/historical-pit-venue-universe-gate-v1.js";
import { persistResearchMinuteSessionV1 as store }
  from "../src/research-minute-archive-v1.js";
import { auditHistoricalPITMinuteArchiveChunkV1 as pageAudit }
  from "../src/four-market-pit-minute-archive-join-v1.js";
import { auditPITMinuteSelectedWindowChunkV1 as period }
  from "../src/four-market-pit-minute-selected-window-v1.js";
import { parsePITMinuteWindowArgsV1 as parse,
  runPITMinuteWindowCliV1 as cli }
  from "../scripts/report-pit-minute-selected-window-v1.mjs";

const DAY=86_400_000, MIN=60_000;
const START=Date.parse("2026-09-18T00:00:00Z");
const ZONES=Object.freeze({
  KR_STOCK:"Asia/Seoul",US_STOCK:"America/New_York",
  CRYPTO_SPOT:"UTC",CRYPTO_FUTURES:"UTC",
});
const VENUES=Object.freeze({
  KR_STOCK:"KRX",US_STOCK:"US_SIP",
  CRYPTO_SPOT:"UPBIT_KRW",CRYPTO_FUTURES:"BITGET_USDT_FUTURES",
});
const SYMBOLS=Object.freeze({
  KR_STOCK:["005930","000660"],US_STOCK:["AAPL","MSFT"],
  CRYPTO_SPOT:["KRW-BTC","KRW-ETH"],
  CRYPTO_FUTURES:["BTCUSDT","ETHUSDT"],
});
const sha=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const folder=()=>mkdtempSync(join(tmpdir(),"pit-minute-selected-window-"));
const time=date=>Date.parse(date+"T00:00:00Z");
function manifest(market, sourceClass="TEST_FIXTURE"){
  const members=SYMBOLS[market].map(symbol=>({
    symbol,listedAtMs:START-120*DAY,removedAtMs:null,halts:[],
    sourceId:"HISTORIC_MOCK_PIT",evidenceSha256:"a".repeat(64),
  }));
  members.push({symbol:"REMOVED",listedAtMs:START-500*DAY,
    removedAtMs:START-200*DAY,halts:[],sourceId:"HISTORIC_MOCK_PIT",
    evidenceSha256:"a".repeat(64)});
  return {
    schemaVersion:"historical-venue-pit-roster-v1",
    sourceClass,...(sourceClass==="TEST_FIXTURE"?{testOnly:true}:{}),
    market,venue:VENUES[market],sourceId:"HISTORIC_MOCK_PIT",
    coverageStartMs:START-800*DAY,coverageEndMs:START+60*DAY,
    retrievedAtMs:START+61*DAY,
    allListedAndRemovedAttested:true,suspensionsAttested:true,
    relistedIdentifiersResolved:true,
    memberships:members,rawMembershipDigestSha256:rosterDigest(members),
  };
}
function session(market,date){
  if(market.startsWith("CRYPTO_"))return null;
  const start=time(date)+(market==="KR_STOCK"?0:13.5*60*MIN);
  return {market,sessions:[{
    tradingDateLocal:date,startMs:start,endMs:start+30*MIN,
    kind:"REGULAR",timeZone:ZONES[market],
  }]};
}
function minute(market,symbol,date,opts={}){
  const calendar=session(market,date);
  const first=calendar?.sessions[0].startMs??time(date);
  const n=opts.count??(calendar?30:1440);
  const venue=VENUES[market],sourceId="PRIVATE_TEST_NATIVE_MINUTE_OHLCV";
  const bars=Array.from({length:n},(_,i)=>({
    market,venue,symbol,sourceId,timestampMs:first+i*MIN,
    availableAtMs:opts.retrospectiveAt??first+(i+1)*MIN,
    open:100,high:101,low:99,close:100,volume:1+i,
  }));
  return {
    market,venue,symbol,sourceId,
    session:{startMs:first,endMs:first+(calendar?30*MIN:DAY),
      kind:calendar?"REGULAR":"UTC_24H",timeZone:ZONES[market],
      calendarSourceId:"TEST_DATED_LOCAL_SESSION_ONLY"},
    minuteBars:bars,sourceMinuteRowsSha256:sha(bars),
    asOfMs:opts.retrospectiveAt??first+n*MIN,
  };
}
async function daySource(root,market,date,man,opts={}){
  const cal=session(market,date);
  if(opts.store!==false) {
    for(const sym of SYMBOLS[market]){
      if(opts.skipSymbol===sym)continue;
      const src=minute(market,sym,date,{
        retrospectiveAt:opts.retrospectiveAt,
        count:opts.minuteCount,
      });
      await store({root,source:src});
    }
  }
  const pages=[await pageAudit({root,market,day:date,manifest:man,
    stockCalendar:cal,expectedRosterDigestSha256:man.rawMembershipDigestSha256,
    offset:0,limit:20})];
  return {market,date,manifest:man,pages,stockCalendar:cal};
}
function inspect(market,researchWindow,dateSources,other={}) {
  return period({
    market,researchWindow,dateSources,
    ...(market.endsWith("STOCK")
      ?{stockTradingDates:dateSources.map(x=>x.date)}:{}),
    chunkCalendarDays:31,...other,
  });
}

test("4 markets, user-selected days, native 1m completeness: fixture never becomes market PASS",async()=>{
  for(const market of Object.keys(VENUES)){
    const root=folder(),m=manifest(market);
    const dates=market.endsWith("STOCK")
      ?["2026-09-18","2026-09-21"]
      :["2026-09-18","2026-09-19"];
    try{
      const inputs=[];
      for(const date of dates)inputs.push(await daySource(root,market,date,m));
      const report=inspect(market,{startDate:dates[0],endDate:dates.at(-1)},
        inputs);
      assert.equal(report.status,"TEST_FIXTURE_COMPLETE_LOCAL_MINUTE_DATE_CHUNK_ONLY");
      assert.equal(report.requestedTradingDays,2);
      assert.equal(report.locallyCompleteMinuteSourceDays,2);
      assert.equal(report.missingDaySourceCount,0);
      assert.equal(report.partialDaySourceCount,0);
      assert.equal(report.fixtureDaySourceCount,2);
      assert.equal(report.sourceAttestedDaySourceCount,0);
      assert.equal(report.dailyReadiness.length,2);
      assert.equal(report.sourceReadinessOnly,true);
      assert.equal(report.localMinuteInventoryCompleteForSelectedChunk,true);
      assert.equal(report.archiveLineageConsistentForCheckedDays,true);
      assert.equal(report.marketWideSourceCoverageVerified,false);
      assert.equal(report.historicalVenuePITUniverseIndependentlyVerified,false);
      assert.equal(report.originalHistoricalScannerAvailabilityVerified,false);
      assert.equal(report.actualMarketWideOpportunityCount,null);
      assert.equal(report.trueMarketWideRecall,null);
      assert.equal(report.actualFillCount,null);
      assert.equal(report.profitabilityProven,false);
      assert.equal(report.executionAuthority,"NONE");
      assert.equal(report.nextCursorDate,null);
    }finally{rmSync(root,{recursive:true,force:true});}
  }
});

test("3-day spot period with missing middle and partial observed day is NOT 0 opportunities",async()=>{
  const root=folder(),market="CRYPTO_SPOT",m=manifest(market);
  try {
    const a=await daySource(root,market,"2026-09-18",m);
    const last=await daySource(root,market,"2026-09-20",m,
      {minuteCount:15,skipSymbol:"KRW-ETH"});
    const report=inspect(market,{startDate:"2026-09-18",
      endDate:"2026-09-20"},[a,last]);
    assert.equal(report.status,"INCOMPLETE_OR_BLOCKED_PIT_MINUTE_DATE_CHUNK");
    assert.equal(report.reason,"MISSING_HISTORIC_SOURCE_DATES");
    assert.equal(report.requestedTradingDays,3);
    assert.equal(report.missingDaySourceCount,1);
    assert.equal(report.partialDaySourceCount,1);
    assert.equal(report.locallyCompleteMinuteSourceDays,1);
    assert.equal(report.dailyReadiness[1].date,"2026-09-19");
    assert.equal(report.dailyReadiness[1].sourceMinuteRows,null);
    assert.equal(report.dailyReadiness[1].memberCount,null);
    assert.equal(report.monthlyCoverage["2026-09"].missingSourceDays,1);
    assert.equal(report.monthlyCoverage["2026-09"].partialMinuteSourceDays,1);
    assert.equal(report.totals.missingSourceMembers,1);
    assert.equal(report.totals.sourceMinuteRows,2895);
    assert.equal(report.fullMarketOpportunityDenominatorVerified,false);
    assert.equal(report.trueMarketWideRecall,null);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("10-year selected window uses 31-day chunk cursor and no source means unknown",()=>{
  const w={startDate:"2016-01-01",endDate:"2025-12-31"};
  const a=period({market:"CRYPTO_FUTURES",researchWindow:w,
    chunkCalendarDays:31,dateSources:[]});
  assert.equal(a.selectedResearchStartDate,"2016-01-01");
  assert.equal(a.selectedResearchEndDate,"2025-12-31");
  assert.equal(a.selectedResearchCalendarDays,3653);
  assert.equal(a.inspectedStartDate,"2016-01-01");
  assert.equal(a.inspectedEndDate,"2016-01-31");
  assert.equal(a.nextCursorDate,"2016-02-01");
  assert.equal(a.missingDaySourceCount,31);
  assert.equal(a.previewIncompleteDates.length,30);
  assert.equal(a.additionalIncompleteDatePreviewsOmitted,1);
  assert.equal(a.dailyReadiness[30].memberCount,null);
  assert.equal(a.actualMarketWideOpportunityCount,null);
  const b=period({market:"CRYPTO_FUTURES",researchWindow:w,
    cursorDate:a.nextCursorDate,chunkCalendarDays:31,dateSources:[]});
  assert.equal(b.inspectedStartDate,"2016-02-01");
  assert.equal(b.nextCursorDate,"2016-03-03");
  assert.throws(()=>period({market:"CRYPTO_FUTURES",researchWindow:w,
    cursorDate:"2026-01-01",dateSources:[]}),
    /PIT_MINUTE_WINDOW_CURSOR_OUTSIDE_SELECTION/);
});

test("source-attested crypto 2 dates proves local inventory only, never independent PIT",async()=>{
  const root=folder(),market="CRYPTO_FUTURES",
    m=manifest(market,"EXCHANGE_DATED_ARCHIVE");
  try{
    const a=await daySource(root,market,"2026-09-18",m);
    const b=await daySource(root,market,"2026-09-19",m);
    const r=inspect(market,{startDate:"2026-09-18",
      endDate:"2026-09-19"},[a,b]);
    assert.equal(r.status,"SOURCE_ATTESTED_LOCAL_MINUTE_DATE_CHUNK_ONLY");
    assert.equal(r.sourceAttestedDaySourceCount,2);
    assert.equal(r.fixtureDaySourceCount,0);
    assert.equal(r.archiveLineageConsistentForCheckedDays,true);
    assert.equal(r.archiveSourceSpansEntireSelectedWindowSelfAttested,true);
    assert.equal(r.localMinuteInventoryCompleteForSelectedChunk,true);
    assert.equal(r.historicalAllSymbolOHLCVPriceSourceIndependentlyVerified,false);
    assert.equal(r.fullPeriodHistoricalSourceAuthenticated,false);
    assert.equal(r.netProfitPct,null);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("PIT lineage change in one date cannot become full source-attested period",async()=>{
  const root=folder(),market="CRYPTO_SPOT",
    m=manifest(market,"EXCHANGE_DATED_ARCHIVE");
  try {
    const a=await daySource(root,market,"2026-09-18",m);
    const m2={...m,sourceId:"DIFFERENT_HISTORY_PROVIDER"};
    const b=await daySource(root,market,"2026-09-19",m2);
    const r=inspect(market,{startDate:"2026-09-18",
      endDate:"2026-09-19"},[a,b]);
    assert.equal(r.status,"PIT_SOURCE_LINEAGE_OR_SPAN_NOT_ATTESTED");
    assert.equal(r.reason,"PIT_LIFECYCLE_DIGEST_OR_SOURCE_CHANGED");
    assert.equal(r.archiveLineageConsistentForCheckedDays,false);
    assert.equal(r.marketWideSourceCoverageVerified,false);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("stock weekends and omitted stock exchange calendar are NOT certified zero trade",async()=>{
  const market="KR_STOCK",w={startDate:"2026-09-18",endDate:"2026-09-21"};
  const noCalendar=period({market,researchWindow:w,dateSources:[]});
  assert.equal(noCalendar.status,"BLOCKED_DATA");
  assert.equal(noCalendar.requestedTradingDays,null);
  assert.equal(noCalendar.reason,
    "HISTORIC_EXCHANGE_LOCAL_STOCK_TRADING_DATES_NOT_CONNECTED");
  const empty=period({market,researchWindow:w,
    stockTradingDates:[],dateSources:[]});
  assert.equal(empty.status,"BLOCKED_DATA");
  assert.equal(empty.reason,
    "STOCK_DATE_CHUNK_HAS_NO_CALENDAR_SESSIONS_ATTESTED");
  assert.equal(empty.fullMarketOpportunityDenominatorVerified,false);
  assert.throws(()=>period({market,researchWindow:w,
    stockTradingDates:["2026-09-21","2026-09-18"]}),
    /PIT_MINUTE_WINDOW_STOCK_CALENDAR_INVALID/);
  assert.throws(()=>period({market:"CRYPTO_SPOT",researchWindow:w,
    stockTradingDates:["2026-09-18"]}),
    /PIT_MINUTE_WINDOW_CRYPTO_STOCK_CALENDAR_FORBIDDEN/);
});

test("duplicate source dates, wrong markets, invalid page budgets and corrupt receipt block",async()=>{
  const root=folder(),market="CRYPTO_SPOT",m=manifest(market);
  const w={startDate:"2026-09-18",endDate:"2026-09-19"};
  try{
    const a=await daySource(root,market,"2026-09-18",m);
    assert.equal(inspect(market,w,[a,a]).reason,
      "DUPLICATE_OUT_OF_RANGE_OR_WRONG_MARKET_SOURCE_DATE");
    assert.equal(inspect(market,w,[{...a,market:"CRYPTO_FUTURES"}]).reason,
      "DUPLICATE_OUT_OF_RANGE_OR_WRONG_MARKET_SOURCE_DATE");
    const corrupt=structuredClone(a);
    corrupt.pages[0].pitRosterDigestSha256="f".repeat(64);
    const r=inspect(market,w,[corrupt]);
    assert.equal(r.blockedDaySourceCount,1);
    assert.equal(r.missingDaySourceCount,1);
    assert.equal(r.dailyReadiness[0].memberCount,null);
    assert.equal(r.localMinuteInventoryCompleteForSelectedChunk,false);
    const many={...a,pages:Array.from({length:257},()=>a.pages[0])};
    const blocked=inspect(market,w,[many]);
    assert.equal(blocked.reason,
      "MINUTE_RECEIPT_PAGE_BUDGET_EXCEEDED_USE_SHORTER_CHUNK");
    assert.equal(blocked.trueMarketWideRecall,null);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("offline file CLI reuses one full-window PIT manifest for two day indexes",async()=>{
  const root=folder(),market="CRYPTO_SPOT",m=manifest(market);
  try {
    const first=await daySource(root,market,"2026-09-18",m);
    const second=await daySource(root,market,"2026-09-19",m);
    const manPath=join(root,"historical-pit-manifest.json");
    const dayIndex=join(root,"day-index.json");
    const output=join(root,"source-period.json");
    writeFileSync(manPath,JSON.stringify(m),{mode:0o600});
    const sourcePaths=[];
    for(const [i,entry] of [first,second].entries()){
      const receiptPath=join(root,"one-day-"+i+".json");
      const pageIndexPath=join(root,"page-index-"+i+".json");
      writeFileSync(receiptPath,JSON.stringify(entry.pages[0]),{mode:0o600});
      writeFileSync(pageIndexPath,
        JSON.stringify({pageReceiptFiles:[receiptPath]}),{mode:0o600});
      sourcePaths.push({date:entry.date,market,
        manifestPath:manPath,pageIndexPath});
    }
    writeFileSync(dayIndex,JSON.stringify({dateSources:sourcePaths}),
      {mode:0o600});
    const tokens=["--market",market,"--start-date","2026-09-18",
      "--end-date","2026-09-19","--day-index",dayIndex,
      "--chunk-days","2","--output",output];
    const cfg=parse(tokens),result=cli(cfg);
    assert.equal(result.status,"TEST_FIXTURE_COMPLETE_LOCAL_MINUTE_DATE_CHUNK_ONLY");
    assert.equal(result.requestedTradingDays,2);
    assert.equal(result.locallyCompleteMinuteSourceDays,2);
    assert.equal(result.nextCursorDate,null);
    assert.equal(result.executionAuthority,"NONE");
    assert.equal(statSync(output).mode&0o077,0);
    const saved=JSON.parse(readFileSync(output,"utf8"));
    assert.equal(saved.dailyReadiness.length,2);
    assert.equal(saved.trueMarketWideRecall,null);
    assert.throws(()=>cli(cfg),/PIT_MINUTE_WINDOW_CLI_OUTPUT_ALREADY_EXISTS/);
    const entry=JSON.parse(readFileSync(dayIndex,"utf8"));
    entry.dateSources[1].pageIndexPath=entry.dateSources[0].pageIndexPath;
    writeFileSync(dayIndex,JSON.stringify(entry));
    assert.throws(()=>cli(parse(tokens.map(x=>x===output
      ?join(root,"other.json"):x))),/PIT_MINUTE_WINDOW_CLI_DUPLICATE_FILE_PATH/);
    chmodSync(dayIndex,0o644);
    assert.throws(()=>cli(parse(tokens.map(x=>x===output
      ?join(root,"unsafe.json"):x))),
      /PIT_MINUTE_WINDOW_CLI_PRIVATE_FILE_REQUIRED/);
  }finally{rmSync(root,{recursive:true,force:true});}
});


test("historical date-level stock source accepts full 2015-2028 calendar for a short 2026 selection",()=>{
  const dates=["2015-01-05","2026-09-18","2026-09-21","2028-01-03"];
  for(const market of ["KR_STOCK","US_STOCK"]){
    const x=period({market,researchWindow:{startDate:"2026-09-18",
      endDate:"2026-09-21"},stockTradingDates:dates,dateSources:[]});
    assert.equal(x.requestedTradingDays,2);
    assert.equal(x.missingDaySourceCount,2);
    assert.equal(x.actualMarketWideOpportunityCount,null);
    assert.equal(x.fullMarketOpportunityDenominatorVerified,false);
    assert.equal(x.executionAuthority,"NONE");
    assert.throws(()=>period({market,researchWindow:{startDate:"2026-09-18",
      endDate:"2026-09-21"},stockTradingDates:["2028-01-03","2015-01-05"]}),
      /PIT_MINUTE_WINDOW_STOCK_CALENDAR_INVALID/);
  }
});
