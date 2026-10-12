import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
 mkdtempSync,readFileSync,writeFileSync,statSync,chmodSync,rmSync,existsSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
 auditOnePITDayIntoCompactReceiptV1 as dayReceipt,
 auditCompactPITReceiptLedgerV1 as ledger,
} from "../src/four-market-pit-daily-ledger-v1.js";
import {FOUR_MARKET_WHOLE_SCOPE_V1 as SCOPE,
 WHOLE_MARKET_BENCHMARK_WINDOW_V1 as WINDOW,
 digestWholeVenueDailyRowsV1} from "../src/four-market-whole-pit-price-coverage-v1.js";
import {digestPITMembershipRowsV1} from "../src/historical-pit-venue-universe-gate-v1.js";
import {collectNativeHistoricalPITDayChunkV1,
 assembleHistoricalPITDayChunksV1}
 from "../src/venue-native-pit-daily-intake-v1.js";
import {
 parsePITLedgerCliArgsV1 as parseArgs,
 runPITLedgerCliV1 as cli,
} from "../scripts/audit-four-market-pit-receipt-ledger-v1.mjs";

const D=86_400_000,H="a".repeat(64);
const spot="CRYPTO_SPOT",futures="CRYPTO_FUTURES";
const utc=(n)=>new Date(n).toISOString().slice(0,10);
function provider(market=spot){
 const venue=SCOPE[market].venue;
 const symbols={CRYPTO_SPOT:["KRW-ABC","KRW-OLD"],
  CRYPTO_FUTURES:["ABCUSDT","OLDUSDT"],
  KR_STOCK:["005930","000660"],US_STOCK:["ACME","OLDCO"]}[market];
 const memberships=[
  {symbol:symbols[0],listedAtMs:WINDOW.startMs-30*D,
   removedAtMs:null,halts:[],sourceId:"full-archive",evidenceSha256:H},
  {symbol:symbols[1],listedAtMs:WINDOW.startMs-30*D,
   removedAtMs:WINDOW.startMs+3*D,halts:[],
   sourceId:"full-archive",evidenceSha256:H},
 ];
 const manifest={
  schemaVersion:"historical-venue-pit-roster-v1",
  market,venue,sourceClass:market==="KR_STOCK"||market==="US_STOCK"
    ?"LICENSED_PIT_HISTORICAL_VENDOR":"EXCHANGE_DATED_ARCHIVE",
  sourceId:"full-archive",
  coverageStartMs:WINDOW.startMs,coverageEndMs:WINDOW.endExclusiveMs,
  retrievedAtMs:WINDOW.endExclusiveMs+D,
  allListedAndRemovedAttested:true,suspensionsAttested:true,
  relistedIdentifiersResolved:true,memberships,
  rawMembershipDigestSha256:digestPITMembershipRowsV1(memberships),
 };
 return manifest;
}
function original(market,d,manifest=provider(market)){
 const venue=SCOPE[market].venue;
 const rows=manifest.memberships.filter(m=>
  m.listedAtMs<d+D&&(m.removedAtMs??Infinity)>d).map(m=>({
   symbol:m.symbol,market,venue,timestampMs:d,
   open:100,high:120,low:98,close:110,volume:1000,
   priorClose:99,priorCloseAsOfMs:d,sourceId:"mock-daily-"+d,
   evidenceSha256:H,
 }));
 const dailySource={
  schemaVersion:"venue-native-historical-all-names-daily-v1",
  sourceClass:market===spot||market===futures?"VENUE_NATIVE_DAILY_ARCHIVE":
    "LICENSED_PIT_DAILY_VENDOR",
  sourceId:"mock-daily-"+d,market,venue,
  dayStartMs:d,dayEndMs:d+D,retrievedAtMs:WINDOW.endExclusiveMs+D,
  exhaustiveActiveSymbolsRequested:true,
  priceSelectionUsedFutureDayOHLC:false,
  corporateActionAdjustmentEvidenceAttached:market==="KR_STOCK"||market==="US_STOCK",
  sourcePriceConvention:"NATIVE_UNADJUSTED",
  rows,rowsSha256:digestWholeVenueDailyRowsV1(rows),
 };
 return {manifest,dailySource};
}
function make(market,d,manifest){
 return dayReceipt({market,dayStartMs:d,...original(market,d,manifest)});
}
function series(market=spot){
 const manifest=provider(market);
 const rows=Array.from({length:WINDOW.expectedCryptoUtcDayCount},(_,i)=>
   make(market,WINDOW.startMs+i*D,manifest));
 return {manifest,rows};
}
test("day receipt seals existing PIT+native daily gate without leaking the original prices",()=>{
 const a=make(spot,WINDOW.startMs);
 assert.equal(a.status,"SOURCE_ATTESTED_PIT_PRICE_JOIN_ONLY");
 assert.equal(a.sourceAttestedFullSymbolDayPriceJoin,true);
 assert.equal(a.sourceActiveSymbols,2);
 assert.equal(a.sourceDailyPriceRows,2);
 assert.match(a.receiptSha256,/^[0-9a-f]{64}$/);
 assert.equal(a.archiveCoverageEndMs,WINDOW.endExclusiveMs);
 assert.equal(a.executionAuthority,"NONE");
 assert.equal(a.actualMarketWideOpportunityCount,null);
 assert.equal(a.trueMarketWideRecall,null);
 assert.equal(a.profitabilityProven,false);
 assert.equal(Object.hasOwn(a,"rows"),false);
 assert.equal(Object.hasOwn(a,"memberships"),false);
 const blocked=dayReceipt({market:spot,dayStartMs:WINDOW.startMs});
 assert.equal(blocked.status,"BLOCKED_DATA");
 assert.match(blocked.reason,/PIT_DATED_HISTORICAL_PIT_ROSTER_NOT_CONNECTED/);
 assert.equal(blocked.sourceAttestedFullSymbolDayPriceJoin,false);
 assert.equal(blocked.actualMarketWideOpportunityCount,null);
});
test("1096 compact source-attested mock days can be indexed without all raw bars in one file",()=>{
 const {rows}=series();
 const report=ledger({market:spot,dayReceipts:rows});
 assert.equal(report.status,"SOURCE_ATTESTED_COMPACT_3Y_LEDGER_ONLY");
 assert.equal(report.sourceAttestedPriceJoinedDays,1096);
 assert.equal(report.requestedTradingDays,1096);
 assert.equal(report.completeRequestedDayReceiptCoverage,true);
 assert.equal(report.sourceArchiveLineageConsistent,true);
 assert.equal(report.sourceArchiveFullBenchmarkWindowCovered,true);
 assert.equal(report.sourceAttestedFullBenchmarkReceiptCoverage,true);
 assert.equal(report.archiveLineageCount,1);
 assert.equal(report.missingDayReceiptCount,0);
 assert.equal(report.blockedDayReceiptCount,0);
 assert.equal(report.monthlyCoverage["2023-09"].requestedDays,5);
 assert.equal(report.monthlyCoverage["2026-09"].requestedDays,25);
 assert.equal(report.sourceIndependentlyAuthenticated,false);
 assert.equal(report.sourceObservedPriceEvents,null);
 assert.equal(report.actualMarketWideOpportunityCount,null);
 assert.equal(report.trueMarketWideRecall,null);
 assert.equal(report.profitabilityProven,false);
});
test("missing 1 of 1096 archive receipts is unknown/blocked and not a zero-opportunity day",()=>{
 const {rows}=series();
 const chosen=rows[121].dayStartMs;
 rows.splice(121,1);
 const r=ledger({market:spot,dayReceipts:rows});
 assert.equal(r.status,"INCOMPLETE_OR_SOURCE_LIMITED_PIT_LEDGER");
 assert.equal(r.missingDayReceiptCount,1);
 assert.equal(r.sourceAttestedPriceJoinedDays,1095);
 assert.equal(r.sourceAttestedFullBenchmarkReceiptCoverage,false);
 assert.equal(r.reason,"MISSING_HISTORICAL_DAY_RECEIPTS");
 assert.ok(r.dayPreview.some(x=>x.dateUtc===utc(chosen)&&
   x.reason==="MISSING_COMPACT_DAY_RECEIPT")||
   r.blockedReasonCounts.MISSING_COMPACT_DAY_RECEIPT===1);
 assert.equal(r.actualMarketWideOpportunityCount,null);
});
test("different PIT archive or too-short historical window cannot pass 3-year lineage gate",()=>{
 const {rows,manifest}=series();
 const wrong={...manifest,sourceId:"changed-provider"};
 rows[500]=make(spot,WINDOW.startMs+500*D,wrong);
 const switched=ledger({market:spot,dayReceipts:rows});
 assert.equal(switched.sourceArchiveLineageConsistent,false);
 assert.equal(switched.sourceAttestedFullBenchmarkReceiptCoverage,false);
 assert.equal(switched.reason,"PIT_SOURCE_LINEAGE_CHANGED");
 rows[500]=make(spot,WINDOW.startMs+500*D,manifest);
 const short={...manifest,coverageStartMs:WINDOW.startMs,
  coverageEndMs:WINDOW.startMs+800*D};
 rows[500]=make(spot,WINDOW.startMs+500*D,short);
 const shortened=ledger({market:spot,dayReceipts:rows});
 assert.equal(shortened.sourceAttestedPriceJoinedDays,1096);
 assert.equal(shortened.sourceArchiveFullBenchmarkWindowCovered,false);
 assert.equal(shortened.reason,"PIT_SOURCE_NOT_FULL_THREE_YEAR_WINDOW");
 assert.equal(shortened.trueMarketWideRecall,null);
});
test("modified compact price receipt, duplicate date or wrong market fail closed",()=>{
 const d=WINDOW.startMs,good=make(spot,d);
 const altered={...good,sourceDailyPriceRows:9};
 for(const input of [[altered],[good,good],[good,make(futures,d)]]){
  const r=ledger({market:spot,dayReceipts:input});
  assert.equal(r.status,"BLOCKED_DATA");
  assert.equal(r.reason,"LEDGER_DATE_DUPLICATE_WRONG_MARKET_OR_DIGEST_INVALID");
  assert.equal(r.actualMarketWideOpportunityCount,null);
 }
 const currentSnapshot={...original(spot,d)};
 currentSnapshot.manifest.sourceClass="CURRENT_SNAPSHOT";
 const failed=dayReceipt({market:spot,dayStartMs:d,...currentSnapshot});
 assert.equal(failed.status,"BLOCKED_DATA");
 assert.equal(failed.sourceAttestedFullSymbolDayPriceJoin,false);
 const out=ledger({market:spot,dayReceipts:[failed]});
 assert.equal(out.blockedDayReceiptCount,1);
 assert.equal(out.sourceAttestedPriceJoinedDays,0);
 assert.equal(out.trueMarketWideRecall,null);
});
test("fixture receipts never qualify as real whole-period source proof",()=>{
 const {rows}=series();
 const x=original(spot,WINDOW.startMs);
 x.manifest.sourceClass="TEST_FIXTURE";x.manifest.testOnly=true;
 x.dailySource.sourceClass="TEST_FIXTURE";
 rows[0]=dayReceipt({market:spot,dayStartMs:WINDOW.startMs,...x});
 const report=ledger({market:spot,dayReceipts:rows});
 assert.equal(report.fixtureJoinedDays,1);
 assert.equal(report.sourceAttestedPriceJoinedDays,1095);
 assert.equal(report.sourceAttestedFullBenchmarkReceiptCoverage,false);
 assert.equal(report.reason,"TEST_FIXTURE_DAYS_CANNOT_PROVE_SOURCE");
 assert.equal(report.actualMarketWideOpportunityCount,null);
});
test("stock calendar supplied by caller is not independently an official 3-year trading calendar",()=>{
 const date=Date.parse("2025-02-03T00:00:00Z");
 const daily=make("KR_STOCK",date);
 const r=ledger({market:"KR_STOCK",expectedStockDays:[date],
   dayReceipts:[daily]});
 assert.equal(r.sourceAttestedPriceJoinedDays,1);
 assert.equal(r.completeRequestedDayReceiptCoverage,true);
 assert.equal(r.stockOfficialTradingCalendarIndependentlyVerified,false);
 assert.equal(r.sourceAttestedFullBenchmarkReceiptCoverage,false);
 assert.equal(r.actualMarketWideOpportunityCount,null);
 const empty=ledger({market:"US_STOCK",dayReceipts:[]});
 assert.equal(empty.requestedTradingDays,null);
 assert.equal(empty.reason,"STOCK_OFFICIAL_HISTORICAL_TRADING_CALENDAR_NOT_CONNECTED");
});
test("private CLI day/ledger paths produce 0600 create-only compact records",()=>{
 const folder=mkdtempSync(join(tmpdir(),"pit-source-ledger-"));
 try{
  const day=WINDOW.startMs,inp=join(folder,"one-day.json");
  const out=join(folder,"day-compact.json");
  const originalSource=original(spot,day);
  writeFileSync(inp,JSON.stringify(originalSource),{mode:0o600});
  const config=parseArgs(["--mode","day","--market",spot,"--day",utc(day),
    "--input",inp,"--output",out]);
  const sum=cli(config);
  assert.equal(sum.status,"SOURCE_ATTESTED_PIT_PRICE_JOIN_ONLY");
  assert.equal(statSync(out).mode&0o077,0);
  const receipt=JSON.parse(readFileSync(out,"utf8"));
  const indexFile=join(folder,"index.json"),ledgerFile=join(folder,"ledger.json");
  writeFileSync(indexFile,JSON.stringify({dayReceiptFiles:[out]}),{mode:0o600});
  const report=cli(parseArgs(["--mode","ledger","--market",spot,
    "--input",indexFile,"--output",ledgerFile]));
  assert.equal(report.status,"INCOMPLETE_OR_SOURCE_LIMITED_PIT_LEDGER");
  const persisted=JSON.parse(readFileSync(ledgerFile,"utf8"));
  assert.equal(persisted.requestedTradingDays,1096);
  assert.equal(persisted.sourceAttestedPriceJoinedDays,1);
  assert.equal(persisted.missingDayReceiptCount,1095);
  assert.equal(statSync(ledgerFile).mode&0o077,0);
  assert.throws(()=>cli(config),/PIT_LEDGER_DESTINATION_ALREADY_EXISTS/);
  chmodSync(inp,0o644);
  assert.throws(()=>cli(parseArgs(["--mode","day","--market",spot,
    "--day",utc(day),"--input",inp,"--output",join(folder,"unsafe.json")])),
    /PIT_LEDGER_PRIVATE_SOURCE_FILE_REQUIRED/);
  assert.equal(existsSync(join(folder,"unsafe.json")),false);
 }finally{rmSync(folder,{recursive:true,force:true});}
});

test("native PIT fetch -> full-name day assembly -> compact ledger receipt is directly connected",async()=>{
 const folder=mkdtempSync(join(tmpdir(),"pit-native-compact-bridge-"));
 try{
  const d=Date.parse("2025-10-09T00:00:00Z"),manifest=provider(spot);
  const mock=async(url)=>{
   const u=new URL(url);
   assert.equal(u.pathname,"/v1/candles/days");
   assert.equal(u.searchParams.get("market"),"KRW-ABC");
   const end=Date.parse(u.searchParams.get("to"));
   const bar=(time,p)=>({
    market:"KRW-ABC",
    candle_date_time_utc:new Date(time).toISOString().slice(0,19),
    timestamp:time+4356,opening_price:p,
    high_price:p+3,low_price:p-2,trade_price:p+1,
    candle_acc_trade_volume:20,candle_acc_trade_price:2000,
   });
   return {ok:true,status:200,async json(){
    return [bar(d,105),bar(d-D,100)].filter(x=>
     Date.parse(x.candle_date_time_utc+"Z")<end);
   }};
  };
  const part=await collectNativeHistoricalPITDayChunkV1({
   market:spot,dayStartMs:d,manifest,limit:20,
   allowPublicReadOnlyFetch:true,upbitFetch:mock,
   nowMs:d+3*D,sleepImpl:async()=>{},minBetweenSymbolsMs:180,
  });
  assert.equal(part.status,"PIT_NATIVE_DAY_CHUNK_OBSERVED");
  assert.equal(part.chunkComplete,true);
  const assembled=assembleHistoricalPITDayChunksV1({
   market:spot,dayStartMs:d,manifest,chunks:[part],
   retrievedAtMs:WINDOW.endExclusiveMs+D,
   includePrivateNativeDayRows:true,
  });
  assert.equal(assembled.status,"SOURCE_ATTESTED_FULL_NAME_DAILY_JOIN_ONLY");
  assert.equal(assembled.privateNativeDayRowsEmitted,true);
  const originalFile=join(folder,"native-assembled.json"),
    rosterFile=join(folder,"historical-roster.json"),
    compactFile=join(folder,"compact-receipt.json");
  writeFileSync(rosterFile,JSON.stringify(manifest),{mode:0o600});
  const wrapped={
   schemaVersion:"native-historic-pit-day-read-only-cli-v1",
   executionAuthority:"NONE",
   provenanceIndependentAuthentication:false,
   dataUsage:"RESEARCH_ONLY_NO_COMMERCIAL_REPUBLICATION_AUTHORIZED",
   result:assembled,
  };
  writeFileSync(originalFile,JSON.stringify(wrapped),{mode:0o600});
  const config=parseArgs(["--mode","day","--market",spot,
   "--day",utc(d),"--manifest",rosterFile,
   "--input",originalFile,"--output",compactFile]);
  const result=cli(config);
  assert.equal(result.status,"SOURCE_ATTESTED_PIT_PRICE_JOIN_ONLY");
  const saved=JSON.parse(readFileSync(compactFile,"utf8"));
  assert.equal(saved.sourceActiveSymbols,1);
  assert.equal(saved.sourceDailyPriceRows,1);
  assert.equal(saved.sourceAttestedFullSymbolDayPriceJoin,true);
  assert.equal(saved.actualMarketWideOpportunityCount,null);
  assert.equal(saved.trueMarketWideRecall,null);
  assert.equal(saved.sourceIndependentlyAuthenticated,false);
  assert.equal(Object.hasOwn(saved,"rows"),false);
  const tampered=join(folder,"tampered-native.json");
  const altered=structuredClone(wrapped);
  altered.result.nativeRowsSha256="0".repeat(64);
  writeFileSync(tampered,JSON.stringify(altered),{mode:0o600});
  assert.throws(()=>cli(parseArgs(["--mode","day","--market",spot,
   "--day",utc(d),"--manifest",rosterFile,
   "--input",tampered,"--output",join(folder,"must-not-create.json")])),
   /PIT_LEDGER_NATIVE_ASSEMBLY_PROVENANCE_INVALID/);
  assert.equal(existsSync(join(folder,"must-not-create.json")),false);
  assert.throws(()=>parseArgs(["--mode","ledger","--market",spot,
   "--manifest",rosterFile,"--input",originalFile,
   "--output",join(folder,"bad-ledger.json")]),
   /PIT_LEDGER_CLI_INPUT_OR_SCOPE_INVALID/);
 }finally{rmSync(folder,{recursive:true,force:true});}
});

test("custom 2022 research window outside legacy 3 years accepts only its 5 historical source days",()=>{
 const start=Date.parse("2022-06-01T00:00:00Z");
 const m=provider(spot);
 m.coverageStartMs=start-60*D;
 m.coverageEndMs=start+20*D;
 m.retrievedAtMs=start+25*D;
 m.memberships[0]={...m.memberships[0],listedAtMs:start-30*D};
 m.memberships[1]={...m.memberships[1],
   listedAtMs:start-30*D,removedAtMs:start+2*D};
 m.rawMembershipDigestSha256=digestPITMembershipRowsV1(m.memberships);
 const receipts=Array.from({length:5},(_,i)=>make(spot,start+i*D,m));
 assert.ok(receipts.every(x=>x.status==="SOURCE_ATTESTED_PIT_PRICE_JOIN_ONLY"));
 const r=ledger({
  market:spot,dayReceipts:receipts,
  researchWindow:{startDate:"2022-06-01",endDate:"2022-06-05"},
 });
 assert.equal(r.status,"SOURCE_ATTESTED_COMPACT_SELECTED_WINDOW_ONLY");
 assert.equal(r.requestedTradingDays,5);
 assert.equal(r.sourceAttestedPriceJoinedDays,5);
 assert.equal(r.sourceArchiveFullSelectedWindowCovered,true);
 assert.equal(r.sourceAttestedFullSelectedWindowReceiptCoverage,true);
 assert.equal(r.selectedResearchStartUtc,"2022-06-01");
 assert.equal(r.selectedResearchEndInclusiveUtc,"2022-06-05");
 assert.equal(r.researchRangeSelectionMode,"USER_SELECTED");
 assert.equal(r.actualMarketWideOpportunityCount,null);
 assert.equal(r.trueMarketWideRecall,null);
 assert.equal(r.profitabilityProven,false);
});
test("select ten years on empty saved archive to see missing days, NOT zero opportunities",()=>{
 const a=ledger({market:futures,
  researchWindow:{startDate:"2016-01-01",endDate:"2025-12-31"},
 });
 assert.ok(a.requestedTradingDays>3650);
 assert.equal(a.sourceAttestedPriceJoinedDays,0);
 assert.equal(a.missingDayReceiptCount,a.requestedTradingDays);
 assert.equal(a.sourceAttestedFullSelectedWindowReceiptCoverage,false);
 assert.equal(a.sourceObservedPriceEvents,null);
 assert.equal(a.actualMarketWideOpportunityCount,null);
 assert.equal(a.trueMarketWideRecall,null);
 assert.equal(a.monthlyCoverage["2016-01"].requestedDays,31);
});
test("stock calendar is limited to selected range and remains independently unverified",()=>{
 const start=Date.parse("2025-02-03T00:00:00Z");
 assert.throws(()=>ledger({market:"US_STOCK",expectedStockDays:[start],
   researchWindow:{startDate:"2022-01-01",endDate:"2022-01-31"},
 }),/PIT_LEDGER_STOCK_CALENDAR_INVALID/);
 const x=ledger({market:"KR_STOCK",expectedStockDays:[start],
  dayReceipts:[make("KR_STOCK",start)],
  researchWindow:{startDate:"2025-02-03",endDate:"2025-02-03"},
 });
 assert.equal(x.requestedTradingDays,1);
 assert.equal(x.sourceAttestedPriceJoinedDays,1);
 assert.equal(x.sourceAttestedFullSelectedWindowReceiptCoverage,false);
 assert.equal(x.stockOfficialTradingCalendarIndependentlyVerified,false);
 assert.equal(x.actualMarketWideOpportunityCount,null);
});
test("private CLI --start/--end accepts dynamic one-day job, never rewrites original receipt",()=>{
 const folder=mkdtempSync(join(tmpdir(),"pit-dynamic-window-"));
 try{
  const d=WINDOW.startMs,p=join(folder,"receipt.json");
  writeFileSync(p,JSON.stringify(make(spot,d)),{mode:0o600});
  const index=join(folder,"index.json"),output=join(folder,"out.json");
  writeFileSync(index,JSON.stringify({dayReceiptFiles:[p]}),{mode:0o600});
  const config=parseArgs([
   "--mode","ledger","--market",spot,
   "--start",utc(d),"--end",utc(d),
   "--input",index,"--output",output,
  ]);
  assert.deepEqual(config.researchWindow,{
   startDate:utc(d),endDate:utc(d)});
  const r=cli(config);
  assert.equal(r.status,"SOURCE_ATTESTED_COMPACT_SELECTED_WINDOW_ONLY");
  assert.equal(r.requestedTradingDays,1);
  const saved=JSON.parse(readFileSync(output,"utf8"));
  assert.equal(saved.selectedResearchStartUtc,utc(d));
  assert.equal(saved.actualMarketWideOpportunityCount,null);
  assert.equal(statSync(output).mode&0o077,0);
  assert.throws(()=>cli(config),/PIT_LEDGER_DESTINATION_ALREADY_EXISTS/);
  assert.throws(()=>parseArgs([
   "--mode","ledger","--market",spot,
   "--start","2025-01-01","--input",index,"--output",output,
  ]),/PIT_LEDGER_CLI_INPUT_OR_SCOPE_INVALID/);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
