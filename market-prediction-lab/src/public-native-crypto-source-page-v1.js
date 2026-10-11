import { isAbsolute, resolve } from "node:path";
import { validatePublicNativeCryptoRosterV1 } from "./public-native-crypto-roster-v1.js";
import { collectUpbitSpotHistory } from "./upbit-spot-history.js";
import { collectBitgetCandles } from "./bitget-candle-collector.js";
import { BitgetPublicClient, BitgetPublicApiError } from "./bitget-public-client.js";
import { isPublicHistorySourceDataErrorV1 } from "./public-history-source-errors-v1.js";
import { normalizeRetrospectiveCryptoMinuteSourceV1 } from "./pit-native-crypto-minute-backfill-v1.js";
import { withResearchMinuteArchiveBudgetV1 } from "./pit-minute-source-task-executor-v1.js";
import { inspectArchivedResearchMinuteSessionV1, persistResearchMinuteSessionV1 } from "./research-minute-archive-v1.js";

/**
 * P0 source acquisition can precede historical PIT certification. This page
 * visits a frozen CURRENT provider roster, not a historical population. It
 * reuses the native collectors and immutable archive, without calling any
 * historical PIT, opportunity denominator, strategy or Paper admission gate.
 * Missing sources and missing minutes remain unknown, never zero returns.
 */
const DAY=86_400_000;
const VENUES=Object.freeze({CRYPTO_SPOT:"UPBIT_KRW",CRYPTO_FUTURES:"BITGET_USDT_FUTURES"});
const SOURCE_IDS=Object.freeze({CRYPTO_SPOT:"UPBIT_PUBLIC_REST_RETROSPECTIVE_1M",
  CRYPTO_FUTURES:"BITGET_PUBLIC_V2_RETROSPECTIVE_1M"});
const MAX_RESPONSE_BYTES=2*1024**2;
const RESPONSE_ERRORS=new Set(["PUBLIC_SOURCE_RESPONSE_TOO_LARGE",
  "PUBLIC_SOURCE_RESPONSE_NOT_JSON","PUBLIC_SOURCE_RESPONSE_ORIGIN_UNVERIFIED",
  "PUBLIC_SOURCE_RESPONSE_STREAM_REQUIRED","PUBLIC_SOURCE_RESPONSE_INVALID_ENCODING"]);
const flags=Object.freeze({
  cohortScope:"CURRENT_PROVIDER_ROSTER_SURVIVOR_BIASED",
  historicalUniverseComplete:false,sourceArchiveCompletenessProven:false,
  fullMarketOpportunityDenominatorVerified:false,
  historicalScannerAvailabilityProven:false,missingMinuteNoTradeProof:false,
  sourceLicenseAndReuseRightsIndependentlyVerified:false,
  sourceRedistributionAllowed:false,trueMarketWideRecall:null,
  rawHttpCandleBodiesArchived:false,providerExtraFieldsArchived:false,
  actualMarketWideOpportunityCount:null,actualFillCount:null,netProfitPct:null,
  OOSPassCount:0,profitabilityProven:false,paperAdmissionAllowed:false,
  executionAuthority:"NONE",liveTrading:false,autoTrading:false,
  realOrders:false,privateTradingApiAllowed:false,scheduledWorkAllowed:false,
});
const result=(identity,values)=>Object.freeze({
  schemaVersion:"public-native-crypto-source-page-v1",...identity,...values,...flags,
});

function providerFailure(error){
  const typed=typeof error?.code==="string"?error.code:"";
  if(RESPONSE_ERRORS.has(typed))return {reason:typed,interrupt:true};
  if(isPublicHistorySourceDataErrorV1(error))
    return {reason:typed,interrupt:typed.endsWith("_TIMEOUT")};
  if(error instanceof BitgetPublicApiError){
    const status=error.details?.status;
    const code=String(error.details?.code??"");
    return {reason:status===429||status===418?"PUBLIC_SOURCE_RATE_LIMITED":
      "BITGET_PUBLIC_SOURCE_UNAVAILABLE",httpStatus:Number.isInteger(status)?status:null,
      providerCode:/^\d{5}$/u.test(code)?code:null,
      interrupt:status===429||status===418||status>=500};
  }
  const m=String(error?.message??"");
  if(/^UPBIT_HISTORY_HTTP_\d{3}$/u.test(m)){
    const status=Number(m.slice(-3));
    return {reason:status===429||status===418?"PUBLIC_SOURCE_RATE_LIMITED":m,
      httpStatus:status,interrupt:status===429||status===418||status>=500};
  }
  if(/^(?:UPBIT_HISTORY_RANGE_INCOMPLETE|UPBIT_HISTORY_INSUFFICIENT_\d+|BITGET_HISTORY_RANGE_INCOMPLETE)$/u.test(m))
    return {reason:m,interrupt:false};
  if(error?.name==="AbortError"||error?.name==="TimeoutError"
    ||/^(?:fetch failed|network error|request timeout)$/iu.test(m))
    return {reason:"PUBLIC_SOURCE_NETWORK_OR_TIMEOUT",interrupt:true};
  if(/^not enough candles collected: \d+$/u.test(m))
    return {reason:"NATIVE_SOURCE_WINDOW_INSUFFICIENT",interrupt:false};
  return null;
}

function restrictedFetch(fetchImpl,market){
  let nextUpbitRequestAt=0;
  const bad=code=>{throw Object.assign(new Error(code),{code});};
  return async (input,options={})=>{
    const url=new URL(input);
    const allowed=market==="CRYPTO_SPOT"
      ?url.origin==="https://api.upbit.com"&&url.pathname==="/v1/candles/minutes/1"
      :url.origin==="https://api.bitget.com"&&url.pathname==="/api/v2/mix/market/history-candles";
    if(!allowed||url.username||url.password||url.hash)
      throw new TypeError("PUBLIC_SOURCE_ENDPOINT_NOT_ALLOWED");
    // One shared gate spans every page AND symbol, including HTTP/data errors.
    if(market==="CRYPTO_SPOT"){
      const wait=nextUpbitRequestAt-Date.now();
      if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));
      nextUpbitRequestAt=Date.now()+220;
    }
    options.signal?.throwIfAborted();
    const response=await fetchImpl(url,{method:"GET",redirect:"error",credentials:"omit",
      signal:options.signal,
      headers:{accept:"application/json","user-agent":"market-prediction-lab/public-source-research"}});
    if(response?.redirected===true||(response?.url&&response.url!==url.toString())){
      response?.body?.cancel?.().catch(()=>{});
      bad("PUBLIC_SOURCE_RESPONSE_ORIGIN_UNVERIFIED");
    }
    if(!Number.isInteger(response?.status)||response.status<200||response.status>599)
      bad("PUBLIC_SOURCE_RESPONSE_ORIGIN_UNVERIFIED");
    // Do not reflect arbitrary error bodies; the collectors still see HTTP status.
    if(!response.ok){
      response.body?.cancel?.().catch(()=>{});
      return new Response(JSON.stringify({code:"PUBLIC_HTTP_ERROR"}),{
        status:response.status,headers:{"content-type":"application/json"}});
    }
    const contentType=response.headers?.get("content-type")??"";
    if(!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/iu.test(contentType)){
      response.body?.cancel?.().catch(()=>{});bad("PUBLIC_SOURCE_RESPONSE_NOT_JSON");
    }
    const declared=response.headers?.get("content-length");
    if(declared!==null&&declared!==undefined&&(!/^\d+$/u.test(declared)
      ||Number(declared)>MAX_RESPONSE_BYTES)){
      response.body?.cancel?.().catch(()=>{});bad("PUBLIC_SOURCE_RESPONSE_TOO_LARGE");
    }
    if(typeof response.body?.getReader!=="function")bad("PUBLIC_SOURCE_RESPONSE_STREAM_REQUIRED");
    // A fixed buffer also bounds bookkeeping when the stream has tiny chunks.
    const reader=response.body.getReader();const bytes=Buffer.allocUnsafe(MAX_RESPONSE_BYTES);let total=0;
    let onAbort;
    const aborted=new Promise((_,reject)=>{
      onAbort=()=>reject(options.signal?.reason??new DOMException("Aborted","AbortError"));
      options.signal?.addEventListener("abort",onAbort,{once:true});
      if(options.signal?.aborted)onAbort();
    });
    try{
      while(true){
        const {done,value}=await Promise.race([reader.read(),aborted]);
        if(done)break;
        if(total+value.byteLength>MAX_RESPONSE_BYTES)bad("PUBLIC_SOURCE_RESPONSE_TOO_LARGE");
        bytes.set(value,total);total+=value.byteLength;
      }
      let body;
      try{body=new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,total));}
      catch{bad("PUBLIC_SOURCE_RESPONSE_INVALID_ENCODING");}
      return new Response(body,{status:response.status,headers:{"content-type":"application/json"}});
    }finally{
      options.signal?.removeEventListener("abort",onAbort);
      reader.cancel().catch(()=>{});
    }
  };
}

function supportedNativeSymbol(market,symbol){
  return market==="CRYPTO_SPOT"?/^KRW-[A-Z0-9]{1,20}$/u.test(symbol)
    :/^[A-Z0-9\p{Script=Han}]{3,30}$/u.test(symbol)&&symbol.endsWith("USDT");
}

function matchesNativeArchive(prior,market,dayStartMs){
  return prior.sourceMinuteIntegrityVerified===true
    &&prior.venue===VENUES[market]&&prior.sourceId===SOURCE_IDS[market]
    &&prior.sessionStartMs===dayStartMs&&prior.archiveSessionEndMs===dayStartMs+DAY
    &&prior.sessionKind==="UTC_24H"&&prior.sessionTimeZone==="UTC"
    &&prior.originalRowsUnavailableBySessionEnd===prior.sourceMinuteRows;
}

export async function collectPublicNativeCryptoSourcePageV1({
  root,market,day,roster,expectedRosterDigestSha256,offset=0,limit=20,
  allowPublicReadOnlyFetch=false,fetchImpl=globalThis.fetch,
  nowImpl=()=>Date.now(),statfsImpl,
  maxLocalBytes=2*1024**3,minFreeBytes=2*1024**3,
}={}){
  const dayStartMs=typeof day==="string"?Date.parse(day+"T00:00:00Z"):NaN;
  if(!Object.hasOwn(VENUES,market)||typeof root!=="string"||!isAbsolute(root)
    ||resolve(root)!==root||!/^\d{4}-\d{2}-\d{2}$/u.test(day??"")
    ||!Number.isSafeInteger(dayStartMs)||dayStartMs<=0
    ||new Date(dayStartMs).toISOString().slice(0,10)!==day
    ||!Number.isSafeInteger(offset)||offset<0
    ||!Number.isSafeInteger(limit)||limit<1||limit>20
    ||!/^[0-9a-f]{64}$/u.test(expectedRosterDigestSha256??"")
    ||typeof allowPublicReadOnlyFetch!=="boolean"
    ||typeof fetchImpl!=="function"||typeof nowImpl!=="function")
    throw new TypeError("PUBLIC_NATIVE_SOURCE_PAGE_ARGUMENT_INVALID");
  const identity={market,venue:VENUES[market],day,offset,limit};
  const stop=reason=>result(identity,{status:"BLOCKED_DATA",reason,
    rows:Object.freeze([]),nextOffset:offset,providerReadOnlyGETs:0});
  const now=nowImpl();
  if(!Number.isSafeInteger(now)||dayStartMs+DAY>now)
    return stop("REQUESTED_UTC_DAY_NOT_CLOSED");
  const checked=validatePublicNativeCryptoRosterV1(roster,expectedRosterDigestSha256);
  if(!checked?.ok||roster.market!==market||roster.venue!==VENUES[market]
    ||roster.observedAtMs>now)return stop("CURRENT_SOURCE_ROSTER_OR_DIGEST_INVALID");
  if(offset>=roster.symbols.length)return stop("CURRENT_SOURCE_CURSOR_OUT_OF_RANGE");
  const selected=roster.symbols.slice(offset,offset+limit);
  const pageIdentity={...identity,rosterDigestSha256:roster.rosterDigestSha256,
    rosterObservedAtMs:roster.observedAtMs,currentSourceSymbolCount:roster.symbols.length,
    selectedSymbolCount:selected.length};
  if(!allowPublicReadOnlyFetch)return result(pageIdentity,{
    status:"PLANNED_CURRENT_SOURCE_PAGE_ONLY",reason:"EXPLICIT_PUBLIC_READ_ONLY_OPT_IN_REQUIRED",
    selectedSymbols:Object.freeze(selected),rows:Object.freeze([]),
    nextOffset:offset,plannedNextOffset:offset+selected.length<roster.symbols.length
      ?offset+selected.length:null,providerReadOnlyGETs:0,
  });
  let requestCount=0;
  const countedFetch=restrictedFetch(async(...args)=>{requestCount++;return fetchImpl(...args);},market);
  const bitget=market==="CRYPTO_FUTURES"?new BitgetPublicClient({
    fetchImpl:countedFetch,maxRetries:0,minIntervalMs:220,timeoutMs:12_000,
  }):null;
  const guarded=await withResearchMinuteArchiveBudgetV1({
    root,maxSources:selected.length,maxLocalBytes,minFreeBytes,
    ...(statfsImpl?{statfsImpl}:{}),
  },async budget=>{
    const rows=[];let interrupted=false;
    for(const [index,symbol] of selected.entries()){
      if(!supportedNativeSymbol(market,symbol)){
        rows.push(Object.freeze({symbol,sourceOffset:offset+index,status:"BLOCKED_DATA",
          reason:"NATIVE_SOURCE_IDENTIFIER_NOT_YET_SUPPORTED",sourceMinuteCount:null,
          missingUnverifiedMinuteSlots:null,providerReadOnlyGETs:0}));continue;
      }
      const prior=await inspectArchivedResearchMinuteSessionV1({
        root,market,symbol,sessionStartMs:dayStartMs,
      });
      if(prior.status!=="BLOCKED_DATA"){
        if(!matchesNativeArchive(prior,market,dayStartMs)){
          rows.push(Object.freeze({symbol,sourceOffset:offset+index,status:"BLOCKED_DATA",
            reason:"EXISTING_ARCHIVE_NATIVE_SOURCE_SCOPE_UNVERIFIED",sourceMinuteCount:null,
            missingUnverifiedMinuteSlots:null,providerReadOnlyGETs:0}));continue;
        }
        rows.push(Object.freeze({symbol,sourceOffset:offset+index,
          status:"ALREADY_RETAINED_SOURCE_ONLY",reason:prior.nativeMinuteSlotInventoryComplete
            ?null:"MISSING_MINUTE_SLOTS_NOT_PROVEN_NO_TRADES",
          sourceMinuteCount:prior.sourceMinuteRows,
          missingUnverifiedMinuteSlots:prior.missingUnverifiedSourceMinuteSlots,
          archiveSourceDigestSha256:prior.archiveSourceDigestSha256,
          sourceId:prior.sourceId,providerRequestWindowVerified:null,
          providerReadOnlyGETs:0}));
        continue;
      }
      if(prior.reason!=="ARCHIVED_SESSION_NOT_FOUND"){
        rows.push(Object.freeze({symbol,sourceOffset:offset+index,status:"BLOCKED_DATA",
          reason:"EXISTING_SOURCE_REVISION_REQUIRES_REVIEW",sourceMinuteCount:null,
          missingUnverifiedMinuteSlots:null,providerReadOnlyGETs:0}));continue;
      }
      const beforeRequests=requestCount;
      let collected;
      try{
        collected=market==="CRYPTO_SPOT"
          ?await collectUpbitSpotHistory({symbol,timeframe:"1m",startTime:dayStartMs,
            endTime:dayStartMs+DAY,minCandles:1,maxPages:10,minIntervalMs:0,
            allowPartialSource:true,requireFullWindow:false,requireMarketIdentity:true,fetchImpl:countedFetch,
            signal:AbortSignal.timeout(60_000)})
          :await collectBitgetCandles({client:bitget,market,symbol,timeframe:"1m",
            startTime:dayStartMs,endTime:dayStartMs+DAY,maxCandles:1600,
            minCandles:1,allowPartialSource:true,requireFullWindow:false,productType:"usdt-futures"});
      }catch(error){
        const failure=providerFailure(error);if(!failure)throw error;
        rows.push(Object.freeze({symbol,sourceOffset:offset+index,status:"BLOCKED_DATA",
          reason:failure.reason,httpStatus:failure.httpStatus??null,
          providerCode:failure.providerCode??null,sourceMinuteCount:null,
          missingUnverifiedMinuteSlots:null,providerReadOnlyGETs:requestCount-beforeRequests}));
        if(failure.interrupt){interrupted=true;break;}continue;
      }
      const receivedAtMs=nowImpl();
      if(!Number.isSafeInteger(receivedAtMs)||receivedAtMs<now)
        throw new TypeError("PUBLIC_NATIVE_SOURCE_CAPTURE_CLOCK_INVALID");
      const parsed=normalizeRetrospectiveCryptoMinuteSourceV1({
        market,symbol,dayStartMs,receivedAtMs,collected,allowPartialSource:true,
      });
      if(!parsed.source){
        rows.push(Object.freeze({symbol,sourceOffset:offset+index,status:"BLOCKED_DATA",
          reason:parsed.error,sourceMinuteCount:null,missingUnverifiedMinuteSlots:null,
          providerReadOnlyGETs:requestCount-beforeRequests}));continue;
      }
      const stored=await persistResearchMinuteSessionV1({root,source:parsed.source});
      const retained=await inspectArchivedResearchMinuteSessionV1({
        root,market,symbol,sessionStartMs:dayStartMs,
        sourceDigestSha256:stored.sourceDigestSha256,
      });
      if(retained.sourceMinuteIntegrityVerified!==true)
        throw new TypeError("PUBLIC_NATIVE_SOURCE_ARCHIVE_READBACK_FAILED");
      rows.push(Object.freeze({symbol,sourceOffset:offset+index,
        status:"RETROSPECTIVE_SOURCE_RETAINED_ONLY",reason:retained.nativeMinuteSlotInventoryComplete
          ?null:parsed.sourcePartialReason??"MISSING_MINUTE_SLOTS_NOT_PROVEN_NO_TRADES",
        sourceMinuteCount:retained.sourceMinuteRows,
        missingUnverifiedMinuteSlots:retained.missingUnverifiedSourceMinuteSlots,
        archiveSourceDigestSha256:retained.archiveSourceDigestSha256,
        sourceId:retained.sourceId,
        providerRequestWindowVerified:parsed.providerRequestWindowVerified,
        receivedAtMs,providerReadOnlyGETs:requestCount-beforeRequests}));
    }
    const retained=rows.filter(r=>r.sourceMinuteCount!==null);
    const next=offset+rows.length-(interrupted?1:0);
    return result(pageIdentity,{status:interrupted?"CURRENT_SOURCE_PAGE_INTERRUPTED":
      "CURRENT_SOURCE_PAGE_CAPTURED_ONLY",reason:interrupted?"PUBLIC_SOURCE_RETRY_REQUIRED":null,
      rows:Object.freeze(rows),nextOffset:next<roster.symbols.length?next:null,
      cohortVisitComplete:next>=roster.symbols.length,
      currentPageRetainedSymbolCount:retained.length,
      currentPageBlockedSymbolCount:rows.length-retained.length,
      sourceMinuteCount:retained.length?retained.reduce((n,r)=>n+r.sourceMinuteCount,0):null,
      missingUnverifiedMinuteSlots:retained.length?retained.reduce((n,r)=>n+r.missingUnverifiedMinuteSlots,0):null,
      unvisitedSelectedSymbolCount:selected.length-rows.length,
      blockedSourceOffsets:Object.freeze(rows.filter(r=>r.status==="BLOCKED_DATA").map(r=>r.sourceOffset)),
      partialSourceOffsets:Object.freeze(retained.filter(r=>r.missingUnverifiedMinuteSlots>0
        ||r.providerRequestWindowVerified===false).map(r=>r.sourceOffset)),
      providerReadOnlyGETs:requestCount,...budget});
  });
  return guarded.schemaVersion?guarded:result(pageIdentity,{...guarded,
    rows:Object.freeze([]),nextOffset:offset,providerReadOnlyGETs:requestCount});
}
