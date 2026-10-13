import {createHash} from "node:crypto";

// A current public roster can select a source-limited collection cohort. It
// cannot attest historical listings, delistings, candle availability or rights.
const SCHEMA="public-native-crypto-roster-v1";
const STATUS="OBSERVED_CURRENT_SOURCE_ROSTER_ONLY";
const MAX_ROWS=20_000,MAX_BYTES=2*1024*1024,TIMEOUT_MS=12_000;
const SHA=/^[a-f0-9]{64}$/;
const SOURCES=Object.freeze({
  CRYPTO_SPOT:Object.freeze({venue:"UPBIT_KRW",
    url:"https://api.upbit.com/v1/market/all?is_details=true"}),
  CRYPTO_FUTURES:Object.freeze({venue:"BITGET_USDT_FUTURES",
    url:"https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES"}),
});
const SAFETY=Object.freeze({
  sourceLimited:true,currentSnapshot:true,
  historicalUniverseComplete:false,fullMarketPITUniverseVerified:false,
  historicalDataAvailabilityVerified:false,
  independentlyAuthenticatedHistoricalSource:false,
  commercialRedistributionPermissionVerified:false,
  historicalScannerAvailabilityVerified:false,
  trueMarketWideRecall:null,profitabilityProven:false,paperAdmissionAllowed:false,
  executionAuthority:"NONE",liveTrading:false,autoTrading:false,
  privateApiCalls:false,realOrders:false,
  digestPurpose:"CONTENT_INTEGRITY_ONLY_NOT_SOURCE_AUTHENTICATION",
});
const REASONS=Object.freeze({
  CRYPTO_SPOT:["OTHER_QUOTE_CURRENCY"],
  CRYPTO_FUTURES:["OTHER_QUOTE_CURRENCY","RWA_NOT_CRYPTO",
    "RWA_CLASSIFICATION_UNVERIFIED","CONTRACT_NOT_NORMAL","NON_PERPETUAL_CONTRACT"],
});
const ERRORS=new Set([
  "MARKET_INVALID","INPUT_INVALID","PAYLOAD_INVALID","ROW_COUNT_INVALID",
  "ROW_INVALID","SYMBOL_INVALID","DUPLICATE_SYMBOL","WARNING_INVALID",
  "CONTRACT_CURRENCY_INVALID","CONTRACT_STATUS_INVALID","CONTRACT_TYPE_INVALID",
  "PROVIDER_CODE_INVALID","CLOCK_INVALID","REDIRECT_BLOCKED","HTTP_UNAVAILABLE",
  "CONTENT_TYPE_INVALID","CONTENT_LENGTH_INVALID","RESPONSE_TOO_LARGE",
  "BODY_STREAM_REQUIRED","BODY_INVALID","BODY_JSON_INVALID",
]);
const prefix="PUBLIC_NATIVE_CRYPTO_ROSTER_";
const fail=code=>{throw new TypeError(prefix+code);};
const plain=x=>!!x&&typeof x==="object"&&!Array.isArray(x)
  &&[Object.prototype,null].includes(Object.getPrototypeOf(x));
const time=x=>Number.isSafeInteger(x)&&x>0&&x<=8_640_000_000_000_000;
const cmp=(a,b)=>a<b?-1:a>b?1:0;
const hash=x=>createHash("sha256").update(x).digest("hex");
const source=market=>Object.hasOwn(SOURCES,market)?SOURCES[market]:fail("MARKET_INVALID");
function freeze(x){
  if(x&&typeof x==="object"){
    for(const item of Object.values(x))freeze(item);
    Object.freeze(x);
  }
  return x;
}
// Native Bitget symbols include Han token names. Preserve exact identifiers;
// permit letters/numbers only, never whitespace, URL separators or controls.
const nativeCode=(x,max=48)=>typeof x==="string"&&x.length>=1&&x.length<=max
  &&x===x.normalize("NFC")&&/^[\p{L}\p{N}]+$/u.test(x)&&!/[a-z]/.test(x);
const upbitCode=x=>typeof x==="string"&&/^(KRW|BTC|USDT)-[A-Z0-9]{1,32}$/.test(x);
const futureCode=x=>typeof x==="string"&&x.length<=64
  &&x===x.normalize("NFC")&&/^[\p{L}\p{N}]+(?:_[A-Z0-9]+)?$/u.test(x)
  &&!/[a-z]/.test(x);
const eligibleCode=(market,x)=>market==="CRYPTO_SPOT"
  ?upbitCode(x)&&x.startsWith("KRW-")
  :nativeCode(x,64)&&x.endsWith("USDT")&&x.length>4;

function warningOf(row){
  let old=null,event=null;
  if(Object.hasOwn(row,"market_warning")){
    if(!["NONE","CAUTION"].includes(row.market_warning))fail("WARNING_INVALID");
    old=row.market_warning==="CAUTION";
  }
  if(Object.hasOwn(row,"market_event")){
    const value=row.market_event;
    if(!plain(value))fail("WARNING_INVALID");
    if(Object.hasOwn(value,"warning")){
      if(typeof value.warning!=="boolean")fail("WARNING_INVALID");
      event=value.warning;
    }
    if(Object.hasOwn(value,"caution")){
      if(!plain(value.caution)||Object.keys(value.caution).length>32
        ||Object.entries(value.caution).some(([k,v])=>
          !/^[A-Z][A-Z0-9_]{0,63}$/.test(k)||typeof v!=="boolean"))
        fail("WARNING_INVALID");
    }
  }
  if(old!==null&&event!==null&&old!==event)fail("WARNING_INVALID");
  return event??old;
}
function countsFor(symbols,excluded,warningSymbols,warningUnknownSymbols){
  const n=reason=>excluded.filter(x=>x.reason===reason).length;
  return {sourceRowCount:symbols.length+excluded.length,
    currentIncludedCount:symbols.length,excludedCount:excluded.length,
    rwaExcludedCount:n("RWA_NOT_CRYPTO"),
    otherMarketExcludedCount:n("OTHER_QUOTE_CURRENCY"),
    classificationUnverifiedCount:n("RWA_CLASSIFICATION_UNVERIFIED"),
    nonTradingExcludedCount:n("CONTRACT_NOT_NORMAL"),
    nonPerpetualExcludedCount:n("NON_PERPETUAL_CONTRACT"),
    warningSymbolCount:warningSymbols.length,
    warningUnknownSymbolCount:warningUnknownSymbols.length};
}
function canonical({market,observedAtMs,rawResponseSha256,symbols,excluded,
  warningSymbols,warningUnknownSymbols}){
  const s=source(market);
  return {schemaVersion:SCHEMA,status:STATUS,market,venue:s.venue,
    observedAtMs,sourceUrl:s.url,rawResponseSha256,symbols,excluded,
    warningSymbols,warningUnknownSymbols,
    counts:countsFor(symbols,excluded,warningSymbols,warningUnknownSymbols),...SAFETY};
}

export function normalizePublicNativeCryptoRosterV1({market,payload,
  observedAtMs,rawResponseSha256}={}){
  source(market);
  if(!time(observedAtMs)||typeof rawResponseSha256!=="string"
    ||!SHA.test(rawResponseSha256))fail("INPUT_INVALID");
  let rows;
  if(market==="CRYPTO_SPOT")rows=payload;
  else{
    if(!plain(payload))fail("PAYLOAD_INVALID");
    if(payload.code!=="00000")fail("PROVIDER_CODE_INVALID");
    rows=payload.data;
  }
  if(!Array.isArray(rows)||rows.length<1||rows.length>MAX_ROWS)fail("ROW_COUNT_INVALID");
  const symbols=[],excluded=[],warningSymbols=[],warningUnknownSymbols=[],seen=new Set();
  for(const row of rows){
    if(!plain(row))fail("ROW_INVALID");
    const symbol=market==="CRYPTO_SPOT"?row.market:row.symbol;
    if(!(market==="CRYPTO_SPOT"?upbitCode(symbol):futureCode(symbol)))fail("SYMBOL_INVALID");
    // Check every provider row before filtering, including duplicate excluded
    // RWA, non-KRW or halted instruments. Never silently discard duplicates.
    if(seen.has(symbol))fail("DUPLICATE_SYMBOL");
    seen.add(symbol);
    let reason=null;
    if(market==="CRYPTO_SPOT"){
      const warning=warningOf(row);
      if(!symbol.startsWith("KRW-"))reason="OTHER_QUOTE_CURRENCY";
      else if(warning===true)warningSymbols.push(symbol);
      else if(warning===null)warningUnknownSymbols.push(symbol);
    }else{
      if(!nativeCode(row.baseCoin)||!nativeCode(row.quoteCoin,12))fail("CONTRACT_CURRENCY_INVALID");
      if(!["normal","listed","maintain","limit_open","restrictedAPI","off"].includes(row.symbolStatus))
        fail("CONTRACT_STATUS_INVALID");
      if(!["perpetual","delivery"].includes(row.symbolType))fail("CONTRACT_TYPE_INVALID");
      if(row.symbolType==="perpetual"&&symbol!==row.baseCoin+row.quoteCoin)
        fail("CONTRACT_CURRENCY_INVALID");
      // Classification exclusions have precedence, so the reported RWA count
      // includes every explicitly classified RWA row, even when also halted.
      if(row.isRwa==="YES")reason="RWA_NOT_CRYPTO";
      else if(row.isRwa!=="NO")reason="RWA_CLASSIFICATION_UNVERIFIED";
      else if(row.quoteCoin!=="USDT")reason="OTHER_QUOTE_CURRENCY";
      else if(row.symbolStatus!=="normal")reason="CONTRACT_NOT_NORMAL";
      else if(row.symbolType!=="perpetual")reason="NON_PERPETUAL_CONTRACT";
    }
    if(reason)excluded.push({symbol,reason});
    else symbols.push(symbol);
  }
  symbols.sort(cmp);excluded.sort((a,b)=>cmp(a.symbol,b.symbol));
  warningSymbols.sort(cmp);warningUnknownSymbols.sort(cmp);
  const roster=canonical({market,observedAtMs,rawResponseSha256,symbols,
    excluded,warningSymbols,warningUnknownSymbols});
  return freeze({...roster,rosterDigestSha256:hash(JSON.stringify(roster))});
}

const exactKeys=(obj,expected)=>plain(obj)&&Object.keys(obj).length===expected.length
  &&expected.every(k=>Object.hasOwn(obj,k));
const sortedUnique=(list,check)=>Array.isArray(list)&&list.length<=MAX_ROWS
  &&list.every((x,i)=>check(x)&&(i===0||cmp(list[i-1],x)<0));
/** Rechecks immutable snapshot contents after JSON/file transport. A digest is
 * self-computable integrity evidence, never exchange-origin authentication. */
export function validatePublicNativeCryptoRosterV1(roster,expectedDigest){
  const bad=reason=>freeze({ok:false,reason:prefix+reason,rosterDigestSha256:null});
  try{
    if(!plain(roster)||!Object.hasOwn(SOURCES,roster.market))return bad("INVALID");
    const {market,symbols,excluded,warningSymbols,warningUnknownSymbols}=roster;
    if(!time(roster.observedAtMs)||typeof roster.rawResponseSha256!=="string"
      ||typeof roster.rosterDigestSha256!=="string"||!SHA.test(roster.rawResponseSha256)
      ||!SHA.test(roster.rosterDigestSha256))return bad("INVALID");
    if(!sortedUnique(symbols,x=>eligibleCode(market,x))
      ||!Array.isArray(excluded)||excluded.length>MAX_ROWS)return bad("INVALID");
    const all=new Set(symbols);
    for(const [i,row] of excluded.entries()){
      if(!exactKeys(row,["symbol","reason"])
        ||!(market==="CRYPTO_SPOT"?upbitCode(row.symbol):futureCode(row.symbol))
        ||!REASONS[market].includes(row.reason)||all.has(row.symbol)
        ||(i>0&&cmp(excluded[i-1].symbol,row.symbol)>=0))return bad("INVALID");
      if(market==="CRYPTO_SPOT"&&row.symbol.startsWith("KRW-"))return bad("INVALID");
      all.add(row.symbol);
    }
    if(all.size<1||all.size>MAX_ROWS)return bad("INVALID");
    const included=new Set(symbols);
    if(!sortedUnique(warningSymbols,x=>included.has(x))
      ||!sortedUnique(warningUnknownSymbols,x=>included.has(x))
      ||(market==="CRYPTO_FUTURES"&&(warningSymbols.length||warningUnknownSymbols.length)))
      return bad("INVALID");
    const unknownWarnings=new Set(warningUnknownSymbols);
    if(warningSymbols.some(x=>unknownWarnings.has(x)))return bad("INVALID");
    const rebuilt=canonical(roster);
    if(!exactKeys(roster,[...Object.keys(rebuilt),"rosterDigestSha256"]))return bad("INVALID");
    for(const [key,value] of Object.entries(rebuilt)){
      if(key==="counts"){
        if(!exactKeys(roster.counts,Object.keys(value))
          ||Object.entries(value).some(([k,v])=>roster.counts[k]!==v))return bad("COUNTS_INVALID");
      }else if(!["symbols","excluded","warningSymbols","warningUnknownSymbols"].includes(key)
        &&roster[key]!==value)return bad("TRUTH_BOUNDARY_INVALID");
    }
    const digest=hash(JSON.stringify(rebuilt));
    if(roster.rosterDigestSha256!==digest)return bad("DIGEST_MISMATCH");
    if(expectedDigest!==undefined&&expectedDigest!==null
      &&(typeof expectedDigest!=="string"||!SHA.test(expectedDigest)||digest!==expectedDigest))
      return bad("EXPECTED_DIGEST_MISMATCH");
    return freeze({ok:true,reason:null,rosterDigestSha256:digest});
  }catch{return bad("INVALID");}
}

/** Verify the retained public-response bytes are the input to this snapshot.
 * This binds raw warning/classification fields to normalized membership; it
 * remains content integrity evidence, not independent exchange authentication. */
export function validatePublicNativeCryptoRosterCaptureV1(envelope,expectedDigest){
  const bad=reason=>freeze({ok:false,reason:prefix+"CAPTURE_"+reason,rosterDigestSha256:null});
  try{
    if(!exactKeys(envelope,["status","roster","rawResponseText","rawResponseSha256",
      "requestStartedAtMs","responseReceivedAtMs","httpStatus"])
      ||envelope.status!=="CURRENT_SOURCE_ROSTER_CAPTURED_ONLY"
      ||envelope.httpStatus!==200
      ||!time(envelope.requestStartedAtMs)||!time(envelope.responseReceivedAtMs)
      ||envelope.responseReceivedAtMs<envelope.requestStartedAtMs
      ||envelope.roster?.observedAtMs!==envelope.responseReceivedAtMs)
      return bad("INVALID");
    const checked=validatePublicNativeCryptoRosterV1(envelope.roster,expectedDigest);
    if(!checked.ok)return bad("ROSTER_INVALID");
    const raw=envelope.rawResponseText;
    if(typeof raw!=="string"||raw.length<2||raw.length>MAX_BYTES
      ||Buffer.byteLength(raw,"utf8")>MAX_BYTES)return bad("RAW_RESPONSE_INVALID");
    const rawHash=hash(raw);
    if(rawHash!==envelope.rawResponseSha256
      ||rawHash!==envelope.roster.rawResponseSha256)return bad("RAW_DIGEST_MISMATCH");
    let normalized;
    try{
      normalized=normalizePublicNativeCryptoRosterV1({market:envelope.roster.market,
        payload:JSON.parse(raw),observedAtMs:envelope.roster.observedAtMs,
        rawResponseSha256:rawHash});
    }catch{return bad("RAW_PAYLOAD_INVALID");}
    if(normalized.rosterDigestSha256!==checked.rosterDigestSha256)
      return bad("NORMALIZATION_MISMATCH");
    return checked;
  }catch{return bad("INVALID");}
}

async function readBounded(response){
  const length=response.headers?.get?.("content-length");
  if(length!==null&&length!==undefined){
    if(!/^\d+$/.test(length))fail("CONTENT_LENGTH_INVALID");
    if(Number(length)>MAX_BYTES)fail("RESPONSE_TOO_LARGE");
  }
  const type=response.headers?.get?.("content-type");
  if(typeof type!=="string"||!/^application\/json(?:\s*;|$)/i.test(type))fail("CONTENT_TYPE_INVALID");
  if(typeof response.body?.getReader!=="function")fail("BODY_STREAM_REQUIRED");
  const reader=response.body.getReader(),chunks=[];let total=0,complete=false;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done){complete=true;break;}
      if(!(value instanceof Uint8Array))fail("BODY_INVALID");
      total+=value.byteLength;
      if(total>MAX_BYTES)fail("RESPONSE_TOO_LARGE");
      chunks.push(Buffer.from(value));
    }
    const raw=Buffer.concat(chunks,total);
    let text,payload;
    try{text=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(raw);payload=JSON.parse(text);}
    catch{fail("BODY_JSON_INVALID");}
    return {text,payload,sha256:hash(raw)};
  }finally{
    if(!complete){try{void reader.cancel().catch(()=>{});}catch{/* noop */}}
    try{reader.releaseLock();}catch{/* already closed */}
  }
}

export async function fetchPublicNativeCryptoRosterV1({market,
  allowPublicReadOnlyFetch=false,fetchImpl=globalThis.fetch,
  nowImpl=()=>Date.now()}={}){
  const s=source(market);
  if(typeof allowPublicReadOnlyFetch!=="boolean"||typeof fetchImpl!=="function"
    ||typeof nowImpl!=="function")fail("INPUT_INVALID");
  const meta={requestStartedAtMs:null,responseReceivedAtMs:null,httpStatus:null};
  const blocked=reason=>freeze({status:"BLOCKED_DATA",reason,market,venue:s.venue,
    sourceUrl:s.url,roster:null,rawResponseText:null,rawResponseSha256:null,...meta,...SAFETY});
  if(!allowPublicReadOnlyFetch)
    return blocked(prefix+"FETCH_NOT_EXPLICITLY_ENABLED");
  meta.requestStartedAtMs=nowImpl();
  if(!time(meta.requestStartedAtMs))fail("CLOCK_INVALID");
  const controller=new AbortController();let timeout,timedOut=false;
  try{
    const work=(async()=>{
      const response=await fetchImpl(s.url,{method:"GET",redirect:"error",
        credentials:"omit",headers:{Accept:"application/json"},signal:controller.signal});
      meta.httpStatus=Number.isInteger(response?.status)?response.status:null;
      if(response?.redirected===true||(response?.url&&response.url!==s.url))fail("REDIRECT_BLOCKED");
      if(!response?.ok||response.status!==200)fail("HTTP_UNAVAILABLE");
      const body=await readBounded(response);
      meta.responseReceivedAtMs=nowImpl();
      if(!time(meta.responseReceivedAtMs)||meta.responseReceivedAtMs<meta.requestStartedAtMs)
        fail("CLOCK_INVALID");
      const roster=normalizePublicNativeCryptoRosterV1({market,payload:body.payload,
        observedAtMs:meta.responseReceivedAtMs,rawResponseSha256:body.sha256});
      return freeze({status:"CURRENT_SOURCE_ROSTER_CAPTURED_ONLY",roster,
        rawResponseText:body.text,rawResponseSha256:body.sha256,...meta});
    })();
    const limit=new Promise((_,reject)=>{
      timeout=setTimeout(()=>{
        timedOut=true;controller.abort();reject(new Error("timeout"));
      },TIMEOUT_MS);
    });
    return await Promise.race([work,limit]);
  }catch(error){
    controller.abort();
    if(meta.responseReceivedAtMs===null){
      const end=nowImpl();
      if(time(end)&&end>=meta.requestStartedAtMs)meta.responseReceivedAtMs=end;
    }
    const code=typeof error?.message==="string"&&error.message.startsWith(prefix)
      ?error.message.slice(prefix.length):"";
    return blocked(prefix+(timedOut?"TIMEOUT":ERRORS.has(code)?code:"NETWORK_OR_RESPONSE_ERROR"));
  }finally{clearTimeout(timeout);}
}
