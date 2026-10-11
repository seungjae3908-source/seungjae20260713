import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync,
  chmodSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { digestPITMembershipRowsV1 } from "../src/historical-pit-venue-universe-gate-v1.js";
import { collectPITNativeCryptoMinuteSourceV1 as collect }
  from "../src/pit-native-crypto-minute-backfill-v1.js";
import { deriveArchivedResearchTimeframesV1 as derive }
  from "../src/research-minute-archive-v1.js";
import { parsePITNativeMinuteBackfillArgsV1 as parse,
  runPITNativeMinuteBackfillCliV1 as cli }
  from "../scripts/pit-native-crypto-minute-backfill-v1.mjs";

const DAY=86_400_000,MIN=60_000;
const START=Date.parse("2026-09-18T00:00:00Z");
const NOW=Date.parse("2026-10-11T00:00:00Z");
const SHA="a".repeat(64);
const tmp=()=>mkdtempSync(join(tmpdir(),"pit-native-public-1m-"));
const nowImpl=()=>NOW;
function manifest(market,symbol,sourceClass="EXCHANGE_DATED_ARCHIVE"){
  const id="TEST_RESEARCH_SOURCE_NOT_OFFICIAL_AUTHENTICATION";
  const members=[
    {symbol,listedAtMs:START-50*DAY,removedAtMs:null,halts:[],
      sourceId:id,evidenceSha256:SHA},
    {symbol:"OLD-DELST",listedAtMs:START-500*DAY,
      removedAtMs:START-100*DAY,halts:[],
      sourceId:id,evidenceSha256:SHA},
  ];
  return {
    schemaVersion:"historical-venue-pit-roster-v1",sourceClass,
    ...(sourceClass==="TEST_FIXTURE"?{testOnly:true}:{}),
    market,venue:market==="CRYPTO_SPOT"?"UPBIT_KRW":"BITGET_USDT_FUTURES",
    coverageStartMs:START-700*DAY,coverageEndMs:START+DAY,
    retrievedAtMs:START+2*DAY,sourceId:id,
    allListedAndRemovedAttested:true,suspensionsAttested:true,
    relistedIdentifiersResolved:true,memberships:members,
    rawMembershipDigestSha256:digestPITMembershipRowsV1(members),
  };
}
function config(root,market,symbol,options={}){
  const pit=options.manifest??manifest(market,symbol);
  return {
    root,market,symbol,dayStartMs:options.dayStartMs??START,
    manifest:pit,
    expectedRosterDigestSha256:options.digest??pit.rawMembershipDigestSha256,
    allowPublicReadOnlyFetch:options.allowPublicReadOnlyFetch??false,
    retryPartialSource:options.retryPartialSource??false,nowImpl,
    ...(options.upbitFetchImpl?{upbitFetchImpl:options.upbitFetchImpl}:{}),
    ...(options.bitgetClient?{bitgetClient:options.bitgetClient}:{}),
  };
}
function nativeMinute(ts,market="KRW-BTC"){
  return {market,candle_date_time_utc:new Date(ts).toISOString().slice(0,19),
    opening_price:100,high_price:104,low_price:99,
    trade_price:102,candle_acc_trade_volume:2.5,
    candle_acc_trade_price:255};
}
function upbitMock(calls) {
  return async (url,options)=>{
    calls.push({url,method:options?.method??"GET"});
    return {ok:true,status:200,json:async()=>[
      nativeMinute(START+2*MIN),nativeMinute(START+MIN),
      nativeMinute(START),nativeMinute(START-MIN),
    ]};
  };
}
function bitgetMock(calls){
  return {get:async(path,params)=>{
    calls.push({path,params});
    const row=ts=>[String(ts),"100","104","99","102","2.5","255"];
    return {code:"00000",data:[
      row(START+2*MIN),row(START+MIN),row(START),row(START-MIN),
    ]};
  }};
}

test("Upbit PIT public 1m opt-in stores private source, no historical as-of fabrication",async()=>{
  const root=tmp(),calls=[];
  try{
    const denied=await collect(config(root,"CRYPTO_SPOT","KRW-BTC",{
      upbitFetchImpl:upbitMock(calls)}));
    assert.equal(denied.reason,"EXPLICIT_PUBLIC_READ_ONLY_OPT_IN_REQUIRED");
    assert.equal(calls.length,0);
    const result=await collect(config(root,"CRYPTO_SPOT","KRW-BTC",{
      allowPublicReadOnlyFetch:true,upbitFetchImpl:upbitMock(calls)}));
    assert.equal(result.status,"RETROSPECTIVE_PRIVATE_SOURCE_RETAINED_ONLY");
    assert.equal(result.sourceMinuteCount,3);
    assert.equal(result.venue,"UPBIT_KRW");
    assert.equal(result.sourceHistoricalPublicationTimeProven,false);
    assert.equal(result.historicalFullMarketPITUniverseVerified,false);
    assert.equal(result.actualMarketWideOpportunityCount,null);
    assert.equal(result.trueMarketWideRecall,null);
    assert.equal(result.executionAuthority,"NONE");
    assert.equal(calls.length,1);
    assert.match(calls[0].url,/api\.upbit\.com\/v1\/candles\/minutes\/1/);
    const original=await derive({root,market:"CRYPTO_SPOT",
      symbol:"KRW-BTC",sessionStartMs:START,asOfMs:NOW,timeframes:["1m","3m"]});
    assert.equal(original.sourceMinuteRows,3);
    assert.equal(original.intervalData["1m"].completeBarCount,3);
    assert.equal(original.intervalData["3m"].completeBarCount,1);
    assert.equal(original.intervalData["1m"].bars[0].availableAtMs,NOW);
    assert.equal(original.fullMarketOpportunityDenominatorVerified,false);
    const atHistoricalEnd=await derive({root,market:"CRYPTO_SPOT",
      symbol:"KRW-BTC",sessionStartMs:START,asOfMs:START+DAY,timeframes:["1m"]});
    assert.equal(atHistoricalEnd.intervalData["1m"].completeBarCount,0);
    assert.equal(atHistoricalEnd.intervalData["1m"].barDataUnavailableAtCutoffBuckets,3);
    assert.equal(atHistoricalEnd.profitabilityProven,false);
    const skipped=await collect(config(root,"CRYPTO_SPOT","KRW-BTC",{
      allowPublicReadOnlyFetch:true,upbitFetchImpl:upbitMock(calls)}));
    assert.equal(skipped.reason,"EXISTING_PARTIAL_SOURCE_NEEDS_EXPLICIT_RETRY");
    assert.equal(calls.length,1);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("Bitget public FUTURES 1m uses only Bitget native history, never Binance",async()=>{
  const root=tmp(),calls=[];
  try{
    const result=await collect(config(root,"CRYPTO_FUTURES","BTCUSDT",{
      allowPublicReadOnlyFetch:true,bitgetClient:bitgetMock(calls)}));
    assert.equal(result.status,"RETROSPECTIVE_PRIVATE_SOURCE_RETAINED_ONLY");
    assert.equal(result.venue,"BITGET_USDT_FUTURES");
    assert.equal(result.sourceMinuteCount,3);
    assert.equal(calls.length,1);
    assert.equal(calls[0].path,"/api/v2/mix/market/history-candles");
    assert.equal(calls[0].params.productType,"usdt-futures");
    assert.equal(calls[0].params.granularity,"1m");
    assert.equal(calls[0].params.symbol,"BTCUSDT");
    const r=await derive({root,market:"CRYPTO_FUTURES",symbol:"BTCUSDT",
      sessionStartMs:START,asOfMs:NOW,timeframes:["1m","5m"]});
    assert.equal(r.sourceMinuteIntegrityVerified,true);
    assert.equal(r.sourceMinuteRows,3);
    assert.equal(r.intervalData["5m"].completeBarCount,0);
    assert.equal(r.historicalWholeMarketSourceCoverageVerified,false);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("missing PIT roster blocks all public GETs even with explicit opt-in",async()=>{
  const root=tmp(),calls=[],market="CRYPTO_SPOT",symbol="KRW-BTC";
  try{
    const opts=config(root,market,symbol,{
      allowPublicReadOnlyFetch:true,upbitFetchImpl:upbitMock(calls),
    });
    const missing=await collect({...opts,manifest:null});
    assert.equal(missing.status,"BLOCKED_DATA");
    assert.equal(missing.reason,"PIT_ROSTER_DIGEST_LEASE_MISMATCH");
    assert.equal(calls.length,0);
    assert.equal(missing.executionAuthority,"NONE");
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("invalid PIT and provider errors never save unsafe source as a normal history",async()=>{
  const root=tmp(),calls=[],market="CRYPTO_SPOT",sym="KRW-BTC";
  try{
    const base=manifest(market,sym);
    const options={allowPublicReadOnlyFetch:true,upbitFetchImpl:upbitMock(calls)};
    const wrongDigest=await collect(config(root,market,sym,{
      ...options,digest:"f".repeat(64)}));
    assert.equal(wrongDigest.reason,"PIT_ROSTER_DIGEST_LEASE_MISMATCH");
    const fixture=await collect(config(root,market,sym,{
      ...options,manifest:manifest(market,sym,"TEST_FIXTURE")}));
    assert.equal(fixture.reason,"PIT_FIXTURE_NOT_ELIGIBLE_FOR_PUBLIC_SOURCE_BACKFILL");
    const wrongVenue=await collect(config(root,market,sym,{
      ...options,manifest:{...base,venue:"BINANCE_SPOT"}}));
    assert.equal(wrongVenue.reason,"PIT_PIT_ARCHIVE_SOURCE_ATTESTATION_INVALID");
    const survivor=await collect(config(root,market,sym,{
      ...options,manifest:{...base,sourceClass:"CURRENT_SNAPSHOT"}}));
    assert.equal(survivor.reason,"PIT_CURRENT_SURVIVOR_LIST_NOT_HISTORICAL_PIT");
    const removedMembers=structuredClone(base);
    removedMembers.memberships[0].removedAtMs=START-MIN;
    removedMembers.rawMembershipDigestSha256=digestPITMembershipRowsV1(removedMembers.memberships);
    const absent=await collect(config(root,market,sym,{
      ...options,manifest:removedMembers}));
    assert.equal(absent.reason,"HISTORIC_SYMBOL_NOT_IN_PIT_DAY");
    const halted=structuredClone(base);
    halted.memberships[0].halts=[{
      startMs:START+MIN,endMs:START+2*MIN,reason:"EXCHANGE_HALT",
    }];
    halted.rawMembershipDigestSha256=digestPITMembershipRowsV1(halted.memberships);
    const halt=await collect(config(root,market,sym,{
      ...options,manifest:halted}));
    assert.equal(halt.reason,"PIT_HISTORIC_TRADING_HALT_NEEDS_SOURCE_PROOF");
    const providerFail=await collect(config(root,market,sym,{
      ...options,upbitFetchImpl:async()=>{
        calls.push("429");return {ok:false,status:429};
      },
    }));
    assert.equal(providerFail.reason,"NATIVE_1M_PROVIDER_DATA_UNAVAILABLE");
    assert.equal(providerFail.status,"BLOCKED_DATA");
    assert.equal(calls.length,1);
    await assert.rejects(()=>collect(config(root,"CRYPTO_FUTURES","BTCUSD",{})),
      /PIT_NATIVE_MINUTE_BACKFILL_ARGUMENTS_INVALID/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("wrong source identity, unavailable historical window and malformed candles block",async()=>{
  const root=tmp(),market="CRYPTO_SPOT",sym="KRW-BTC";
  try{
    const result=await collect(config(root,market,sym,{
      allowPublicReadOnlyFetch:true,
      upbitFetchImpl:async()=>({ok:true,status:200,json:async()=>[
        nativeMinute(START+2*MIN,"KRW-ETH"),
        nativeMinute(START+MIN,"KRW-ETH"),
        nativeMinute(START,"KRW-ETH"),
        nativeMinute(START-MIN,"KRW-ETH"),
      ]}),
    }));
    assert.equal(result.status,"BLOCKED_DATA");
    assert.equal(result.reason,"NATIVE_PROVIDER_MARKET_IDENTITY_INVALID");
    const none=await derive({root,market,symbol:sym,sessionStartMs:START,
      asOfMs:NOW,timeframes:["1m"]});
    assert.equal(none.reason,"ARCHIVED_SESSION_NOT_FOUND");
    const future=await collect(config(root,market,sym,{
      dayStartMs:START+40*DAY,allowPublicReadOnlyFetch:true,
      upbitFetchImpl:()=>{throw new Error("must not GET future");},
    }));
    assert.equal(future.reason,"HISTORIC_UTC_DAY_NOT_CLOSED");
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("private CLI dry-run outputs blocked receipt; explicit GET stores and duplicate receipt fails",async()=>{
  const root=tmp(),sym="KRW-BTC",market="CRYPTO_SPOT",m=manifest(market,sym);
  try{
    const manifestPath=join(root,"manifest.json"),out=join(root,"result.json");
    writeFileSync(manifestPath,JSON.stringify(m),{mode:0o600});
    const tokens=["--root",root,"--market",market,"--symbol",sym,
      "--day","2026-09-18","--manifest",manifestPath,
      "--expected-roster-sha",m.rawMembershipDigestSha256,
      "--output",out];
    const dry=await cli(parse(tokens),{nowImpl});
    assert.equal(dry.reason,"EXPLICIT_PUBLIC_READ_ONLY_OPT_IN_REQUIRED");
    assert.equal(dry.executionAuthority,"NONE");
    const saved=JSON.parse(readFileSync(out,"utf8"));
    assert.equal(saved.privateTradingApiAllowed,false);
    assert.equal(statSync(out).mode&0o077,0);
    await assert.rejects(()=>cli(parse(tokens),{nowImpl}),
      /PIT_NATIVE_MINUTE_CLI_OUTPUT_EXISTS/);
    const full=await cli(parse([...tokens.slice(0,-2),
      "--output",join(root,"fetched.json"),"--read-public"]),{
      nowImpl,upbitFetchImpl:upbitMock([]),
    });
    assert.equal(full.status,"RETROSPECTIVE_PRIVATE_SOURCE_RETAINED_ONLY");
    assert.equal(full.sourceMinuteCount,3);
    assert.throws(()=>parse([...tokens,"--retry-partial"]),
      /PIT_NATIVE_MINUTE_CLI_SCOPE_INVALID/);
    chmodSync(manifestPath,0o644);
    await assert.rejects(()=>cli(parse([...tokens.slice(0,-2),
      "--output",join(root,"private-error.json")]),{nowImpl}),
      /PIT_NATIVE_MINUTE_CLI_PRIVATE_INPUT_REQUIRED/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
