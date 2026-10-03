import { BitgetPublicClient } from "./bitget-public-client.js";
import { collectBitgetCandles } from "./bitget-candle-collector.js";
import {
  buildPumpReversalPointInTimeProfile,
  evaluatePumpReversalCleanV1,
} from "./crypto-pump-reversal-clean-v1.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value) {
  return String(value ?? "").trim();
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function payloadRows(payload, code) {
  if (text(payload?.code) !== "00000" || !Array.isArray(payload?.data)) {
    throw new Error(code);
  }
  return payload.data;
}

function normalizeContracts(rows) {
  const map = new Map();
  for (const row of rows) {
    const symbol = text(row?.symbol).toUpperCase();
    if (!/^[A-Z0-9]{2,24}USDT$/u.test(symbol)) continue;
    const status = text(row?.symbolStatus).toLowerCase();
    map.set(symbol, status === "off" ? "OFF" : "TRADABLE");
  }
  return map;
}

function normalizeTickers(rows) {
  const newest = new Map();
  for (const row of rows) {
    const symbol = text(row?.symbol).toUpperCase();
    const price = finite(row?.markPrice ?? row?.lastPr);
    const change24h = finite(row?.change24h);
    const quoteVolume24h = finite(row?.usdtVolume);
    const bid = finite(row?.bidPr);
    const ask = finite(row?.askPr);
    const timestampMs = finite(row?.ts);
    if (!/^[A-Z0-9]{2,24}USDT$/u.test(symbol)
      || price == null || price <= 0
      || change24h == null) continue;
    const normalized = {
      symbol,
      price,
      change24hPercent: change24h * 100,
      quoteVolume24h,
      bid,
      ask,
      timestampMs,
    };
    const previous = newest.get(symbol);
    if (!previous || (timestampMs ?? 0) >= (previous.timestampMs ?? 0)) {
      newest.set(symbol, normalized);
    }
  }
  return [...newest.values()];
}

function publicLiquidityReady(ticker) {
  return ticker.quoteVolume24h != null
    && ticker.quoteVolume24h > 0
    && ticker.bid != null
    && ticker.ask != null
    && ticker.bid > 0
    && ticker.ask >= ticker.bid;
}

function candleInput(snapshot) {
  return snapshot.candles.map((row) => ({
    timestampMs: row.timestamp,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    quoteVolume: row.quoteVolume,
  }));
}

export async function collectPumpReversalCleanPublicSignals({
  client = new BitgetPublicClient(),
  collectCandles = collectBitgetCandles,
  nowMs = Date.now(),
  lastEntryAtBySymbol = {},
} = {}) {
  if (!client || typeof client.get !== "function") throw new TypeError("Bitget public client is required");
  if (typeof collectCandles !== "function") throw new TypeError("collectCandles must be a function");
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new TypeError("nowMs must be a positive integer");
  if (!lastEntryAtBySymbol || typeof lastEntryAtBySymbol !== "object" || Array.isArray(lastEntryAtBySymbol)) {
    throw new TypeError("lastEntryAtBySymbol must be an object");
  }

  const [tickerPayload, contractPayload, btcDaily] = await Promise.all([
    client.get("/api/v2/mix/market/tickers", { productType: "USDT-FUTURES" }),
    client.get("/api/v2/mix/market/contracts", { productType: "USDT-FUTURES" }),
    collectCandles({
      client,
      market: "CRYPTO_FUTURES",
      symbol: "BTCUSDT",
      timeframe: "1d",
      startTime: nowMs - 70 * DAY_MS,
      endTime: nowMs,
      maxCandles: 70,
    }),
  ]);

  const tickers = normalizeTickers(payloadRows(tickerPayload, "BITGET_PUMP_TICKERS_INVALID"));
  const contracts = normalizeContracts(payloadRows(contractPayload, "BITGET_PUMP_CONTRACTS_INVALID"));

  // Ticker change is only a cheap prefilter. Final 24h return is recomputed from
  // closed 1h candles by the deterministic strategy core.
  const eventTickers = tickers
    .filter((ticker) => ticker.change24hPercent >= 25)
    .sort((left, right) => right.change24hPercent - left.change24hPercent
      || (right.quoteVolume24h ?? 0) - (left.quoteVolume24h ?? 0)
      || left.symbol.localeCompare(right.symbol));

  const signals = [];
  const evaluated = [];
  const failures = [];
  for (const ticker of eventTickers) {
    try {
      const [hourly, daily] = await Promise.all([
        collectCandles({
          client,
          market: "CRYPTO_FUTURES",
          symbol: ticker.symbol,
          timeframe: "1h",
          startTime: nowMs - 180 * HOUR_MS,
          endTime: nowMs,
          maxCandles: 180,
        }),
        collectCandles({
          client,
          market: "CRYPTO_FUTURES",
          symbol: ticker.symbol,
          timeframe: "1d",
          startTime: nowMs - 200 * DAY_MS,
          endTime: nowMs,
          maxCandles: 200,
        }),
      ]);

      const profile = buildPumpReversalPointInTimeProfile({
        symbol: ticker.symbol,
        observedAtMs: nowMs,
        dailyCandles: candleInput(daily),
        tradingStatus: contracts.get(ticker.symbol) ?? "UNKNOWN",
        liquidityReady: publicLiquidityReady(ticker),
      });
      const signal = evaluatePumpReversalCleanV1({
        symbol: ticker.symbol,
        observedAtMs: nowMs,
        profile,
        hourlyCandles: candleInput(hourly),
        btcDailyCandles: candleInput(btcDaily),
        lastEntryAtMs: lastEntryAtBySymbol[ticker.symbol] ?? null,
      });
      const record = freeze({
        symbol: ticker.symbol,
        tickerChange24hPercent: ticker.change24hPercent,
        tickerQuoteVolume24h: ticker.quoteVolume24h,
        profile,
        signal,
      });
      evaluated.push(record);
      if (signal.eligibleForProspectiveResearchSample === true) signals.push(record);
    } catch (error) {
      failures.push(freeze({
        symbol: ticker.symbol,
        code: text(error?.code ?? error?.message ?? "PUMP_PUBLIC_EVIDENCE_FAILED"),
      }));
    }
  }

  return freeze({
    schemaVersion: "crypto-pump-reversal-public-source-v1",
    status: failures.length > 0 && evaluated.length === 0 ? "BLOCKED_DATA" : "READY",
    provider: "bitget-public-v2",
    market: "CRYPTO_FUTURES",
    observedAtMs: nowMs,
    tickerUniverseCount: tickers.length,
    prefilteredPumpCount: eventTickers.length,
    evaluatedCount: evaluated.length,
    signalCount: signals.length,
    decision: signals.length > 0 ? "PAPER_RESEARCH_SIGNALS" : "VALID_NO_TRADE",
    signals,
    evaluated,
    failures,
    publicOnly: true,
    privateRequestCount: 0,
    executionAuthority: "NONE",
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    profitabilityProven: false,
    profitabilityClaimAllowed: false,
  });
}
