import test from "node:test";
import {mkdtempSync,readFileSync,statSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {parseNativePITBatchArgsV1,runNativePITBatchCliV1,
 verifyNativePITChunkEnvelopeV1}
  from "../scripts/run-native-pit-daily-batch-v1.mjs";
import assert from "node:assert/strict";
import {digestPITMembershipRowsV1} from "../src/historical-pit-venue-universe-gate-v1.js";
import {collectNativePITDayPriceV1 as one,collectNativeHistoricalPITDayChunkV1 as chunk,
 assembleHistoricalPITDayChunksV1 as assemble,
 nativePITDailyPriceRowSha256V1 as rowSha}
 from "../src/venue-native-pit-daily-intake-v1.js";
const D=86400000, T=Date.parse("2025-10-09T00:00:00Z"), H="a".repeat(64);
function manifest(market,symbols){
 const venue={CRYPTO_SPOT:"UPBIT_KRW",CRYPTO_FUTURES:"BITGET_USDT_FUTURES",
  KR_STOCK:"KRX",US_STOCK:"US_SIP"}[market];
 const memberships=symbols.map(symbol=>({symbol,listedAtMs:T-50*D,
  removedAtMs:null,halts:[],sourceId:"test-pit",evidenceSha256:H}));
 memberships.push({symbol:market==="KR_STOCK"?"999999":"OLDOLD",
  listedAtMs:T-500*D,removedAtMs:T-100*D,halts:[],
  sourceId:"test-pit",evidenceSha256:H});
 return {schemaVersion:"historical-venue-pit-roster-v1",market,venue,
  sourceClass:"TEST_FIXTURE",testOnly:true,sourceId:"test-pit",
  coverageStartMs:T-600*D,coverageEndMs:T+D,retrievedAtMs:T+4*D,
  allListedAndRemovedAttested:true,suspensionsAttested:true,
  relistedIdentifiersResolved:true,memberships,
  rawMembershipDigestSha256:digestPITMembershipRowsV1(memberships)};
}
function bar(market,time,price){
 return {market,candle_date_time_utc:new Date(time).toISOString().slice(0,19),
  timestamp:time+4356,opening_price:price,
  high_price:price+3,low_price:price-2,trade_price:price+1,
  candle_acc_trade_volume:20,candle_acc_trade_price:2000};
}
async function upbit(url){
 const u=new URL(url);
 assert.equal(u.pathname,"/v1/candles/days");
 const sym=u.searchParams.get("market"),end=Date.parse(u.searchParams.get("to"));
 return {ok:true,status:200,async json(){
  return [bar(sym,T,105),bar(sym,T-D,100)]
   .filter(x=>Date.parse(x.candle_date_time_utc+"Z")<end);
 }};
}
const bitget={get:async(path,params)=>{
 assert.equal(path,"/api/v2/mix/market/history-candles");
 assert.equal(params.productType,"USDT-FUTURES");
 assert.equal(params.granularity,"1Dutc");
 assert.equal(params.category,undefined);
 assert.equal(params.interval,undefined);
 assert.equal(params.startTime,T-2*D);
 assert.equal(params.endTime,T+D);
 return {code:"00000",data:[
  [String(T),"105","115","103","110","1200","90000"],
  [String(T-D),"100","102","99","101","1100","80000"],
 ]};
}};
test("native Upbit daily data uses actual KRW venue and closed prior bar",async()=>{
 const r=await one({market:"CRYPTO_SPOT",symbol:"KRW-ABC",dayStartMs:T,
  upbitFetch:upbit,nowMs:T+3*D});
 assert.equal(r.status,"NATIVE_SELECTED_PIT_SYMBOL_DAY_PRICE_ONLY");
 assert.equal(r.priceRow.priorClose,101);
 assert.equal(r.priceRow.priorCloseAsOfMs,T);
 assert.equal(r.priceRow.high,108);
 assert.equal(r.sourceReceipt.providerHistoricalDelistingsVerified,false);
 assert.equal(r.trueMarketWideRecall,null);
 assert.equal(r.executionAuthority,"NONE");
});
test("Bitget V2 explicit UTC-day history is price-only and LONG/SHORT needs scanner evidence",async()=>{
 const r=await one({market:"CRYPTO_FUTURES",symbol:"ABCUSDT",dayStartMs:T,
  bitgetClient:bitget,nowMs:T+3*D});
 assert.equal(r.status,"NATIVE_SELECTED_PIT_SYMBOL_DAY_PRICE_ONLY");
 assert.equal(r.sourceReceipt.provider,"BITGET");
 assert.equal(r.sourceReceipt.endpoint,"/api/v2/mix/market/history-candles");
 assert.equal(r.sourceReceipt.granularity,"1Dutc");
 assert.equal(r.sourceReceipt.utcCalendarDayBoundaryRequested,true);
 assert.equal(r.priceRow.sourceId,"BITGET_PUBLIC_V2_USDT_FUTURES_1DUTC");
 assert.equal(r.priceRow.priorClose,101);
 assert.equal(r.priceRow.high,115);
 assert.equal(r.actualFillCount,null);
 assert.equal(r.profitabilityProven,false);
});
test("without a historical all-name roster no venue API is called",async()=>{
 let hits=0;
 const r=await chunk({market:"CRYPTO_SPOT",dayStartMs:T,manifest:null,
  allowPublicReadOnlyFetch:true,
  upbitFetch:async()=>{hits++;throw Error("unexpected public call")}});
 assert.equal(hits,0);
 assert.match(r.reason,/PIT_DATED_HISTORICAL_PIT_ROSTER_NOT_CONNECTED/);
 assert.equal(r.actualMarketWideOpportunityCount,null);
});
test("historical all-name roster can be processed in stable resumable chunks, not a six-name basket",async()=>{
 const roster=manifest("CRYPTO_SPOT",["KRW-ABC","KRW-DEF"]);
 const base={market:"CRYPTO_SPOT",dayStartMs:T,manifest:roster,limit:1,
  allowPublicReadOnlyFetch:true,upbitFetch:upbit,nowMs:T+3*D,
  sleepImpl:async()=>{},minBetweenSymbolsMs:180};
 const first=await chunk({...base,offset:0});
 const second=await chunk({...base,offset:1});
 assert.equal(first.chunkComplete,true);
 assert.equal(first.requestedHistoricalActiveMembers,2);
 assert.equal(first.nextOffset,1);
 assert.equal(second.nextOffset,null);
 const result=assemble({market:"CRYPTO_SPOT",dayStartMs:T,
  manifest:roster,chunks:[second,first],retrievedAtMs:T+4*D});
 assert.equal(result.status,"TEST_FIXTURE_FULL_NAME_DAILY_JOIN_ONLY");
 assert.equal(result.sourceAttestedFullSymbolDayPriceJoin,true);
 assert.equal(result.sourceAttestedDailyBars,2);
 assert.equal(result.actualMarketWideOpportunityCount,null);
 assert.equal(result.trueMarketWideRecall,null);
 assert.equal(result.rawNativeDailySourcePublicationAllowed,false);
 assert.equal(result.profitabilityProven,false);
});
test("Bitget two future contracts are processed without current ticker lookup",async()=>{
 const roster=manifest("CRYPTO_FUTURES",["ABCUSDT","DEFUSDT"]);
 const oneChunk=await chunk({market:"CRYPTO_FUTURES",dayStartMs:T,
  manifest:roster,allowPublicReadOnlyFetch:true,bitgetClient:bitget,
  limit:2,nowMs:T+3*D,sleepImpl:async()=>{}});
 assert.equal(oneChunk.rows.length,2);
 assert.equal(oneChunk.chunkComplete,true);
 const r=assemble({market:"CRYPTO_FUTURES",dayStartMs:T,
  manifest:roster,chunks:[oneChunk],retrievedAtMs:T+4*D});
 assert.equal(r.sourceAttestedFullSymbolDayPriceJoin,true);
 assert.equal(r.fullMarketPITUniverseVerified,false);
 assert.equal(r.executionAuthority,"NONE");
});
test("stock venues stay blocked until licensed historical stock bars exist",async()=>{
 for(const [market,symbol] of [["KR_STOCK","005930"],["US_STOCK","ACME"]]){
  const r=await chunk({market,dayStartMs:T,
   manifest:manifest(market,[symbol]),allowPublicReadOnlyFetch:true});
  assert.equal(r.reason,"LICENSED_HISTORICAL_STOCK_DAY_BARS_NOT_CONNECTED");
  assert.equal(r.requestsPerformed,0);
 }
});
test("absent prior UTC close is BLOCKED, not a zero-return event",async()=>{
 const r=await one({market:"CRYPTO_SPOT",symbol:"KRW-ABC",
  dayStartMs:T,nowMs:T+3*D,upbitFetch:async()=>{
   return {ok:true,status:200,async json(){
     return [bar("KRW-ABC",T,110),bar("KRW-ABC",T-3*D,100)];
   }};
  }});
 assert.equal(r.reason,"NATIVE_PRIOR_UTC_DAY_CLOSE_MISSING");
 assert.equal(r.actualMarketWideOpportunityCount,null);
});
test("wrong Upbit symbol and bad Bitget symbol cannot contaminate PIT prices",async()=>{
 await assert.rejects(()=>one({market:"CRYPTO_SPOT",symbol:"KRW-ABC",
  dayStartMs:T,nowMs:T+3*D,upbitFetch:async()=>({
   ok:true,status:200,async json(){
    return [bar("KRW-SOL",T,105),bar("KRW-SOL",T-D,100)];
   },
  })}),/UPBIT_HISTORY_MARKET_IDENTITY_UNVERIFIED/);
 await assert.rejects(()=>one({market:"CRYPTO_FUTURES",symbol:"BTC/USDT",
  dayStartMs:T,nowMs:T+3*D,bitgetClient:bitget}),
 /BITGET_NATIVE_PIT_SYMBOL_INVALID/);
});
test("one skipped symbol or stale roster digest blocks full-market label",async()=>{
 const roster=manifest("CRYPTO_SPOT",["KRW-ABC","KRW-DEF"]);
 const base={market:"CRYPTO_SPOT",manifest:roster,dayStartMs:T,limit:1,
  allowPublicReadOnlyFetch:true,upbitFetch:upbit,nowMs:T+3*D};
 const c=await chunk(base);
 const r=assemble({market:"CRYPTO_SPOT",dayStartMs:T,
  manifest:roster,chunks:[c],retrievedAtMs:T+4*D});
 assert.equal(r.reason,"PIT_NATIVE_CHUNK_MISSING_OR_PROVENANCE_MISMATCH");
 const mismatch=await chunk({...base,expectedRosterDigestSha256:H});
 assert.equal(mismatch.reason,"PIT_ROSTER_DIGEST_CHANGED");
});
test("public historical collection requires explicit opt-in and a strict max-20 budget",async()=>{
 let hits=0;
 const roster=manifest("CRYPTO_SPOT",["KRW-ABC"]);
 const r=await chunk({market:"CRYPTO_SPOT",manifest:roster,dayStartMs:T,
  upbitFetch:async()=>{hits++;throw Error("no consent")}});
 assert.equal(hits,0);
 assert.equal(r.reason,"PUBLIC_NATIVE_PRICE_FETCH_NOT_EXPLICITLY_ENABLED");
 await assert.rejects(()=>chunk({market:"CRYPTO_SPOT",manifest:roster,
  dayStartMs:T,limit:21}),/PIT_CHUNK_ARGUMENT_INVALID/);
});
test("intraday fresh listing is visible and blocks complete-day source claim",async()=>{
 const roster=manifest("CRYPTO_SPOT",["KRW-ABC","KRW-DEF"]);
 roster.memberships[0].listedAtMs=T+3600000;
 roster.rawMembershipDigestSha256=digestPITMembershipRowsV1(roster.memberships);
 const c=await chunk({market:"CRYPTO_SPOT",manifest:roster,
  dayStartMs:T,limit:2,nowMs:T+3*D,
  allowPublicReadOnlyFetch:true,upbitFetch:upbit,sleepImpl:async()=>{}});
 assert.equal(c.chunkComplete,false);
 assert.equal(c.status,"PIT_NATIVE_DAY_CHUNK_PARTIAL");
 assert.ok(c.failed.some(x=>x.reason==="PIT_PARTIAL_SESSION_LISTING_DELISTING_OR_HALT"));
 const r=assemble({market:"CRYPTO_SPOT",manifest:roster,
  dayStartMs:T,chunks:[c],retrievedAtMs:T+4*D});
 assert.equal(r.status,"BLOCKED_DATA");
});

test("research-only CLI validates date, max batch and explicit public read",()=>{
 const a=parseNativePITBatchArgsV1([
  "--mode","plan","--market","CRYPTO_SPOT","--day","2025-10-09",
  "--output","/tmp/unused-pit-readiness.json",
 ]);
 assert.equal(a.allowPublicReadOnlyFetch,false);
 assert.equal(a.limit,20);
 assert.throws(()=>parseNativePITBatchArgsV1([
  "--mode","fetch","--market","CRYPTO_SPOT","--day","2025-10-09",
  "--output","/tmp/unused.json",
 ]),/PIT_CLI_SOURCE_AUTHORITY_INVALID/);
 assert.throws(()=>parseNativePITBatchArgsV1([
  "--mode","plan","--market","CRYPTO_SPOT","--day","2025-02-31",
  "--output","/tmp/unused.json",
 ]),/PIT_CLI_REQUIRED_ARGS_INVALID/);
 assert.throws(()=>parseNativePITBatchArgsV1([
  "--mode","fetch","--read-public","--market","CRYPTO_SPOT",
  "--day","2025-10-09","--offset","0","--limit","2000",
  "--output","/tmp/unused.json",
 ]),/PIT_CLI_BUDGET_INVALID/);
});
test("offline CLI produces honest BLOCKED with private 0600 output, never source requests",async()=>{
 const folder=mkdtempSync(join(tmpdir(),"pit-private-roster-"));
 const output=join(folder,"report.json");
 const c=parseNativePITBatchArgsV1([
  "--mode","plan","--market","CRYPTO_SPOT","--day","2025-10-09",
  "--output",output,
 ]);
 const r=await runNativePITBatchCliV1(c);
 assert.equal(r.status,"BLOCKED_DATA");
 assert.equal(r.executionAuthority,"NONE");
 assert.equal(r.trueMarketWideRecall,null);
 assert.equal(statSync(output).mode&0o077,0);
 const saved=JSON.parse(readFileSync(output,"utf8"));
 assert.equal(saved.result.status,"BLOCKED_DATA");
 assert.equal(saved.result.reason,"PIT_DATED_HISTORICAL_PIT_ROSTER_NOT_CONNECTED");
 assert.equal(saved.dataUsage,"RESEARCH_ONLY_NO_COMMERCIAL_REPUBLICATION_AUTHORIZED");
 await assert.rejects(()=>runNativePITBatchCliV1(c),/EEXIST/);
});

test("CLI complete offline-mocked plan → fetch envelope → assemble is executable",async()=>{
 const folder=mkdtempSync(join(tmpdir(),"pit-whole-cli-e2e-"));
 const archive=manifest("CRYPTO_SPOT",["KRW-ABC","KRW-DEF"]);
 const archiveFile=join(folder,"historical-pit.json");
 writeFileSync(archiveFile,JSON.stringify(archive),{mode:0o600});
 const mk=(mode,output,extra=[])=>parseNativePITBatchArgsV1([
  "--mode",mode,"--market","CRYPTO_SPOT","--day","2025-10-09",
  "--manifest",archiveFile,"--output",output,...extra,
 ]);
 const plan=await runNativePITBatchCliV1(mk("plan",join(folder,"plan.json")));
 assert.equal(plan.status,"BLOCKED_DATA");
 assert.equal(plan.rosterDigestSha256,archive.rawMembershipDigestSha256);
 const files=[];
 for(let i=0;i<2;i++){
  const file=join(folder,"native-"+i+".json");files.push(file);
  const c=mk("fetch",file,[
   "--read-public","--expected-pit-sha",plan.rosterDigestSha256,
   "--offset",String(i),"--limit","1",
  ]);
  const r=await runNativePITBatchCliV1(c,{upbitFetch:upbit});
  assert.equal(r.status,"PIT_NATIVE_DAY_CHUNK_OBSERVED");
  assert.equal(r.nextOffset,i===0?1:null);
  assert.equal(r.rosterDigestSha256,plan.rosterDigestSha256);
  assert.equal(statSync(file).mode&0o077,0);
  const wrapped=JSON.parse(readFileSync(file,"utf8"));
  const actual=verifyNativePITChunkEnvelopeV1(wrapped,{
   market:"CRYPTO_SPOT",dayStartMs:T,
   expectedRosterDigestSha256:plan.rosterDigestSha256,
  });
  assert.equal(actual.chunkOffset,i);
  assert.equal(actual.rows.length,1);
 }
 const finalFile=join(folder,"assembled.json");
 const assembled=await runNativePITBatchCliV1(mk("assemble",finalFile,[
  "--expected-pit-sha",plan.rosterDigestSha256,
  "--chunks",files.slice().reverse().join(","),
 ]));
 assert.equal(assembled.status,"TEST_FIXTURE_FULL_NAME_DAILY_JOIN_ONLY");
 assert.equal(assembled.sourceAttestedFullSymbolDayPriceJoin,true);
 assert.equal(assembled.trueMarketWideRecall,null);
 assert.equal(assembled.profitabilityProven,false);
 assert.equal(assembled.executionAuthority,"NONE");
 const done=JSON.parse(readFileSync(finalFile,"utf8"));
 assert.equal(done.result.sourceAttestedDailyBars,2);
 assert.equal(done.result.actualMarketWideOpportunityCount,null);
});
test("CLI rejects mismatched envelope, stale roster and absent fetch SHA",async()=>{
 const folder=mkdtempSync(join(tmpdir(),"pit-cli-tamper-"));
 const m=manifest("CRYPTO_SPOT",["KRW-ABC"]);
 const manifestFile=join(folder,"roster.json");
 writeFileSync(manifestFile,JSON.stringify(m),{mode:0o600});
 const args=(mode,output,other=[])=>parseNativePITBatchArgsV1([
  "--mode",mode,"--market","CRYPTO_SPOT","--day","2025-10-09",
  "--manifest",manifestFile,"--output",output,...other,
 ]);
 assert.throws(()=>args("fetch",join(folder,"never.json"),["--read-public"]),
  /PIT_CLI_FETCH_ROSTER_AND_SHA_REQUIRED/);
 const chunkFile=join(folder,"good.json");
 await runNativePITBatchCliV1(args("fetch",chunkFile,[
  "--read-public","--expected-pit-sha",m.rawMembershipDigestSha256,
  "--limit","1",
 ]),{upbitFetch:upbit});
 const raw=JSON.parse(readFileSync(chunkFile,"utf8"));
 for(const mutation of [
  x=>{x.schemaVersion="FAKE";},
  x=>{x.executionAuthority="LIVE";},
  x=>{x.result.venue="BINANCE_USDT";},
  x=>{x.result.dayStartMs+=D;},
  x=>{x.result.rosterDigestSha256="0".repeat(64);},
  x=>{x.result.chunkComplete=false;},
 ]){
  const x=structuredClone(raw);mutation(x);
  assert.throws(()=>verifyNativePITChunkEnvelopeV1(x,{
   market:"CRYPTO_SPOT",dayStartMs:T,
   expectedRosterDigestSha256:m.rawMembershipDigestSha256,
  }),/PIT_CLI_CHUNK_ENVELOPE_OR_PROVENANCE_INVALID/);
 }
 const bareFile=join(folder,"bare.json");
 writeFileSync(bareFile,JSON.stringify(raw.result),{mode:0o600});
 await assert.rejects(()=>runNativePITBatchCliV1(args("assemble",
  join(folder,"fail.json"),["--chunks",bareFile])),
  /PIT_CLI_CHUNK_ENVELOPE_OR_PROVENANCE_INVALID/);
 assert.equal(statSync(chunkFile).mode&0o077,0);
});

test("all-name assembler rejects changed source OHLC or wrong provider even if counts and symbols match",async()=>{
 const roster=manifest("CRYPTO_SPOT",["KRW-ABC"]);
 const c=await chunk({market:"CRYPTO_SPOT",dayStartMs:T,manifest:roster,
  limit:1,allowPublicReadOnlyFetch:true,upbitFetch:upbit});
 assert.equal(c.status,"PIT_NATIVE_DAY_CHUNK_OBSERVED");
 assert.equal(c.rows[0].evidenceSha256,rowSha(c.rows[0]));
 const tamperedPrice={...c,rows:[{...c.rows[0],high:c.rows[0].high+99}]};
 assert.equal(assemble({market:"CRYPTO_SPOT",dayStartMs:T,
  manifest:roster,chunks:[tamperedPrice],retrievedAtMs:T+4*D}).reason,
  "PIT_NATIVE_PRICE_ROW_INTEGRITY_OR_PROVIDER_INVALID");
 const otherProvider={...c,rows:[{...c.rows[0],
  sourceId:"BINANCE_PUBLIC_DAY_CANDLES",
 }]};
 assert.equal(assemble({market:"CRYPTO_SPOT",dayStartMs:T,
  manifest:roster,chunks:[otherProvider],retrievedAtMs:T+4*D}).reason,
  "PIT_NATIVE_PRICE_ROW_INTEGRITY_OR_PROVIDER_INVALID");
 const legitimate=assemble({market:"CRYPTO_SPOT",dayStartMs:T,
  manifest:roster,chunks:[c],retrievedAtMs:T+4*D});
 assert.equal(legitimate.status,"TEST_FIXTURE_FULL_NAME_DAILY_JOIN_ONLY");
 assert.equal(legitimate.fullMarketPITUniverseVerified,false);
 assert.equal(legitimate.actualMarketWideOpportunityCount,null);
});
test("assembler rejects a row moved into a different PIT chunk under a valid roster hash",async()=>{
 const roster=manifest("CRYPTO_FUTURES",["ABCUSDT","DEFUSDT"]);
 const c=await chunk({market:"CRYPTO_FUTURES",dayStartMs:T,manifest:roster,
  limit:2,allowPublicReadOnlyFetch:true,bitgetClient:bitget,
  sleepImpl:async()=>{}});
 assert.equal(c.chunkComplete,true);
 const forged={...c,requestedSymbolIds:[...c.requestedSymbolIds].reverse()};
 const r=assemble({market:"CRYPTO_FUTURES",dayStartMs:T,
  manifest:roster,chunks:[forged],retrievedAtMs:T+4*D});
 assert.equal(r.reason,"PIT_NATIVE_CHUNK_MISSING_OR_PROVENANCE_MISMATCH");
});

test("native source-attested whole-day output requires explicit private-row opt-in",async()=>{
 const roster=manifest("CRYPTO_SPOT",["KRW-ABC"]);
 const c=await chunk({market:"CRYPTO_SPOT",dayStartMs:T,
  manifest:roster,allowPublicReadOnlyFetch:true,upbitFetch:upbit});
 const summary=assemble({market:"CRYPTO_SPOT",dayStartMs:T,
  manifest:roster,chunks:[c],retrievedAtMs:T+4*D});
 assert.equal(summary.privateNativeDayRowsEmitted,false);
 assert.equal(Object.hasOwn(summary,"privateNativeDaySource"),false);
 const privateResult=assemble({market:"CRYPTO_SPOT",dayStartMs:T,
  manifest:roster,chunks:[c],retrievedAtMs:T+4*D,
  includePrivateNativeDayRows:true});
 assert.equal(privateResult.status,"TEST_FIXTURE_FULL_NAME_DAILY_JOIN_ONLY");
 assert.equal(privateResult.privateNativeDayRowsEmitted,true);
 assert.equal(privateResult.privateNativeDaySource.rows.length,1);
 assert.equal(createHash("sha256")
   .update(privateResult.privateNativeDaySource.canonicalRowsJSON).digest("hex"),
   privateResult.privateNativeDaySource.rowsSha256);
 assert.deepEqual(JSON.parse(privateResult.privateNativeDaySource.canonicalRowsJSON),
   privateResult.privateNativeDaySource.rows);
 const row=privateResult.privateNativeDaySource.rows[0];
 assert.equal(row.priorBarTimestampMs,T-D);
 assert.equal(row.priorBarOpen,100);
 assert.equal(row.priorBarHigh,103);
 assert.equal(row.priorBarLow,98);
 assert.equal(row.priorBarVolume,20);
 assert.equal(row.priorClose,101);
 assert.equal(row.evidenceSha256,rowSha(row));
 assert.equal(privateResult.rawNativeDailySourcePublicationAllowed,false);
 assert.equal(privateResult.actualMarketWideOpportunityCount,null);
});
test("CLI private native day handoff works only on an assembled offline PIT source",async()=>{
 const folder=mkdtempSync(join(tmpdir(),"pit-private-day-handoff-"));
 const roster=manifest("CRYPTO_SPOT",["KRW-ABC"]);
 const rosterFile=join(folder,"roster.json");
 writeFileSync(rosterFile,JSON.stringify(roster),{mode:0o600});
 const digest=roster.rawMembershipDigestSha256;
 const args=(mode,out,extra)=>parseNativePITBatchArgsV1([
  "--mode",mode,"--market","CRYPTO_SPOT","--day","2025-10-09",
  "--manifest",rosterFile,"--output",out,...extra,
 ]);
 const fetchFile=join(folder,"chunk.json");
 await runNativePITBatchCliV1(args("fetch",fetchFile,[
  "--read-public","--expected-pit-sha",digest,"--limit","1",
 ]),{upbitFetch:upbit});
 const privateFile=join(folder,"private-day.json");
 const r=await runNativePITBatchCliV1(args("assemble",privateFile,[
  "--chunks",fetchFile,"--expected-pit-sha",digest,
  "--emit-private-day-rows",
 ]));
 assert.equal(r.privateNativeDayRowsEmitted,true);
 assert.equal(statSync(privateFile).mode&0o077,0);
 const saved=JSON.parse(readFileSync(privateFile,"utf8"));
 assert.equal(saved.result.privateNativeDaySource.rows.length,1);
 assert.equal(saved.result.privateNativeDaySource.sourceClass,"TEST_FIXTURE");
 assert.equal(saved.result.fullMarketPITUniverseVerified,false);
 assert.equal(saved.result.profitabilityProven,false);
 assert.throws(()=>args("fetch",join(folder,"invalid.json"),[
  "--read-public","--emit-private-day-rows",
  "--expected-pit-sha",digest,
 ]),/PIT_CLI_SOURCE_AUTHORITY_INVALID/);
});

test("Bitget shift by UTC+8 is BLOCKED, never re-dated into false whole-market events",async()=>{
 const shifted=await one({market:"CRYPTO_FUTURES",
  symbol:"ABCUSDT",dayStartMs:T,nowMs:T+3*D,
  bitgetClient:{get:async(path,params)=>{
   assert.equal(path,"/api/v2/mix/market/history-candles");
   assert.equal(params.granularity,"1Dutc");
   // Simulate a provider that ignored explicit UTC and returned a
   // 16:00 UTC local-day boundary. No rounding or false opportunities.
   return {code:"00000",data:[
    [String(T-8*3600_000),"105","115","103","110","1200","90000"],
    [String(T-D-8*3600_000),"100","102","99","101","1100","80000"],
   ]};
  }},
 });
 assert.equal(shifted.status,"BLOCKED_DATA");
 assert.equal(shifted.reason,"NATIVE_EXCHANGE_UTC_DAY_BOUNDARY_NOT_VERIFIED");
 assert.equal(shifted.actualMarketWideOpportunityCount,null);
 assert.equal(shifted.trueMarketWideRecall,null);
 assert.equal(shifted.profitabilityProven,false);
});
test("Bitget wrong missing UTC prior day is a BLOCKED event, not 0% return",async()=>{
 const partial=await one({market:"CRYPTO_FUTURES",
  symbol:"ABCUSDT",dayStartMs:T,nowMs:T+3*D,
  bitgetClient:{get:async(path,params)=>{
   assert.equal(path,"/api/v2/mix/market/history-candles");
   assert.equal(params.granularity,"1Dutc");
   return {code:"00000",data:[[String(T),"100","120","90","111","500","1000"]]};
  }},
 });
 assert.equal(partial.status,"BLOCKED_DATA");
 assert.equal(partial.reason,"NATIVE_PRIOR_UTC_DAY_CLOSE_MISSING");
 assert.equal(partial.actualMarketWideOpportunityCount,null);
});
