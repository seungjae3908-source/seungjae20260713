import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  BENCHMARK_PERIOD,
  runEqualWeightBuyHoldBaseline,
} from "../src/evidence-backed-3y-benchmark-v1.js";
import {
  buildMonthRange,
  collectVisionFuturesFunding,
  extractSingleCsvFromZip,
} from "../src/binance-vision-futures-archive.js";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
import {
  EVIDENCE_ALPHA_PARAMETERS,
  evidenceAlphaSafety,
  runCryptoOrderFlowProxy,
  runKrOvernightDaytimeReversalProxy,
  runUsPriorRvolGapContinuationProxy,
} from "../src/public-evidence-alpha-3y-v1.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const OUTPUT = resolve(process.argv[2] ?? "docs/public-evidence-alpha-3y-v1-result.json");

const STOCK_BASKETS = Object.freeze({
  US_STOCK: Object.freeze(["AAPL", "MSFT", "NVDA", "AMZN", "META", "TSLA", "JPM", "XOM"]),
  KR_STOCK: Object.freeze(["005930", "000660", "005380", "105560", "035420", "000270", "068270", "066570"]),
});

const CRYPTO_SYMBOLS = Object.freeze(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);

async function save(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: String(error?.message ?? error).slice(0, 1800),
    details: error?.details ?? null,
    stack: typeof error?.stack === "string" ? error.stack.split("\n").slice(0, 12) : [],
  };
}

function normalizeTimestamp(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error("BINANCE_TIMESTAMP_INVALID");
  const milliseconds = value >= 100_000_000_000_000 ? Math.trunc(value / 1000) : Math.trunc(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) throw new Error("BINANCE_TIMESTAMP_INVALID");
  return milliseconds;
}

function rows(text) {
  return String(text)
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(",").map((cell) => cell.trim()));
}

function isHeader(row) {
  return row?.some((cell) => /[A-Za-z_]/u.test(cell));
}

function parseDetailedKlines(text, symbol) {
  const parsed = rows(text);
  const data = isHeader(parsed[0]) ? parsed.slice(1) : parsed;
  return data.map((row, index) => {
    if (row.length < 10) throw new Error(`BINANCE_KLINE_COLUMNS_INSUFFICIENT:${index}`);
    const timestamp = normalizeTimestamp(row[0]);
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const volume = Number(row[5]);
    const takerBuyVolume = Number(row[9]);
    if (![open, high, low, close, volume, takerBuyVolume].every(Number.isFinite)
        || !(open > 0 && high > 0 && low > 0 && close > 0)
        || volume < 0 || takerBuyVolume < 0 || takerBuyVolume > volume * 1.0000001
        || high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
      throw new Error(`BINANCE_KLINE_INVALID:${symbol}:${index}`);
    }
    return Object.freeze({
      symbol,
      timestamp,
      observedAt: timestamp,
      isClosed: true,
      open,
      high,
      low,
      close,
      volume,
      takerBuyVolume,
    });
  });
}

async function fetchVerifiedCsv(url) {
  const checksumResponse = await fetch(`${url}.CHECKSUM`, {
    headers: { "user-agent": "market-prediction-lab/public-evidence-alpha-v1" },
  });
  if (!checksumResponse.ok) throw Object.assign(new Error(`BINANCE_VISION_CHECKSUM_HTTP_${checksumResponse.status}`), { url });
  const checksumText = (await checksumResponse.text()).trim();
  const expected = checksumText.split(/\s+/u)[0]?.toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(expected ?? "")) throw new Error(`BINANCE_VISION_CHECKSUM_INVALID:${url}`);

  const response = await fetch(url, {
    headers: { "user-agent": "market-prediction-lab/public-evidence-alpha-v1" },
  });
  if (!response.ok) throw Object.assign(new Error(`BINANCE_VISION_HTTP_${response.status}`), { url });
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`BINANCE_VISION_CHECKSUM_MISMATCH:${url}`);
  const extracted = extractSingleCsvFromZip(bytes);
  return Object.freeze({ text: extracted.text, sha256: actual });
}

async function collectDetailedVisionKlines({
  market,
  symbol,
  startTime,
  endTime,
  interval = "1h",
  concurrency = 6,
}) {
  const months = [...buildMonthRange(startTime, endTime)];
  const base = market === "CRYPTO_FUTURES"
    ? "https://data.binance.vision/data/futures/um/monthly/klines"
    : "https://data.binance.vision/data/spot/monthly/klines";
  const output = new Array(months.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= months.length) return;
      const month = months[index];
      const file = `${symbol}-${interval}-${month}.zip`;
      const url = `${base}/${symbol}/${interval}/${file}`;
      const csv = await fetchVerifiedCsv(url);
      output[index] = Object.freeze({
        month,
        url,
        sha256: csv.sha256,
        rows: parseDetailedKlines(csv.text, symbol),
      });
    }
  };

  await Promise.all(Array.from(
    { length: Math.max(1, Math.min(concurrency, months.length)) },
    () => worker(),
  ));

  const byTimestamp = new Map();
  for (const entry of output) {
    for (const row of entry.rows) {
      if (row.timestamp >= startTime && row.timestamp <= endTime) byTimestamp.set(row.timestamp, row);
    }
  }
  const candles = [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
  if (candles.length < 1_000) throw new Error(`BINANCE_VISION_HISTORY_INSUFFICIENT:${market}:${symbol}:${candles.length}`);
  return Object.freeze({
    provider: market === "CRYPTO_FUTURES"
      ? "binance-vision-usdm-monthly-1h"
      : "binance-vision-spot-monthly-1h",
    market,
    symbol,
    interval,
    checksumVerified: true,
    candleCount: candles.length,
    firstTimestamp: candles[0].timestamp,
    lastTimestamp: candles.at(-1).timestamp,
    candles: Object.freeze(candles),
    manifests: Object.freeze(output.map(({ rows: ignored, ...manifest }) => manifest)),
  });
}

async function collectStockBasket(market) {
  const datasets = [];
  const startTime = BENCHMARK_PERIOD.startTime - 90 * DAY;
  const endTime = BENCHMARK_PERIOD.endTime + DAY;
  for (const symbol of STOCK_BASKETS[market]) {
    const history = await collectYahooStockHistory({ market, symbol, startTime, endTime });
    datasets.push(Object.freeze({
      symbol,
      provider: history.source,
      candles: history.candles.map((row) => Object.freeze({
        ...row,
        symbol,
        observedAt: row.timestamp,
        isClosed: true,
      })),
      coverage: Object.freeze({
        candleCount: history.candleCount,
        firstTimestamp: history.firstTimestamp,
        lastTimestamp: history.lastTimestamp,
      }),
    }));
  }
  return Object.freeze(datasets);
}

async function collectCryptoBasket(market) {
  const startTime = BENCHMARK_PERIOD.startTime - 72 * HOUR;
  const endTime = BENCHMARK_PERIOD.endTime;
  const datasets = [];
  for (const symbol of CRYPTO_SYMBOLS) {
    const history = await collectDetailedVisionKlines({
      market,
      symbol,
      startTime,
      endTime,
      interval: "1h",
    });
    datasets.push(Object.freeze({
      symbol,
      provider: history.provider,
      candles: history.candles,
      coverage: Object.freeze({
        candleCount: history.candleCount,
        firstTimestamp: history.firstTimestamp,
        lastTimestamp: history.lastTimestamp,
        checksumVerified: history.checksumVerified,
      }),
    }));
  }
  return Object.freeze(datasets);
}

async function collectFundingBySymbol() {
  const startTime = BENCHMARK_PERIOD.startTime - 7 * DAY;
  const endTime = BENCHMARK_PERIOD.endTime;
  const entries = [];
  for (const symbol of CRYPTO_SYMBOLS) {
    const history = await collectVisionFuturesFunding({
      symbol,
      startTime,
      endTime,
      concurrency: 6,
    });
    entries.push([symbol, history.records]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function baselineRow({ market, datasets, barsPerYear }) {
  const result = runEqualWeightBuyHoldBaseline({
    datasets,
    perSideCostBps: 10,
    barsPerYear,
  });
  return Object.freeze({
    market,
    strategy: "EQUAL_WEIGHT_BUY_HOLD_BASELINE",
    status: "MEASURED_BASELINE",
    performance: result.performance,
    periodAnalysis: result.periodAnalysis,
  });
}

function strategyRow({ market, strategy, evidenceTier, result }) {
  return Object.freeze({
    market,
    strategy,
    evidenceTier,
    status: "MEASURED_PROXY",
    sourceFaithfulReplication: result.sourceFaithfulReplication,
    performance: result.performance,
    periodAnalysis: result.periodAnalysis,
    details: result.details,
    profitabilityCredit: 0,
    promotionEligible: false,
    executionAuthority: "NONE",
  });
}

const startedAt = Date.now();
const results = [];
const blockers = [];
const provenance = {};
const errors = [];

try {
  const us = await collectStockBasket("US_STOCK");
  provenance.US_STOCK = us.map((row) => ({ symbol: row.symbol, provider: row.provider, ...row.coverage }));
  const usResult = runUsPriorRvolGapContinuationProxy({ datasets: us });
  results.push(strategyRow({
    market: "US_STOCK",
    strategy: usResult.family,
    evidenceTier: "PROXY_FROM_STOCKS_IN_PLAY_OPENING_CONTINUATION",
    result: usResult,
  }));
  results.push(baselineRow({ market: "US_STOCK", datasets: us, barsPerYear: 252 }));
} catch (error) {
  errors.push({ market: "US_STOCK", error: serializeError(error) });
}

try {
  const kr = await collectStockBasket("KR_STOCK");
  provenance.KR_STOCK = kr.map((row) => ({ symbol: row.symbol, provider: row.provider, ...row.coverage }));
  const krResult = runKrOvernightDaytimeReversalProxy({ datasets: kr });
  results.push(strategyRow({
    market: "KR_STOCK",
    strategy: krResult.family,
    evidenceTier: "DIRECT_DAILY_PROXY_FROM_KOREA_OVERNIGHT_DAYTIME_REVERSAL",
    result: krResult,
  }));
  results.push(baselineRow({ market: "KR_STOCK", datasets: kr, barsPerYear: 252 }));
} catch (error) {
  errors.push({ market: "KR_STOCK", error: serializeError(error) });
}

let spot = null;
try {
  spot = await collectCryptoBasket("CRYPTO_SPOT");
  provenance.CRYPTO_SPOT = spot.map((row) => ({ symbol: row.symbol, provider: row.provider, ...row.coverage }));
  const spotResult = runCryptoOrderFlowProxy({
    datasets: spot,
    market: "CRYPTO_SPOT",
  });
  results.push(strategyRow({
    market: "CRYPTO_SPOT",
    strategy: spotResult.family,
    evidenceTier: "BINANCE_TAKER_FLOW_PROXY_FOR_GLOBAL_ORDER_FLOW_ML",
    result: spotResult,
  }));
  results.push(baselineRow({ market: "CRYPTO_SPOT", datasets: spot, barsPerYear: 365 * 24 }));
} catch (error) {
  errors.push({ market: "CRYPTO_SPOT", error: serializeError(error) });
}

try {
  const futures = await collectCryptoBasket("CRYPTO_FUTURES");
  const fundingBySymbol = await collectFundingBySymbol();
  provenance.CRYPTO_FUTURES = futures.map((row) => ({
    symbol: row.symbol,
    provider: row.provider,
    ...row.coverage,
    fundingRecords: fundingBySymbol[row.symbol]?.length ?? 0,
  }));
  const futuresResult = runCryptoOrderFlowProxy({
    datasets: futures,
    market: "CRYPTO_FUTURES",
    fundingBySymbol,
  });
  results.push(strategyRow({
    market: "CRYPTO_FUTURES",
    strategy: futuresResult.family,
    evidenceTier: "BINANCE_TAKER_FLOW_PLUS_FUNDING_PROXY",
    result: futuresResult,
  }));
  results.push(baselineRow({ market: "CRYPTO_FUTURES", datasets: futures, barsPerYear: 365 * 24 }));
} catch (error) {
  errors.push({ market: "CRYPTO_FUTURES", error: serializeError(error) });
}

blockers.push(
  Object.freeze({
    market: "US_STOCK",
    exactReplication: "BLOCKED_DATA",
    missing: Object.freeze([
      "THREE_YEAR_POINT_IN_TIME_FULL_US_UNIVERSE",
      "THREE_YEAR_5M_FIRST_RANGE_AND_FIRST_5M_RVOL",
      "NYSE_OPENING_AUCTION_IMBALANCE_HISTORY_BOUND_TO_SYMBOLS",
      "TRANSACTION_LEVEL_INTRADAY_SHORT_FLOW",
    ]),
  }),
  Object.freeze({
    market: "KR_STOCK",
    exactReplication: "PARTIAL_DAILY_ONLY",
    missing: Object.freeze([
      "POINT_IN_TIME_RETAIL_VS_INSTITUTION_COUNTERPARTY_ORDER_FLOW",
      "POINT_IN_TIME_NAT_SERIES",
      "THREE_YEAR_FIRST_30M_INTRADAY_BARS",
    ]),
  }),
  Object.freeze({
    market: "CRYPTO_SPOT",
    exactReplication: "PROXY_ONLY",
    missing: Object.freeze([
      "84_COIN_GLOBAL_MULTI_EXCHANGE_ORDER_FLOW",
      "PUBLISHED_NONLINEAR_ML_SPECIFICATION_AND_TRAINING_REPLICATION",
    ]),
  }),
  Object.freeze({
    market: "CRYPTO_FUTURES",
    exactReplication: "PROXY_ONLY",
    missing: Object.freeze([
      "THREE_YEAR_POINT_IN_TIME_L2_DEPTH_AND_ABSORPTION",
      "THREE_YEAR_OPEN_INTEREST_HISTORY",
      "THREE_YEAR_LIQUIDATION_EVENT_HISTORY",
      "MULTI_VENUE_SPOT_FUTURES_OPTIONS_ORDER_IMBALANCE",
    ]),
  }),
);

const report = Object.freeze({
  schemaVersion: 1,
  contract: "public-evidence-alpha-3y/v1",
  status: results.some((row) => row.status === "MEASURED_PROXY")
    ? "PASS_WITH_PROXY_AND_DATA_BLOCKS"
    : "BLOCKED_NO_MEASURED_PROXY",
  generatedAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  period: BENCHMARK_PERIOD,
  parameters: EVIDENCE_ALPHA_PARAMETERS,
  methodology: Object.freeze({
    predeclaredBeforeResultRead: true,
    fixedThreeYearWindow: true,
    stockExecution: "signal known at daily open; exit same daily close; round-trip friction included",
    cryptoExecution: "trailing 24h taker-flow signal; 4h rebalance cadence on 1h public klines; next interval returns; turnover cost included",
    futuresFundingIncluded: true,
    lookaheadAllowed: false,
    sourcePaperReturnsUsedAsLocalExpectedReturn: false,
  }),
  results: Object.freeze(results),
  blockers: Object.freeze(blockers),
  provenance: Object.freeze(provenance),
  errors: Object.freeze(errors),
  safety: evidenceAlphaSafety(),
});

await save(OUTPUT, report);
console.log(JSON.stringify({
  status: report.status,
  output: OUTPUT,
  durationMs: report.durationMs,
  measured: report.results.filter((row) => row.status === "MEASURED_PROXY").map((row) => ({
    market: row.market,
    strategy: row.strategy,
    totalReturn: row.performance.totalReturn,
    cagr: row.performance.cagr,
    sharpe: row.performance.annualizedSharpe,
    mdd: row.performance.maximumDrawdown,
    windows: Object.fromEntries(Object.entries(row.periodAnalysis.windows).map(([key, value]) => [
      key,
      { latestReturn: value.latestReturn, positiveRate: value.positiveRate },
    ])),
  })),
  errors: report.errors,
  blockers: report.blockers,
}, null, 2));
