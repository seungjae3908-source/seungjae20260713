import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${name}`);
    values[name] = value;
    index += 1;
  }
  return values;
}

async function readLastJsonLine(filePath) {
  const content = await readFile(filePath, "utf8");
  const lines = content.trim().split("\n").filter(Boolean);
  if (lines.length === 0) throw new Error(`no JSONL records in ${filePath}`);
  return JSON.parse(lines.at(-1));
}

const args = parseArgs(process.argv.slice(2));
const dataRoot = resolve(args["data-root"] ?? "live-smoke-data");
const outputPath = resolve(args.output ?? "docs/live-smoke-result.json");
const candlePath = resolve(dataRoot, "crypto_futures/BTCUSDT/candles-15m.json");
const qualityPath = resolve(dataRoot, "quality-report.json");
const contextPath = resolve(dataRoot, "crypto_futures/BTCUSDT/futures-context.jsonl");

const candleBytes = await readFile(candlePath);
const quality = JSON.parse(await readFile(qualityPath, "utf8"));
const context = await readLastJsonLine(contextPath);
const result = {
  schemaVersion: 1,
  status: quality.status,
  verifiedAt: Date.now(),
  source: "github-actions-isolated-live-smoke",
  provider: quality.provider,
  market: quality.market,
  symbol: quality.symbol,
  timeframe: quality.timeframe,
  candleCount: quality.candleCount,
  firstTimestamp: quality.firstTimestamp,
  lastTimestamp: quality.lastTimestamp,
  latestAgeMs: quality.latestAgeMs,
  gaps: quality.gaps,
  zeroVolume: quality.zeroVolume,
  maximumGapMs: quality.maximumGapMs,
  candleFileSha256: createHash("sha256").update(candleBytes).digest("hex"),
  futuresContext: {
    collectedAt: context.collectedAt,
    openInterest: context.openInterest,
    openInterestTimestamp: context.openInterestTimestamp,
    fundingRate: context.fundingRate,
    fundingIntervalHours: context.fundingIntervalHours,
    marketPrice: context.marketPrice,
    markPrice: context.markPrice,
    indexPrice: context.indexPrice,
    fundingHistoryCount: Array.isArray(context.fundingHistory) ? context.fundingHistory.length : 0,
  },
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
