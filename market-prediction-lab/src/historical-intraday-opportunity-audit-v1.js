import { computeSearchQualityMetrics } from "./search-quality-metrics-v1.js";

// Research-only bridge: a minute OHLC crossing is an INTERVAL, not a tick timestamp.
// This does not change the canonical OMS, Paper, or settlement execution engines.
const MINUTE_MS = 60_000;
const VENUE = Object.freeze({
  KR_STOCK: "KRX",
  US_STOCK: "US_SIP",
  CRYPTO_SPOT: "UPBIT_KRW",
  CRYPTO_FUTURES: "BITGET_USDT_FUTURES",
});
const THRESHOLDS_PCT = Object.freeze([5, 10, 20]);
const DISCOVERED = new Set(["CANDIDATE", "RANK_EXCLUDED", "ENTRY_BLOCKED", "EXECUTION_FAILED", "SIMULATED_FILL"]);
const STATES = new Set(["OBSERVED_NO_SIGNAL", "DATA_DELAYED", ...DISCOVERED]);
const WINDOWS_MIN = Object.freeze([60, 30, 15, 5]);

function validTime(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function finitePositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function symbolOf(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._:-]{0,39}$/.test(symbol)) throw new TypeError("INVALID_SYMBOL");
  return symbol;
}
function directionOf(value, market) {
  const normalized = String(value ?? "").toUpperCase();
  const direction = normalized === "BUY" || normalized === "LONG" ? "LONG" : normalized;
  if (direction !== "LONG" && !(market === "CRYPTO_FUTURES" && direction === "SHORT")) {
    throw new TypeError("MARKET_DIRECTION_NOT_ALLOWED");
  }
  return direction;
}
function blocked(market, reason, details = {}) {
  return Object.freeze({
    schemaVersion: "historical-intraday-opportunity-audit-v1",
    status: "BLOCKED_DATA", market, reason, details,
    opportunities: [], quality: null, observedOpportunityCount: null,
    trueMarketWideRecall: null, actualFillCount: null,
    fullMarketOpportunityDenominatorVerified: false,
    profitabilityProven: false, executionAuthority: "NONE",
  });
}
function validateCandle(row, intervalMs, session) {
  const symbol = symbolOf(row?.symbol);
  const timestampMs = row?.timestampMs;
  const availableAtMs = row?.availableAtMs;
  const { open, high, low, close, volume } = row ?? {};
  if (!validTime(timestampMs) || timestampMs % intervalMs !== 0
      || timestampMs < session.startMs || timestampMs + intervalMs > session.endMs
      || !validTime(availableAtMs) || availableAtMs < timestampMs + intervalMs
      || ![open, high, low, close].every(finitePositive)
      || typeof volume !== "number" || !Number.isFinite(volume) || volume < 0
      || high < Math.max(open, close) || low > Math.min(open, close) || low > high) {
    throw new TypeError("MINUTE_OHLCV_OR_AVAILABILITY_INVALID");
  }
  return { symbol, timestampMs, availableAtMs, open, high, low, close, volume };
}
function cutoffFeatures(sortedBars, cutoffMs) {
  const eligible = sortedBars.filter((bar) =>
    bar.timestampMs + MINUTE_MS <= cutoffMs && bar.availableAtMs <= cutoffMs);
  const last = eligible.at(-1);
  return last ? Object.freeze({
    cutoffMs, lastBarStartMs: last.timestampMs,
    lastClose: last.close,
    lastBarVolume: last.volume,
    // Historical candle highs/lows and volumes after cutoff are NEVER read here.
    barsAvailable: eligible.length,
  }) : null;
}
function latestPrior(rows, symbol, direction, beforeMs) {
  return rows.filter((row) => row.symbol === symbol && row.direction === direction
    && row.availableAtMs < beforeMs).at(-1) ?? null;
}


const EMPTY_REASONS = new Set(["NO_TRADES", "TRADING_HALT"]);

/**
 * Closed-minute proof: bar intervals and explicitly verified empty ranges must
 * tile the session exactly. A bool such as noTradeGapsChecked cannot stand in
 * for the missing range evidence. Source claims are still cohort-only, not
 * market-wide completeness attestation.
 *
 * Complexity: O((bars + ranges) log(bars + ranges)) per symbol/session.
 */
function verifyMinutePartition({ symbol, session, receipt, series, intervalMs }) {
  if (!Array.isArray(receipt?.verifiedEmptyRanges)) {
    return { reason:"MINUTE_EMPTY_RANGE_MANIFEST_MISSING", symbol };
  }
  const spans = series.map((bar) => ({
    startMs:bar.timestampMs, endMs:bar.timestampMs + intervalMs,
    kind:"BAR",
  }));
  let emptyMinutes = 0;
  for (const [index, range] of receipt.verifiedEmptyRanges.entries()) {
    if (!validTime(range?.startMs) || !validTime(range?.endMs)
        || range.startMs >= range.endMs
        || range.startMs % intervalMs !== 0 || range.endMs % intervalMs !== 0
        || range.startMs < session.startMs || range.endMs > session.endMs
        || !EMPTY_REASONS.has(range?.reason)
        || range.exhaustiveSourcePagesVerified !== true
        || String(range?.sourceId ?? "") !== String(receipt?.sourceId ?? "")
        || !String(range?.evidenceId ?? "").trim()) {
      return { reason:"UNVERIFIED_EMPTY_MINUTE_RANGE", symbol, index };
    }
    emptyMinutes += (range.endMs - range.startMs) / intervalMs;
    spans.push({ startMs:range.startMs, endMs:range.endMs, kind:"PROVEN_EMPTY" });
  }
  spans.sort((a,b) => a.startMs - b.startMs || a.endMs - b.endMs);
  let cursor = session.startMs;
  for (const span of spans) {
    if (span.startMs > cursor) {
      return { reason:"UNVERIFIED_ONE_MINUTE_GAP", symbol,
        missingStartMs:cursor, missingEndMs:span.startMs };
    }
    if (span.startMs < cursor) {
      return { reason:"MINUTE_BAR_EMPTY_RANGE_CONFLICT", symbol,
        conflictStartMs:span.startMs, previousEndMs:cursor };
    }
    cursor = span.endMs;
  }
  if (cursor < session.endMs) return { reason:"UNVERIFIED_ONE_MINUTE_GAP", symbol,
    missingStartMs:cursor, missingEndMs:session.endMs };
  if (cursor !== session.endMs) return { reason:"MINUTE_RANGE_OUTSIDE_SESSION", symbol };
  return { reason:null, symbol, verifiedCandleMinutes:series.length,
    verifiedEmptyMinutes:emptyMinutes };
}

/**
 * Provider-normalized input, NEVER raw exchange data without provenance:
 * universe: { sourceId, pointInTimeVerified, delistedIncluded,
 *   suspendedIncluded, expectedActiveSymbols, symbols:[{symbol,priorClose,
 *   baselineAvailableAtMs}] }
 * coverage: one {symbol, status:"VERIFIED_COMPLETE"|"VERIFIED_NO_TRADES",
 *   sourceId, startMs, endMs, noTradeGapsChecked:true,
 *   verifiedEmptyRanges:[{startMs,endMs,reason:"NO_TRADES"|"TRADING_HALT",
 *     sourceId,evidenceId,exhaustiveSourcePagesVerified:true}]} per PIT symbol.
 *   Missing 1m intervals MUST be covered by explicit source-evidenced ranges.
 *   A missing Upbit candle is not automatically NO_TRADES.
 * bars: closed 1m OHLCV with timestampMs=OPEN and actual availableAtMs.
 * scannerObservations: {symbol,direction,state,availableAtMs,dataCutoffMs,
 *   signalId (required for discovered states)}. States are evidenced claims,
 *   not invented fills. watchedSymbols is contemporaneous scanner coverage.
 *
 * A complete-looking manifest is still only producer ATTESTATION: market-wide
 * membership, completeness, actual fills, and profitability stay unproven.
 */
export function auditHistoricalIntradayOpportunitiesV1({
  market, venue, session, universe, coverage = [], bars = [],
  scannerObservations = [], watchedSymbols = null, intervalMs = MINUTE_MS,
  maxScannerLagMs = 180_000,
} = {}) {
  if (!Object.hasOwn(VENUE, market)) throw new TypeError("MARKET_INVALID");
  if (intervalMs !== MINUTE_MS) throw new TypeError("ONE_MINUTE_ONLY");
  if (!Number.isSafeInteger(maxScannerLagMs) || maxScannerLagMs < 0) {
    throw new TypeError("SCANNER_LAG_LIMIT_INVALID");
  }
  if (!session || !validTime(session.startMs) || !validTime(session.endMs)
      || session.endMs <= session.startMs
      || session.startMs % intervalMs !== 0 || session.endMs % intervalMs !== 0
      || typeof session.id !== "string" || !session.id.trim()) {
    throw new TypeError("SESSION_INVALID");
  }
  if (venue !== VENUE[market]) return blocked(market, "EXECUTION_VENUE_MISMATCH", {expected: VENUE[market], actual: venue ?? null});
  if (!universe || universe.syntheticHistoricalData === true
      || universe.pointInTimeVerified !== true || universe.delistedIncluded !== true
      || universe.suspendedIncluded !== true || !String(universe.sourceId ?? "").trim()
      || !Array.isArray(universe.symbols) || !universe.symbols.length
      || !Number.isSafeInteger(universe.expectedActiveSymbols)
      || universe.expectedActiveSymbols !== universe.symbols.length) {
    return blocked(market, "POINT_IN_TIME_UNIVERSE_NOT_ATTESTED");
  }
  if (![coverage, bars, scannerObservations].every(Array.isArray)) throw new TypeError("ARRAY_INPUT_REQUIRED");
  if (watchedSymbols != null && !Array.isArray(watchedSymbols)) throw new TypeError("WATCHLIST_INVALID");

  const membership = new Map();
  for (const row of universe.symbols) {
    const symbol = symbolOf(row?.symbol);
    if (membership.has(symbol)) throw new TypeError("DUPLICATE_PIT_SYMBOL");
    if (!finitePositive(row?.priorClose) || !validTime(row?.baselineAvailableAtMs)
        || row.baselineAvailableAtMs > session.startMs) {
      return blocked(market, "PRIOR_BASELINE_NOT_CAUSALLY_AVAILABLE", {symbol});
    }
    membership.set(symbol, {priorClose:row.priorClose, baselineAvailableAtMs:row.baselineAvailableAtMs});
  }
  const coverageBySymbol = new Map();
  for (const row of coverage) {
    const symbol = symbolOf(row?.symbol);
    if (!membership.has(symbol) || coverageBySymbol.has(symbol)) throw new TypeError("COVERAGE_SYMBOL_DUPLICATE_OR_OUTSIDE_UNIVERSE");
    coverageBySymbol.set(symbol, row);
  }
  const unsupported = [...membership.keys()].filter((symbol) => {
    const c = coverageBySymbol.get(symbol);
    return !c || !["VERIFIED_COMPLETE", "VERIFIED_NO_TRADES"].includes(c.status)
      || !String(c.sourceId ?? "").trim()
      || !validTime(c.startMs) || !validTime(c.endMs)
      || c.startMs > session.startMs || c.endMs < session.endMs
      || c.noTradeGapsChecked !== true;
  });
  if (unsupported.length) return blocked(market, "INTRADAY_SOURCE_COVERAGE_MISSING", {blockedSymbols:unsupported.slice(0,100), blockedCount:unsupported.length});

  const bySymbol = new Map([...membership.keys()].map((symbol) => [symbol, []]));
  const seen = new Set();
  for (const raw of bars) {
    const candle = validateCandle(raw, intervalMs, session);
    if (!membership.has(candle.symbol)) throw new TypeError("CANDLE_OUTSIDE_PIT_UNIVERSE");
    const key = candle.symbol + ":" + candle.timestampMs;
    if (seen.has(key)) return blocked(market, "DUPLICATE_MINUTE_CANDLE", {key});
    seen.add(key);
    bySymbol.get(candle.symbol).push(candle);
  }
  let verifiedCandleMinutes = 0;
  let verifiedEmptyMinutes = 0;
  for (const [symbol, series] of bySymbol) {
    series.sort((a,b) => a.timestampMs - b.timestampMs);
    const receipt = coverageBySymbol.get(symbol);
    const status = receipt.status;
    if ((status === "VERIFIED_COMPLETE" && !series.length)
        || (status === "VERIFIED_NO_TRADES" && series.length)) {
      return blocked(market, "SOURCE_COVERAGE_CONTRADICTS_BARS", {symbol});
    }
    const proof = verifyMinutePartition({symbol,session,receipt,series,intervalMs});
    if (proof.reason) return blocked(market, proof.reason, proof);
    verifiedCandleMinutes += proof.verifiedCandleMinutes;
    verifiedEmptyMinutes += proof.verifiedEmptyMinutes;
  }
  // A current-day/survivor ticker set alone cannot qualify as an active PIT list.
  const watched = watchedSymbols == null ? null : new Set(watchedSymbols.map(symbolOf));
  const scans = scannerObservations.map((raw) => {
    const symbol = symbolOf(raw?.symbol);
    const direction = directionOf(raw?.direction, market);
    if (!membership.has(symbol)) throw new TypeError("SCANNER_SYMBOL_OUTSIDE_PIT_UNIVERSE");
    if (!STATES.has(raw?.state) || !validTime(raw?.availableAtMs)
        || !validTime(raw?.dataCutoffMs)
        || raw.dataCutoffMs > raw.availableAtMs
        || raw.availableAtMs < session.startMs || raw.availableAtMs >= session.endMs
        || (DISCOVERED.has(raw.state) && !String(raw?.signalId ?? "").trim())) {
      throw new TypeError("SCANNER_CAUSAL_PROVENANCE_INVALID");
    }
    // A stale feed is a data-delay observation, NEVER an early discovery.
    const state = raw.availableAtMs - raw.dataCutoffMs > maxScannerLagMs
      ? "DATA_DELAYED" : raw.state;
    return {symbol, direction, state,
      availableAtMs:raw.availableAtMs, dataCutoffMs:raw.dataCutoffMs,
      signalId: String(raw?.signalId ?? "").trim()};
  }).sort((a,b) => a.availableAtMs - b.availableAtMs);
  const opportunities = [];
  const reasonCounts = {};
  const directions = market === "CRYPTO_FUTURES" ? ["LONG","SHORT"] : ["LONG"];
  for (const [symbol, series] of bySymbol) {
    const baseline = membership.get(symbol).priorClose;
    for (const direction of directions) {
      for (const thresholdPct of THRESHOLDS_PCT) {
        const threshold = thresholdPct / 100;
        const crossing = series.find((bar) => direction === "LONG"
          ? bar.high >= baseline * (1 + threshold)
          : bar.low <= baseline * (1 - threshold));
        if (!crossing) continue;
        const first = latestPrior(scans, symbol, direction, crossing.timestampMs);
        const priorCandidate = scans.find((row) => row.symbol === symbol && row.direction === direction
          && DISCOVERED.has(row.state) && row.availableAtMs < crossing.timestampMs);
        // A later OBSERVED_NO_SIGNAL must not hide this candidate's subsequent
        // RANK/ENTRY/EXECUTION stage; follow the SAME signalId before crossing.
        const candidateStage = priorCandidate ? scans.filter((row) =>
          row.symbol === symbol && row.direction === direction
          && row.signalId === priorCandidate.signalId && DISCOVERED.has(row.state)
          && row.availableAtMs < crossing.timestampMs).at(-1) : null;
        const discovery = !!priorCandidate;
        let reason = "DISCOVERED_BEFORE_CROSSING";
        if (!discovery) {
          reason = watched == null ? "WATCHLIST_NOT_ATTESTED"
            : !watched.has(symbol) ? "UNIVERSE_MISSING"
            : !first ? "SCANNER_EVIDENCE_MISSING"
            : first.state === "DATA_DELAYED" ? "DATA_DELAYED"
            : first.state === "OBSERVED_NO_SIGNAL" ? "SIGNAL_MISSED"
            : "DISCOVERY_TIMING_NOT_ATTESTED";
        } else if (candidateStage?.state === "RANK_EXCLUDED"
          || candidateStage?.state === "ENTRY_BLOCKED"
          || candidateStage?.state === "EXECUTION_FAILED") {
          reason = candidateStage.state;
        } else if (candidateStage?.state === "CANDIDATE") {
          reason = "ENTRY_OUTCOME_NOT_ATTESTED";
        } else if (candidateStage?.state === "SIMULATED_FILL") {
          reason = "SIMULATED_FILL_NOT_ACTUAL_EXECUTION";
        }
        reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
        opportunities.push(Object.freeze({
          opportunityId: [market,session.id,symbol,direction,thresholdPct].join(":"),
          horizonKey: "FIRST_" + thresholdPct + "PCT",
          market, sessionId:session.id, symbol, direction, thresholdPct,
          firstCrossingBarStartMs:crossing.timestampMs,
          firstCrossingBarEndMs:crossing.timestampMs + intervalMs,
          firstCrossingExactTickTimestampMs:null,
          firstBarAvailableAtMs:crossing.availableAtMs,
          openedAlreadyBeyondThreshold: crossing.timestampMs === session.startMs &&
            (direction === "LONG" ? crossing.open >= baseline * (1 + threshold)
              : crossing.open <= baseline * (1 - threshold)),
          discoveredBeforeCrossing: discovery,
          firstPreCrossingSignalAtMs:priorCandidate?.availableAtMs ?? null,
          missingOrEntryReason:reason,
          tMinusFeatures:Object.fromEntries(WINDOWS_MIN.map((min) => [
            "T_MINUS_" + min,
            cutoffFeatures(series,crossing.timestampMs - min * MINUTE_MS),
          ])),
        }));
      }
    }
  }
  // Reuse canonical search-quality math. A logged candidate is never a fill.
  const uniqueSignals = new Map();
  for (const scan of scans) {
    if (!DISCOVERED.has(scan.state)) continue;
    const previous = uniqueSignals.get(scan.signalId);
    if (previous && (previous.symbol !== scan.symbol || previous.direction !== scan.direction)) {
      throw new TypeError("SIGNAL_ID_REUSED_FOR_DIFFERENT_OPPORTUNITIES");
    }
    if (!previous) uniqueSignals.set(scan.signalId, scan);
  }
  const settledSignals = [];
  for (const scan of uniqueSignals.values()) {
    for (const pct of THRESHOLDS_PCT) {
      const horizonKey = "FIRST_" + pct + "PCT";
      const target = opportunities.find((event) => event.symbol === scan.symbol
        && event.direction === scan.direction && event.thresholdPct === pct
        && scan.availableAtMs < event.firstCrossingBarStartMs);
      settledSignals.push({
        signalId:scan.signalId + ":" + pct, market,
        symbol:scan.symbol, direction:scan.direction, horizonKey,
        hit:!!target, matchedOpportunityId:target?.opportunityId ?? null,
        leadTimeMs:target ? target.firstCrossingBarStartMs - scan.availableAtMs : null,
        returnPct:null,
      });
    }
  }
  const groundTruthOpportunities = opportunities.map(({opportunityId,horizonKey}) => ({opportunityId,horizonKey}));
  const quality = computeSearchQualityMetrics({settledSignals,groundTruthOpportunities});
  return Object.freeze({
    schemaVersion:"historical-intraday-opportunity-audit-v1",
    status:"OBSERVED_COHORT_ONLY", market, venue, sessionId:session.id,
    timeframe:"1m", thresholdPcts:THRESHOLDS_PCT, maxScannerLagMs,
    universeSourceId:universe.sourceId,
    universeSymbolCount:membership.size, coveredSymbolCount:coverageBySymbol.size,
    sourceMinuteCoverage:"EXPLICIT_BAR_OR_VERIFIED_EMPTY_INTERVAL_PARTITION",
    verifiedCandleMinutes, verifiedEmptyMinutes,
    observedOpportunityCount:opportunities.length, reasonCounts,
    opportunities, quality,
    // Intrabar order is unobservable in OHLC. Only interval + bar availability proven.
    intrabarFirstCrossingTimestampKnown:false,
    tMinusFeaturesUseFullyAvailableBarsOnly:true,
    scannerAvailabilityRequired:true,
    venueMatched:true,
    fullMarketOpportunityDenominatorVerified:false,
    trueMarketWideRecall:null, actualFillCount:null,
    costAdjustedProfitabilityProven:false, profitabilityProven:false,
    statusNotEligibleForLivePromotion:true, executionAuthority:"NONE",
  });
}
