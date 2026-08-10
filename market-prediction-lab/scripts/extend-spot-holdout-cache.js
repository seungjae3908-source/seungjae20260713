import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import { collectBitgetCandles } from "../src/bitget-candle-collector.js";
import { repairBitgetCandleGaps } from "../src/candle-gap-repair.js";
import { HISTORICAL_V1_CRYPTO_SPECS, summarizeHistoricalCoverage, toResearchCandles } from "../src/historical-backtest-data.js";
import { RESEARCH_BACKTEST_PERIOD } from "../src/multi-market-backtest-engine.js";

const DAY = 24 * 60 * 60 * 1000;
const root = resolve(process.argv[2] ?? "long-history-v1");
const generatedAt = Date.now();
const requestedEnd = Math.min(RESEARCH_BACKTEST_PERIOD.defaultEndTime, generatedAt);
const client = new BitgetPublicClient({ minIntervalMs: 160, maxRetries: 4, timeoutMs: 15_000 });

async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function writeJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

function mergeUnique(left, right) {
  const map = new Map();
  for (const row of [...left, ...right]) {
    const existing = map.get(row.timestamp);
    if (existing && ["open", "high", "low", "close", "volume"].some((field) => existing[field] !== row[field])) {
      throw new Error(`conflicting spot cached row at ${row.timestamp}`);
    }
    map.set(row.timestamp, row);
  }
  return [...map.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function assertContinuous(candles, label) {
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index].timestamp - candles[index - 1].timestamp !== DAY) throw new Error(`${label} candle gap at ${candles[index - 1].timestamp}`);
  }
}

const report = [];
for (const spec of HISTORICAL_V1_CRYPTO_SPECS.filter((row) => row.market === "CRYPTO_SPOT")) {
  const candlePath = resolve(root, `${spec.id}.candles.json`);
  const cached = await readJson(candlePath);
  const existing = cached.candles ?? [];
  const actualEnd = existing.at(-1)?.timestamp ?? null;
  if (actualEnd == null) throw new Error(`${spec.id} cached candles are empty`);
  const fetchStart = actualEnd + DAY;
  if (fetchStart > requestedEnd) {
    report.push({ spec: spec.id, status: "already_current", actualEnd });
    continue;
  }

  const collected = await collectBitgetCandles({
    client,
    market: spec.market,
    symbol: spec.exchangeSymbol,
    timeframe: spec.timeframe,
    startTime: fetchStart,
    endTime: requestedEnd + DAY,
    maxCandles: 5_000,
    onPage: ({ page, received, oldest, newest }) => console.log(JSON.stringify({ spec: spec.id, stage: "incremental-spot", page, received, oldest, newest })),
  });
  const repaired = await repairBitgetCandleGaps({
    client,
    market: spec.market,
    symbol: spec.exchangeSymbol,
    timeframe: spec.timeframe,
    candles: collected.candles,
    onAttempt: (attempt) => console.log(JSON.stringify({ spec: spec.id, stage: "incremental-repair", ...attempt })),
  });
  if (repaired.remainingMissingCandleCount > 0) throw new Error(`${spec.id} unresolved incremental candle gaps: ${repaired.remainingMissingCandleCount}`);
  const appended = toResearchCandles(spec, { candles: repaired.candles }).filter((row) => row.timestamp >= fetchStart && row.timestamp <= requestedEnd);
  const merged = mergeUnique(existing, appended);
  assertContinuous(merged, spec.id);
  const coverage = summarizeHistoricalCoverage({
    spec,
    candles: merged,
    requestedStartTime: RESEARCH_BACKTEST_PERIOD.startTime,
    requestedEndTime: RESEARCH_BACKTEST_PERIOD.defaultEndTime,
    asOfTime: generatedAt,
  });
  if (!coverage.coverageThroughAsOf) throw new Error(`${spec.id} failed incremental coverage through current closed history`);
  await writeJson(candlePath, {
    ...cached,
    coverage,
    candles: merged,
    incremental: { appendedFrom: fetchStart, appendedThrough: merged.at(-1)?.timestamp ?? actualEnd, generatedAt },
  });
  report.push({ spec: spec.id, status: appended.length ? "extended" : "already_current", fetchedFrom: fetchStart, appended: appended.length, actualEnd: merged.at(-1)?.timestamp ?? actualEnd });
}

console.log(JSON.stringify({ status: "ok", requestedEnd, report }));
