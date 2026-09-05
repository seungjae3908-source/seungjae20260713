import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectUpbitSpotHistory } from "../src/upbit-spot-history.js";
import { normalizeCandleRows } from "../src/normalizers.js";
import { buildTrainingRecords } from "../src/training-dataset.js";
import { walkForwardSplit } from "../src/walk-forward.js";
import { BASELINE_MODEL } from "../src/tiny-model.js";
import {
  calibrateTemperature,
  compareCandidateToBaseline,
  evaluateStoredBaseline,
  evaluateTinyModel,
  trainTinySoftmaxModel,
} from "../src/tiny-model-training.js";

const SYMBOLS = ["BTC", "ETH"];
const DAY = 86_400_000;

async function save(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function metrics(value) {
  return {
    sampleCount: value.sampleCount,
    accuracy: value.accuracy,
    balancedAccuracy: value.balancedAccuracy,
    macroF1: value.macroF1,
    logLoss: value.logLoss,
    brier: value.brier,
    expectedCalibrationError: value.expectedCalibrationError,
  };
}

const endTime = Date.now();
const startTime = endTime - 240 * DAY;
const output = resolve(process.argv[2] ?? "docs/upbit-spot-suite-result.json");
const datasets = [];
const datasetReport = {};

for (const symbol of SYMBOLS) {
  const history = await collectUpbitSpotHistory({ symbol, startTime, endTime });
  const normalized = normalizeCandleRows(history.candles, {
    market: "CRYPTO_SPOT",
    symbol,
    timeframe: "4h",
    format: "canonical-object",
    source: `upbit-public-${symbol}-4h`,
    strict: true,
  });
  if (normalized.quality.status === "invalid") throw new Error(`UPBIT_${symbol}_QUALITY_INVALID`);
  const records = buildTrainingRecords(normalized, { lookback: 200, horizon: 6, stride: 1 });
  if (records.length < 120) throw new Error(`UPBIT_${symbol}_RECORDS_${records.length}`);
  const split = walkForwardSplit(records, { trainRatio: 0.7, validationRatio: 0.15 });
  datasets.push({ symbol, history, split });
  datasetReport[symbol] = {
    candleCount: history.candleCount,
    pageCount: history.pageCount,
    firstTimestamp: history.firstTimestamp,
    lastTimestamp: history.lastTimestamp,
    quality: normalized.quality,
    split: split.report,
  };
}

const combined = {
  train: datasets.flatMap((item) => item.split.train),
  validation: datasets.flatMap((item) => item.split.validation),
  test: datasets.flatMap((item) => item.split.test),
};
const model = trainTinySoftmaxModel(combined.train, {
  featureOrder: BASELINE_MODEL.featureOrder,
  id: "tiny-softmax-upbit-spot-4h-btc-eth-v1",
  epochs: 520,
  learningRate: 0.075,
  l2: 0.003,
  patience: 60,
});
const calibrated = calibrateTemperature(combined.validation, model);
const baseline = evaluateStoredBaseline(combined.test);
const candidate = evaluateTinyModel(combined.test, calibrated);
const comparison = compareCandidateToBaseline(baseline, candidate);
const perSymbol = Object.fromEntries(datasets.map((item) => {
  const base = evaluateStoredBaseline(item.split.test);
  const cand = evaluateTinyModel(item.split.test, calibrated);
  return [item.symbol, {
    baseline: metrics(base),
    candidate: metrics(cand),
    comparison: compareCandidateToBaseline(base, cand),
  }];
}));
const perSymbolNonRegressive = Object.values(perSymbol).every((item) => item.comparison.promoted || item.comparison.reason === "candidate_not_materially_better");
const status = comparison.promoted && perSymbolNonRegressive ? "shadow_candidate" : "research_hold";
const report = {
  schemaVersion: 1,
  status,
  market: "CRYPTO_SPOT",
  exchange: "UPBIT",
  group: "upbit-spot-4h-btc-eth",
  crossSymbol: true,
  symbols: SYMBOLS,
  researchOnly: true,
  liveExecutionAllowed: false,
  privateAccountRequestAllowed: false,
  baselineTest: metrics(baseline),
  candidateTest: metrics(candidate),
  comparison,
  perSymbol,
  datasets: datasetReport,
  limitations: [
    "price-volume features only",
    "classification metrics are not trading PnL",
    "shadow_candidate still requires cost-aware PnL and extended walk-forward confirmation",
  ],
};
await save(output, report);
console.log(JSON.stringify(report, null, 2));
