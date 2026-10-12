import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePublicNativeCryptoRosterV1 } from "../src/public-native-crypto-roster-v1.js";
import { collectPublicNativeCryptoSourcePageV1 as collect } from "../src/public-native-crypto-source-page-v1.js";
import { deriveArchivedResearchTimeframesV1, inspectArchivedResearchMinuteSessionV1, persistResearchMinuteSessionV1 } from "../src/research-minute-archive-v1.js";
import { parsePublicNativeSourcePageArgsV1, runPublicNativeSourcePageCliV1 } from "../scripts/collect-public-native-source-page-v1.mjs";

const DAY=86_400_000,MIN=60_000,day="2025-10-09",start=Date.parse(day+"T00:00:00Z");
const now=start+DAY*10;
const sha=s=>createHash("sha256").update(s).digest("hex");
function roster(market="CRYPTO_SPOT",names=["AAA","BBB","CCC"]){
  const payload=market==="CRYPTO_SPOT"?names.map(n=>({market:"KRW-"+n,
    market_event:{warning:false,caution:{}}})):{code:"00000",data:names.map(n=>({
    symbol:n+"USDT",baseCoin:n,quoteCoin:"USDT",symbolStatus:"normal",
    symbolType:"perpetual",isRwa:"NO"}))};
  return normalizePublicNativeCryptoRosterV1({market,payload,observedAtMs:now-1000,
    rawResponseSha256:sha(JSON.stringify(payload))});
}
async function rootFor(t){
  const root=await mkdtemp(join(tmpdir(),"public-native-source-"));
  t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
const config=(root,r=roster(),extra={})=>({root,market:r.market,day,roster:r,
  expectedRosterDigestSha256:r.rosterDigestSha256,nowImpl:()=>now,...extra});
function upbitRow(symbol,ts){return {market:symbol,candle_date_time_utc:new Date(ts).toISOString().slice(0,19),
  timestamp:ts+55_000,opening_price:100,high_price:102,low_price:99,trade_price:101,
  candle_acc_trade_volume:12,candle_acc_trade_price:1200};}
function provider({full=false,errorSymbol=null,status=null}={}){
  const requests=[];
  const fetchImpl=async(input,options)=>{
    const url=new URL(input);requests.push({url,options,startedAt:Date.now()});
    if(status)return new Response(JSON.stringify({code:"42900"}),{status,headers:{"content-type":"application/json"}});
    if(url.origin==="https://api.upbit.com"){
      const symbol=url.searchParams.get("market");
      let rows;
      if(full){
        const end=Date.parse(url.searchParams.get("to"));
        const last=Math.ceil(end/MIN)-1;
        rows=Array.from({length:200},(_,i)=>upbitRow(symbol,(last-i)*MIN));
      }else rows=[upbitRow(symbol,start+MIN),upbitRow(symbol,start)];
      if(symbol===errorSymbol)rows[0].high_price=50;
      return new Response(JSON.stringify(rows),{headers:{"content-type":"application/json"}});
    }
    const rows=[[start+MIN,"100","102","99","101","12","1200"],
      [start,"100","102","99","101","12","1200"]];
    return new Response(JSON.stringify({code:"00000",data:rows}),{headers:{"content-type":"application/json"}});
  };return {fetchImpl,requests};
}

test("current whole roster plans bounded pages without claiming historical PIT or making requests",async t=>{
  const root=await rootFor(t),r=roster("CRYPTO_SPOT",Array.from({length:126},(_,i)=>"C"+String(i).padStart(3,"0")));
  let calls=0;
  const x=await collect(config(root,r,{offset:100,limit:20,fetchImpl:async()=>{calls++;throw Error("must not fetch");}}));
  assert.equal(x.status,"PLANNED_CURRENT_SOURCE_PAGE_ONLY");assert.equal(calls,0);
  assert.equal(x.currentSourceSymbolCount,126);assert.equal(x.selectedSymbols.length,20);
  assert.equal(x.plannedNextOffset,120);assert.equal(x.nextOffset,100);
  assert.equal(x.historicalUniverseComplete,false);assert.equal(x.trueMarketWideRecall,null);
  assert.equal(x.paperAdmissionAllowed,false);assert.equal(x.profitabilityProven,false);
  assert.deepEqual(await readdir(root),[]);
});

test("wrong lease, tampered roster and impossible/future days block before provider I/O",async t=>{
  const root=await rootFor(t),r=roster();let calls=0;
  const fetchImpl=async()=>{calls++;throw Error("no");};
  const x=await collect(config(root,r,{allowPublicReadOnlyFetch:true,fetchImpl,expectedRosterDigestSha256:"0".repeat(64)}));
  assert.equal(x.reason,"CURRENT_SOURCE_ROSTER_OR_DIGEST_INVALID");
  const altered=JSON.parse(JSON.stringify(r));altered.symbols[0]="KRW-ZZZ";
  assert.equal((await collect(config(root,altered,{fetchImpl}))).status,"BLOCKED_DATA");
  await assert.rejects(collect(config(root,r,{day:"2025-02-30",fetchImpl})),/ARGUMENT_INVALID/);
  await assert.rejects(collect(config(root,r,{expectedRosterDigestSha256:undefined,fetchImpl})),/ARGUMENT_INVALID/);
  assert.equal((await collect(config(root,r,{day:"2026-01-01",fetchImpl}))).reason,"REQUESTED_UTC_DAY_NOT_CLOSED");
  assert.equal(calls,0);
});

test("twenty actual collector-to-archive fixture paths persist partial minutes and resume without refetch",async t=>{
  const root=await rootFor(t),r=roster("CRYPTO_SPOT",Array.from({length:25},(_,i)=>"C"+String(i).padStart(3,"0")));
  const p=provider();
  const x=await collect(config(root,r,{allowPublicReadOnlyFetch:true,fetchImpl:p.fetchImpl}));
  assert.equal(x.status,"CURRENT_SOURCE_PAGE_CAPTURED_ONLY");assert.equal(x.nextOffset,20);
  assert.equal(x.currentPageRetainedSymbolCount,20);assert.equal(x.sourceMinuteCount,40);
  assert.equal(x.missingUnverifiedMinuteSlots,20*1438);assert.equal(x.providerReadOnlyGETs,20);
  assert.ok(x.rows.every(row=>row.reason==="MISSING_MINUTE_SLOTS_NOT_PROVEN_NO_TRADES"));
  assert.ok(p.requests.every(x=>x.options.method==="GET"&&x.options.redirect==="error"));
  assert.ok(p.requests.slice(1).every((r,i)=>r.startedAt-p.requests[i].startedAt>=190),
    "shared Upbit pacing must also cover consecutive one-page symbols");
  assert.deepEqual(x.partialSourceOffsets,Array.from({length:20},(_,i)=>i));
  const again=await collect(config(root,r,{allowPublicReadOnlyFetch:true,fetchImpl:async()=>{throw Error("must reuse");}}));
  assert.equal(again.providerReadOnlyGETs,0);assert.equal(again.sourceMinuteCount,40);
  assert.deepEqual(again.rows.map(r=>r.archiveSourceDigestSha256),x.rows.map(r=>r.archiveSourceDigestSha256));
  assert.ok(again.rows.every(r=>r.status==="ALREADY_RETAINED_SOURCE_ONLY"));
  assert.ok(!(await readdir(root)).includes(".pit-native-minute-task.lock"));
});

test("full native 1440-row day is retained and reuses causal 3m/5m/15m/1h converter without historical publication credit",async t=>{
  const root=await rootFor(t),r=roster("CRYPTO_SPOT",["BTC"]),p=provider({full:true});
  const x=await collect(config(root,r,{allowPublicReadOnlyFetch:true,fetchImpl:p.fetchImpl}));
  assert.equal(x.sourceMinuteCount,1440);assert.equal(x.missingUnverifiedMinuteSlots,0);assert.equal(x.nextOffset,null);
  const audit=await inspectArchivedResearchMinuteSessionV1({root,market:r.market,symbol:"KRW-BTC",sessionStartMs:start});
  assert.equal(audit.originalRowsUnavailableBySessionEnd,1440);
  const derived=await deriveArchivedResearchTimeframesV1({root,market:r.market,symbol:"KRW-BTC",sessionStartMs:start,
    asOfMs:now,timeframes:["3m","5m","15m","1h"]});
  assert.equal(derived.sourceMinuteIntegrityVerified,true);
  assert.equal(derived.profitabilityProven,false);
  for(const [tf,n] of Object.entries({"3m":480,"5m":288,"15m":96,"1h":24}))
    assert.equal(derived.intervalData[tf].bars.length,n);
});

test("Bitget Han contract identifiers survive collector, hashed archive and readback",async t=>{
  const root=await rootFor(t),r=roster("CRYPTO_FUTURES",["龙虾"]),p=provider();
  const x=await collect(config(root,r,{allowPublicReadOnlyFetch:true,fetchImpl:p.fetchImpl}));
  assert.equal(x.currentPageRetainedSymbolCount,1);assert.equal(x.rows[0].symbol,"龙虾USDT");
  assert.equal(p.requests[0].url.searchParams.get("symbol"),"龙虾USDT");
  assert.equal((await inspectArchivedResearchMinuteSessionV1({root,market:r.market,symbol:"龙虾USDT",sessionStartMs:start})).sourceMinuteRows,2);
});

test("HTTP429 interrupts the page, retains failing cursor and leaves unvisited symbols unknown",async t=>{
  const root=await rootFor(t),p=provider({status:429});
  const x=await collect(config(root,roster(),{allowPublicReadOnlyFetch:true,fetchImpl:p.fetchImpl}));
  assert.equal(x.status,"CURRENT_SOURCE_PAGE_INTERRUPTED");assert.equal(x.nextOffset,0);
  assert.equal(x.providerReadOnlyGETs,1);assert.equal(x.unvisitedSelectedSymbolCount,2);
  assert.equal(x.rows[0].sourceMinuteCount,null);assert.equal(x.rows[0].reason,"PUBLIC_SOURCE_RATE_LIMITED");
});

test("known invalid source OHLC is recorded per symbol, unknown implementation failures propagate and unlock",async t=>{
  const root=await rootFor(t),p=provider({errorSymbol:"KRW-AAA"});
  const x=await collect(config(root,roster(),{allowPublicReadOnlyFetch:true,fetchImpl:p.fetchImpl}));
  assert.equal(x.rows[0].reason,"UPBIT_HISTORY_INVALID_OHLCV");assert.equal(x.rows[0].sourceMinuteCount,null);
  assert.equal(x.currentPageBlockedSymbolCount,1);assert.equal(x.currentPageRetainedSymbolCount,2);
  assert.deepEqual(x.blockedSourceOffsets,[0]);
  await assert.rejects(collect(config(root,roster(),{limit:1,allowPublicReadOnlyFetch:true,
    fetchImpl:async()=>{throw new ReferenceError("implementation defect");}})),/implementation defect/);
  await assert.rejects(collect(config(root,roster(),{limit:1,allowPublicReadOnlyFetch:true,
    fetchImpl:async()=>{throw new TypeError("UPBIT_HISTORY_UNEXPECTED_BUG");}})),/UPBIT_HISTORY_UNEXPECTED_BUG/);
  assert.ok(!(await readdir(root)).includes(".pit-native-minute-task.lock"));
});

test("shared archive lock and disk reserve block public downloads",async t=>{
  const root=await rootFor(t),r=roster();let calls=0;
  const fetchImpl=async()=>{calls++;throw Error("must not fetch");};
  const lock=join(root,".pit-native-minute-task.lock");await writeFile(lock,"existing writer",{mode:0o600});
  assert.equal((await collect(config(root,r,{allowPublicReadOnlyFetch:true,fetchImpl}))).reason,"ARCHIVE_WRITER_LOCK_HELD");
  await rm(lock);
  assert.equal((await collect(config(root,r,{allowPublicReadOnlyFetch:true,fetchImpl,
    statfsImpl:async()=>({bavail:1,bsize:4096})}))).reason,"ARCHIVE_MINIMUM_FREE_SPACE_NOT_MET");
  assert.equal(calls,0);
});

test("CLI plans from private roster, rejects overwrite and cannot fetch in plan mode",async t=>{
  const root=await rootFor(t),r=roster(),rosterPath=join(root,"roster.json"),outputPath=join(root,"plan.json");
  await writeFile(rosterPath,JSON.stringify(r),{mode:0o600});
  const args=["--market",r.market,"--day",day,"--roster",rosterPath,"--root",join(root,"archive"),
    "--expected-roster-digest",r.rosterDigestSha256,"--output",outputPath];
  assert.throws(()=>parsePublicNativeSourcePageArgsV1([...args,"--read-public"]),/PLAN_CANNOT_FETCH/);
  assert.throws(()=>parsePublicNativeSourcePageArgsV1([...args,"--api-key","hidden"]),/OPTION_INVALID/);
  const c=parsePublicNativeSourcePageArgsV1(args);
  const x=await runPublicNativeSourcePageCliV1(c,{nowImpl:()=>now,
    allowPublicReadOnlyFetch:true,market:"CRYPTO_FUTURES",root:"/not-the-reviewed-root",
    fetchImpl:async()=>{throw Error("dependencies must never enable a plan fetch");}});
  assert.equal(x.status,"PLANNED_CURRENT_SOURCE_PAGE_ONLY");
  assert.equal(JSON.parse(await readFile(outputPath,"utf8")).historicalUniverseComplete,false);
  await assert.rejects(runPublicNativeSourcePageCliV1(c),/OUTPUT_EXISTS/);
});

test("CLI roster mode cannot acquire opt-in from dependency overrides and rejects altered raw envelopes",async t=>{
  const root=await rootFor(t);let calls=0;
  const noRead=parsePublicNativeSourcePageArgsV1(["--mode","roster","--market","CRYPTO_SPOT",
    "--output",join(root,"no-read.json")]);
  const x=await runPublicNativeSourcePageCliV1(noRead,{allowPublicReadOnlyFetch:true,
    nowImpl:()=>now,fetchImpl:async()=>{calls++;throw Error("must not fetch");}});
  assert.equal(x.status,"BLOCKED_DATA");assert.equal(calls,0);
  const r=roster(),rosterPath=join(root,"altered-roster.json");
  await writeFile(rosterPath,JSON.stringify({roster:r,rawResponseText:"[]",
    rawResponseSha256:sha("[]")}),{mode:0o600});
  const c=parsePublicNativeSourcePageArgsV1(["--market",r.market,"--day",day,"--roster",rosterPath,
    "--root",join(root,"archive"),"--expected-roster-digest",r.rosterDigestSha256,
    "--output",join(root,"altered-plan.json")]);
  await assert.rejects(runPublicNativeSourcePageCliV1(c,{nowImpl:()=>now}),/ROSTER_CAPTURE_INVALID/);
});

test("valid current roster identifiers outside collector grammar remain explicit blocked members",async t=>{
  const root=await rootFor(t),r=roster("CRYPTO_FUTURES",["ÉCOIN","BTC"]),p=provider();
  const x=await collect(config(root,r,{allowPublicReadOnlyFetch:true,fetchImpl:p.fetchImpl}));
  assert.equal(x.currentSourceSymbolCount,2);assert.equal(x.currentPageBlockedSymbolCount,1);
  const blocked=x.rows.find(r=>r.symbol==="ÉCOINUSDT");
  assert.equal(blocked.reason,"NATIVE_SOURCE_IDENTIFIER_NOT_YET_SUPPORTED");
  assert.equal(blocked.sourceMinuteCount,null);assert.equal(blocked.providerReadOnlyGETs,0);
  assert.equal(x.currentPageRetainedSymbolCount,1);assert.equal(x.nextOffset,null);
});

test("archives with a different native source or historical availability claim are not silently reused",async t=>{
  const root=await rootFor(t),r=roster("CRYPTO_SPOT",["AAA","BBB"]);
  for(const [i,symbol] of r.symbols.entries()){
    const sourceId=i===0?"UNVERIFIED_OTHER_SOURCE":"UPBIT_PUBLIC_REST_RETROSPECTIVE_1M";
    const minuteBars=[0,1].map(n=>({market:r.market,venue:r.venue,symbol,sourceId,
      timestampMs:start+n*MIN,availableAtMs:i===0?now:start+(n+1)*MIN,
      open:100,high:102,low:99,close:101,volume:12}));
    await persistResearchMinuteSessionV1({root,source:{market:r.market,venue:r.venue,symbol,sourceId,
      session:{startMs:start,endMs:start+DAY,kind:"UTC_24H",timeZone:"UTC",
        calendarSourceId:"RETROSPECTIVE_UTC_DAY_NOT_INDEPENDENT_PIT_PROOF"},
      minuteBars,sourceMinuteRowsSha256:sha(JSON.stringify(minuteBars)),asOfMs:now}});
  }
  const x=await collect(config(root,r,{allowPublicReadOnlyFetch:true,
    fetchImpl:async()=>{throw Error("must review existing source before fetch");}}));
  assert.equal(x.currentPageRetainedSymbolCount,0);assert.equal(x.providerReadOnlyGETs,0);
  assert.ok(x.rows.every(r=>r.reason==="EXISTING_ARCHIVE_NATIVE_SOURCE_SCOPE_UNVERIFIED"));
  assert.equal(x.sourceMinuteCount,null);
});

test("short listing-edge source retains a single real minute without claiming a traversed day",async t=>{
  for(const market of ["CRYPTO_SPOT","CRYPTO_FUTURES"]){
    const root=await rootFor(t),r=roster(market,["BTC"]);let calls=0;
    const fetchImpl=async()=>{
      calls++;
      const payload=market==="CRYPTO_SPOT"?(calls===1?[upbitRow("KRW-BTC",start+13*60*MIN)]:[])
        :{code:"00000",data:calls===1
          ?[[start+13*60*MIN,"100","102","99","101","12","1200"]]:[]};
      return new Response(JSON.stringify(payload),{headers:{"content-type":"application/json"}});
    };
    const x=await collect(config(root,r,{allowPublicReadOnlyFetch:true,fetchImpl}));
    assert.equal(x.sourceMinuteCount,1);assert.equal(x.missingUnverifiedMinuteSlots,1439);
    assert.equal(x.rows[0].providerRequestWindowVerified,false);
    assert.deepEqual(x.partialSourceOffsets,[0]);assert.equal(x.historicalUniverseComplete,false);
    assert.equal(x.cohortVisitComplete,true);assert.equal(x.sourceArchiveCompletenessProven,false);
  }
});

test("malformed giant, non-JSON and redirected candle responses stop before archive writes",async t=>{
  const cases=[
    [()=>new Response("{}",{headers:{"content-type":"application/json","content-length":"3000000"}}),
      "PUBLIC_SOURCE_RESPONSE_TOO_LARGE"],
    [()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(2*1024**2+1));c.close();}}),
      {headers:{"content-type":"application/json"}}),"PUBLIC_SOURCE_RESPONSE_TOO_LARGE"],
    [()=>new Response("<html>unrelated service</html>",{headers:{"content-type":"text/html"}}),
      "PUBLIC_SOURCE_RESPONSE_NOT_JSON"],
    [()=>{const response=new Response("[]",{headers:{"content-type":"application/json"}});
      Object.defineProperty(response,"redirected",{value:true});return response;},
      "PUBLIC_SOURCE_RESPONSE_ORIGIN_UNVERIFIED"],
  ];
  for(const [make,reason] of cases){
    const root=await rootFor(t),r=roster();
    const x=await collect(config(root,r,{allowPublicReadOnlyFetch:true,fetchImpl:async()=>make()}));
    assert.equal(x.status,"CURRENT_SOURCE_PAGE_INTERRUPTED");assert.equal(x.rows[0].reason,reason);
    assert.equal(x.nextOffset,0);assert.equal(x.sourceMinuteCount,null);assert.equal(x.providerReadOnlyGETs,1);
    assert.deepEqual(await readdir(root),[]);
  }
});
