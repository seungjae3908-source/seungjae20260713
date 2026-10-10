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
