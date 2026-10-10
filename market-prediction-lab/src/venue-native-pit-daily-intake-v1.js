import {createHash} from "node:crypto";
import {collectUpbitSpotHistory} from "./upbit-spot-history.js";
import {normalizeBitgetCandle} from "./bitget-candle-collector.js";
import {BitgetPublicApiError} from "./bitget-public-client.js";
import {auditHistoricalPITVenueUniverseV1}
  from "./historical-pit-venue-universe-gate-v1.js";
import {FOUR_MARKET_WHOLE_SCOPE_V1 as SCOPE,
  digestWholeVenueDailyRowsV1,auditWholeVenuePITDailyCoverageV1}
  from "./four-market-whole-pit-price-coverage-v1.js";

/**
 * NO hardcoded six-symbol basket or a current ticker list is used here.
 * A supplied, historical exchange-specific PIT roster MUST validate first.
 *
 * Bounded stateless pagination: at most 20 symbols per call, read-only public
 * daily candles for Upbit KRW and Bitget USDT futures. Stock prices remain
 * BLOCKED until a licensed dated OHLC source is explicitly connected.
 * Neither a current Upbit downloadable archive (current-supported pairs)
 * nor Bitget live instruments API proves historical delisted coverage.
 * No source file is persisted and no private API/DB/secrets/order is accessed.
 */
const D=86_400_000,MAX=20;
const sameDay=(t,d)=>Number.isSafeInteger(t)&&t===d;
const valid=n=>Number.isSafeInteger(n)&&n>0;
const sha=x=>createHash("sha256").update(x).digest("hex");
const markets=Object.keys(SCOPE);
const safe=(market,extra={})=>Object.freeze({
  market,venue:SCOPE[market].venue,status:"BLOCKED_DATA",
  fullMarketPITUniverseVerified:false,
  independentlyAuthenticatedHistoricalSource:false,
  actualMarketWideOpportunityCount:null,trueMarketWideRecall:null,
  historicalScannerLeadMs:null,netProfitPct:null,actualFillCount:null,
  profitabilityProven:false,executionAuthority:"NONE",liveTrading:false,
  autoTrading:false,privateApiCalls:false,realOrders:false,...extra,
});
const blocked=(market,reason,extra={})=>safe(market,{reason,...extra});
const arr=x=>Array.isArray(x)?x:[];

function activeRows(manifest,startMs){
  const seen=new Set(),active=[];
  for(const item of manifest.memberships){
    if(item.listedAtMs>=startMs+D||(item.removedAtMs??Infinity)<=startMs)continue;
    const sym=String(item.symbol).trim().toUpperCase();
    if(seen.has(sym))return {error:"PIT_SAME_DAY_IDENTIFIER_REUSE_REQUIRES_SESSION_PROOF"};
    seen.add(sym);active.push(item);
  }
  active.sort((a,b)=>a.symbol.localeCompare(b.symbol));
  return {active};
}
function partitionCheck(item,day){
  return item.listedAtMs>day || (item.removedAtMs??Infinity)<day+D
    ||item.halts.some(x=>x.startMs<day+D&&x.endMs>day);
}
function normalizedDay(market,symbol,dayStartMs,prior,day,sourceId){
  const obs={symbol,market,venue:SCOPE[market].venue,
    timestampMs:dayStartMs,
    open:day.open,high:day.high,low:day.low,close:day.close,
    volume:day.volume,priorClose:prior.close,
    priorCloseAsOfMs:dayStartMs,
    sourceId,
    evidenceSha256:sha(JSON.stringify([
      sourceId,symbol,prior.timestamp,prior.open,prior.high,prior.low,prior.close,
      day.timestamp,day.open,day.high,day.low,day.close,day.volume,
    ])),
  };
  return Object.freeze(obs);
}
function pickDay(candles,day){
  if(!Array.isArray(candles))throw new TypeError("PIT_NATIVE_DAY_CANDLES_INVALID");
  const timestamps=new Set();
  for(const candle of candles){
    if(!valid(candle?.timestamp)||candle.timestamp%D!==0
       ||timestamps.has(candle.timestamp))
      throw new TypeError("PIT_NATIVE_DAILY_TIMESTAMP_DUPLICATE_OR_UNALIGNED");
    timestamps.add(candle.timestamp);
  }
  return {
    prior:candles.find(x=>sameDay(x.timestamp,day-D)),
    current:candles.find(x=>sameDay(x.timestamp,day)),
  };
}
export async function collectNativePITDayPriceV1({
  market,symbol,dayStartMs,upbitFetch=globalThis.fetch,
  bitgetClient=null,nowMs=Date.now(),
}={}){
  if(!["CRYPTO_SPOT","CRYPTO_FUTURES"].includes(market)
     ||!valid(dayStartMs)||dayStartMs%D!==0
     ||!valid(nowMs)||dayStartMs+D>nowMs)
    throw new TypeError("NATIVE_PIT_DAY_INPUT_INVALID");
  if(market==="CRYPTO_SPOT"&&!/^KRW-[A-Z0-9]{1,20}$/.test(symbol??""))
    throw new TypeError("UPBIT_NATIVE_PIT_SYMBOL_INVALID");
  if(market==="CRYPTO_FUTURES"&&!/^[A-Z0-9]{3,30}USDT$/.test(symbol??""))
    throw new TypeError("BITGET_NATIVE_PIT_SYMBOL_INVALID");
  let candles,sourceId,sourceReceipt;
  if(market==="CRYPTO_SPOT"){
    // Reuse the existing Upbit collector, including page tracing and UTC
    // candle boundary normalization. Do not backfill missing prior trades.
    const c=await collectUpbitSpotHistory({
      symbol,timeframe:"1d",startTime:dayStartMs-D,endTime:dayStartMs+D,
      maxPages:2,minCandles:1,minIntervalMs:200,requireFullWindow:true,
      requireMarketIdentity:true,fetchImpl:upbitFetch,
      signal:AbortSignal.timeout(25_000),
    });
    if(c.rawPageWindowTraversed!==true||c.providerMarket!==symbol
       ||c.source!=="upbit-public-candles")
      return blocked(market,"UPBIT_DAILY_SOURCE_PROVENANCE_INVALID",{symbol});
    candles=c.candles;sourceId="UPBIT_PUBLIC_DAY_CANDLES_V1";
    sourceReceipt={provider:"UPBIT",endpoint:"/v1/candles/days",
      pageCount:c.pageCount,providerHistoricalDelistingsVerified:false,
      providerCurrentMarketListNotPIT:true};
  }else{
    if(!bitgetClient||typeof bitgetClient.get!=="function")
      throw new TypeError("BITGET_READ_ONLY_PUBLIC_CLIENT_REQUIRED");
    // v3 official history endpoint can query older than 90 days;
    // per-query window is only 3 days here (documented max 90).
    const params={category:"USDT-FUTURES",symbol,interval:"1D",
      type:"market",startTime:dayStartMs-2*D,endTime:dayStartMs+D,limit:100};
    const x=await bitgetClient.get("/api/v3/market/history-candles",params);
    if(!Array.isArray(x?.data)||x.data.length>100)
      throw new TypeError("BITGET_V3_HISTORIC_DAY_RESPONSE_INVALID");
    candles=x.data.map(normalizeBitgetCandle);
    sourceId="BITGET_PUBLIC_V3_USDT_FUTURES_1D";
    sourceReceipt={provider:"BITGET",endpoint:"/api/v3/market/history-candles",
      category:"USDT-FUTURES",historicalContractLifecycleVerified:false,
      providerCurrentInstrumentsNotPIT:true,
      responseRows:x.data.length};
  }
  const {prior,current}=pickDay(candles,dayStartMs);
  if(!prior||!current)return blocked(market,
    !prior?"NATIVE_PRIOR_UTC_DAY_CLOSE_MISSING":
      "NATIVE_EVALUATION_UTC_DAY_PRICE_MISSING",{
      symbol,sourceId,observedDayCount:candles.length,
      sourceReceipt,
    });
  const row=normalizedDay(market,symbol,dayStartMs,prior,current,sourceId);
  return safe(market,{status:"NATIVE_SELECTED_PIT_SYMBOL_DAY_PRICE_ONLY",
    reason:null,symbol,dayStartMs,
    sourceReceipt,
    sourceName:sourceId,
    rawNativeCandleDigestSha256:sha(JSON.stringify(candles)),
    priceRow:row,
    nativePITPriceCompleteForSingleSymbol:true,
    // Real population denominator can only come from immutable historical
    // listing+delisting evidence, NOT the candle request itself.
    fullMarketPITUniverseVerified:false,
  });
}
function expectedProviderFailure(error){
  const e=String(error?.message??"");
  return error instanceof BitgetPublicApiError
    ||/^UPBIT_HISTORY_(?:HTTP_\d+|RANGE_INCOMPLETE|INSUFFICIENT_\d+)/.test(e);
}
export async function collectNativeHistoricalPITDayChunkV1({
  market,dayStartMs,manifest=null,offset=0,limit=MAX,
  allowPublicReadOnlyFetch=false,expectedRosterDigestSha256=null,
  upbitFetch=globalThis.fetch,bitgetClient=null,
  sleepImpl=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  minBetweenSymbolsMs=200,nowMs=Date.now(),
}={}){
  if(!Object.hasOwn(SCOPE,market))throw new TypeError("PIT_CHUNK_MARKET_INVALID");
  if(!valid(dayStartMs)||dayStartMs%D!==0
     ||!Number.isSafeInteger(offset)||offset<0
     ||!Number.isSafeInteger(limit)||limit<1||limit>MAX
     ||typeof allowPublicReadOnlyFetch!=="boolean"
     ||typeof sleepImpl!=="function"
     ||!Number.isSafeInteger(minBetweenSymbolsMs)
     ||minBetweenSymbolsMs<180||minBetweenSymbolsMs>2000)
    throw new TypeError("PIT_CHUNK_ARGUMENT_INVALID");
  const pit=auditHistoricalPITVenueUniverseV1({
    market,dayStartMs,dayEndMs:dayStartMs+D,selectedRows:[],manifest,
  });
  if(!["SOURCE_ATTESTED_PIT_COHORT_ONLY","TEST_FIXTURE_ONLY"].includes(pit.status))
    return blocked(market,"PIT_"+pit.reason,{
      rosterDigestSha256:null,requestedHistoricalActiveMembers:null,
      requestedChunkCount:null,chunkOffset:offset,nextOffset:null,rows:[],
    });
  const digest=manifest.rawMembershipDigestSha256;
  if(expectedRosterDigestSha256!=null&&expectedRosterDigestSha256!==digest)
    return blocked(market,"PIT_ROSTER_DIGEST_CHANGED",{
      rosterDigestSha256:digest,requestedHistoricalActiveMembers:null,
      requestedChunkCount:null,chunkOffset:offset,nextOffset:null,rows:[],
    });
  const roster=activeRows(manifest,dayStartMs);
  if(roster.error)return blocked(market,roster.error,{
    rosterDigestSha256:digest,rows:[],nextOffset:null,
  });
  const total=roster.active.length;
  if(!total||offset>=total)return blocked(market,"PIT_EMPTY_OR_CURSOR_OUTSIDE_ACTIVE_NAMES",{
    rosterDigestSha256:digest,requestedHistoricalActiveMembers:total,
    rows:[],nextOffset:null,
  });
  const symbols=roster.active.slice(offset,offset+limit);
  const nextOffset=offset+symbols.length<total?offset+symbols.length:null;
  const metadata={dayStartMs,dayEndMs:dayStartMs+D,
    rosterDigestSha256:digest,requestedHistoricalActiveMembers:total,
    chunkOffset:offset,requestedChunkCount:symbols.length,nextOffset,
    requestedSymbolIds:symbols.map(s=>s.symbol),
    originalPITSourceStatus:pit.status};
  if(["KR_STOCK","US_STOCK"].includes(market))
    return blocked(market,"LICENSED_HISTORICAL_STOCK_DAY_BARS_NOT_CONNECTED",{
      ...metadata,rows:[],requestsPerformed:0,
    });
  if(!allowPublicReadOnlyFetch)
    return blocked(market,"PUBLIC_NATIVE_PRICE_FETCH_NOT_EXPLICITLY_ENABLED",{
      ...metadata,rows:[],requestsPerformed:0,
    });
  if(!valid(nowMs)||dayStartMs+D>nowMs)
    return blocked(market,"NATIVE_DAY_NOT_YET_CLOSED",{
      ...metadata,rows:[],requestsPerformed:0,
    });
  const rows=[],failed=[];let performed=0;
  for(const [index,item] of symbols.entries()){
    if(partitionCheck(item,dayStartMs)){
      failed.push({symbol:item.symbol,
        reason:"PIT_PARTIAL_SESSION_LISTING_DELISTING_OR_HALT"});
      continue;
    }
    if(performed>0)await sleepImpl(minBetweenSymbolsMs);
    performed++;
    try{
      const result=await collectNativePITDayPriceV1({
        market,symbol:item.symbol,dayStartMs,
        upbitFetch,bitgetClient,nowMs,
      });
      if(result.status!=="NATIVE_SELECTED_PIT_SYMBOL_DAY_PRICE_ONLY"){
        failed.push({symbol:item.symbol,reason:result.reason});
      }else{
        rows.push(result.priceRow);
      }
    }catch(error){
      if(!expectedProviderFailure(error))throw error;
      failed.push({symbol:item.symbol,
        reason:"NATIVE_PUBLIC_PRICE_SOURCE_UNAVAILABLE",
        sourceErrorCode:String(error?.message??"").slice(0,100)});
    }
  }
  return safe(market,{status:failed.length?"PIT_NATIVE_DAY_CHUNK_PARTIAL":
      "PIT_NATIVE_DAY_CHUNK_OBSERVED",
    reason:failed.length?"INCOMPLETE_OR_BLOCKED_DATED_SOURCE":null,
    ...metadata,rows,failed,requestsPerformed:performed,
    sourceAttestedPriceRows:rows.length,
    chunkComplete:failed.length===0&&rows.length===symbols.length,
  });
}
export function assembleHistoricalPITDayChunksV1({
  market,dayStartMs,manifest=null,chunks=[],retrievedAtMs=Date.now(),
}={}){
  if(!Object.hasOwn(SCOPE,market)||!valid(dayStartMs)||dayStartMs%D!==0)
    throw new TypeError("PIT_DAY_ASSEMBLER_SCOPE_INVALID");
  const pit=auditHistoricalPITVenueUniverseV1({
    market,dayStartMs,dayEndMs:dayStartMs+D,selectedRows:[],manifest,
  });
  if(!["TEST_FIXTURE_ONLY","SOURCE_ATTESTED_PIT_COHORT_ONLY"].includes(pit.status))
    return blocked(market,"PIT_"+pit.reason);
  if(!Array.isArray(chunks)||chunks.length>5000||!valid(retrievedAtMs)
     ||retrievedAtMs<dayStartMs+D)
    throw new TypeError("PIT_DAY_ASSEMBLER_INPUT_INVALID");
  const roster=activeRows(manifest,dayStartMs);
  if(roster.error)return blocked(market,roster.error);
  const expected=roster.active.map(x=>x.symbol);
  const ordered=[...chunks].sort((a,b)=>a.chunkOffset-b.chunkOffset);
  let count=0;const rows=[];
  for(const piece of ordered){
    if(piece?.market!==market||piece?.venue!==SCOPE[market].venue
       ||piece.dayStartMs!==dayStartMs
       ||piece.rosterDigestSha256!==manifest.rawMembershipDigestSha256
       ||piece.requestedHistoricalActiveMembers!==expected.length
       ||piece.chunkOffset!==count
       ||piece.chunkComplete!==true
       ||!Array.isArray(piece.rows)||!Array.isArray(piece.requestedSymbolIds)
       ||piece.rows.length!==piece.requestedChunkCount
       ||piece.requestedSymbolIds.length!==piece.rows.length
       ||piece.requestedSymbolIds.some((s,i)=>s!==expected[count+i]
         ||piece.rows[i]?.symbol!==s))
      return blocked(market,"PIT_NATIVE_CHUNK_MISSING_OR_PROVENANCE_MISMATCH",{
        mergedNativeSymbols:count,requiredHistoricalActiveSymbols:expected.length,
      });
    rows.push(...piece.rows);
    count+=piece.rows.length;
  }
  if(count!==expected.length)
    return blocked(market,"PIT_NATIVE_CHUNK_MISSING_OR_PROVENANCE_MISMATCH",{
      mergedNativeSymbols:count,requiredHistoricalActiveSymbols:expected.length,
    });
  const nativeArchiveId=[market,dayStartMs,
    manifest.rawMembershipDigestSha256].join(":");
  const normalized=rows.map(x=>({...x,sourceId:nativeArchiveId}));
  const dailySource={
    schemaVersion:"venue-native-historical-all-names-daily-v1",
    market,venue:SCOPE[market].venue,
    sourceClass:pit.status==="TEST_FIXTURE_ONLY"
      ?"TEST_FIXTURE":"VENUE_NATIVE_DAILY_ARCHIVE",
    sourceId:nativeArchiveId,dayStartMs,dayEndMs:dayStartMs+D,
    retrievedAtMs,
    exhaustiveActiveSymbolsRequested:true,
    priceSelectionUsedFutureDayOHLC:false,
    corporateActionAdjustmentEvidenceAttached:false,
    sourcePriceConvention:"NATIVE_UNADJUSTED",
    rows:normalized,rowsSha256:digestWholeVenueDailyRowsV1(normalized),
  };
  const audit=auditWholeVenuePITDailyCoverageV1({
    market,dayStartMs,manifest,dailySource,
  });
  return safe(market,{
    status:audit.status,
    reason:audit.reason,
    sourceAttestedHistoricalActiveSymbols:audit.sourceAttestedHistoricalActiveSymbols,
    sourceAttestedDailyBars:audit.sourceAttestedDailyBars,
    missingDailyBarCount:audit.missingDailyBarCount,
    sourceAttestedFullSymbolDayPriceJoin:audit.sourceAttestedFullSymbolDayPriceJoin,
    assembledChunkCount:ordered.length,
    nativeRowsSha256:dailySource.rowsSha256,
    // Do not leak paid/personal archives to an app or a public CI artifact.
    rawNativeDailySourcePublicationAllowed:false,
    independentlyAuthenticatedHistoricalSource:false,
    fullMarketPITUniverseVerified:false,
    fullMarketOpportunityDenominatorVerified:false,
    actualMarketWideOpportunityCount:null,trueMarketWideRecall:null,
    originalScannerObservationsVerified:false,actualFillCount:null,
    profitabilityProven:false,executionAuthority:"NONE",
  });
}
