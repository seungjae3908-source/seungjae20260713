import { ScannerUniverseService } from "../../api-server/src/services/scanner-universe.service.ts";
import { createBoundedScannerService } from "../../api-server/src/services/bounded-scanner.service.ts";
import { applyStockSignalPolicy } from "../../api-server/src/services/scanner-signal-policy.service.ts";
import { applyScannerQuantHardening } from "../../api-server/src/services/scanner-quant-hardening.service.ts";
import { applyScannerMarketProfile } from "../../api-server/src/services/scanner-market-profile-overlay.service.ts";
import { applyScannerSignalLifecycle } from "../../api-server/src/services/scanner-signal-lifecycle.service.ts";
import { rankScannerCandidates } from "../../api-server/src/services/scanner-candidate-ranking.service.ts";
import { createCryptoSignalScannerService } from "../../api-server/src/services/crypto-signal-scanner.service.ts";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
import { collectUpbitSpotHistory } from "../src/upbit-spot-history.js";
import { runCanonicalMeaningfulSearchRuntime } from "../src/canonical-scanner-meaningful-search-runtime-v1.js";
import {
  canonicalHardRejectReasons,
  classifyProviderFailure,
  nextCoverageCursor,
  parseNasdaqTraderDirectories,
  primarySecondaryReasons,
  separateInternalAndDisplayCandidates,
  withPublicProviderRetry,
} from "../src/public-coverage-audit-v1.js";

const MEMBER_ID = "public-meaningful-search-audit";
const STOCK_BATCH_SIZE = 40;
const CRYPTO_BATCH_SIZE = 40;
const DAY_MS = 24 * 60 * 60 * 1_000;
const UPBIT_BASE = "https://api.upbit.com";
const NASDAQ_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt";
const OTHER_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt";

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function increment(counts, key, amount = 1) {
  if (!key || amount <= 0) return;
  counts[key] = (counts[key] ?? 0) + amount;
}

function createStartScheduler(minIntervalMs) {
  let tail = Promise.resolve();
  let nextStartAt = 0;
  return async (operation) => {
    let release;
    const previous = tail;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    const delayMs = Math.max(0, nextStartAt - Date.now());
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    nextStartAt = Date.now() + minIntervalMs;
    release();
    return operation();
  };
}

function linkedSignal(parent, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("PUBLIC_PROVIDER_TIMEOUT")), timeoutMs);
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

function createPublicFetch({ minIntervalMs, timeoutMs, maxAttempts }) {
  const schedule = createStartScheduler(minIntervalMs);
  return async (url, options = {}) => withPublicProviderRetry(async () => {
    const linked = linkedSignal(options.signal, timeoutMs);
    try {
      const response = await schedule(() => fetch(url, { ...options, signal: linked.signal }));
      if (!response.ok) {
        const error = Object.assign(new Error(`PUBLIC_HTTP_${response.status}`), { status: response.status });
        const retryAfter = Number(response.headers.get("retry-after"));
        if (Number.isFinite(retryAfter)) error.retryAfterMs = retryAfter * 1_000;
        throw error;
      }
      return response;
    } finally {
      linked.clear();
    }
  }, { maxAttempts, baseBackoffMs: 250 });
}

const directoryFetch = createPublicFetch({ minIntervalMs: 25, timeoutMs: 12_000, maxAttempts: 3 });
const upbitFetch = createPublicFetch({ minIntervalMs: 110, timeoutMs: 3_000, maxAttempts: 4 });
const bitgetFetch = createPublicFetch({ minIntervalMs: 5, timeoutMs: 3_000, maxAttempts: 3 });
const yahooSchedule = createStartScheduler(20);

async function yahooFetch(url, options = {}) {
  return yahooSchedule(() => fetch(url, options));
}

let stockUniversesPromise;

async function loadStockUniverses() {
  if (stockUniversesPromise) return stockUniversesPromise;
  stockUniversesPromise = (async () => {
    const kr = await ScannerUniverseService.get("KR");
    let us;
    try {
      const [nasdaqResponse, otherResponse] = await Promise.all([
        directoryFetch(NASDAQ_LISTED_URL, { headers: { accept: "text/plain", "user-agent": "seungjae-public-coverage-audit/1.0" } }),
        directoryFetch(OTHER_LISTED_URL, { headers: { accept: "text/plain", "user-agent": "seungjae-public-coverage-audit/1.0" } }),
      ]);
      us = parseNasdaqTraderDirectories({
        nasdaqText: await nasdaqResponse.text(),
        otherText: await otherResponse.text(),
      });
    } catch (error) {
      const fallback = await ScannerUniverseService.get("US");
      us = {
        source: fallback.source,
        rawTotal: fallback.totalCount,
        eligibleTotal: fallback.totalCount,
        entries: fallback.entries,
        exclusionReasons: { US_PUBLIC_DIRECTORY_FAILED: 1 },
        partial: true,
        providerError: classifyProviderFailure(error),
      };
    }
    return {
      KR_STOCK: {
        source: kr.source,
        rawTotal: kr.totalCount,
        eligibleTotal: kr.totalCount,
        entries: kr.entries,
        exclusionReasons: {},
        partial: kr.partial || kr.stale,
      },
      US_STOCK: us,
    };
  })();
  return stockUniversesPromise;
}

function yahooProviderSymbol(market, entry) {
  if (market === "US_STOCK") return entry.ticker;
  if (/\.K[QS]$/u.test(entry.ticker)) return entry.ticker;
  const exchange = String(entry.exchange ?? "").toUpperCase();
  return `${entry.ticker}${/KOSDAQ|코스닥/u.test(exchange) ? ".KQ" : ".KS"}`;
}

function toStockCandles(snapshot) {
  return snapshot.candles.map((candle) => ({
    time: candle.timestamp,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  }));
}

function quoteFromCandles(candles) {
  const latest = candles.at(-1);
  const previous = candles.at(-2);
  if (!latest || !previous) throw new Error("YAHOO_STOCK_INSUFFICIENT_HISTORY");
  const changeAmount = latest.close - previous.close;
  const recent = candles.slice(-252);
  return {
    price: latest.close,
    changeAmount,
    changePercent: previous.close > 0 ? changeAmount / previous.close * 100 : Number.NaN,
    volume: latest.volume,
    marketCap: Number.NaN,
    week52High: Math.max(...recent.map((row) => row.high)),
    week52Low: Math.min(...recent.map((row) => row.low)),
  };
}

function createYahooHistoryStore(market) {
  const successes = new Map();
  const pending = new Map();
  const failures = new Map();
  const attempts = new Map();
  const key = (entry) => entry.ticker;
  async function load(entry) {
    const id = key(entry);
    if (successes.has(id)) return successes.get(id);
    if (pending.has(id)) return pending.get(id);
    attempts.set(id, (attempts.get(id) ?? 0) + 1);
    const now = Date.now();
    const promise = collectYahooStockHistory({
      market,
      symbol: yahooProviderSymbol(market, entry),
      startTime: now - 420 * DAY_MS,
      endTime: now,
      timeoutMs: 1_800,
      fetchImpl: yahooFetch,
    }).then((snapshot) => {
      const candles = toStockCandles(snapshot);
      const value = { snapshot, candles, quote: quoteFromCandles(candles) };
      successes.set(id, value);
      failures.delete(id);
      return value;
    }).catch((error) => {
      failures.set(id, { classification: classifyProviderFailure(error), message: String(error?.message ?? error).slice(0, 160) });
      throw error;
    }).finally(() => pending.delete(id));
    pending.set(id, promise);
    return promise;
  }
  return {
    getCandles: async (entry) => (await load(entry)).candles,
    getQuote: async (entry) => (await load(entry)).quote,
    peekCandles: (entry) => successes.get(key(entry))?.candles ?? [],
    snapshot(entries) {
      const providerFailureClassifications = {};
      let success = 0;
      let failed = 0;
      let notStarted = 0;
      let retries = 0;
      const failureRows = [];
      for (const entry of entries) {
        const id = key(entry);
        retries += Math.max(0, (attempts.get(id) ?? 0) - 1);
        if (successes.has(id)) success += 1;
        else if (failures.has(id)) {
          failed += 1;
          const failure = failures.get(id);
          increment(providerFailureClassifications, failure.classification);
          failureRows.push({ symbol: id, ...failure });
        } else notStarted += 1;
      }
      if (market === "KR_STOCK") increment(providerFailureClassifications, "FALLBACK_USED", success);
      return { success, failed, notStarted, retries, failureRows, providerFailureClassifications };
    },
  };
}

const yahooStores = { KR_STOCK: createYahooHistoryStore("KR_STOCK"), US_STOCK: createYahooHistoryStore("US_STOCK") };

async function boundedPublicStockScan(market, entries) {
  const store = yahooStores[market];
  const entryByTicker = new Map(entries.map((entry) => [entry.ticker, entry]));
  const scanner = createBoundedScannerService({
    catalog: entries,
    getCandles: (ticker) => store.getCandles(entryByTicker.get(ticker)),
    getQuote: (ticker) => store.getQuote(entryByTicker.get(ticker)),
    getContext: async (entry) => ({ currency: entry.currency }),
    now: Date.now,
  });
  return scanner.scan(market === "KR_STOCK" ? "KR" : "US", [], {
    timeframe: "1D",
    minimumScore: undefined,
    maximumRiskScore: undefined,
  }, { deadlineMs: 12_000, itemTimeoutMs: 4_000, concurrency: 6, limit: entries.length || 1 });
}

function rankAllInternal(cards, market) {
  const internal = [];
  for (let cursor = 0; cursor < cards.length; cursor += 10) {
    internal.push(...rankScannerCandidates({
      cards: cards.slice(cursor, cursor + 10),
      market: market === "KR_STOCK" ? "KR" : "US",
      strategy: "swing",
      limit: 10,
    }).cards);
  }
  return internal;
}

async function scanPublicStockBatch(market, cursor) {
  const universes = await loadStockUniverses();
  const universe = universes[market];
  const entries = universe.entries.slice(cursor, cursor + STOCK_BATCH_SIZE);
  const store = yahooStores[market];
  let raw = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { raw = await boundedPublicStockScan(market, entries); } catch (error) { lastError = error; }
    const state = store.snapshot(entries);
    if (state.notStarted === 0 && (state.failed === 0 || attempt === 3)) break;
  }
  const state = store.snapshot(entries);
  if (!raw && state.success > 0) {
    const successfulEntries = entries.filter((entry) => store.peekCandles(entry).length > 0);
    try { raw = await boundedPublicStockScan(market, successfulEntries); } catch (error) { lastError = error; }
  }

  const entryByTicker = new Map(entries.map((entry) => [entry.ticker, entry]));
  const broadCandidates = (raw?.cards ?? []).map((card) => {
    const entry = entryByTicker.get(card.ticker);
    if (!entry) return null;
    const candles = store.peekCandles(entry);
    const policy = applyStockSignalPolicy({ memberId: MEMBER_ID, card, universeEntry: entry, candles, selected: [], timeframe: "1D" });
    const quant = applyScannerQuantHardening({
      card: policy, timeframe: "1D", candles, contextCandles: [], strategyMode: "swing", allowShort: false, sessionAware: true,
    });
    return applyScannerMarketProfile({ card: quant, profile: market, candles, strategyMode: "swing" });
  }).filter(Boolean);

  const hardRejects = broadCandidates.flatMap((card) => {
    const reasons = canonicalHardRejectReasons(card);
    return reasons.length ? [{ symbol: card.symbol, ...primarySecondaryReasons(reasons) }] : [];
  });
  const displayRanking = rankScannerCandidates({ cards: broadCandidates, market: market === "KR_STOCK" ? "KR" : "US", strategy: "swing", limit: 10 });
  const internalCards = rankAllInternal(broadCandidates, market);
  const displayCards = applyScannerSignalLifecycle(MEMBER_ID, displayRanking.cards).cards;
  const separated = separateInternalAndDisplayCandidates(internalCards, displayCards);
  const timeoutCount = state.failureRows.filter((failure) => failure.classification === "TIMEOUT").length;
  const failedWithoutTimeout = Math.max(0, state.failed - timeoutCount);
  const nextCursor = nextCoverageCursor({ cursor, batchLength: entries.length, totalCount: universe.eligibleTotal });
  const failures = state.failureRows.map((failure) => ({
    symbol: failure.symbol, reason: "provider_error", classification: failure.classification,
    primaryRejectReason: failure.classification, message: failure.message,
  }));
  if (!raw && lastError && !failures.length && entries.length) {
    const classification = classifyProviderFailure(lastError);
    failures.push({ symbol: "*", reason: "provider_error", classification, primaryRejectReason: classification, message: String(lastError?.message ?? lastError).slice(0, 160) });
    increment(state.providerFailureClassifications, classification);
  }
  return {
    universe: { totalCount: universe.eligibleTotal, cursor, nextCursor, source: universe.source, partial: universe.partial, stale: false },
    execution: {
      requestedCount: entries.length,
      startedCount: entries.length - state.notStarted,
      completedCount: state.success,
      providerAcceptedCount: state.success,
      providerErrorCount: failedWithoutTimeout,
      timeoutCount,
      requiredProviderFailureCount: state.failed,
      optionalProviderMissingCount: cursor === 0 ? 1 : 0,
      insufficientDataCount: state.failureRows.filter((failure) => failure.classification === "INSUFFICIENT_HISTORY").length,
      filteredByStrategyCount: raw?.filteredByStrategyCount ?? 0,
      hardFilterPassCount: separated.internalCandidateCount,
      hardFilterRejectedCount: hardRejects.length,
      softCandidateCount: separated.internalCandidateCount,
      finalDisplayedCount: separated.displayCandidateCount,
      partial: state.failed > 0 || state.notStarted > 0 || universe.partial,
      timedOut: timeoutCount > 0 || state.notStarted > 0,
      providerFailureClassifications: state.providerFailureClassifications,
    },
    cards: displayCards,
    failures,
    audit: {
      rangeEnd: cursor + entries.length,
      requestSkippedCount: 0,
      requestSkippedReasons: {},
      historyOkCount: state.success,
      historyFailCount: state.failed,
      insufficientHistoryCount: state.failureRows.filter((failure) => failure.classification === "INSUFFICIENT_HISTORY").length,
      hardRejects,
      internalCards: separated.internalCards,
      providerFailureClassifications: state.providerFailureClassifications,
      universeScope: { rawTotal: universe.rawTotal, eligibleScopeDefined: true, exclusionReasons: universe.exclusionReasons },
      retries: state.retries,
      uiTopNSeparated: separated.evidencePreserved,
    },
  };
}

let upbitUniversePromise;

async function loadUpbitUniverse(signal) {
  if (upbitUniversePromise) return upbitUniversePromise;
  upbitUniversePromise = (async () => {
    const marketResponse = await upbitFetch(`${UPBIT_BASE}/v1/market/all?isDetails=true`, { signal, headers: { accept: "application/json" } });
    const marketRows = await marketResponse.json();
    const listed = (Array.isArray(marketRows) ? marketRows : [])
      .filter((row) => String(row?.market ?? "").startsWith("KRW-"))
      .map((row) => ({ market: String(row.market), symbol: String(row.market).replace(/^KRW-/u, ""), name: String(row.korean_name ?? row.market), warning: String(row.market_warning ?? "NONE") !== "NONE" }));
    const tickerRows = [];
    for (let cursor = 0; cursor < listed.length; cursor += 100) {
      const chunk = listed.slice(cursor, cursor + 100);
      const response = await upbitFetch(`${UPBIT_BASE}/v1/ticker?markets=${encodeURIComponent(chunk.map((row) => row.market).join(","))}`, { signal, headers: { accept: "application/json" } });
      const payload = await response.json();
      if (!Array.isArray(payload)) throw new Error("UPBIT_TICKERS_BAD_RESPONSE");
      tickerRows.push(...payload);
    }
    const meta = new Map(listed.map((row) => [row.market, row]));
    const rows = tickerRows.map((row) => {
      const info = meta.get(String(row?.market ?? ""));
      const price = finite(row?.trade_price);
      if (!info || price == null || price <= 0) return null;
      return {
        symbol: info.symbol, name: info.name, price,
        changePercent: (finite(row?.signed_change_rate) ?? 0) * 100,
        volume: finite(row?.acc_trade_volume_24h),
        tradingValue: finite(row?.acc_trade_price_24h),
        bid: null, ask: null, fundingRate: null, openInterest: null,
        timestamp: finite(row?.timestamp), warning: info.warning,
      };
    }).filter((row) => row && row.volume != null && row.tradingValue != null)
      .sort((left, right) => right.tradingValue - left.tradingValue || left.symbol.localeCompare(right.symbol));
    if (!rows.length) throw new Error("UPBIT_TICKERS_BAD_RESPONSE");
    return { rows, source: "upbit-public", providerErrorCount: 0, rawTotal: listed.length };
  })();
  try { return await upbitUniversePromise; } catch (error) { upbitUniversePromise = null; throw error; }
}

function createUpbitEvidenceStore() {
  const candles = new Map();
  const spreads = new Map();
  const candlePending = new Map();
  const spreadPending = new Map();
  const failures = new Map();
  const attempts = new Map();
  const loadCandles = async (symbol, timeframe, signal) => {
    if (timeframe !== "4H") return [];
    if (candles.has(symbol)) return candles.get(symbol);
    if (candlePending.has(symbol)) return candlePending.get(symbol);
    attempts.set(symbol, (attempts.get(symbol) ?? 0) + 1);
    const now = Date.now();
    const promise = collectUpbitSpotHistory({
      symbol, startTime: now - 40 * DAY_MS, endTime: now, maxPages: 1, minIntervalMs: 0, signal, fetchImpl: upbitFetch,
    }).then((snapshot) => {
      const value = snapshot.candles.map((row) => ({ ...row, time: row.timestamp }));
      candles.set(symbol, value);
      return value;
    }).catch((error) => {
      failures.set(symbol, { classification: classifyProviderFailure(error), message: String(error?.message ?? error).slice(0, 160) });
      throw error;
    }).finally(() => candlePending.delete(symbol));
    candlePending.set(symbol, promise);
    return promise;
  };
  const loadSpread = async (symbol, signal) => {
    if (spreads.has(symbol)) return spreads.get(symbol);
    if (spreadPending.has(symbol)) return spreadPending.get(symbol);
    const promise = upbitFetch(`${UPBIT_BASE}/v1/orderbook?markets=${encodeURIComponent(`KRW-${symbol}`)}`, { signal, headers: { accept: "application/json" } })
      .then((response) => response.json())
      .then((payload) => {
        const unit = Array.isArray(payload) ? payload[0]?.orderbook_units?.[0] : null;
        const bid = finite(unit?.bid_price);
        const ask = finite(unit?.ask_price);
        if (bid == null || ask == null || bid <= 0 || ask < bid) throw new Error("UPBIT_ORDERBOOK_BAD_RESPONSE");
        const value = { bid, ask };
        spreads.set(symbol, value);
        return value;
      }).catch((error) => {
        failures.set(symbol, { classification: classifyProviderFailure(error), message: String(error?.message ?? error).slice(0, 160) });
        throw error;
      }).finally(() => spreadPending.delete(symbol));
    spreadPending.set(symbol, promise);
    return promise;
  };
  return {
    loadCandles,
    loadSpread,
    snapshot(symbols) {
      const providerFailureClassifications = {};
      const failureRows = [];
      let success = 0;
      let failed = 0;
      let notStarted = 0;
      let retries = 0;
      for (const symbol of symbols) {
        retries += Math.max(0, (attempts.get(symbol) ?? 0) - 1);
        if (candles.has(symbol) && spreads.has(symbol)) success += 1;
        else if (failures.has(symbol)) {
          failed += 1;
          const failure = failures.get(symbol);
          increment(providerFailureClassifications, failure.classification);
          failureRows.push({ symbol, ...failure });
        } else notStarted += 1;
      }
      return { success, failed, notStarted, retries, failureRows, providerFailureClassifications };
    },
  };
}

const upbitEvidence = createUpbitEvidenceStore();
const upbitAuditScanner = createCryptoSignalScannerService({
  getUniverse: (_market, signal) => loadUpbitUniverse(signal),
  getCandles: (_market, symbol, timeframe, signal) => upbitEvidence.loadCandles(symbol, timeframe, signal),
  getSpread: (_market, ticker, signal) => upbitEvidence.loadSpread(ticker.symbol, signal),
  now: Date.now,
});

async function scanSpotBatch(cursor) {
  const universe = await loadUpbitUniverse();
  const batch = universe.rows.slice(cursor, cursor + CRYPTO_BATCH_SIZE);
  const symbols = batch.map((row) => row.symbol);
  let response = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await upbitAuditScanner.scan({ memberId: MEMBER_ID, market: "spot", timeframe: "4H", condition: "trend", cursor, batchSize: CRYPTO_BATCH_SIZE, strategyMode: "swing" });
    } catch (error) { lastError = error; }
    const state = upbitEvidence.snapshot(symbols);
    if (state.notStarted === 0 && (state.failed === 0 || attempt === 3)) break;
  }
  const state = upbitEvidence.snapshot(symbols);
  const timeoutCount = state.failureRows.filter((failure) => failure.classification === "TIMEOUT").length;
  const failures = state.failureRows.map((failure) => ({ symbol: failure.symbol, reason: "provider_error", classification: failure.classification, primaryRejectReason: failure.classification, message: failure.message }));
  if (!response && lastError && !failures.length && batch.length) {
    const classification = classifyProviderFailure(lastError);
    failures.push({ symbol: "*", reason: "provider_error", classification, primaryRejectReason: classification, message: String(lastError?.message ?? lastError).slice(0, 160) });
    increment(state.providerFailureClassifications, classification);
  }
  const cards = response?.cards ?? [];
  return {
    ...(response ?? {}),
    universe: { totalCount: universe.rows.length, cursor, nextCursor: nextCoverageCursor({ cursor, batchLength: batch.length, totalCount: universe.rows.length }), source: universe.source, partial: false, stale: false },
    execution: {
      ...(response?.execution ?? {}),
      requestedCount: batch.length,
      startedCount: batch.length - state.notStarted,
      completedCount: state.success,
      providerAcceptedCount: state.success,
      providerErrorCount: Math.max(0, state.failed - timeoutCount),
      timeoutCount,
      requiredProviderFailureCount: state.failed,
      insufficientDataCount: state.failureRows.filter((failure) => failure.classification === "INSUFFICIENT_HISTORY").length,
      hardFilterPassCount: cards.length,
      hardFilterRejectedCount: 0,
      softCandidateCount: cards.length,
      filteredByStrategyCount: 0,
      partial: state.failed > 0 || state.notStarted > 0,
      timedOut: timeoutCount > 0 || state.notStarted > 0,
      providerFailureClassifications: state.providerFailureClassifications,
    },
    cards,
    failures,
    audit: {
      rangeEnd: cursor + batch.length,
      requestSkippedCount: 0,
      requestSkippedReasons: {},
      historyOkCount: state.success,
      historyFailCount: state.failed,
      insufficientHistoryCount: state.failureRows.filter((failure) => failure.classification === "INSUFFICIENT_HISTORY").length,
      hardRejects: [],
      internalCards: cards,
      providerFailureClassifications: state.providerFailureClassifications,
      universeScope: { rawTotal: universe.rawTotal, eligibleScopeDefined: true, exclusionReasons: {} },
      retries: state.retries,
      spotDerivativesFields: "NOT_APPLICABLE",
    },
  };
}

let futuresUniversePromise;

async function publicCryptoTotal(market) {
  if (market === "spot") return loadUpbitUniverse();
  if (!futuresUniversePromise) {
    futuresUniversePromise = withPublicProviderRetry(async () => {
      const response = await fetch("https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES", { headers: { accept: "application/json" } });
      if (!response.ok) throw Object.assign(new Error(`PUBLIC_HTTP_${response.status}`), { status: response.status });
      const payload = await response.json();
      const newest = new Map();
      for (const row of Array.isArray(payload?.data) ? payload.data : []) {
        const symbol = String(row?.symbol ?? "").toUpperCase();
        if (!symbol || !(finite(row?.markPrice ?? row?.lastPr) > 0)) continue;
        const previous = newest.get(symbol);
        if (!previous || (finite(row?.ts) ?? 0) >= (finite(previous?.ts) ?? 0)) newest.set(symbol, row);
      }
      const rows = [...newest.values()].sort((left, right) => (
        (finite(right?.usdtVolume) ?? 0) - (finite(left?.usdtVolume) ?? 0)
          || String(left?.symbol ?? "").localeCompare(String(right?.symbol ?? ""))
      ));
      if (!rows.length) throw new Error("BITGET_TICKERS_BAD_RESPONSE");
      return { rows, source: "bitget-public", providerErrorCount: 0, rawTotal: rows.length };
    }, { maxAttempts: 3, baseBackoffMs: 250 });
  }
  try { return await futuresUniversePromise; } catch (error) { futuresUniversePromise = null; throw error; }
}

function normalizedBitgetUniverseRows(rows) {
  return rows.map((row) => ({
    symbol: String(row?.symbol ?? "").toUpperCase(),
    name: String(row?.symbol ?? "").toUpperCase(),
    price: finite(row?.markPrice ?? row?.lastPr),
    changePercent: (finite(row?.change24h) ?? 0) * 100,
    volume: finite(row?.baseVolume) ?? 0,
    tradingValue: finite(row?.usdtVolume) ?? 0,
    bid: finite(row?.bidPr),
    ask: finite(row?.askPr),
    fundingRate: finite(row?.fundingRate),
    openInterest: finite(row?.holdingAmount),
    timestamp: finite(row?.ts),
    warning: false,
  }));
}

function normalizedBitgetCandles(rows) {
  const latestAllowed = Date.now() + 60_000;
  const candles = new Map();
  for (const raw of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(raw)) continue;
    const time = finite(raw[0]);
    const open = finite(raw[1]);
    const high = finite(raw[2]);
    const low = finite(raw[3]);
    const close = finite(raw[4]);
    const volume = finite(raw[5]);
    if (time == null || time <= 0 || time > latestAllowed) continue;
    if ([open, high, low, close].some((value) => value == null || value <= 0) || volume == null || volume < 0) continue;
    candles.set(time, {
      time,
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close,
      volume,
      quoteVolume: finite(raw[6]),
    });
  }
  return [...candles.values()].sort((left, right) => left.time - right.time);
}

const bitgetAuditScanner = createCryptoSignalScannerService({
  async getUniverse() {
    const universe = await publicCryptoTotal("futures");
    return { rows: normalizedBitgetUniverseRows(universe.rows), source: universe.source, providerErrorCount: 0 };
  },
  async getCandles(_market, symbol, timeframe, signal) {
    const granularity = timeframe === "60m" ? "1H" : timeframe;
    const response = await bitgetFetch(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${encodeURIComponent(symbol)}&productType=USDT-FUTURES&granularity=${encodeURIComponent(granularity)}&limit=200`, {
      signal,
      headers: { accept: "application/json" },
    });
    const payload = await response.json();
    if (String(payload?.code ?? "") !== "00000" || !Array.isArray(payload?.data)) {
      throw new Error(`BITGET_${String(payload?.code ?? "BAD_RESPONSE")}`);
    }
    return normalizedBitgetCandles(payload.data);
  },
  async getSpread(_market, ticker) {
    return { bid: ticker.bid, ask: ticker.ask };
  },
  now: Date.now,
});

async function scanFuturesBatch(cursor) {
  const universe = await publicCryptoTotal("futures");
  const batch = universe.rows.slice(cursor, cursor + CRYPTO_BATCH_SIZE);
  const symbols = batch.map((row) => String(row?.symbol ?? "").toUpperCase()).filter(Boolean);
  const targetSymbols = new Set(symbols);
  const cardsBySymbol = new Map();
  const failuresBySymbol = new Map();
  let latestResponse = null;
  let lastError = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    attempts = attempt;
    try {
      const response = await bitgetAuditScanner.scan({ memberId: MEMBER_ID, market: "futures", timeframe: "4H", condition: "trend", cursor, batchSize: CRYPTO_BATCH_SIZE, strategyMode: "swing" });
      latestResponse = response;
      for (const card of response.cards ?? []) {
        const symbol = String(card.symbol).toUpperCase();
        if (!targetSymbols.has(symbol)) continue;
        cardsBySymbol.set(symbol, card);
        failuresBySymbol.delete(symbol);
      }
      for (const failure of response.failures ?? []) {
        const symbol = String(failure.symbol).toUpperCase();
        if (targetSymbols.has(symbol)) failuresBySymbol.set(symbol, failure);
      }
    } catch (error) {
      lastError = error;
    }
    if (symbols.every((symbol) => cardsBySymbol.has(symbol))) break;
  }
  const missingSymbols = symbols.filter((symbol) => !cardsBySymbol.has(symbol));
  const providerFailureClassifications = {};
  const failures = missingSymbols.map((symbol) => {
    const original = failuresBySymbol.get(symbol);
    const classification = classifyProviderFailure(original?.message ?? lastError ?? "BITGET_PUBLIC_CANDLE_FAILED");
    increment(providerFailureClassifications, classification);
    return {
      symbol,
      reason: original?.reason ?? "provider_error",
      classification,
      primaryRejectReason: classification,
      message: String(original?.message ?? lastError?.message ?? "BITGET_PUBLIC_CANDLE_FAILED").slice(0, 160),
    };
  });
  const cards = symbols.map((symbol) => cardsBySymbol.get(symbol)).filter(Boolean);
  const timeoutCount = failures.filter((failure) => failure.classification === "TIMEOUT").length;
  return {
    ...(latestResponse ?? {}),
    universe: {
      totalCount: universe.rows.length,
      cursor,
      nextCursor: nextCoverageCursor({ cursor, batchLength: batch.length, totalCount: universe.rows.length }),
      source: universe.source,
      partial: false,
      stale: false,
    },
    execution: {
      ...(latestResponse?.execution ?? {}),
      requestedCount: batch.length,
      startedCount: batch.length,
      completedCount: cards.length,
      providerAcceptedCount: cards.length,
      providerErrorCount: Math.max(0, failures.length - timeoutCount),
      timeoutCount,
      requiredProviderFailureCount: failures.length,
      insufficientDataCount: failures.filter((failure) => failure.classification === "INSUFFICIENT_HISTORY").length,
      hardFilterPassCount: cards.length,
      hardFilterRejectedCount: 0,
      softCandidateCount: cards.length,
      filteredByStrategyCount: 0,
      partial: failures.length > 0,
      timedOut: timeoutCount > 0,
      providerFailureClassifications,
    },
    cards,
    failures,
    audit: {
      rangeEnd: cursor + batch.length,
      requestSkippedCount: 0,
      requestSkippedReasons: {},
      historyOkCount: cards.length,
      historyFailCount: failures.length,
      insufficientHistoryCount: failures.filter((failure) => failure.classification === "INSUFFICIENT_HISTORY").length,
      hardRejects: [],
      internalCards: cards,
      providerFailureClassifications,
      universeScope: { rawTotal: universe.rawTotal, eligibleScopeDefined: true, exclusionReasons: {} },
      retries: Math.max(0, attempts - 1),
    },
  };
}

async function scanBatch({ market, cursor }) {
  if (market === "KR_STOCK" || market === "US_STOCK") return scanPublicStockBatch(market, cursor);
  if (market === "CRYPTO_SPOT") return scanSpotBatch(cursor);
  return scanFuturesBatch(cursor);
}

function providerCapabilities(report) {
  const byMarket = new Map(report.markets.map((market) => [market.market, market]));
  return {
    KIWOOM_CHART: { role: "OPTIONAL_PRIMARY_WITH_PUBLIC_FALLBACK", classification: "FALLBACK_USED", fallback: "yahoo-public-chart", impact: "NONE_WHEN_YAHOO_SUCCEEDS" },
    DART: { role: "OPTIONAL_ENRICHMENT", classification: "OPTIONAL_ENRICHMENT_MISSING", fallback: null, impact: "DISCOVERY_CONTINUES_WITH_NULL_ENRICHMENT" },
    FINNHUB: { role: "OPTIONAL_UNIVERSE_ENRICHMENT", classification: "OPTIONAL_ENRICHMENT_MISSING", fallback: "nasdaq-trader-public-directory", impact: "NONE_WHEN_PUBLIC_DIRECTORY_SUCCEEDS" },
    YAHOO_PUBLIC_CHART: { role: "REQUIRED_STOCK_DISCOVERY", classification: byMarket.get("KR_STOCK")?.providerFailed || byMarket.get("US_STOCK")?.providerFailed ? "PARTIAL_FAILURE" : "READY", fallback: "query1/query2 hosts", impact: "EXACT_FAILURES_REPORTED" },
    UPBIT_PUBLIC: { role: "REQUIRED_SPOT_DISCOVERY", classification: byMarket.get("CRYPTO_SPOT")?.providerFailed ? "PARTIAL_FAILURE" : "READY", fallback: null, impact: "EXACT_FAILURES_REPORTED" },
    BITGET_PUBLIC: { role: "REQUIRED_FUTURES_CONTROL", classification: byMarket.get("CRYPTO_FUTURES")?.providerFailed ? "PARTIAL_FAILURE" : "READY", fallback: null, impact: "CONTROL_MARKET" },
  };
}

async function main() {
  const selectedMarkets = String(process.env.MEANINGFUL_SEARCH_MARKETS ?? "")
    .split(",")
    .map((market) => market.trim())
    .filter(Boolean);
  const report = await runCanonicalMeaningfulSearchRuntime({
    scanBatch,
    ...(selectedMarkets.length ? { markets: selectedMarkets } : {}),
    maximumBatches: 1_000,
    onProgress(progress) {
      if (progress.batches === 1 || progress.batches % 10 === 0 || progress.providerRequested >= progress.universeCount) {
        process.stderr.write(`${JSON.stringify({ stage: "coverage-progress", ...progress })}\n`);
      }
    },
  });
  process.stdout.write(`${JSON.stringify({
    ...report,
    providerCapabilities: providerCapabilities(report),
    safetyAudit: { liveTrading: false, realOrder: false, privateApi: false, accountRequestCount: 0, financialMutationCount: 0 },
  }, null, 2)}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
