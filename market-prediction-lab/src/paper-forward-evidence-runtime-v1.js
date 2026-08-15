import { collectYahooStockHistory } from "./yahoo-stock-history.js";
import { collectUpbitSpotHistory } from "./upbit-spot-history.js";
import { BitgetPublicClient } from "./bitget-public-client.js";
import { BITGET_TIMEFRAME_MS, collectBitgetCandles } from "./bitget-candle-collector.js";
import { RECURRING_PAPER_MARKETS } from "./recurring-paper-loop-v1.js";
import { runScheduledPaperCycle } from "./paper-scheduler-driver-v1.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

export const PAPER_FORWARD_PROVIDER_AUTHORITY = Object.freeze({
  KR_STOCK: Object.freeze({ provider: "yahoo-public-chart", symbol: "005930", timeframe: "1d", intervalMs: DAY_MS, closeOffsetMs: 6.5 * 60 * 60 * 1000, maxAgeMs: 4 * DAY_MS }),
  US_STOCK: Object.freeze({ provider: "yahoo-public-chart", symbol: "SPY", timeframe: "1d", intervalMs: DAY_MS, closeOffsetMs: 6.5 * 60 * 60 * 1000, maxAgeMs: 4 * DAY_MS }),
  CRYPTO_SPOT: Object.freeze({ provider: "upbit-public-candles", symbol: "BTC", timeframe: "4h", intervalMs: FOUR_HOURS_MS, maxAgeMs: 8 * 60 * 60 * 1000 }),
  CRYPTO_FUTURES: Object.freeze({ provider: "bitget-public-v2", symbol: "BTCUSDT", timeframe: "4h", intervalMs: FOUR_HOURS_MS, maxAgeMs: 8 * 60 * 60 * 1000 }),
});

export const PAPER_FORWARD_RUNTIME_CONTRACT = Object.freeze({
  version: "paper-forward-evidence-runtime-v1",
  publicDataOnly: true,
  canonicalPaperLoopOnly: true,
  scheduleActive: false,
  privateAccountAccess: false,
  liveTrading: false,
  orderAuthority: false,
});

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function safeReason(error) {
  const text = String(error?.code ?? error?.message ?? "PROVIDER_FAILED").toUpperCase();
  if (text.includes("TIMEOUT") || error?.name === "AbortError") return "PROVIDER_TIMEOUT";
  if (text.includes("429") || text.includes("RATE")) return "PROVIDER_RATE_LIMITED";
  return "PROVIDER_FAILED";
}

function transientProviderError(error) {
  const status = Number(error?.status ?? error?.details?.status);
  const text = String(error?.code ?? error?.message ?? "").toUpperCase();
  return status === 429 || (status >= 500 && status <= 599)
    || text.includes("HTTP_429") || /HTTP_5\d\d/u.test(text)
    || text.includes("TIMEOUT") || error?.name === "AbortError";
}

async function withBoundedProviderRetry(operation, { maxAttempts, baseBackoffMs, sleep }) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (!transientProviderError(error) || attempt === maxAttempts) throw error;
      const retryAfterMs = Number(error?.retryAfterMs ?? error?.details?.retryAfterMs);
      await sleep(Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? Math.min(retryAfterMs, 30_000) : baseBackoffMs * attempt);
    }
  }
  throw lastError;
}

function blocked(market, authority, reason, dataAsOfMs = null) {
  return Object.freeze({
    status: "BLOCKED_DATA",
    publicOnly: true,
    market,
    provider: authority.provider,
    provenance: Object.freeze({ provider: authority.provider, market, symbol: authority.symbol, timeframe: authority.timeframe }),
    dataAsOfMs,
    observedAtMs: dataAsOfMs,
    maxAgeMs: authority.maxAgeMs,
    candidates: Object.freeze([]),
    exits: Object.freeze([]),
    blocker: reason,
  });
}

function readyEvidence({ market, authority, snapshot, nowMs }) {
  const candles = snapshot?.candles;
  if (!Array.isArray(candles) || candles.length === 0) return blocked(market, authority, "NO_CANONICAL_CANDLES");
  const source = snapshot.source ?? snapshot.provider;
  if (source !== authority.provider) return blocked(market, authority, "PROVIDER_MISMATCH");
  if (snapshot.market !== market) return blocked(market, authority, "MARKET_MISMATCH");
  if (snapshot.timeframe !== authority.timeframe) return blocked(market, authority, "TIMEFRAME_MISMATCH");
  const closeOffsetMs = authority.closeOffsetMs ?? authority.intervalMs;
  const latest = candles.filter((candle) => Number(candle?.timestamp) + closeOffsetMs <= nowMs).at(-1);
  if (!latest) return blocked(market, authority, "UNCLOSED_CANDLE");
  const candleOpenMs = Number(latest?.timestamp);
  const closedAtMs = candleOpenMs + closeOffsetMs;
  if (!Number.isInteger(candleOpenMs) || candleOpenMs <= 0) return blocked(market, authority, "INVALID_CANDLE_TIME");
  if (nowMs - closedAtMs > authority.maxAgeMs) return blocked(market, authority, "STALE_EVIDENCE", closedAtMs);
  return Object.freeze({
    status: "READY",
    publicOnly: true,
    market,
    provider: authority.provider,
    provenance: Object.freeze({
      provider: authority.provider,
      market,
      symbol: authority.symbol,
      timeframe: authority.timeframe,
      candleCount: candles.length,
      dataAsOfMs: closedAtMs,
      closedCandle: true,
    }),
    dataAsOfMs: closedAtMs,
    observedAtMs: closedAtMs,
    maxAgeMs: authority.maxAgeMs,
    candidates: Object.freeze([]),
    exits: Object.freeze([]),
    blocker: null,
  });
}

export function createCanonicalPaperForwardEvidenceProvider({
  collectYahoo = collectYahooStockHistory,
  collectUpbit = collectUpbitSpotHistory,
  collectBitget = collectBitgetCandles,
  bitgetClient = new BitgetPublicClient(),
  clock = Date.now,
  authority = PAPER_FORWARD_PROVIDER_AUTHORITY,
  providerRetry = Object.freeze({ maxAttempts: 3, baseBackoffMs: 250 }),
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  if (!Number.isInteger(providerRetry?.maxAttempts) || providerRetry.maxAttempts < 1 || providerRetry.maxAttempts > 5
    || !Number.isInteger(providerRetry?.baseBackoffMs) || providerRetry.baseBackoffMs < 1 || providerRetry.baseBackoffMs > 30_000) {
    throw new TypeError("bounded providerRetry configuration is required");
  }
  return Object.freeze({
    async collectPublicEvidence({ market, signal }) {
      const lane = authority[market];
      if (!lane) return blocked(market, { provider: "NONE", symbol: "NONE", timeframe: "NONE", maxAgeMs: 1 }, "NO_CANONICAL_PROVIDER");
      const nowMs = clock();
      if (!finite(nowMs)) throw new TypeError("clock must return a finite number");
      const startTime = nowMs - (market.endsWith("STOCK") ? 180 * DAY_MS : 60 * DAY_MS);
      try {
        const snapshot = await withBoundedProviderRetry(async () => {
          if (market === "KR_STOCK" || market === "US_STOCK") {
            return collectYahoo({ market, symbol: lane.symbol, startTime, endTime: nowMs, signal });
          }
          if (market === "CRYPTO_SPOT") {
            return collectUpbit({ symbol: lane.symbol, startTime, endTime: nowMs, signal, maxPages: 4 });
          }
          return collectBitget({
            client: bitgetClient,
            market,
            symbol: lane.symbol,
            timeframe: lane.timeframe,
            startTime,
            endTime: nowMs,
            maxCandles: 500,
          });
        }, { ...providerRetry, sleep });
        return readyEvidence({ market, authority: lane, snapshot, nowMs });
      } catch (error) {
        const result = blocked(market, lane, safeReason(error));
        if (result.blocker === "PROVIDER_TIMEOUT") throw Object.assign(new Error(result.blocker), { code: "PROVIDER_TIMEOUT" });
        if (result.blocker === "PROVIDER_RATE_LIMITED") throw Object.assign(new Error(result.blocker), { code: "PROVIDER_RATE_LIMITED", status: 429 });
        return result;
      }
    },
  });
}

function sanitizeLane(market, evidence) {
  return Object.freeze({
    market,
    status: evidence?.status ?? "BLOCKED_DATA",
    provider: evidence?.provider ?? null,
    dataAsOfMs: finite(evidence?.dataAsOfMs) ? evidence.dataAsOfMs : null,
    acceptedEvidenceCount: evidence?.status === "READY" ? 1 : 0,
    blocker: evidence?.blocker ?? (evidence?.status === "READY" ? null : "PROVIDER_FAILED"),
  });
}

export async function validateCanonicalPaperForwardEvidence({ provider, nowMs = Date.now() } = {}) {
  if (!provider || typeof provider.collectPublicEvidence !== "function") throw new TypeError("public evidence provider is required");
  const cycle = Object.freeze({ cycleId: `manual-validation:${nowMs}`, scheduledAtMs: nowMs, startedAtMs: nowMs });
  const lanes = [];
  for (const market of RECURRING_PAPER_MARKETS) {
    try {
      lanes.push(sanitizeLane(market, await provider.collectPublicEvidence({ market, cycle, attempt: 1, signal: new AbortController().signal })));
    } catch (error) {
      lanes.push(sanitizeLane(market, { status: "BLOCKED_DATA", blocker: safeReason(error) }));
    }
  }
  return Object.freeze({
    contract: PAPER_FORWARD_RUNTIME_CONTRACT,
    validatedAtMs: nowMs,
    ready: lanes.every((lane) => lane.status === "READY"),
    lanes: Object.freeze(lanes),
    privateRequestCount: 0,
    financialMutationCount: 0,
  });
}

export async function runPaperForwardEvidenceRuntime({
  publicEvidenceProvider,
  runtimeStatusStore,
  runScheduled = runScheduledPaperCycle,
  ...scheduledInput
} = {}) {
  if (!publicEvidenceProvider || typeof publicEvidenceProvider.collectPublicEvidence !== "function") throw new TypeError("public evidence provider is required");
  const observed = new Map();
  const trackingProvider = Object.freeze({
    async collectPublicEvidence(input) {
      try {
        const evidence = await publicEvidenceProvider.collectPublicEvidence(input);
        observed.set(input.market, sanitizeLane(input.market, evidence));
        return evidence;
      } catch (error) {
        observed.set(input.market, sanitizeLane(input.market, { status: "BLOCKED_DATA", blocker: safeReason(error) }));
        throw error;
      }
    },
  });
  const result = await runScheduled({ ...scheduledInput, publicEvidenceProvider: trackingProvider });
  const lanes = RECURRING_PAPER_MARKETS.map((market) => observed.get(market) ?? sanitizeLane(market, null));
  const status = Object.freeze({
    schemaVersion: "paper-forward-runtime-status-v1",
    cycleId: result.cycleId,
    status: result.status,
    mutationCount: result.mutationCount ?? 0,
    replayCount: result.status === "REPLAYED" ? 1 : 0,
    settlementCount: result.summary?.tradesSettled ?? 0,
    outcomeCount: result.summary?.tradesSettled ?? 0,
    lanes: Object.freeze(lanes),
    privateRequestCount: 0,
    orderCount: 0,
    ...PAPER_FORWARD_RUNTIME_CONTRACT,
  });
  await runtimeStatusStore?.save?.(status);
  return Object.freeze({ ...result, runtimeStatus: status });
}
