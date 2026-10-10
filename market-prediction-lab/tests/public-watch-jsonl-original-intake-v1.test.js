import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm,symlink,link,chmod,unlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
 PUBLIC_WATCH_EXPORT_LIMITS_V1 as limits,
 examineOriginalPublicWatchJsonlV1 as intake,
 readOriginalPublicWatchExportV1 as fromFiles,
} from "../src/public-watch-jsonl-original-intake-v1.js";
import {
 publicWatchEventIdV1,publicWatchCadenceIdV1,
} from "../src/public-watch-native-minute-reconcile-v1.js";

const DAY="2026-10-10",RELEASE="a".repeat(40);
const firstTime="2026-10-10T00:10:00.000Z";
const timePlus6="2026-10-10T00:17:00.000Z";
const joinRows=rows=>rows.map(r=>JSON.stringify(r)).join("\n")+"\n";
function markets({futuresStatus="READY",futuresN=4}={}){
 return [
  {market:"KR_STOCK",status:"BLOCKED_PUBLIC_STOCK_FEED_MISSING",observedCount:0},
  {market:"US_STOCK",status:"BLOCKED_PUBLIC_STOCK_FEED_MISSING",observedCount:0},
  {market:"CRYPTO_SPOT",status:"READY",observedCount:4},
  {market:"CRYPTO_FUTURES",status:futuresStatus,observedCount:futuresN},
 ];
}
function cadence(when=firstTime,extra={}){
 const row={
  schemaVersion:"public-watch-cadence-observation-v1",
  researchSha:RELEASE,observedAt:when,
  cycleStatus:"PARTIAL_MARKET_COVERAGE",resourceBudget:"RUN",
  markets:markets(),publicPriceObservationOnly:true,
  economicEvidenceCredit:0,paperCredit:0,oosCredit:0,
  executionAuthority:"NONE",
  ...extra,
 };
 row.eventId=publicWatchCadenceIdV1(row);
 return row;
}
function event(when=firstTime,extra={}){
 const observed=Date.parse(when);
 const row={
  schemaVersion:"lightweight-market-opportunity-watch-v1",
  researchSha:RELEASE,market:"CRYPTO_FUTURES",symbol:"BTCUSDT",
  direction:"DOWN",source:"BITGET_PUBLIC_TICKERS",
  kind:"PROVISIONAL_PRICE_ACCELERATION",
  observedAt:when,sourceAtMs:observed-1000,
  priorSourceAtMs:observed-121000,
  movePercent:-2.45,executionAuthority:"NONE",
  isTradingSignal:false,aiReviewed:false,oosPassed:false,
  paperAdmitted:false,
  ...extra,
 };
 row.eventId=publicWatchEventIdV1(row);
 return row;
}
function input(events=[event()],cadenceRows=[cadence()],kwargs={}){
 return intake({dayUtc:DAY,expectedResearchSha:RELEASE,
  eventsText:joinRows(events),cadenceText:joinRows(cadenceRows),...kwargs});
}
test("missing historical Vultr export means UNKNOWN not a zero detection or false negative",()=>{
 const x=intake({dayUtc:DAY});
 assert.equal(x.receipt.status,"BLOCKED_DATA");
 assert.equal(x.receipt.reason,"ORIGINAL_WATCH_FILES_NOT_CONNECTED");
 assert.equal(x.receipt.originalEventRows,null);
 assert.equal(x.receipt.trueMarketWideRecall,null);
 assert.equal(x.receipt.verifiedFalseNegativeCount,null);
 assert.deepEqual(x.originalEvents,[]);
 assert.equal(x.receipt.profitabilityProven,false);
 assert.equal(x.receipt.executionAuthority,"NONE");
});
test("original watcher event+cadence hash contracts validate as positive evidence only",()=>{
 const x=input();
 assert.equal(x.receipt.status,"VALIDATED_POSITIVE_LOG_COHORT_ONLY");
 assert.equal(x.receipt.originalEventRows,1);
 assert.equal(x.receipt.originalCadenceRows,1);
 assert.equal(x.receipt.distinctEventIds,1);
 assert.equal(x.receipt.distinctCadenceCycles,1);
 assert.equal(x.originalEvents.length,1);
 assert.equal(x.cadenceRows.length,1);
 assert.match(x.receipt.sourceBytesSha256.events,/^[0-9a-f]{64}$/);
 assert.equal(x.receipt.fullWatchlistNegativeEvidenceVerified,false);
 assert.equal(x.receipt.liveHistoricalScannerAsOfVerified,false);
 assert.equal(x.receipt.trueMarketWideRecall,null);
 assert.equal(x.receipt.actualFillCount,null);
 assert.equal(x.receipt.realOrders,false);
});
test("empty event file cannot certify zero full-market discoveries",()=>{
 const x=input([],[cadence()]);
 assert.equal(x.receipt.status,"BLOCKED_DATA");
 assert.equal(x.receipt.reason,"SOURCE_JSONL_EMPTY_EVENTS");
 assert.equal(x.receipt.originalEventRows,null);
 assert.equal(x.receipt.trueMarketWideRecall,null);
 assert.equal(x.receipt.verifiedFalseNegativeCount,null);
});
test("missing event file despite cadence is source blocked, not observed no-signal",()=>{
 const x=input([],[cadence()],{eventsText:null});
 assert.equal(x.receipt.status,"BLOCKED_DATA");
 assert.equal(x.receipt.reason,"SOURCE_FILE_MISSING_EVENTS");
});
test("missing cadence despite an original event blocks positive observation",()=>{
 const x=input([event()],[],{cadenceText:null});
 assert.equal(x.receipt.reason,"SOURCE_FILE_MISSING_CADENCE");
 assert.deepEqual(x.originalEvents,[]);
});
test("conflicting research SHA does not mix two deployments into one old scan",()=>{
 const e=event();
 e.researchSha="b".repeat(40);
 e.eventId=publicWatchEventIdV1(e);
 const x=input([e],[cadence()]);
 assert.equal(x.receipt.reason,"INVALID_OR_MIXED_RELEASE_EVENT");
 assert.equal(x.receipt.trueMarketWideRecall,null);
});
test("out of date 2025 or 2027 records cannot become 2026 source events",()=>{
 for(const when of ["2025-02-03T01:00:00.000Z","2027-01-01T00:00:00.000Z"]){
  const e=event(when),c=cadence(when);
  assert.equal(input([e],[c]).receipt.status,"BLOCKED_DATA");
 }
});
test("future source timestamp invalidates claimed observation availability",()=>{
 const e=event();
 e.sourceAtMs=Date.parse(e.observedAt)+1000;
 e.eventId=publicWatchEventIdV1(e);
 const x=input([e],[cadence()]);
 assert.equal(x.receipt.reason,"INVALID_OR_MIXED_RELEASE_EVENT");
});
test("explicit trading/OOS flag cannot be attributed to 2min public price watcher",()=>{
 const e=event(firstTime,{isTradingSignal:true,oosPassed:true});
 const x=input([e],[cadence()]);
 assert.equal(x.receipt.status,"BLOCKED_DATA");
 assert.equal(x.receipt.profitabilityProven,false);
});
test("altered eventId after price change is blocked as tampered hash",()=>{
 const e=event();e.sourceAtMs+=1;
 const x=input([e],[cadence()]);
 assert.equal(x.receipt.reason,"INVALID_OR_MIXED_RELEASE_EVENT");
});
test("contradictory cycle status to actual market source count is invalid",()=>{
 const c=cadence(firstTime,{cycleStatus:"OBSERVING_ALL_FOUR"});
 const x=input([event()],[c]);
 assert.equal(x.receipt.reason,"INVALID_OR_MIXED_RELEASE_CADENCE");
});
test("positive event without same timestamp cycle cannot be treated as corroborated",()=>{
 const x=input([event()],[cadence(timePlus6)]);
 assert.equal(x.receipt.reason,"UNCORROBORATED_OR_BLOCKED_POSITIVE_CYCLE");
});
test("cadence says futures blocked while event claims fresh futures: reject",()=>{
 const c=cadence(firstTime,{
  markets:markets({futuresStatus:"BLOCKED_PUBLIC_SOURCE_DOWN",futuresN:0}),
 });
 const x=input([event()],[c]);
 assert.equal(x.receipt.reason,"UNCORROBORATED_OR_BLOCKED_POSITIVE_CYCLE");
});
test("duplicate crash replay deduplicates exact rows and never double-counts",()=>{
 const e=event(),c=cadence();
 const x=input([e,e],[c,c]);
 assert.equal(x.receipt.status,"VALIDATED_POSITIVE_LOG_COHORT_ONLY");
 assert.equal(x.receipt.originalEventRows,2);
 assert.equal(x.receipt.distinctEventIds,1);
 assert.equal(x.receipt.distinctCadenceCycles,1);
 assert.equal(x.receipt.duplicatedIdenticalEvents,1);
 assert.equal(x.receipt.duplicatedIdenticalCadence,1);
});
test("a changed event with same identity hash but different movePercent fails closed",()=>{
 const e=event(),altered={...e,movePercent:e.movePercent+1};
 const x=input([e,altered],[cadence()]);
 assert.equal(x.receipt.reason,"CONFLICTING_REPLAYED_EVENT");
});
test("same timestamp with different legitimate cadence hashes is a conflict",()=>{
 const c=cadence(),modified=cadence(firstTime,{markets:markets({
  futuresStatus:"PARTIAL_TICKERS",futuresN:4,
 })});
 const x=input([event()],[c,modified]);
 assert.equal(x.receipt.reason,"CONFLICTING_SAME_CYCLE_CADENCE");
});
test("seven-minute cycle gap is recorded, NOT fake negative coverage",()=>{
 const x=input([event()],[cadence(),cadence(timePlus6)]);
 assert.equal(x.receipt.maxObservedCadenceGapMs,7*60_000);
 assert.equal(x.receipt.cadenceGapExceedsSixMinutes,true);
 assert.equal(x.receipt.fullWatchlistNegativeEvidenceVerified,false);
});
test("truncated JSONL and malformed lines cannot produce a detected candidate",()=>{
 assert.equal(input([event()],[cadence()],{
  eventsText:JSON.stringify(event()),
 }).receipt.reason,"SOURCE_JSONL_TRUNCATED_OR_INVALID_NEWLINES_EVENTS");
 assert.equal(input([event()],[cadence()],{
  eventsText:"{not_json}\n",
 }).receipt.reason,"SOURCE_JSONL_PARSE_ERROR_EVENTS");
});
test("per-line 16k and per-file 8MiB source caps enforced",()=>{
 const big=JSON.stringify({...event(),debug:"X".repeat(17000)})+"\n";
 assert.equal(input([event()],[cadence()],{eventsText:big}).receipt.reason,
  "SOURCE_JSONL_ROW_SIZE_EVENTS");
 assert.equal(input([event()],[cadence()],{
  eventsText:"X".repeat(limits.maxFileBytes+1)+"\n",
 }).receipt.reason,"SOURCE_FILE_TOO_LARGE_EVENTS");
});
test("cadence >2000 records is rejected rather than partial numerical proof",()=>{
 const c=cadence();
 const raw=Array(2001).fill(JSON.stringify(c)).join("\n")+"\n";
 const x=input([event()],[c],{cadenceText:raw});
 assert.equal(x.receipt.reason,"SOURCE_JSONL_ROW_CAP_CADENCE");
});
test("invalid date and malformed release ID reject before parsing",()=>{
 assert.throws(()=>intake({dayUtc:"2026-02-30"}),/WATCH_EXPORT_DAY_INVALID/);
 assert.throws(()=>intake({dayUtc:DAY,expectedResearchSha:"not-sha"}),
  /WATCH_EXPORT_RESEARCH_SHA_INVALID/);
});
async function makeRoot(){
 const root=await mkdtemp(join(tmpdir(),"public-watch-export-v1-"));
 await mkdir(join(root,"watch","events"),{recursive:true,mode:0o700});
 await mkdir(join(root,"watch","cadence"),{recursive:true,mode:0o700});
 const ep=join(root,"watch","events",DAY+".jsonl");
 const cp=join(root,"watch","cadence",DAY+".jsonl");
 await writeFile(ep,joinRows([event()]),{mode:0o600});
 await writeFile(cp,joinRows([cadence()]),{mode:0o600});
 await chmod(ep,0o600);await chmod(cp,0o600);
 return {root,ep,cp};
}
test("exact read-only exported root imports only stated day and release",async()=>{
 const {root}=await makeRoot();
 try{
  const x=await fromFiles({rootDir:root,dayUtc:DAY,expectedResearchSha:RELEASE});
  assert.equal(x.receipt.status,"VALIDATED_POSITIVE_LOG_COHORT_ONLY");
  assert.equal(x.receipt.originalEventRows,1);
  assert.equal(x.receipt.privateProviderTradeApi,false);
 }finally{await rm(root,{recursive:true,force:true});}
});
test("symlinked final event archive blocked before read",async()=>{
 const {root,ep}=await makeRoot();
 const target=join(root,"elsewhere.jsonl");
 try{
  await writeFile(target,joinRows([event()]),{mode:0o600});
  await unlink(ep);await symlink(target,ep);
  await assert.rejects(()=>fromFiles({
   rootDir:root,dayUtc:DAY,expectedResearchSha:RELEASE,
  }),/WATCH_EXPORT_SOURCE_FILE_UNSAFE_events/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test("hard-linked event archive blocked before read",async()=>{
 const {root,ep}=await makeRoot();
 const secondary=join(root,"copied.jsonl");
 try{
  await link(ep,secondary);
  await assert.rejects(()=>fromFiles({
   rootDir:root,dayUtc:DAY,expectedResearchSha:RELEASE,
  }),/WATCH_EXPORT_SOURCE_FILE_UNSAFE_events/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test("world-readable source archive rejected to reduce accidental key or row exposure",async()=>{
 const {root,ep}=await makeRoot();
 try{
  await chmod(ep,0o644);
  await assert.rejects(()=>fromFiles({
   rootDir:root,dayUtc:DAY,expectedResearchSha:RELEASE,
  }),/WATCH_EXPORT_SOURCE_FILE_UNSAFE_events/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test("local source absent in both categories is UNKNOWN, not 0 scanning",async()=>{
 const root=await mkdtemp(join(tmpdir(),"no-watch-events-v1-"));
 try{
  const x=await fromFiles({
   rootDir:root,dayUtc:DAY,expectedResearchSha:RELEASE,
  });
  assert.equal(x.receipt.reason,"ORIGINAL_WATCH_FILES_NOT_CONNECTED");
  assert.equal(x.receipt.verifiedFalseNegativeCount,null);
 }finally{await rm(root,{recursive:true,force:true});}
});
