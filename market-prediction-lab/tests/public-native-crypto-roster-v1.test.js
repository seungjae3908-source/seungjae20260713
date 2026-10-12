import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {normalizePublicNativeCryptoRosterV1 as normalize,
  validatePublicNativeCryptoRosterV1 as validate,
  validatePublicNativeCryptoRosterCaptureV1 as validateCapture,
  fetchPublicNativeCryptoRosterV1 as fetchRoster}
  from "../src/public-native-crypto-roster-v1.js";

const T=Date.UTC(2026,9,11,8,25),HASH="a".repeat(64);
const SPOT="CRYPTO_SPOT",FUTURES="CRYPTO_FUTURES";
const hash=x=>createHash("sha256").update(x).digest("hex");
const spot=(market,warning=false)=>({market,market_event:{warning,
  caution:{PRICE_FLUCTUATIONS:false}}});
const future=(baseCoin,extra={})=>({symbol:baseCoin+"USDT",baseCoin,
  quoteCoin:"USDT",symbolStatus:"normal",symbolType:"perpetual",isRwa:"NO",...extra});
const norm=(market,rows)=>normalize({market,observedAtMs:T,rawResponseSha256:HASH,
  payload:market===SPOT?rows:{code:"00000",data:rows}});
const response=payload=>new Response(JSON.stringify(payload),{
  status:200,headers:{"content-type":"application/json"}});
const clone=x=>JSON.parse(JSON.stringify(x));

test("Upbit warning/caution pairs remain included and current roster never attests PIT",()=>{
  const rows=[spot("BTC-BTC"),...Array.from({length:7},(_,i)=>spot("KRW-C"+i,true)),
    {market:"KRW-BTC"},spot("USDT-BTC")];
  const r=norm(SPOT,rows);
  assert.equal(r.symbols.length,8);
  assert.equal(r.counts.sourceRowCount,10);
  assert.equal(r.counts.otherMarketExcludedCount,2);
  assert.equal(r.counts.warningSymbolCount,7);
  assert.deepEqual(r.warningUnknownSymbols,["KRW-BTC"]);
  assert.equal(r.historicalUniverseComplete,false);
  assert.equal(r.historicalDataAvailabilityVerified,false);
  assert.equal(r.historicalScannerAvailabilityVerified,false);
  assert.equal(r.commercialRedistributionPermissionVerified,false);
  assert.equal(r.profitabilityProven,false);
  assert.equal(r.trueMarketWideRecall,null);
  assert.equal(r.executionAuthority,"NONE");
  assert.equal(validate(r,r.rosterDigestSha256).ok,true);
  assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.symbols)&&Object.isFrozen(r.counts));
  assert.ok(Object.isFrozen(r.excluded[0]));
  rows[1].market="KRW-CHANGED";
  assert.equal(r.symbols.includes("KRW-CHANGED"),false);
});

test("Bitget excludes RWA, unknown classifications, other quotes and nontrading contracts",()=>{
  const r=norm(FUTURES,[future("BTC"),future("龙虾"),future("牛来"),future("哈基米"),
    ...Array.from({length:7},(_,i)=>future("STOCK"+i,{isRwa:"YES"})),
    future("NEW",{isRwa:undefined}),future("LATER",{isRwa:"UNKNOWN"}),
    future("ETH",{symbol:"ETHUSDC",quoteCoin:"USDC"}),
    future("HALT",{symbolStatus:"off",launchTime:"123",offTime:"456"}),
    future("DELIVERY",{symbolType:"delivery"})]);
  assert.deepEqual(r.symbols,["BTCUSDT","哈基米USDT","牛来USDT","龙虾USDT"]);
  assert.equal(r.counts.sourceRowCount,16);
  assert.equal(r.counts.rwaExcludedCount,7);
  assert.equal(r.counts.classificationUnverifiedCount,2);
  assert.equal(r.counts.otherMarketExcludedCount,1);
  assert.equal(r.counts.nonTradingExcludedCount,1);
  assert.equal(r.counts.nonPerpetualExcludedCount,1);
  assert.equal(validate(r,r.rosterDigestSha256).ok,true);
  assert.equal("launchTime" in r,false);
});

test("duplicate IDs block before filtering even when both rows would be excluded",()=>{
  for(const [market,rows] of [[SPOT,[spot("BTC-BTC"),spot("BTC-BTC")]],
    [FUTURES,[future("STOCK",{isRwa:"YES"}),future("STOCK",{isRwa:"YES"})]]])
    assert.throws(()=>norm(market,rows),/DUPLICATE_SYMBOL/);
});

test("malformed IDs, currency identities, statuses and warning fields fail closed",()=>{
  for(const row of [{market:"KRW-BTC/../keys"},{market:"krw-btc"},
    {market:"EUR-BTC"},{market:"KRW-BTC",market_event:{warning:"false"}},
    {market:"KRW-BTC",market_warning:"NONE",market_event:{warning:true}},
    {market:"KRW-BTC",market_event:{caution:{PRICE_FLUCTUATIONS:1}}}])
    assert.throws(()=>norm(SPOT,[row]),/ROSTER_(SYMBOL|WARNING)_INVALID/);
  for(const row of [future("BTC",{quoteCoin:"USD"}),
    future("BTC",{symbolStatus:"unknown"}),future("BTC",{symbolType:"option"}),
    future("BTC",{symbol:"BTCUSDT?secret=x"})])
    assert.throws(()=>norm(FUTURES,[row]),/ROSTER_(CONTRACT|SYMBOL)/);
  assert.throws(()=>normalize({market:FUTURES,payload:{code:"40000",data:[]},
    observedAtMs:T,rawResponseSha256:HASH}),/PROVIDER_CODE_INVALID/);
  assert.throws(()=>norm(SPOT,[]),/ROW_COUNT_INVALID/);
  assert.throws(()=>norm(SPOT,Array.from({length:20_001},(_,i)=>spot("KRW-C"+i))),/ROW_COUNT_INVALID/);
});

test("stored digest detects changed members and safety assertions after JSON transport",()=>{
  const r=norm(SPOT,[spot("KRW-BTC"),spot("KRW-ETH")]),digest=r.rosterDigestSha256;
  assert.equal(validate(clone(r),digest).ok,true);
  const reordered=Object.fromEntries(Object.entries(clone(r)).reverse());
  assert.equal(validate(reordered,digest).ok,true);
  for(const change of [x=>{x.symbols[0]="KRW-ADA";},x=>{x.counts.sourceRowCount=999;},
    x=>{x.historicalUniverseComplete=true;},x=>{x.executionAuthority="LIVE";},
    x=>{x.venue="BINANCE";},x=>{x.sourceUrl="https://api.upbit.com/v1/accounts";},
    x=>{x.profitabilityProven=true;},x=>{x.unexpectedProof=true;}]){
    const altered=clone(r);change(altered);assert.equal(validate(altered,digest).ok,false);
  }
  assert.equal(validate(r,"b".repeat(64)).ok,false);
  assert.equal(validate(null,digest).ok,false);
});

test("default mode performs no HTTP and no private information is returned",async()=>{
  let calls=0;
  const r=await fetchRoster({market:SPOT,fetchImpl:async()=>{calls++;throw Error("never");}});
  assert.equal(calls,0);assert.equal(r.status,"BLOCKED_DATA");
  assert.match(r.reason,/FETCH_NOT_EXPLICITLY_ENABLED/);
  assert.equal(r.roster,null);assert.equal(r.rawResponseText,null);
  assert.equal(r.requestStartedAtMs,null);
});

test("public fetch pins GET URL and prevents cookies/redirects; hashes exact raw bytes",async()=>{
  for(const market of [SPOT,FUTURES]){
    const payload=market===SPOT?[spot("KRW-BTC")]:{code:"00000",data:[future("牛来")]};
    const text=JSON.stringify(payload);let n=0,calls=0;
    const r=await fetchRoster({market,allowPublicReadOnlyFetch:true,nowImpl:()=>T+n++,
      fetchImpl:async(url,options)=>{
        calls++;assert.equal(options.method,"GET");assert.equal(options.redirect,"error");
        assert.equal(options.credentials,"omit");assert.deepEqual(options.headers,{Accept:"application/json"});
        assert.ok(options.signal instanceof AbortSignal);
        assert.equal(url,market===SPOT?"https://api.upbit.com/v1/market/all?is_details=true":
          "https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES");
        return response(payload);
      }});
    assert.equal(calls,1);assert.equal(r.status,"CURRENT_SOURCE_ROSTER_CAPTURED_ONLY");
    assert.equal(r.rawResponseText,text);assert.equal(r.rawResponseSha256,hash(text));
    assert.equal(r.requestStartedAtMs,T);assert.equal(r.responseReceivedAtMs,T+1);
    assert.equal(r.roster.observedAtMs,T+1);
    assert.equal(validate(r.roster,r.roster.rosterDigestSha256).ok,true);
    assert.equal(validateCapture(clone(r),r.roster.rosterDigestSha256).ok,true);
    assert.equal("payload" in r.roster,false);
  }
});

test("retained capture detects raw warning tampering even with valid normalized digest",async()=>{
  const captured=await fetchRoster({market:SPOT,allowPublicReadOnlyFetch:true,
    nowImpl:()=>T,fetchImpl:async()=>response([spot("KRW-BTC",true)])});
  const changed=clone(captured),payload=JSON.parse(changed.rawResponseText);
  payload[0].market_event.warning=false;
  changed.rawResponseText=JSON.stringify(payload);
  assert.equal(validate(changed.roster,changed.roster.rosterDigestSha256).ok,true);
  assert.match(validateCapture(changed,changed.roster.rosterDigestSha256).reason,/RAW_DIGEST_MISMATCH/);

  // Updating both byte hashes and the self-computable roster digest still
  // cannot bind the old warning set to different raw warning data.
  changed.rawResponseSha256=hash(changed.rawResponseText);
  changed.roster.rawResponseSha256=changed.rawResponseSha256;
  const {rosterDigestSha256:previousDigest,...contents}=changed.roster;
  changed.roster.rosterDigestSha256=hash(JSON.stringify(contents));
  assert.equal(validate(changed.roster,changed.roster.rosterDigestSha256).ok,true);
  assert.match(validateCapture(changed,changed.roster.rosterDigestSha256).reason,/NORMALIZATION_MISMATCH/);
  assert.equal(validateCapture(captured,previousDigest).ok,true);
});

test("retained capture binds Bitget crypto classification and native Unicode symbols to raw bytes",async()=>{
  const captured=await fetchRoster({market:FUTURES,allowPublicReadOnlyFetch:true,
    nowImpl:()=>T,fetchImpl:async()=>response({code:"00000",data:[future("龙虾"),
      future("STOCK",{isRwa:"YES"})]})});
  assert.equal(validateCapture(captured,captured.roster.rosterDigestSha256).ok,true);
  const changed=clone(captured),payload=JSON.parse(changed.rawResponseText);
  payload.data[1].isRwa="NO";
  changed.rawResponseText=JSON.stringify(payload);
  changed.rawResponseSha256=hash(changed.rawResponseText);
  changed.roster.rawResponseSha256=changed.rawResponseSha256;
  const {rosterDigestSha256,...contents}=changed.roster;
  changed.roster.rosterDigestSha256=hash(JSON.stringify(contents));
  assert.equal(validate(changed.roster,changed.roster.rosterDigestSha256).ok,true);
  assert.match(validateCapture(changed,changed.roster.rosterDigestSha256).reason,/NORMALIZATION_MISMATCH/);
  assert.equal(validateCapture(captured,"b".repeat(64)).ok,false);
  assert.equal(validateCapture(captured,rosterDigestSha256).ok,true);
});

test("retained capture rejects missing or invalid evidence and oversized raw data without throwing",async()=>{
  const captured=await fetchRoster({market:SPOT,allowPublicReadOnlyFetch:true,
    nowImpl:()=>T,fetchImpl:async()=>response([spot("KRW-BTC")])});
  for(const mutate of [e=>{e.status="BLOCKED_DATA";},e=>{e.httpStatus=301;},
    e=>{e.responseReceivedAtMs=T-1;},e=>{e.requestStartedAtMs=null;},
    e=>{e.responseReceivedAtMs=T+1;},e=>{delete e.rawResponseText;},
    e=>{e.rawResponseSha256="b".repeat(64);},e=>{e.rawResponseText=null;},
    e=>{e.rawResponseText="x".repeat(2*1024*1024+1);},
    e=>{e.rawResponseText="牛".repeat(1024*1024);},
    e=>{e.independentlyAuthenticatedHistoricalSource=true;}]){
    const changed=clone(captured);mutate(changed);
    assert.equal(validateCapture(changed,changed.roster.rosterDigestSha256).ok,false);
  }
  const malformed=clone(captured);
  malformed.rawResponseText="{bad";
  malformed.rawResponseSha256=hash(malformed.rawResponseText);
  malformed.roster.rawResponseSha256=malformed.rawResponseSha256;
  const {rosterDigestSha256,...contents}=malformed.roster;
  malformed.roster.rosterDigestSha256=hash(JSON.stringify(contents));
  assert.match(validateCapture(malformed,malformed.roster.rosterDigestSha256).reason,/RAW_PAYLOAD_INVALID/);
  for(const input of [null,{},captured.roster])assert.equal(validateCapture(input).ok,false);
  assert.equal(validate(captured.roster,rosterDigestSha256).ok,true);
  assert.ok(Object.isFrozen(validateCapture(captured)));
});

test("redirects, oversized bodies and invalid JSON are blocked without partial rosters",async()=>{
  const redirects=response([spot("KRW-BTC")]);Object.defineProperty(redirects,"redirected",{value:true});
  const moved=response([spot("KRW-BTC")]);Object.defineProperty(moved,"url",{value:"https://private.invalid/"});
  const oversized=new Response("x",{headers:{"content-type":"application/json","content-length":String(2*1024*1024+1)}});
  let cancelled=false;
  const streamed=new Response(new ReadableStream({
    start(c){c.enqueue(new Uint8Array(2*1024*1024));c.enqueue(new Uint8Array(1));},
    cancel(){cancelled=true;},
  }),{headers:{"content-type":"application/json"}});
  for(const [res,reason] of [[redirects,"REDIRECT_BLOCKED"],[moved,"REDIRECT_BLOCKED"],
    [oversized,"RESPONSE_TOO_LARGE"],[streamed,"RESPONSE_TOO_LARGE"],
    [new Response("private key does not belong here",{headers:{"content-type":"text/html"}}),"CONTENT_TYPE_INVALID"],
    [new Response("{bad",{headers:{"content-type":"application/json"}}),"BODY_JSON_INVALID"],
    [new Response("no",{status:429}),"HTTP_UNAVAILABLE"]]){
    const r=await fetchRoster({market:SPOT,allowPublicReadOnlyFetch:true,
      nowImpl:()=>T,fetchImpl:async()=>res});
    assert.equal(r.status,"BLOCKED_DATA");assert.equal(r.reason,"PUBLIC_NATIVE_CRYPTO_ROSTER_"+reason);
    assert.equal(r.roster,null);assert.equal(r.rawResponseText,null);
    assert.equal(JSON.stringify(r).includes("private key"),false);
  }
  assert.equal(cancelled,true);
});

test("network errors are sanitized instead of including request or secret text",async()=>{
  const r=await fetchRoster({market:FUTURES,allowPublicReadOnlyFetch:true,nowImpl:()=>T,
    fetchImpl:async()=>{throw Error("Authorization Bearer private-secret-value");}});
  assert.equal(r.reason,"PUBLIC_NATIVE_CRYPTO_ROSTER_NETWORK_OR_RESPONSE_ERROR");
  assert.equal(JSON.stringify(r).includes("private-secret-value"),false);
});

test("12 second deadline aborts a fetch that never returns",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  let signal;
  const pending=fetchRoster({market:SPOT,allowPublicReadOnlyFetch:true,nowImpl:()=>T,
    fetchImpl:async(_url,options)=>{signal=options.signal;return new Promise(()=>{});}});
  t.mock.timers.tick(12_000);
  const result=await pending;
  assert.equal(signal.aborted,true);
  assert.equal(result.status,"BLOCKED_DATA");
  assert.equal(result.reason,"PUBLIC_NATIVE_CRYPTO_ROSTER_TIMEOUT");
  assert.equal(result.roster,null);
  assert.equal(result.rawResponseText,null);
});
