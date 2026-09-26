import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import { collectBitgetCandles } from "../src/bitget-candle-collector.js";
import { repairBitgetCandleGaps } from "../src/candle-gap-repair.js";
import { collectFundingRateHistory } from "../src/derivatives-history.js";
import { normalizeCandleRows } from "../src/normalizers.js";
import { buildTrainingRecords } from "../src/training-dataset.js";
import { walkForwardSplit } from "../src/walk-forward.js";
import { optimizeFrozenFuturesPnl } from "../src/futures-model-pnl-audit.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const GROUPS = Object.freeze([
  Object.freeze({ group: "crypto-futures-15m", timeframe: "15m", days: 60, lookback: 200, horizon: 8, stride: 4 }),
  Object.freeze({ group: "crypto-futures-1h", timeframe: "1h", days: 120, lookback: 200, horizon: 12, stride: 2 }),
]);
const SEED_SYMBOLS = Object.freeze(["BTCUSDT", "ETHUSDT"]);
const HOLDOUT_SYMBOLS = Object.freeze(["SOLUSDT"]);

async function save(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: String(error?.message ?? error).slice(0, 1200),
    details: error?.details ?? null,
    stack: typeof error?.stack === "string" ? error.stack.split("\n").slice(0, 10) : [],
  };
}

async function loadFrozenModel(group) {
  const artifact = JSON.parse(await readFile(resolve("docs/candidate-models", `${group}.json`), "utf8"));
  if (artifact?.status !== "shadow_candidate") {
    return Object.freeze({
      status: "research_hold",
      reason: "NO_FROZEN_SHADOW_CANDIDATE",
      sourceCandidateStatus: typeof artifact?.status === "string" ? artifact.status : "unknown",
      model: null,
    });
  }
  if (artifact?.model?.trained !== true) throw new Error(`INVALID_FROZEN_SHADOW_CANDIDATE_MODEL:${group}`);
  return Object.freeze({ status: "ready", reason: null, sourceCandidateStatus: artifact.status, model: artifact.model });
}

async function collectDataset({ client, symbol, config, suiteEndTime }) {
  const startTime = suiteEndTime - config.days * DAY_MS;
  const raw = await collectBitgetCandles({
    client,
    market: "CRYPTO_FUTURES",
    symbol,
    timeframe: config.timeframe,
    startTime,
    endTime: suiteEndTime,
    maxCandles: 50_000,
  });
  const repaired = await repairBitgetCandleGaps({
    client,
    market: "CRYPTO_FUTURES",
    symbol,
    timeframe: config.timeframe,
    candles: raw.candles,
  });
  if (repaired.remainingMissingCandleCount > 0) throw new Error(`${symbol}_${config.timeframe}_UNRESOLVED_GAPS_${repaired.remainingMissingCandleCount}`);
  const normalized = normalizeCandleRows(repaired.candles, {
    market: "CRYPTO_FUTURES",
    symbol,
    timeframe: config.timeframe,
    format: "canonical-object",
    source: `bitget-public-futures-pnl-${symbol}-${config.timeframe}`,
    strict: true,
  });
  if (normalized.quality.status !== "clean") throw new Error(`${symbol}_${config.timeframe}_QUALITY_${normalized.quality.status}`);
  const records = buildTrainingRecords(normalized, {
    lookback: config.lookback,
    horizon: config.horizon,
    stride: config.stride,
  });
  if (records.length < 120) throw new Error(`${symbol}_${config.timeframe}_RECORDS_${records.length}`);
  const split = walkForwardSplit(records, { trainRatio: 0.65, validationRatio: 0.15 });
  const funding = await collectFundingRateHistory({
    client,
    symbol,
    startTime: startTime - 12 * 60 * 60 * 1000,
    endTime: suiteEndTime,
    pageSize: 100,
    maxPages: 100,
  });
  return Object.freeze({
    symbol,
    timeframe: config.timeframe,
    candles: normalized.candles,
    records,
    split,
    fundingRates: funding.records,
    report: Object.freeze({
      symbol,
      timeframe: config.timeframe,
      candleCount: normalized.candles.length,
      recordCount: records.length,
      fundingRecords: funding.records.length,
      firstTimestamp: normalized.candles[0]?.timestamp ?? null,
      lastTimestamp: normalized.candles.at(-1)?.timestamp ?? null,
      split: split.report,
      quality: normalized.quality.status,
    }),
  });
}

const output = resolve(process.argv[2] ?? "docs/futures-pnl-suite-result.json");
const suiteEndTime = Date.now();
const client = new BitgetPublicClient({ minIntervalMs: 170, maxRetries: 4, timeoutMs: 12_000 });
const groups = {};

for (const config of GROUPS) {
  try {
    const frozen = await loadFrozenModel(config.group);
    if (frozen.status === "research_hold") {
      groups[config.group] = Object.freeze({
        status: "research_hold",
        reason: frozen.reason,
        sourceCandidateStatus: frozen.sourceCandidateStatus,
        modelRetrained: false,
        candidateFabricated: false,
      });
      continue;
    }
    const seedDatasets = [];
    const holdoutDatasets = [];
    for (const symbol of SEED_SYMBOLS) seedDatasets.push(await collectDataset({ client, symbol, config, suiteEndTime }));
    for (const symbol of HOLDOUT_SYMBOLS) holdoutDatasets.push(await collectDataset({ client, symbol, config, suiteEndTime }));
    const result = optimizeFrozenFuturesPnl({
      model: frozen.model,
      seedDatasets,
      holdoutDatasets,
      stressMultiplier: 1.5,
      initialCapital: 1_000_000,
    });
    groups[config.group] = Object.freeze({
      ...result,
      seedSymbols: SEED_SYMBOLS,
      holdoutSymbols: HOLDOUT_SYMBOLS,
      datasets: Object.freeze([...seedDatasets, ...holdoutDatasets].map((dataset) => dataset.report)),
    });
  } catch (error) {
    groups[config.group] = Object.freeze({ status: "technical_failure", error: serializeError(error) });
  }
}

const technicalFailure = Object.values(groups).some((group) => group.status === "technical_failure");
const report = Object.freeze({
  schemaVersion: 1,
  status: technicalFailure ? "fail" : "pass",
  researchOnly: true,
  liveExecutionAllowed: false,
  privateAccountRequestAllowed: false,
  suiteEndTime,
  methodology: "frozen BTC+ETH direction model -> train/validation execution-parameter selection -> untouched BTC+ETH test -> 1.5x cost stress -> unseen SOL holdout -> unseen SOL stress -> fixed-parameter future-time rolling audit",
  safeguards: Object.freeze({
    modelRetrained: false,
    candidateFabricationAllowed: false,
    noCandidateIsResearchHoldNotTechnicalFailure: true,
    solUsedForSelection: false,
    testUsedForSelection: false,
    currentOpenInterestBackfilled: false,
    historicalFundingAppliedOnlyDuringTradeHoldingPeriod: true,
    actualOrders: 0,
    privateAccountRequests: 0,
  }),
  groups,
});
await save(output, report);
console.log(JSON.stringify(report, null, 2));
if (technicalFailure) process.exitCode = 1;
