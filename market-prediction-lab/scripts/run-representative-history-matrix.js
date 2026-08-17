import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
import { collectUpbitSpotHistory } from "../src/upbit-spot-history.js";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import { collectBitgetCandles } from "../src/bitget-candle-collector.js";
import { repairBitgetCandleGaps } from "../src/candle-gap-repair.js";
import { normalizeCandleRows } from "../src/normalizers.js";
import { buildTrainingRecords } from "../src/training-dataset.js";
import { walkForwardSplit } from "../src/walk-forward.js";
import { evaluateStoredBaseline } from "../src/tiny-model-training.js";

const DAY = 86_400_000;
const REQUESTED_START = Date.UTC(2000, 0, 1);
const TARGET_2010 = Date.UTC(2010, 0, 1);
const TODAY = new Date();
const REQUESTED_END = Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), TODAY.getUTCDate());
const scope = String(process.argv[2] ?? "stocks").toLowerCase();
const outputJson = resolve(process.argv[3] ?? `docs/representative-history-${scope}.json`);
const outputMd = resolve(process.argv[4] ?? `docs/representative-history-${scope}.md`);

const STOCKS = Object.freeze([
  { market: "KR_STOCK", symbol: "005930" }, { market: "KR_STOCK", symbol: "000660" },
  { market: "KR_STOCK", symbol: "035420" }, { market: "KR_STOCK", symbol: "005380" },
  { market: "KR_STOCK", symbol: "068270" },
  { market: "US_STOCK", symbol: "AAPL" }, { market: "US_STOCK", symbol: "MSFT" },
  { market: "US_STOCK", symbol: "NVDA" }, { market: "US_STOCK", symbol: "AMZN" },
  { market: "US_STOCK", symbol: "GOOGL" }, { market: "US_STOCK", symbol: "SPY" },
  { market: "US_STOCK", symbol: "QQQ" }, { market: "US_STOCK", symbol: "BRK.B" },
]);
const SPOT = Object.freeze(["BTC", "ETH", "XRP", "SOL", "DOGE"]);
const FUTURES = Object.freeze(["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT"]);

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function retry(operation, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(attempt); }
    catch (error) { lastError = error; if (attempt < attempts) await sleep(220 * attempt); }
  }
  throw lastError;
}
async function save(file, value) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, value, "utf8"); }
function iso(value) { return Number.isFinite(Number(value)) ? new Date(Number(value)).toISOString() : null; }
function classCounts(records) {
  const out = { bullish: 0, neutral: 0, bearish: 0 };
  for (const row of records) if (Object.prototype.hasOwnProperty.call(out, row?.label?.direction)) out[row.label.direction] += 1;
  return out;
}
function metricSummary(value) {
  return { sampleCount: value.sampleCount, accuracy: value.accuracy, balancedAccuracy: value.balancedAccuracy, macroF1: value.macroF1, logLoss: value.logLoss, brier: value.brier, expectedCalibrationError: value.expectedCalibrationError };
}
function strictCoverage(candles, expectedMs) {
  let duplicates = 0; let gaps = 0; let maxGapMs = 0;
  for (let index = 1; index < candles.length; index += 1) {
    const delta = candles[index].timestamp - candles[index - 1].timestamp;
    if (delta <= 0) duplicates += 1;
    if (expectedMs && delta > expectedMs * 2.5) { gaps += 1; maxGapMs = Math.max(maxGapMs, delta); }
  }
  return { duplicates, gaps, maxGapMs };
}
function profileValidation(normalized, profile) {
  const records = buildTrainingRecords(normalized, profile);
  if (records.length < 120) return { status: "INSUFFICIENT_RECORDS", recordCount: records.length };
  const split = walkForwardSplit(records, { trainRatio: 0.7, validationRatio: 0.15 });
  const baseline = evaluateStoredBaseline(split.test);
  return {
    status: "WALK_FORWARD_READY", recordCount: records.length, split: split.report,
    classCounts: { train: classCounts(split.train), validation: classCounts(split.validation), test: classCounts(split.test) },
    baselineTest: metricSummary(baseline),
  };
}
function coverageLabel(firstTimestamp) {
  if (!Number.isFinite(firstTimestamp)) return { coverage2010: false, pre2010: false, reason: "NO_DATA" };
  const coverage2010 = firstTimestamp <= TARGET_2010 + 7 * DAY;
  return { coverage2010, pre2010: firstTimestamp < TARGET_2010, reason: coverage2010 ? null : "ACTUAL_HISTORY_STARTS_AFTER_2010" };
}

async function collectStockLong(spec) {
  const chunks = [
    [REQUESTED_START, Date.UTC(2013, 0, 1)],
    [Date.UTC(2013, 0, 1), REQUESTED_END],
  ];
  const byTime = new Map(); const providers = new Set(); const chunkReports = [];
  for (const [startTime, endTime] of chunks) {
    const history = await retry(() => collectYahooStockHistory({ market: spec.market, symbol: spec.symbol, startTime, endTime, timeoutMs: 20_000 }));
    providers.add(history.providerSymbol);
    for (const candle of history.candles) byTime.set(candle.timestamp, candle);
    chunkReports.push({ requestedStart: iso(startTime), requestedEnd: iso(endTime), candleCount: history.candles.length, providerSymbol: history.providerSymbol, first: iso(history.firstTimestamp), last: iso(history.lastTimestamp) });
    await sleep(180);
  }
  const candles = [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
  const normalized = normalizeCandleRows(candles, { market: spec.market, symbol: spec.symbol, timeframe: "1d", format: "canonical-object", source: `yahoo-public-representative-${spec.symbol}`, strict: true });
  if (normalized.quality.status === "invalid") throw new Error(`${spec.symbol}_NORMALIZED_INVALID`);
  const firstTimestamp = normalized.candles[0]?.timestamp ?? null;
  const lastTimestamp = normalized.candles.at(-1)?.timestamp ?? null;
  return {
    market: spec.market, symbol: spec.symbol, source: "yahoo-public-chart", providerSymbols: [...providers],
    requestedStart: iso(REQUESTED_START), requestedEnd: iso(REQUESTED_END), actualStart: iso(firstTimestamp), actualEnd: iso(lastTimestamp), candleCount: normalized.candles.length,
    ...coverageLabel(firstTimestamp), quality: normalized.quality, integrity: strictCoverage(normalized.candles, DAY), chunks: chunkReports,
    strategyValidation: {
      SCALPING_15M: { status: "PROVIDER_DEPTH_LIMIT", exact2010Validation: false, note: "Yahoo intraday history does not provide 2010-to-current 15m coverage; current functionality is tested separately." },
      SWING_60M: { status: "PROVIDER_DEPTH_LIMIT", exact2010Validation: false, note: "Yahoo 60m history is bounded; daily long-history is auxiliary evidence, not a 60m profitability claim." },
      SWING_DAILY_AUX: profileValidation(normalized, { lookback: 200, horizon: 5, stride: 2 }),
      MID_LONG_1D: profileValidation(normalized, { lookback: 250, horizon: 20, stride: 5 }),
    },
  };
}

let upbitNextAt = 0;
async function upbitJson(url) {
  return retry(async (attempt) => {
    const delay = Math.max(0, upbitNextAt - Date.now()); if (delay) await sleep(delay); upbitNextAt = Date.now() + 135;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json", "user-agent": "prediction-lab-representative/1.0" } });
      if (!response.ok) {
        if (response.status === 429 && attempt < 4) { const after = Number(response.headers.get("retry-after")); if (Number.isFinite(after) && after > 0) await sleep(after * 1000); }
        throw Object.assign(new Error(`UPBIT_HTTP_${response.status}`), { status: response.status });
      }
      return response.json();
    } finally { clearTimeout(timer); }
  });
}
async function collectUpbitDaily(symbol) {
  const market = `KRW-${symbol}`; const byTime = new Map(); let cursor = REQUESTED_END; let pages = 0;
  while (cursor > REQUESTED_START && pages < 100) {
    const rows = await upbitJson(`https://api.upbit.com/v1/candles/days?market=${encodeURIComponent(market)}&to=${encodeURIComponent(new Date(cursor).toISOString())}&count=200`);
    if (!Array.isArray(rows) || !rows.length) break;
    let oldest = Infinity;
    for (const row of rows) {
      const timestamp = Date.parse(`${row.candle_date_time_utc}Z`);
      if (!Number.isFinite(timestamp)) continue;
      oldest = Math.min(oldest, timestamp);
      if (timestamp >= REQUESTED_START && timestamp < REQUESTED_END) byTime.set(timestamp, { timestamp, open: Number(row.opening_price), high: Number(row.high_price), low: Number(row.low_price), close: Number(row.trade_price), volume: Number(row.candle_acc_trade_volume) });
    }
    pages += 1; if (!Number.isFinite(oldest) || oldest <= REQUESTED_START) break; cursor = oldest - 1;
  }
  return { pages, candles: [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp) };
}
async function collectSpotLong(symbol) {
  const fourHour = await collectUpbitSpotHistory({ symbol, startTime: REQUESTED_START, endTime: REQUESTED_END, maxPages: 100, minIntervalMs: 135 });
  const normalized4h = normalizeCandleRows(fourHour.candles, { market: "CRYPTO_SPOT", symbol, timeframe: "4h", format: "canonical-object", source: `upbit-public-${symbol}-4h-long`, strict: true });
  const daily = await collectUpbitDaily(symbol);
  const normalized1d = normalizeCandleRows(daily.candles, { market: "CRYPTO_SPOT", symbol, timeframe: "1d", format: "canonical-object", source: `upbit-public-${symbol}-1d-long`, strict: true });
  const firstTimestamp = normalized1d.candles[0]?.timestamp ?? normalized4h.candles[0]?.timestamp ?? null;
  return {
    market: "CRYPTO_SPOT", symbol, source: "upbit-public-candles", requestedStart: iso(REQUESTED_START), requestedEnd: iso(REQUESTED_END),
    actualStart: iso(firstTimestamp), actualEnd: iso(normalized1d.candles.at(-1)?.timestamp ?? normalized4h.candles.at(-1)?.timestamp),
    candleCount1d: normalized1d.candles.length, candleCount4h: normalized4h.candles.length, pages1d: daily.pages, pages4h: fourHour.pageCount,
    ...coverageLabel(firstTimestamp), integrity1d: strictCoverage(normalized1d.candles, DAY), integrity4h: strictCoverage(normalized4h.candles, 4 * 60 * 60 * 1000),
    strategyValidation: {
      SCALPING_15M: { status: "NO_2010_EXACT_HISTORY", exact2010Validation: false, note: "Asset/exchange did not exist for the requested 2010 period; current 15m search is tested separately." },
      SWING_60M: { status: "NO_2010_EXACT_HISTORY", exact2010Validation: false, note: "Canonical cost-aware historical validator currently uses 4h; 60m current search is tested separately." },
      SWING_4H_CANONICAL: profileValidation(normalized4h, { lookback: 200, horizon: 6, stride: 1 }),
      MID_LONG_1D: profileValidation(normalized1d, { lookback: 200, horizon: 20, stride: 3 }),
    },
  };
}

async function collectFuturesLong(symbol, client) {
  const collected = await collectBitgetCandles({ client, market: "CRYPTO_FUTURES", symbol, timeframe: "1d", startTime: REQUESTED_START, endTime: REQUESTED_END, maxCandles: 10_000 });
  const repaired = await repairBitgetCandleGaps({ client, market: "CRYPTO_FUTURES", symbol, timeframe: "1d", candles: collected.candles });
  const normalized = normalizeCandleRows(repaired.candles, { market: "CRYPTO_FUTURES", symbol, timeframe: "1d", format: "canonical-object", source: `bitget-public-${symbol}-1d-long`, strict: true });
  const firstTimestamp = normalized.candles[0]?.timestamp ?? null;
  return {
    market: "CRYPTO_FUTURES", symbol, source: "bitget-public-v2", requestedStart: iso(REQUESTED_START), requestedEnd: iso(REQUESTED_END), actualStart: iso(firstTimestamp), actualEnd: iso(normalized.candles.at(-1)?.timestamp), candleCount: normalized.candles.length,
    ...coverageLabel(firstTimestamp), quality: normalized.quality, integrity: strictCoverage(normalized.candles, DAY), initialGapCount: repaired.initialGapCount, remainingGapCount: repaired.remainingGapCount,
    strategyValidation: {
      SCALPING_15M: { status: "RECENT_EXACT_VALIDATOR_ONLY", exact2010Validation: false, note: "Canonical Bitget futures PnL validates recent 15m data; no synthetic pre-listing data is created." },
      SWING_60M: { status: "RECENT_EXACT_VALIDATOR_ONLY", exact2010Validation: false, note: "Canonical Bitget futures PnL validates recent 1h data; long-history Binance Vision evidence is explicitly cross-venue proxy." },
      MID_LONG_1D: profileValidation(normalized, { lookback: 200, horizon: 20, stride: 3 }),
    },
  };
}

function markdown(report) {
  const rows = report.rows.map((row) => `| ${row.market} | ${row.symbol} | ${row.actualStart ?? '-'} | ${row.actualEnd ?? '-'} | ${row.candleCount ?? row.candleCount1d ?? '-'} | ${row.coverage2010 ? 'YES' : 'NO'} | ${row.status ?? 'OK'} |`);
  return `# Representative Long-History Matrix — ${report.scope}\n\n- requested history start: 2000-01-01 (2010 is the required comparison line)\n- no synthetic/backfilled pre-listing data\n- current intraday search and historical profitability are intentionally separated\n- execution authority: NONE\n\n| Market | Symbol | Actual start | Actual end | Daily candles | Covers 2010 | Result |\n|---|---|---|---|---:|---|---|\n${rows.join("\n")}\n`;
}

const rows = [];
if (scope === "stocks") {
  for (const spec of STOCKS) {
    try { rows.push({ ...(await collectStockLong(spec)), status: "OK" }); }
    catch (error) { rows.push({ market: spec.market, symbol: spec.symbol, status: "TECHNICAL_FAILURE", error: String(error?.message ?? error).slice(0, 900) }); }
  }
} else if (scope === "spot") {
  for (const symbol of SPOT) {
    try { rows.push({ ...(await collectSpotLong(symbol)), status: "OK" }); }
    catch (error) { rows.push({ market: "CRYPTO_SPOT", symbol, status: "TECHNICAL_FAILURE", error: String(error?.message ?? error).slice(0, 900) }); }
  }
} else if (scope === "futures") {
  const client = new BitgetPublicClient({ minIntervalMs: 170, maxRetries: 4, timeoutMs: 15_000 });
  for (const symbol of FUTURES) {
    try { rows.push({ ...(await collectFuturesLong(symbol, client)), status: "OK" }); }
    catch (error) { rows.push({ market: "CRYPTO_FUTURES", symbol, status: "TECHNICAL_FAILURE", error: String(error?.message ?? error).slice(0, 900) }); }
  }
} else throw new Error(`UNKNOWN_SCOPE:${scope}`);

const technicalFailures = rows.filter((row) => row.status === "TECHNICAL_FAILURE").length;
const coverage2010 = rows.filter((row) => row.coverage2010 === true).length;
const report = { schemaVersion: 1, scope, generatedAt: new Date().toISOString(), requestedStart: iso(REQUESTED_START), target2010: iso(TARGET_2010), requestedEnd: iso(REQUESTED_END), researchOnly: true, liveExecutionAllowed: false, privateAccountRequestAllowed: false, actualOrders: 0, technicalFailures, coverage2010, rowCount: rows.length, rows };
await save(outputJson, `${JSON.stringify(report, null, 2)}\n`);
await save(outputMd, markdown(report));
console.log(JSON.stringify({ scope, technicalFailures, coverage2010, rowCount: rows.length, outputJson }, null, 2));
if (technicalFailures > 0) process.exitCode = 1;
