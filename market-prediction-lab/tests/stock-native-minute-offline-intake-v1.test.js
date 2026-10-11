import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,rmSync,existsSync,readFileSync,writeFileSync,
  statSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {importStockNativeMinuteOfflineV1 as ingest}
  from "../src/stock-native-minute-offline-intake-v1.js";
import {digestPITMembershipRowsV1} from
  "../src/historical-pit-venue-universe-gate-v1.js";
import {deriveArchivedResearchTimeframesV1 as read}
  from "../src/research-minute-archive-v1.js";
import {runOriginalReplayPrivateJobV1 as runPrivate}
  from "../scripts/run-four-market-original-minute-replay-v1.mjs";

const MIN=60_000,DAY=86_400_000;
const D=Date.parse("2026-09-18T00:00:00Z");
const SHA=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const temp=()=>mkdtempSync(join(tmpdir(),"licensed-stock-minute-offline-"));
const policy={
 KR_STOCK:{venue:"KRX",symbol:"005930",kind:"REGULAR",
   zone:"Asia/Seoul",start:D},
 US_STOCK:{venue:"US_SIP",symbol:"AAPL",kind:"REGULAR",
   zone:"America/New_York",
   start:Date.parse("2026-09-18T13:30:00Z")},
};
function make(market,root,{premarket=false,gap=false}={}){
 const p=policy[market];
 const start=p.start+(premarket?-30*MIN:0);
 const day="2026-09-18";
 const kind=premarket?"PREMARKET":"REGULAR";
 const sourceId="TEST_HISTORICAL_STOCK_VENDOR_1M";
 const minuteBars=Array.from({length:30},(_,i)=>({
   market,venue:p.venue,symbol:p.symbol,sourceId,
   timestampMs:start+i*MIN,availableAtMs:start+(i+1)*MIN,
   open:100,high:102,low:99,close:101,volume:50+i,
 }));
 if(gap)minuteBars.splice(7,1);
 const source={market,venue:p.venue,symbol:p.symbol,sourceId,
   session:{startMs:start,endMs:start+30*MIN,kind,timeZone:p.zone,
     calendarSourceId:"TEST_SELF_ATTESTED_VENUE_TRADING_SESSION"},
   minuteBars,sourceMinuteRowsSha256:SHA(minuteBars),
   asOfMs:start+30*MIN};
 const memberships=[
  {symbol:p.symbol,listedAtMs:D-300*DAY,
    removedAtMs:null,halts:[],
    sourceId:"TEST_HISTORICAL_PIT_MEMBERSHIP",evidenceSha256:"a".repeat(64)},
  {symbol:"REMOVED",listedAtMs:D-450*DAY,
    removedAtMs:D-100*DAY,halts:[],
    sourceId:"TEST_HISTORICAL_PIT_MEMBERSHIP",evidenceSha256:"a".repeat(64)},
 ];
 const manifest={
   schemaVersion:"historical-venue-pit-roster-v1",
   market,venue:p.venue,sourceClass:"TEST_FIXTURE",testOnly:true,
   coverageStartMs:D-500*DAY,coverageEndMs:D+30*DAY,
   retrievedAtMs:D+31*DAY,sourceId:"TEST_HISTORICAL_PIT_MEMBERSHIP",
   allListedAndRemovedAttested:true,suspensionsAttested:true,
   relistedIdentifiersResolved:true,memberships,
   rawMembershipDigestSha256:digestPITMembershipRowsV1(memberships),
 };
 const stockCalendar={market,
   sessions:[
    {tradingDateLocal:"2015-01-05",
      startMs:Date.parse(market==="KR_STOCK"
        ?"2015-01-05T00:00:00Z":"2015-01-05T14:30:00Z"),
      endMs:Date.parse(market==="KR_STOCK"
        ?"2015-01-05T00:30:00Z":"2015-01-05T15:00:00Z"),
      kind:"REGULAR",timeZone:p.zone},
    {tradingDateLocal:day,startMs:start,endMs:start+30*MIN,
      kind,timeZone:p.zone},
    {tradingDateLocal:"2028-01-03",
      startMs:Date.parse(market==="KR_STOCK"
        ?"2028-01-03T00:00:00Z":"2028-01-03T14:30:00Z"),
      endMs:Date.parse(market==="KR_STOCK"
        ?"2028-01-03T00:30:00Z":"2028-01-03T15:00:00Z"),
      kind:"REGULAR",timeZone:p.zone},
   ]};
 const license={schemaVersion:"stock-native-minute-local-license-attestation-v1",
   sourceId,originalRowsSha256:source.sourceMinuteRowsSha256,
   localRetentionRightsRef:"TEST_VENDOR_LICENSE_SCOPE_ONLY_NOT_PROVIDER_VERIFIED",
   historicalReadRightsAcknowledged:true,
   localImmutableArchiveRetentionAcknowledged:true,
   originalPriceRowsUnmodifiedAcknowledged:true,
   privateRedistributionNotAllowed:true,
 };
 return {root,market,source,manifest,stockCalendar,license,
   tradingDateLocal:day,allowLocalOfflineImport:true};
}
test("KR/US original minute file is written to private immutable source; rights and PIT remain self-attested",async()=>{
 const folder=temp();
 try{
  for(const market of ["KR_STOCK","US_STOCK"]){
   const args=make(market,folder);
   const first=await ingest(args);
   assert.equal(first.status,
     "RETROSPECTIVE_STOCK_NATIVE_MINUTE_ARCHIVE_RETAINED_ONLY",market);
   assert.equal(first.physicalArchiveRetained,true);
   assert.equal(first.sourceMinuteRowsVerified,30);
   assert.equal(first.missingUnverifiedSourceMinuteSlots,0);
   assert.equal(first.sourceHistoricalPublicationTimeIndependentlyVerified,false);
   assert.equal(first.importedDataLegalRightsIndependentlyVerified,false);
   assert.equal(first.stockVenueOfficialSourceIndependentlyAuthenticated,false);
   assert.equal(first.historicalPITAndOfficialCalendarIndependentlyAuthenticated,false);
   assert.equal(first.actualMarketWideOpportunityCount,null);
   assert.equal(first.trueMarketWideRecall,null);
   assert.equal(first.actualFillCount,null);
   assert.equal(first.profitabilityProven,false);
   assert.equal(first.executionAuthority,"NONE");
   assert.equal(first.paperAdmissionAllowed,false);
   assert.equal(first.privateTradingApiCalls,0);
   assert.equal(first.readOnlyProviderGETs,0);
   const twice=await ingest(args);
   assert.equal(twice.originalArchiveDigestSha256,first.originalArchiveDigestSha256);
   const inspected=await read({root:folder,market,
     symbol:args.source.symbol,
     sessionStartMs:args.source.session.startMs,
     asOfMs:args.source.session.endMs,timeframes:["1m","5m","15m"]});
   assert.equal(inspected.intervalData["1m"].completeBarCount,30);
   assert.equal(inspected.intervalData["5m"].completeBarCount,6);
   assert.equal(inspected.intervalData["15m"].completeBarCount,2);
   assert.equal(inspected.fullMarketOpportunityDenominatorVerified,false);
   assert.equal(inspected.profitabilityProven,false);
  }
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("KRX premarket original 1m uses local exchange date rather than UTC midnight",async()=>{
 const folder=temp();
 try{
   const args=make("KR_STOCK",folder,{premarket:true});
   assert.equal(args.source.session.startMs,D-30*MIN);
   const out=await ingest(args);
   assert.equal(out.status,"RETROSPECTIVE_STOCK_NATIVE_MINUTE_ARCHIVE_RETAINED_ONLY");
   assert.equal(out.tradingDateLocal,"2026-09-18");
   assert.equal(out.physicalArchiveRetained,true);
   assert.equal(out.originalMinuteHistoricalScannerAvailabilityProven,false);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("explicit local archive rights gate requires consent BEFORE creating any private source file",async()=>{
 const folder=temp();
 try{
  const input=make("KR_STOCK",folder);
  const refused=await ingest({...input,allowLocalOfflineImport:false});
  assert.equal(refused.status,"BLOCKED_DATA");
  assert.equal(refused.reason,"EXPLICIT_LOCAL_LICENSED_SOURCE_IMPORT_CONSENT_REQUIRED");
  assert.equal(refused.physicalArchiveRetained,false);
  assert.equal(refused.originalArchiveDigestSha256,null);
  assert.equal(existsSync(join(folder,"minute-sessions-v1")),false);
  const fake={...input,license:{...input.license,
    localImmutableArchiveRetentionAcknowledged:false}};
  const withheld=await ingest(fake);
  assert.equal(withheld.status,"BLOCKED_DATA");
  assert.equal(existsSync(join(folder,"minute-sessions-v1")),false);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("partial native minute vendor file is retained as incomplete, never zero-filled or marketwide PASS",async()=>{
 const folder=temp();
 try{
  const args=make("US_STOCK",folder,{gap:true});
  const out=await ingest(args);
  assert.equal(out.status,"PARTIAL_NATIVE_STOCK_MINUTE_ARCHIVE_RETAINED_NOT_COMPLETE");
  assert.equal(out.sourceMinuteRowsVerified,29);
  assert.equal(out.missingUnverifiedSourceMinuteSlots,1);
  assert.equal(out.fullMarketOpportunityDenominatorVerified,false);
  assert.equal(out.OOSPassCount,0);
  assert.equal(out.profitabilityProven,false);
  assert.equal(out.actualMarketWideOpportunityCount,null);
  assert.equal(out.executionAuthority,"NONE");
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("rejects wrong venue/session, PIT digest, licence digest, malformed native bars and non-stock import",async()=>{
 const folder=temp();
 try{
   const args=make("US_STOCK",folder);
   await assert.rejects(()=>ingest({...args,
     source:{...args.source,venue:"KRX"}}),
     /STOCK_NATIVE_MINUTE_IDENTITY_OR_ROWS_INVALID/);
   await assert.rejects(()=>ingest({...args,
     tradingDateLocal:"2026-09-17"}),
     /STOCK_NATIVE_MINUTE_IDENTITY_OR_ROWS_INVALID/);
   await assert.rejects(()=>ingest({...args,
     manifest:{...args.manifest,
       rawMembershipDigestSha256:"f".repeat(64)}}),
     /STOCK_NATIVE_MINUTE_HISTORIC_PIT_ROSTER_INVALID/);
   await assert.rejects(()=>ingest({...args,
     license:{...args.license,
       originalRowsSha256:"f".repeat(64)}}),
     /STOCK_NATIVE_MINUTE_LICENSE_METADATA_INVALID/);
   await assert.rejects(()=>ingest({...args,
     stockCalendar:{market:args.market,sessions:[]}}),
     /STOCK_NATIVE_MINUTE_SESSION_CALENDAR_IDENTITY_UNVERIFIED/);
   await assert.rejects(()=>ingest({...args,market:"CRYPTO_SPOT"}),
     /STOCK_NATIVE_MINUTE_IDENTITY_OR_ROWS_INVALID/);
   const edited=structuredClone(args.source);
   edited.minuteBars[0].close=500;
   await assert.rejects(()=>ingest({...args,source:edited}),
     /STOCK_NATIVE_MINUTE_IDENTITY_OR_ROWS_INVALID/);
   assert.equal(existsSync(join(folder,"minute-sessions-v1")),false);
 }finally{rmSync(folder,{recursive:true,force:true});}
});


test("STOCK_IMPORT private CLI accepts one explicit licensed original 1m receipt, never a broker/Paper instruction",async()=>{
 const folder=temp();
 try{
   const args=make("US_STOCK",folder);
   const input=join(folder,"stock-private-input.json");
   const output=join(folder,"US_SOURCE_IMPORT_REPORT.json");
   writeFileSync(input,JSON.stringify({...args,mode:"STOCK_IMPORT"}),
     {mode:0o600});
   const status=await runPrivate({input,output});
   assert.equal(status.mode,"STOCK_IMPORT");
   assert.equal(status.status,
     "RETROSPECTIVE_STOCK_NATIVE_MINUTE_ARCHIVE_RETAINED_ONLY");
   assert.equal(status.executionAuthority,"NONE");
   assert.equal(status.orderSubmitted,false);
   const report=JSON.parse(readFileSync(output,"utf8"));
   assert.equal(report.offlineOriginalArchiveWriteAllowed,true);
   assert.equal(report.physicalArchiveRetained,true);
   assert.equal(report.readOnlyProviderGETs,0);
   assert.equal(report.privateTradingApiCalls,0);
   assert.equal(report.financialMutationCount,0);
   assert.equal(report.paperAdmissionAllowed,false);
   assert.equal(report.profitabilityProven,false);
   assert.equal(report.executionAuthority,"NONE");
   assert.equal(report.actualFillCount,null);
   assert.equal(statSync(output).mode&0o077,0);
   await assert.rejects(()=>runPrivate({input,output}),/EEXIST/);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
