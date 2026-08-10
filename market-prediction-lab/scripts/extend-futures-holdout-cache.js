import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  collectVisionFuturesDailyKlines,
  collectVisionFuturesFunding,
} from "../src/binance-vision-futures-archive.js";
import { HISTORICAL_V1_CRYPTO_SPECS, summarizeHistoricalCoverage, toResearchCandles } from "../src/historical-backtest-data.js";
import { RESEARCH_BACKTEST_PERIOD } from "../src/multi-market-backtest-engine.js";

const DAY = 24 * 60 * 60 * 1000;
const root = resolve(process.argv[2] ?? "long-history-v1");
const asOf = Date.now();
const previousMonthEnd = Date.UTC(new Date(asOf).getUTCFullYear(), new Date(asOf).getUTCMonth(), 1) - DAY;
const requestedEnd = Math.min(RESEARCH_BACKTEST_PERIOD.defaultEndTime, previousMonthEnd);
const start = RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime;

function mergeUnique(left, right, fields) {
  const map = new Map();
  for (const row of [...left, ...right]) {
    const existing = map.get(row.timestamp);
    if (existing && fields.some((field) => existing[field] !== row[field])) throw new Error(`conflicting cached row at ${row.timestamp}`);
    map.set(row.timestamp, row);
  }
  return [...map.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function assertContinuous(candles, label) {
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index].timestamp - candles[index - 1].timestamp !== DAY) throw new Error(`${label} candle gap at ${candles[index - 1].timestamp}`);
  }
}

function assertFunding(records, label) {
  for (let index = 1; index < records.length; index += 1) {
    if (records[index].timestamp === records[index - 1].timestamp) throw new Error(`${label} duplicate funding at ${records[index].timestamp}`);
    if (records[index].timestamp - records[index - 1].timestamp > DAY) throw new Error(`${label} funding gap exceeds 24h at ${records[index - 1].timestamp}`);
  }
}

async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function writeJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

const report = [];
if (requestedEnd < start) {
  console.log(JSON.stringify({ status: "skipped", reason: "no_completed_2026_archive_month", requestedEnd }));
  process.exit(0);
}

for (const spec of HISTORICAL_V1_CRYPTO_SPECS.filter((row) => row.market === "CRYPTO_FUTURES")) {
  const candlePath = resolve(root, `${spec.id}.candles.json`);
  const fundingPath = resolve(root, `${spec.id}.funding.json`);
  const cachedCandles = await readJson(candlePath);
  const cachedFunding = await readJson(fundingPath);
  const alreadyThrough = cachedCandles.candles?.at(-1)?.timestamp ?? 0;
  const fetchStart = Math.max(start, alreadyThrough + DAY);
  if (fetchStart > requestedEnd) {
    report.push({ spec: spec.id, status: "already_current", actualEnd: alreadyThrough });
    continue;
  }

  const [price, funding] = await Promise.all([
    collectVisionFuturesDailyKlines({
      symbol: spec.exchangeSymbol,
      startTime: fetchStart,
      endTime: requestedEnd,
      concurrency: 6,
      onMonth: ({ month, rowCount }) => console.log(JSON.stringify({ spec: spec.id, stage: "holdout-price", month, rowCount })),
    }),
    collectVisionFuturesFunding({
      symbol: spec.exchangeSymbol,
      startTime: fetchStart,
      endTime: requestedEnd,
      concurrency: 6,
      onMonth: ({ month, rowCount }) => console.log(JSON.stringify({ spec: spec.id, stage: "holdout-funding", month, rowCount })),
    }),
  ]);
  if (price.checksumVerified !== true || funding.checksumVerified !== true) throw new Error(`${spec.id} archive checksum verification failed`);
  const newCandles = toResearchCandles(spec, price);
  const mergedCandles = mergeUnique(cachedCandles.candles ?? [], newCandles, ["open", "high", "low", "close", "volume"]);
  const mergedFunding = mergeUnique(cachedFunding.records ?? [], funding.records ?? [], ["rate"]);
  assertContinuous(mergedCandles, spec.id);
  assertFunding(mergedFunding, spec.id);
  const coverage = summarizeHistoricalCoverage({
    spec,
    candles: mergedCandles,
    requestedStartTime: RESEARCH_BACKTEST_PERIOD.startTime,
    requestedEndTime: requestedEnd,
    asOfTime: requestedEnd,
  });
  if (!coverage.coverageThroughAsOf) throw new Error(`${spec.id} failed completed-archive coverage through ${requestedEnd}`);

  await writeJson(candlePath, {
    ...cachedCandles,
    coverage,
    manifests: [...(cachedCandles.manifests ?? []), ...(price.manifests ?? [])],
    candles: mergedCandles,
    incremental: { appendedFrom: fetchStart, appendedThrough: requestedEnd, generatedAt: asOf },
  });
  await writeJson(fundingPath, {
    ...cachedFunding,
    endTime: requestedEnd,
    manifests: [...(cachedFunding.manifests ?? []), ...(funding.manifests ?? [])],
    records: mergedFunding,
    incremental: { appendedFrom: fetchStart, appendedThrough: requestedEnd, generatedAt: asOf },
  });
  report.push({ spec: spec.id, status: "extended", fetchedFrom: fetchStart, actualEnd: mergedCandles.at(-1)?.timestamp ?? null, fundingEnd: mergedFunding.at(-1)?.timestamp ?? null });
}

console.log(JSON.stringify({ status: "ok", requestedEnd, report }));
