import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import { collectFundingRateHistory } from "../src/derivatives-history.js";
import {
  collectVisionFuturesDailyArchiveKlines,
  collectVisionFuturesDailyKlines,
  collectVisionFuturesFunding,
} from "../src/binance-vision-futures-archive.js";
import {
  BITGET_STANDARD_TAKER_RESEARCH_COSTS,
  HISTORICAL_V1_CRYPTO_SPECS,
  toResearchCandles,
} from "../src/historical-backtest-data.js";
import {
  FINAL_HOLDOUT_END,
  FINAL_HOLDOUT_WARMUP_START,
  FROZEN_CANDIDATE_MANIFEST_SHA256,
  runFrozenFinalHoldout,
} from "../src/final-holdout-evaluator.js";
import {
  ETH_V6_FORWARD_CANDIDATE,
  compareReplayMetrics,
} from "../src/eth-v6-forward-validation.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHLY_END = Date.UTC(2026, 7, 1) - 1;
const DAILY_START = Date.UTC(2026, 7, 1);
const expectedPath = resolve(process.argv[2] ?? "docs/final-holdout-2026-result.json");
const proofPath = resolve(process.argv[3] ?? "docs/eth-v6-replay-proof.json");
const markdownPath = resolve(process.argv[4] ?? "docs/eth-v6-replay-proof.md");

function mergeRows(groups, fields, label) {
  const map = new Map();
  for (const rows of groups) {
    for (const row of rows) {
      const previous = map.get(row.timestamp);
      if (previous && fields.some((field) => previous[field] !== row[field])) throw new Error(`${label} conflict at ${row.timestamp}`);
      map.set(row.timestamp, row);
    }
  }
  return Object.freeze([...map.values()].sort((a, b) => a.timestamp - b.timestamp));
}

function compact(result) {
  const metrics = result?.metrics ?? result;
  return Object.freeze({
    finalCapital: metrics.finalCapital,
    returnPercent: metrics.returnPercent,
    successRatePercent: metrics.successRatePercent,
    profitFactor: metrics.profitFactor,
    maximumDrawdownPercent: metrics.maximumDrawdownPercent,
    expectancy: metrics.expectancy,
    trades: metrics.trades,
  });
}

function iso(timestamp) {
  return timestamp ? new Date(timestamp).toISOString() : null;
}

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

const stored = JSON.parse(await readFile(expectedPath, "utf8"));
if (stored.candidateManifestSha256 !== FROZEN_CANDIDATE_MANIFEST_SHA256) throw new Error("stored final holdout manifest does not match frozen candidate manifest");
const expected = stored.results.find((row) => row.id === ETH_V6_FORWARD_CANDIDATE.id);
if (!expected) throw new Error("stored ETH V6 final holdout result is missing");

const spec = HISTORICAL_V1_CRYPTO_SPECS.find((row) => row.market === "CRYPTO_FUTURES" && row.exchangeSymbol === "ETHUSDT");
if (!spec) throw new Error("ETHUSDT historical futures spec is missing");

const [monthlyPrices, dailyPrices, monthlyFunding] = await Promise.all([
  collectVisionFuturesDailyKlines({ symbol: "ETHUSDT", startTime: FINAL_HOLDOUT_WARMUP_START, endTime: MONTHLY_END, concurrency: 6 }),
  collectVisionFuturesDailyArchiveKlines({ symbol: "ETHUSDT", startTime: DAILY_START, endTime: FINAL_HOLDOUT_END, concurrency: 4 }),
  collectVisionFuturesFunding({ symbol: "ETHUSDT", startTime: FINAL_HOLDOUT_WARMUP_START, endTime: MONTHLY_END, concurrency: 6 }),
]);

const bitget = new BitgetPublicClient({ minIntervalMs: 180, maxRetries: 4, timeoutMs: 15_000 });
const augustFunding = await collectFundingRateHistory({
  client: bitget,
  symbol: "ETHUSDT",
  productType: "usdt-futures",
  startTime: DAILY_START,
  endTime: FINAL_HOLDOUT_END,
  pageSize: 100,
  maxPages: 10,
});

const priceRows = mergeRows([monthlyPrices.candles, dailyPrices.candles], ["open", "high", "low", "close", "volume"], "ETHUSDT replay prices");
const fundingRates = mergeRows([monthlyFunding.records, augustFunding.records], ["rate"], "ETHUSDT replay funding");
const candles = toResearchCandles(spec, { candles: priceRows });

for (let index = 1; index < candles.length; index += 1) {
  if (candles[index].timestamp - candles[index - 1].timestamp !== DAY_MS) throw new Error(`ETHUSDT replay daily gap at ${candles[index - 1].timestamp}`);
}
if (candles.at(-1)?.timestamp < Date.UTC(2026, 7, 7)) throw new Error("ETHUSDT replay price coverage ends before 2026-08-07");
if (fundingRates.at(-1)?.timestamp < Date.UTC(2026, 7, 7)) throw new Error("ETHUSDT replay funding coverage ends before 2026-08-07");

const result = runFrozenFinalHoldout({
  candidate: ETH_V6_FORWARD_CANDIDATE,
  backtestInput: Object.freeze({
    market: "CRYPTO_FUTURES",
    symbol: "ETHUSDT",
    side: "long",
    timeframe: "1d",
    initialCapital: 1_000_000,
    candles,
    fundingRates,
    costModel: BITGET_STANDARD_TAKER_RESEARCH_COSTS.CRYPTO_FUTURES,
    riskModel: Object.freeze({ riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 }),
  }),
  endTime: FINAL_HOLDOUT_END,
});

const actual = compact(result);
const comparison = compareReplayMetrics(expected, actual, 1e-8);
const proof = Object.freeze({
  schemaVersion: 1,
  generatedAt: Date.now(),
  strategyId: ETH_V6_FORWARD_CANDIDATE.id,
  candidateManifestSha256: FROZEN_CANDIDATE_MANIFEST_SHA256,
  replayOf: "2026-one-shot-final-holdout",
  status: comparison.passed ? "passed" : "failed",
  expected: Object.freeze({
    finalCapital: expected.finalCapital,
    returnPercent: expected.returnPercent,
    successRatePercent: expected.successRatePercent,
    profitFactor: expected.profitFactor,
    maximumDrawdownPercent: expected.maximumDrawdownPercent,
    expectancy: expected.expectancy,
    trades: expected.trades,
  }),
  actual,
  comparison,
  tradeLedger: result.trades,
  data: Object.freeze({
    priceProvider: "binance-vision-usdm-monthly+daily",
    monthlyPriceChecksumVerified: monthlyPrices.checksumVerified,
    dailyPriceChecksumVerified: dailyPrices.checksumVerified,
    fundingProvider: "binance-vision-usdm-monthly->bitget-public-v2-august",
    monthlyFundingChecksumVerified: monthlyFunding.checksumVerified,
    priceStart: candles[0]?.timestamp ?? null,
    priceEnd: candles.at(-1)?.timestamp ?? null,
    fundingStart: fundingRates[0]?.timestamp ?? null,
    fundingEnd: fundingRates.at(-1)?.timestamp ?? null,
  }),
  safeguards: Object.freeze({
    usedForSelection: false,
    parametersChanged: false,
    optimizerUsed: false,
    replayOnly: true,
    publicMarketDataOnly: true,
    orderSubmitted: false,
    privateAccountRequestAllowed: false,
    liveOrderAllowed: false,
  }),
});

const markdown = `# ETHUSDT V6 deterministic replay proof\n\n`
  + `- status: **${proof.status}**\n`
  + `- candidate: ${proof.strategyId}\n`
  + `- manifest: \`${proof.candidateManifestSha256}\`\n`
  + `- price coverage: ${iso(proof.data.priceStart)} ~ ${iso(proof.data.priceEnd)}\n`
  + `- funding coverage: ${iso(proof.data.fundingStart)} ~ ${iso(proof.data.fundingEnd)}\n`
  + `- expected return: ${expected.returnPercent.toFixed(6)}% / replay return: ${actual.returnPercent.toFixed(6)}%\n`
  + `- expected trades: ${expected.trades} / replay trades: ${actual.trades}\n`
  + `- used for selection: false\n`
  + `- parameters changed after holdout: false\n`
  + `- live/order/private-account access: false\n`;

await write(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
await write(markdownPath, markdown);
console.log(markdown);
if (!comparison.passed) process.exitCode = 1;
