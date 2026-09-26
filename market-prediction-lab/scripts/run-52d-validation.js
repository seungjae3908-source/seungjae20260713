import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import { collectBitgetCandles, collectBitgetFuturesContext } from "../src/bitget-candle-collector.js";
import { repairBitgetCandleGaps } from "../src/candle-gap-repair.js";
import { verifyLiveCollection } from "../src/live-collection-verifier.js";
import { normalizeCandleRows } from "../src/normalizers.js";
import { buildTrainingRecords } from "../src/training-dataset.js";
import { walkForwardSplit } from "../src/walk-forward.js";
import { exportWalkForwardDataset } from "../src/dataset-export.js";

async function writeJsonAtomically(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: String(error?.message ?? error).slice(0, 1000),
    details: error?.details ?? null,
    stack: typeof error?.stack === "string" ? error.stack.split("\n").slice(0, 12) : [],
  };
}

function portableOutputs(outputs) {
  return Object.fromEntries(Object.entries(outputs).map(([name, output]) => [name, {
    count: output.count,
    sha256: output.sha256,
  }]));
}

function sha256Json(value) {
  return createHash("sha256").update(`${JSON.stringify(value, null, 2)}\n`).digest("hex");
}

const outputRoot = resolve(process.argv[2] ?? "live-52d-data");
const reportPath = resolve(process.argv[3] ?? "docs/btcusdt-15m-52d-result.json");
const market = "CRYPTO_FUTURES";
const symbol = "BTCUSDT";
const timeframe = "15m";
const days = 52;
const lookback = 200;
const horizon = 8;
const stride = 4;
const startedAt = Date.now();
let stage = "initialize";

try {
  stage = "collect_candles";
  const endTime = Date.now();
  const startTime = endTime - (days * 24 * 60 * 60 * 1000);
  const client = new BitgetPublicClient({ minIntervalMs: 150, maxRetries: 4, timeoutMs: 10_000 });
  const rawSnapshot = await collectBitgetCandles({
    client,
    market,
    symbol,
    timeframe,
    startTime,
    endTime,
    onPage: ({ page, received, oldest, newest }) => {
      console.log(JSON.stringify({ stage: "collect_candles", page, received, oldest, newest }));
    },
  });
  const rawPath = resolve(outputRoot, "raw-candles.json");
  await writeJsonAtomically(rawPath, rawSnapshot);

  stage = "repair_candle_gaps";
  const repair = await repairBitgetCandleGaps({
    client,
    market,
    symbol,
    timeframe,
    candles: rawSnapshot.candles,
    maxPasses: 2,
    onAttempt: (attempt) => console.log(JSON.stringify({ stage: "repair_candle_gaps", ...attempt })),
  });
  const repairReport = {
    schemaVersion: 1,
    initialGapCount: repair.initialGapCount,
    initialMissingCandleCount: repair.initialMissingCandleCount,
    repairedCandleCount: repair.repairedCandleCount,
    remainingGapCount: repair.remainingGapCount,
    remainingMissingCandleCount: repair.remainingMissingCandleCount,
    unresolvedGaps: repair.unresolvedGaps,
    attempts: repair.attempts,
  };
  await writeJsonAtomically(resolve(outputRoot, "gap-repair-report.json"), repairReport);

  const snapshot = Object.freeze({
    ...rawSnapshot,
    collectedAt: Date.now(),
    candles: repair.candles,
    repair: Object.freeze(repairReport),
  });
  await writeJsonAtomically(resolve(outputRoot, "repaired-candles.json"), snapshot);
  if (repair.remainingMissingCandleCount > 0) {
    const error = new Error(`unresolved timeframe gaps after targeted repair: ${repair.remainingMissingCandleCount}`);
    error.details = {
      remainingGapCount: repair.remainingGapCount,
      remainingMissingCandleCount: repair.remainingMissingCandleCount,
      unresolvedGaps: repair.unresolvedGaps,
    };
    throw error;
  }

  stage = "verify_candles";
  const quality = verifyLiveCollection(snapshot, { minCandles: 4_900 });
  await writeJsonAtomically(resolve(outputRoot, "quality-report.json"), quality);

  stage = "normalize_candles";
  const normalized = normalizeCandleRows(snapshot.candles, {
    market,
    symbol,
    timeframe,
    format: "canonical-object",
    source: "bitget-public-live-52d",
    strict: true,
  });
  if (normalized.quality.status === "invalid") throw new Error("normalized candle quality is invalid");
  const normalizedPath = resolve(outputRoot, "normalized-candles.json");
  await writeJsonAtomically(normalizedPath, normalized);

  stage = "build_training_records";
  const records = buildTrainingRecords(normalized, { lookback, horizon, stride });
  if (records.length < 500) throw new Error(`not enough training records: ${records.length}`);

  stage = "walk_forward_split";
  const split = walkForwardSplit(records, { trainRatio: 0.7, validationRatio: 0.15 });
  const manifest = await exportWalkForwardDataset(resolve(outputRoot, "dataset"), split, {
    market,
    symbol,
    timeframe,
    lookback,
    horizon,
    stride,
  });

  stage = "collect_futures_context";
  const context = await collectBitgetFuturesContext({ client, symbol });
  await writeJsonAtomically(resolve(outputRoot, "futures-context.json"), context);

  stage = "write_summary";
  const result = {
    schemaVersion: 1,
    status: "pass",
    stage: "complete",
    verifiedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    source: "github-actions-isolated-52d-validation",
    market,
    symbol,
    timeframe,
    requestedDays: days,
    candleCount: quality.candleCount,
    firstTimestamp: quality.firstTimestamp,
    lastTimestamp: quality.lastTimestamp,
    latestAgeMs: quality.latestAgeMs,
    gaps: quality.gaps,
    zeroVolume: quality.zeroVolume,
    maximumGapMs: quality.maximumGapMs,
    rawCandleSnapshotSha256: sha256Json(rawSnapshot),
    repairedCandleSnapshotSha256: sha256Json(snapshot),
    gapRepair: repairReport,
    normalizedQuality: normalized.quality,
    training: {
      lookback,
      horizon,
      stride,
      recordCount: records.length,
      splitReport: manifest.splitReport,
      outputs: portableOutputs(manifest.outputs),
    },
    futuresContext: {
      openInterestRaw: context.openInterestRaw,
      fundingRateRaw: context.fundingRateRaw,
      fundingIntervalHours: context.fundingIntervalHours,
      marketPriceRaw: context.marketPriceRaw,
      markPriceRaw: context.markPriceRaw,
      indexPriceRaw: context.indexPriceRaw,
      fundingHistoryCount: context.fundingHistory.length,
    },
  };
  await writeJsonAtomically(reportPath, result);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const result = {
    schemaVersion: 1,
    status: "fail",
    stage,
    verifiedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    source: "github-actions-isolated-52d-validation",
    market,
    symbol,
    timeframe,
    requestedDays: days,
    error: serializeError(error),
  };
  await writeJsonAtomically(reportPath, result);
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}
