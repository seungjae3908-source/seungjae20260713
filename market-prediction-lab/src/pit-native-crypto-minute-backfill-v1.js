import { createHash } from "node:crypto";
import { auditHistoricalPITVenueUniverseV1 } from "./historical-pit-venue-universe-gate-v1.js";
import { collectUpbitSpotHistory } from "./upbit-spot-history.js";
import { collectBitgetCandles } from "./bitget-candle-collector.js";
import { BitgetPublicClient, BitgetPublicApiError } from "./bitget-public-client.js";
import { isPublicHistorySourceDataErrorV1 } from "./public-history-source-errors-v1.js";
import {
  persistResearchMinuteSessionV1,
  deriveArchivedResearchTimeframesV1,
} from "./research-minute-archive-v1.js";

/**
 * PUBLIC-READ-OPT-IN, ONE historical PIT crypto symbol and ONE closed UTC day.
 * Bounded Upbit/Bitget existing collectors -> exact venue 1m source adapter ->
 * existing private immutable gzip archive. No private API, key, order or DB.
 *
 * Historical REST data captured TODAY were NOT necessarily published to a
 * historical scanner at bar close: availableAtMs is conservative retrieval
 * time, never a fabricated historical quote publication time. The archive
 * may inform retrospective market-event denominators only once independent
 * PIT roster, source license, missing/no-trade proof and as-of evidence exist.
 */
const DAY = 86_400_000, MIN = 60_000;
const MARKET = Object.freeze({
  CRYPTO_SPOT: Object.freeze({
    venue: "UPBIT_KRW", sourceId: "UPBIT_PUBLIC_REST_RETROSPECTIVE_1M",
  }),
  CRYPTO_FUTURES: Object.freeze({
    venue: "BITGET_USDT_FUTURES",
    sourceId: "BITGET_PUBLIC_V2_RETROSPECTIVE_1M",
  }),
});
const SYMBOL = /^[A-Z0-9\p{Script=Han}][A-Z0-9\p{Script=Han}._:-]{0,39}$/u;
const SHA = /^[0-9a-f]{64}$/u;
const digest = rows => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
const stop = (market, symbol, dayStartMs, reason, extra = {}) => Object.freeze({
  schemaVersion: "pit-native-crypto-minute-backfill-v1",
  status: "BLOCKED_DATA", reason, market, venue: MARKET[market]?.venue ?? null,
  symbol, dayStartMs, ...extra,
  historicalFullMarketPITUniverseVerified: false,
  sourceHistoricalPublicationTimeProven: false,
  nativeMinutesNoTradeGapVerified: false,
  actualMarketWideOpportunityCount: null, trueMarketWideRecall: null,
  actualFillCount: null, netProfitPct: null, profitabilityProven: false,
  executionAuthority: "NONE", liveTrading: false, autoTrading: false,
  realOrders: false, privateTradingApiAllowed: false,
  sourceRedistributionAllowed: false,
});
function validate(input) {
  if (!input || !Object.hasOwn(MARKET, input.market)
    || typeof input.symbol !== "string" || !SYMBOL.test(input.symbol)
    || input.symbol!==input.symbol.normalize("NFC")
    || (input.market === "CRYPTO_SPOT" && !/^KRW-[A-Z0-9]{1,20}$/u.test(input.symbol))
    || (input.market === "CRYPTO_FUTURES"
      && !/^[A-Z0-9\p{Script=Han}]{1,26}USDT$/u.test(input.symbol))
    || !Number.isSafeInteger(input.dayStartMs) || input.dayStartMs <= 0
    || input.dayStartMs % DAY !== 0
    || !SHA.test(input.expectedRosterDigestSha256 ?? "")
    || typeof input.root !== "string"
    || ![true,false].includes(input.allowPublicReadOnlyFetch)
    || ![true,false].includes(input.retryPartialSource)
    || ![true,false].includes(input.allowSourceLimitedArchive)
    || (input.retryPartialSource
      ? !SHA.test(input.expectedExistingSourceDigestSha256??"")
      : input.expectedExistingSourceDigestSha256 != null)
    || typeof input.nowImpl !== "function") {
    throw new TypeError("PIT_NATIVE_MINUTE_BACKFILL_ARGUMENTS_INVALID");
  }
}
function eligibleLife(manifest, symbol, start, end) {
  const rows = manifest.memberships.filter(r =>
    String(r.symbol).trim().toUpperCase() === symbol
    && r.listedAtMs < end && (r.removedAtMs ?? Infinity) > start);
  if (rows.length !== 1) return rows.length === 0
    ? "HISTORIC_SYMBOL_NOT_IN_PIT_DAY" : "PIT_TICKER_REUSE_NEEDS_STABLE_IDENTIFIER";
  const row = rows[0];
  if (row.listedAtMs > start || (row.removedAtMs ?? Infinity) < end)
    return "PIT_INTRADAY_LISTING_OR_DELISTING_NEEDS_SESSION_PROOF";
  if (row.halts.some(h => h.startMs < end && h.endMs > start))
    return "PIT_HISTORIC_TRADING_HALT_NEEDS_SOURCE_PROOF";
  return null;
}
function expectedProviderFailure(error) {
  const code = String(error?.message ?? "");
  return isPublicHistorySourceDataErrorV1(error)
    || error instanceof BitgetPublicApiError
    || /^UPBIT_HISTORY_HTTP_\d{3}$/u.test(code)
    || /^UPBIT_HISTORY_(RANGE_INCOMPLETE|INSUFFICIENT_\d+)$/u.test(code)
    || /^BITGET_HISTORY_RANGE_INCOMPLETE$/u.test(code)
    || /^not enough candles collected: \d+$/u.test(code)
    || /^(?:fetch failed|network error|request timeout|The operation was aborted)$/iu.test(code);
}
export function normalizeRetrospectiveCryptoMinuteSourceV1({
  market, symbol, dayStartMs, receivedAtMs, collected, allowPartialSource = false,
} = {}) {
  if (typeof allowPartialSource !== "boolean")
    return { error: "NATIVE_1M_PARTIAL_SOURCE_OPTION_INVALID" };
  if (!Object.hasOwn(MARKET, market) || typeof symbol !== "string"
    || !(market === "CRYPTO_SPOT"
      ? /^KRW-[A-Z0-9]{1,20}$/u.test(symbol)
      : /^[A-Z0-9\p{Script=Han}]{1,26}USDT$/u.test(symbol)))
    return { error: "NATIVE_1M_SOURCE_IDENTITY_INVALID" };
  if (!Number.isSafeInteger(dayStartMs) || dayStartMs <= 0
    || dayStartMs % DAY !== 0 || dayStartMs + DAY > 8_640_000_000_000_000
    || !Number.isSafeInteger(receivedAtMs) || receivedAtMs < dayStartMs + DAY
    || receivedAtMs > 8_640_000_000_000_000)
    return { error: "NATIVE_1M_CAPTURE_CLOCK_OR_DAY_INVALID" };
  const policy = MARKET[market], end = dayStartMs + DAY;
  const correctSource = market === "CRYPTO_SPOT"
    ? collected?.market === market && collected?.providerMarket === symbol
      && collected?.source === "upbit-public-candles" && collected?.exchange === "UPBIT"
    : collected?.market === market && collected?.symbol === symbol
      && collected?.provider === "bitget-public-v2"
      && collected?.productType === "usdt-futures";
  const providerRequestWindowVerified = collected?.rawPageWindowTraversed === true
    && collected?.reachedRequestedStart === true;
  if (!correctSource || collected?.timeframe !== "1m"
    || collected?.intervalMs !== MIN
    || collected?.requestedStartTime !== dayStartMs
    || collected?.requestedEndTime !== end
    || typeof collected?.rawPageWindowTraversed !== "boolean"
    || typeof collected?.reachedRequestedStart !== "boolean"
    || (collected.rawPageWindowTraversed === true && collected.reachedRequestedStart === false)
    || (!allowPartialSource && !providerRequestWindowVerified)
    || collected?.historicalSignalAvailabilityProven !== false
    || collected?.actualFillProven !== false
    || !Array.isArray(collected.candles)
    || collected.candles.length < (allowPartialSource ? 1 : 2) || collected.candles.length > 1440) {
    return { error: "NATIVE_1M_PROVIDER_SCOPE_OR_HISTORY_UNVERIFIED" };
  }
  let previous = 0;
  const bars = [];
  for (const row of collected.candles) {
    const ts = row?.timestamp;
    if (!Number.isSafeInteger(ts) || ts < dayStartMs || ts + MIN > end
      || ts + MIN > receivedAtMs
      || ts % MIN !== 0 || ts <= previous
      || typeof row.open !== "number" || !Number.isFinite(row.open)
      || typeof row.high !== "number" || !Number.isFinite(row.high)
      || typeof row.low !== "number" || !Number.isFinite(row.low)
      || typeof row.close !== "number" || !Number.isFinite(row.close)
      || typeof row.volume !== "number" || !Number.isFinite(row.volume)
      || row.volume < 0 || row.high < Math.max(row.open,row.close)
      || row.low > Math.min(row.open,row.close) || row.low > row.high
      || [row.open,row.high,row.low,row.close].some(n=>n<=0)) {
      return { error: "NATIVE_1M_ROW_ORDER_OR_OHLC_INVALID" };
    }
    previous = ts;
    bars.push({
      market,venue:policy.venue,symbol,sourceId:policy.sourceId,
      timestampMs:ts,
      // Capture time is a conservative bound; never imply live as-of
      // publication at the original historical bar close.
      availableAtMs:Math.max(ts+MIN,receivedAtMs),
      open:row.open,high:row.high,low:row.low,close:row.close,volume:row.volume,
    });
  }
  const missingUnverifiedMinuteSlots = 1440 - bars.length;
  return {
    // These flags describe the actual provider pagination result, not an
    // independently attested universe or proof that missing minutes had no trades.
    providerRequestWindowVerified,
    providerRawPageWindowTraversed: collected.rawPageWindowTraversed,
    providerReachedRequestedStart: collected.reachedRequestedStart,
    sourcePartialReason: !providerRequestWindowVerified
      ? "PROVIDER_REQUEST_WINDOW_NOT_FULLY_TRAVERSED"
      : missingUnverifiedMinuteSlots > 0 ? "MISSING_MINUTE_SLOTS_NOT_PROVEN_NO_TRADES" : null,
    missingUnverifiedMinuteSlots,
    source:{
      market,venue:policy.venue,symbol,sourceId:policy.sourceId,
      session:{startMs:dayStartMs,endMs:end,kind:"UTC_24H",timeZone:"UTC",
        calendarSourceId:"RETROSPECTIVE_UTC_DAY_NOT_INDEPENDENT_PIT_PROOF"},
      minuteBars:bars,sourceMinuteRowsSha256:digest(bars),
      asOfMs:receivedAtMs,
    },
  };
}
export async function collectPITNativeCryptoMinuteSourceV1({
  root,market,symbol,dayStartMs,manifest=null,
  expectedRosterDigestSha256=null,
  allowPublicReadOnlyFetch=false,retryPartialSource=false,
  allowSourceLimitedArchive=false,
  expectedExistingSourceDigestSha256=null,
  nowImpl=()=>Date.now(),
  upbitFetchImpl=null,bitgetClient=null,
} = {}) {
  validate({root,market,symbol,dayStartMs,
    expectedRosterDigestSha256,allowPublicReadOnlyFetch,retryPartialSource,
    allowSourceLimitedArchive,expectedExistingSourceDigestSha256,nowImpl});
  const end=dayStartMs+DAY;
  const now=nowImpl();
  if (!Number.isSafeInteger(now) || now < end
    || now <= 0) return stop(market,symbol,dayStartMs,"HISTORIC_UTC_DAY_NOT_CLOSED");
  if (manifest?.rawMembershipDigestSha256 !== expectedRosterDigestSha256)
    return stop(market,symbol,dayStartMs,"PIT_ROSTER_DIGEST_LEASE_MISMATCH");
  const pit=auditHistoricalPITVenueUniverseV1({
    market,dayStartMs,dayEndMs:end,manifest,selectedRows:[],
  });
  if (!["TEST_FIXTURE_ONLY","SOURCE_ATTESTED_PIT_COHORT_ONLY"]
    .includes(pit.status))
    return stop(market,symbol,dayStartMs,"PIT_"+pit.reason);
  if (pit.status==="TEST_FIXTURE_ONLY")
    return stop(market,symbol,dayStartMs,
      "PIT_FIXTURE_NOT_ELIGIBLE_FOR_PUBLIC_SOURCE_BACKFILL");
  const life=eligibleLife(manifest,symbol,dayStartMs,end);
  if (life) return stop(market,symbol,dayStartMs,life);
  // Inspect before network I/O. Do not refetch retained complete data.
  const existing=await deriveArchivedResearchTimeframesV1({
    root,market,symbol,sessionStartMs:dayStartMs,asOfMs:now,
    timeframes:["1m"],
  });
  if(retryPartialSource&&existing.reason==="ARCHIVED_SESSION_NOT_FOUND")
    return stop(market,symbol,dayStartMs,"RETRY_EXISTING_PARTIAL_ARCHIVE_REQUIRED");
  if (existing.status==="BLOCKED_DATA"
    && existing.reason!=="ARCHIVED_SESSION_NOT_FOUND") {
    return stop(market,symbol,dayStartMs,
      "EXISTING_ARCHIVE_REQUIRES_MANUAL_SOURCE_REVIEW",{
        archiveReason:existing.reason,
      });
  }
  if (existing.sourceMinuteIntegrityVerified===true) {
    // Never retry a different source revision, a stale request, or an
    // ambiguous archive containing multiple immutable histories.
    if (retryPartialSource
      && (existing.archiveRevisionCount!==1
        || existing.archiveSourceDigestSha256!==expectedExistingSourceDigestSha256)) {
      return stop(market,symbol,dayStartMs,"RETRY_SOURCE_REVISION_DIGEST_MISMATCH",{
        currentSourceDigestSha256:existing.archiveSourceDigestSha256??null,
      });
    }
    const complete=existing.intervalData?.["1m"]?.sourceSessionCoverageComplete;
    if (complete===true) {
      return stop(market,symbol,dayStartMs,"ALREADY_RETAINED_COMPLETE_1M_SOURCE",{
        retainedOriginalMinuteCount:existing.sourceMinuteRows,
        existingSourceDigestSha256:existing.archiveSourceDigestSha256,
      });
    }
    if (!retryPartialSource) {
      return stop(market,symbol,dayStartMs,
        "EXISTING_PARTIAL_SOURCE_NEEDS_EXPLICIT_RETRY",{
          retainedOriginalMinuteCount:existing.sourceMinuteRows,
        });
    }
  }
  if (!allowPublicReadOnlyFetch)
    return stop(market,symbol,dayStartMs,"EXPLICIT_PUBLIC_READ_ONLY_OPT_IN_REQUIRED");
  let collected;
  try {
    collected=market==="CRYPTO_SPOT"
      ?await collectUpbitSpotHistory({
        symbol,timeframe:"1m",startTime:dayStartMs,endTime:end,
        minCandles:allowSourceLimitedArchive?1:2,
        maxPages:10,minIntervalMs:220,
        requireFullWindow:!allowSourceLimitedArchive,
        allowPartialSource:allowSourceLimitedArchive,
        requireMarketIdentity:true,
        ...(upbitFetchImpl?{fetchImpl:upbitFetchImpl}:{}),
      })
      :await collectBitgetCandles({
        client:bitgetClient??new BitgetPublicClient({
          timeoutMs:12_000,maxRetries:1,minIntervalMs:220,
        }),
        market,symbol,timeframe:"1m",startTime:dayStartMs,endTime:end,
        maxCandles:1600,minCandles:allowSourceLimitedArchive?1:2,
        maxPages:512,requireFullWindow:!allowSourceLimitedArchive,
        allowPartialSource:allowSourceLimitedArchive,
        productType:"usdt-futures",
      });
  } catch (error) {
    if (error?.message === "UPBIT_HISTORY_MARKET_IDENTITY_UNVERIFIED")
      return stop(market,symbol,dayStartMs,
        "NATIVE_PROVIDER_MARKET_IDENTITY_INVALID");
    if (!expectedProviderFailure(error)) throw error;
    return stop(market,symbol,dayStartMs,"NATIVE_1M_PROVIDER_DATA_UNAVAILABLE",{
      providerReason:String(error.message).slice(0,120),
    });
  }
  const collectedAtMs=nowImpl();
  if (!Number.isSafeInteger(collectedAtMs) || collectedAtMs < now
    || collectedAtMs < end) {
    throw new TypeError("PIT_NATIVE_MINUTE_PROVIDER_CLOCK_INVALID");
  }
  const parsed=normalizeRetrospectiveCryptoMinuteSourceV1({
    market,symbol,dayStartMs,receivedAtMs:collectedAtMs,collected,
    allowPartialSource:allowSourceLimitedArchive,
  });
  if (!parsed.source)
    return stop(market,symbol,dayStartMs,parsed.error);
  if (retryPartialSource) {
    // A later retrospective GET may have additional observed minutes, but it
    // must NOT delete or silently revise any previously stored OHLCV.
    // The as-of timestamp naturally becomes *later* at a re-download;
    // compare original OHLCV only and do not rewrite its earlier as-of.
    const oldBars=existing.intervalData?.["1m"]?.bars;
    if (!Array.isArray(oldBars)
      || oldBars.length!==existing.sourceMinuteRows
      || existing.archiveRevisionCount!==1) {
      return stop(market,symbol,dayStartMs,"RETRY_PREVIOUS_SOURCE_UNVERIFIABLE");
    }
    const freshByMinute=new Map(parsed.source.minuteBars
      .map(row=>[row.timestampMs,row]));
    for(const old of oldBars){
      const fresh=freshByMinute.get(old.startMs);
      if(!fresh)
        return stop(market,symbol,dayStartMs,"RETRY_PRIOR_MINUTE_DISAPPEARED");
      if(['open','high','low','close','volume']
        .some(key=>fresh[key]!==old[key]))
        return stop(market,symbol,dayStartMs,"RETRY_HISTORICAL_PRICE_CONFLICT");
    }
    if(parsed.source.minuteBars.length<=oldBars.length){
      return stop(market,symbol,dayStartMs,"RETRY_NO_ADDITIONAL_ORIGINAL_MINUTES",{
        retainedOriginalMinuteCount:existing.sourceMinuteRows,
        currentSourceDigestSha256:existing.archiveSourceDigestSha256,
      });
    }
  }
  const stored=await persistResearchMinuteSessionV1({
    root,source:parsed.source,
  });
  // A source-limited native archive is historical observation material,
  // NOT proof of no-trade intervals, PIT membership or prior scanner access.
  const sourceLimited=parsed.providerRequestWindowVerified!==true
    ||parsed.missingUnverifiedMinuteSlots>0;
  return Object.freeze({
    schemaVersion:"pit-native-crypto-minute-backfill-v1",
    status:retryPartialSource
      ?"RETROSPECTIVE_IMMUTABLE_SUPERSET_AWAITING_REVISION_REVIEW"
      :allowSourceLimitedArchive&&sourceLimited
        ?"RETROSPECTIVE_SOURCE_LIMITED_RETAINED_REVIEW_ONLY"
        :"RETROSPECTIVE_PRIVATE_SOURCE_RETAINED_ONLY",
    reason:retryPartialSource
      ?"EXPLICIT_ARCHIVE_REVISION_SELECTION_REQUIRED"
      :allowSourceLimitedArchive&&sourceLimited
        ?"SOURCE_LIMITED_ORIGINAL_1M_REQUIRES_MANUAL_REVIEW"
        :"HISTORICAL_SCANNER_PUBLICATION_NOT_ESTABLISHED",
    competingArchiveRevisionExists:retryPartialSource,
    priorSourceDigestSha256:retryPartialSource
      ?existing.archiveSourceDigestSha256:null,
    sourceRevisionAutoSelected:false,
    market,venue:MARKET[market].venue,symbol,dayStartMs,
    archiveStatus:stored.status,
    sourceMinuteCount:stored.storedOneMinuteRows,
    archiveSourceDigestSha256:stored.sourceDigestSha256,
    // Actual network *page* count, not necessarily HTTP retry attempts.
    requestedProviderPages:collected.requestedProviderPages??null,
    providerRequestWindowVerified:parsed.providerRequestWindowVerified,
    providerRawPageWindowTraversed:parsed.providerRawPageWindowTraversed,
    providerReachedRequestedStart:parsed.providerReachedRequestedStart,
    sourcePartialReason:parsed.sourcePartialReason,
    missingUnverifiedMinuteSlots:parsed.missingUnverifiedMinuteSlots,
    sourceLimitedOnly:sourceLimited,
    allowSourceLimitedArchiveUsed:allowSourceLimitedArchive,
    originalMinutePublicationTimeAssumed:false,
    availableAtMsConservativelyBoundToRetrieval:true,
    historicalFullMarketPITUniverseVerified:false,
    sourceHistoricalPublicationTimeProven:false,
    nativeMinutesNoTradeGapVerified:false,
    actualMarketWideOpportunityCount:null,trueMarketWideRecall:null,
    actualFillCount:null,netProfitPct:null,profitabilityProven:false,
    executionAuthority:"NONE",liveTrading:false,autoTrading:false,
    realOrders:false,privateTradingApiAllowed:false,
    sourceRedistributionAllowed:false,
  });
}
