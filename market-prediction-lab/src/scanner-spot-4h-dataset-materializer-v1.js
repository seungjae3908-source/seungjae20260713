import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { sha256Canonical as hash } from "./research-cache-provenance.js";
import {
  buildResearchDatasetSnapshotManifestV1,
  persistResearchDatasetSnapshotManifestV1,
} from "../../research-production/src/research-dataset-snapshot-store.mjs";
import {
  buildCanonicalDatasetComponentV1,
  persistCanonicalDatasetComponentV1,
} from "../../research-production/src/research-canonical-dataset-component.mjs";

export const SCANNER_SPOT_4H_DATASET_MATERIALIZER_V1 = "scanner-spot-4h-dataset-materializer-v1";
export const SPOT_SCANNER_HISTORICAL_SPREAD_FIRST_ZERO = "SPOT_SCANNER_HISTORICAL_SPREAD_SERIES_MISSING";

const SHA40 = /^[0-9a-f]{40}$/iu;
const SYMBOL = /^[A-Z0-9]{1,20}$/u;
const HOUR = 60 * 60 * 1000;
const FOUR_HOURS = 4 * HOUR;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
function exactSha(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!SHA40.test(normalized)) throw new Error("SPOT_SCANNER_EXACT_RESEARCH_SHA_REQUIRED");
  return normalized;
}
function exactSymbol(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (!SYMBOL.test(normalized)) throw new Error("SPOT_SCANNER_SYMBOL_INVALID");
  return normalized;
}
function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function normalizeClosedRows(history, expectedTimeframe, intervalMs, observedAtMs, { requireContiguous = true } = {}) {
  if (!history || history.market !== "CRYPTO_SPOT" || history.exchange !== "UPBIT"
      || history.timeframe !== expectedTimeframe || history.intervalMs !== intervalMs
      || !Array.isArray(history.candles)) {
    throw new Error(`SPOT_SCANNER_${expectedTimeframe.toUpperCase()}_HISTORY_IDENTITY_INVALID`);
  }
  const rows = history.candles
    .filter((row) => Number.isSafeInteger(row?.timestamp) && row.timestamp + intervalMs <= observedAtMs)
    .map((row) => ({
      timestamp: row.timestamp,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
      quoteVolume: row.quoteVolume == null ? null : Number(row.quoteVolume),
    }))
    .sort((left, right) => left.timestamp - right.timestamp);
  if (rows.length < 300) throw new Error(`SPOT_SCANNER_${expectedTimeframe.toUpperCase()}_HISTORY_INSUFFICIENT`);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (![row.open, row.high, row.low, row.close, row.volume].every(finite)
        || row.open <= 0 || row.high <= 0 || row.low <= 0 || row.close <= 0 || row.volume < 0
        || row.high < Math.max(row.open, row.close, row.low)
        || row.low > Math.min(row.open, row.close, row.high)) {
      throw new Error(`SPOT_SCANNER_${expectedTimeframe.toUpperCase()}_ROW_INVALID`);
    }
    if (index > 0) {
      const delta = row.timestamp - rows[index - 1].timestamp;
      if (delta <= 0 || delta % intervalMs !== 0) {
        throw new Error(`SPOT_SCANNER_${expectedTimeframe.toUpperCase()}_INTERVAL_ALIGNMENT_INVALID`);
      }
      if (requireContiguous && delta !== intervalMs) {
        throw new Error(`SPOT_SCANNER_${expectedTimeframe.toUpperCase()}_INTERVAL_GAP`);
      }
    }
  }
  return rows;
}
function splitAssignments(rows) {
  const trainEnd = Math.floor(rows.length * 0.6);
  const validationEnd = Math.floor(rows.length * 0.8);
  const train = rows.slice(0, trainEnd).map((row) => row.timestamp);
  const validation = rows.slice(trainEnd, validationEnd).map((row) => row.timestamp);
  const oos = rows.slice(validationEnd).map((row) => row.timestamp);
  if (!train.length || !validation.length || !oos.length) throw new Error("SPOT_SCANNER_SPLIT_EMPTY");
  return Object.freeze({
    TRAIN: Object.freeze(train),
    VALIDATION: Object.freeze(validation),
    OOS: Object.freeze(oos),
  });
}
function primaryRowsOnly(rows) {
  return rows.map(({ timestamp, open, high, low, close, volume }) => ({
    timestamp, open, high, low, close, volume,
  }));
}
function prepare(input = {}) {
  const researchSha = exactSha(input.researchSha);
  const symbol = exactSymbol(input.symbol ?? "BTC");
  const observedAtMs = Number(input.observedAtMs);
  const nowMs = Number(input.nowMs ?? observedAtMs);
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs <= 0
      || !Number.isSafeInteger(nowMs) || nowMs < observedAtMs) {
    throw new Error("SPOT_SCANNER_OBSERVATION_TIME_INVALID");
  }

  const primaryWithQuote = normalizeClosedRows(input.primaryHistory, "4h", FOUR_HOURS, observedAtMs);
  const primaryRows = primaryRowsOnly(primaryWithQuote);
  const primaryStart = primaryRows[0].timestamp;
  const primaryEnd = primaryRows.at(-1).timestamp + FOUR_HOURS;

  const allContext = normalizeClosedRows(input.contextHistory, "60m", HOUR, observedAtMs, { requireContiguous: false });
  const contextRows = allContext.filter((row) => row.timestamp >= primaryStart && row.timestamp < primaryEnd);
  const expectedContextCount = (primaryEnd - primaryStart) / HOUR;
  if (contextRows.length < 300) throw new Error("SPOT_SCANNER_60M_CONTEXT_HISTORY_INSUFFICIENT");
  const contextSlots = new Set();
  for (const row of contextRows) {
    const offset = row.timestamp - primaryStart;
    if (offset < 0 || offset >= primaryEnd - primaryStart || offset % HOUR !== 0) {
      throw new Error("SPOT_SCANNER_60M_CONTEXT_INTERVAL_ALIGNMENT_INVALID");
    }
    const slot = offset / HOUR;
    if (contextSlots.has(slot)) throw new Error("SPOT_SCANNER_60M_CONTEXT_DUPLICATE_INTERVAL");
    contextSlots.add(slot);
  }
  const contextMissingIntervalCount = expectedContextCount - contextSlots.size;
  if (contextMissingIntervalCount < 0) throw new Error("SPOT_SCANNER_60M_CONTEXT_COVERAGE_INVALID");
  for (let index = 0; index < contextRows.length; index += 1) {
    if (contextRows[index].quoteVolume == null
        || !finite(contextRows[index].quoteVolume)
        || contextRows[index].quoteVolume < 0) {
      throw new Error("SPOT_SCANNER_60M_CONTEXT_QUOTE_VOLUME_MISSING");
    }
    // Upbit legitimately omits candle intervals with no trades. Preserve those gaps exactly;
    // never synthesize, forward-fill, or convert them into zero-volume candles.
  }

  const primaryDatasetDigest = hash(primaryRows);
  const manifest = buildResearchDatasetSnapshotManifestV1({
    researchSha,
    createdAt: new Date(observedAtMs).toISOString(),
    profileId: "CRYPTO_SPOT:SCANNER_SWING_4H",
    evidence: {
      primaryDatasetDigest,
      primaryDatasetCoverage: 1,
      missingIntervalCount: 0,
      duplicateRowCount: 0,
      closedCandlesOnly: true,
      publicDataOnly: true,
      syntheticDataAllowed: false,
      source: "upbit-public-candles",
      sourceType: "PUBLIC_MARKET_DATA",
    },
    scope: {
      timeframe: "4H",
      symbols: [symbol],
      startTime: primaryStart,
      endTime: primaryEnd,
      primaryDatasetDigest,
      universeDigest: null,
      publicDataOnly: true,
    },
  });

  const splits = splitAssignments(primaryRows);
  const metadata = {
    provider: "upbit-public",
    providerVersion: "v1",
    sourceType: "PUBLIC_MARKET_DATA",
    adjustmentMode: "not_applicable",
    corporateActionMode: "not_applicable",
    timezone: "UTC",
    sourceDigest: primaryDatasetDigest,
    loaderVersion: "upbit-spot-history-v2",
    missingIntervalCount: 0,
    duplicateRowCount: 0,
    dataQualityStatus: "VERIFIED",
    profileSourceDigest: primaryDatasetDigest,
  };
  const datasetId = `dataset:CRYPTO_SPOT:${symbol}:4H:${manifest.datasetSnapshotHash.slice(0, 16)}`;
  const built = buildCanonicalDatasetComponentV1({
    datasetSnapshotManifest: manifest,
    datasetId,
    symbol,
    rows: primaryRows,
    splitAssignments: splits,
    metadata,
    observedAtMs,
    nowMs,
  });
  const contextDigest = hash(contextRows);

  const result = deepFreeze({
    schemaVersion: 1,
    contract: SCANNER_SPOT_4H_DATASET_MATERIALIZER_V1,
    status: "DATASET_READY_REPLAY_BLOCKED",
    researchCodeSha: researchSha,
    market: "CRYPTO_SPOT",
    exchange: "UPBIT",
    symbol,
    timeframe: "4H",
    contextTimeframe: "60m",
    datasetSnapshotManifest: manifest,
    datasetRecord: built.record,
    dataset: {
      datasetId,
      rowCount: primaryRows.length,
      startTime: primaryStart,
      endTime: primaryEnd,
      datasetDigest: built.record.datasetDigest,
      datasetSnapshotHash: manifest.datasetSnapshotHash,
      splitCounts: {
        TRAIN: splits.TRAIN.length,
        VALIDATION: splits.VALIDATION.length,
        OOS: splits.OOS.length,
      },
      closedCandlesOnly: true,
      missingIntervalCount: 0,
      duplicateRowCount: 0,
    },
    contextEvidence: {
      source: "upbit-public-candles",
      timeframe: "60m",
      rowCount: contextRows.length,
      expectedRowCount: expectedContextCount,
      startTime: primaryStart,
      endTime: primaryEnd,
      actualFirstTimestamp: contextRows[0]?.timestamp ?? null,
      actualLastTimestamp: contextRows.at(-1)?.timestamp ?? null,
      datasetDigest: contextDigest,
      quoteVolumeCoverage: 1,
      missingIntervalCount: contextMissingIntervalCount,
      sparseIntervalsPreserved: contextMissingIntervalCount > 0,
      syntheticGapFillAllowed: false,
      duplicateRowCount: 0,
    },
    historicalReplay: {
      status: "BLOCKED_DATA",
      firstZero: SPOT_SCANNER_HISTORICAL_SPREAD_FIRST_ZERO,
      blockers: [SPOT_SCANNER_HISTORICAL_SPREAD_FIRST_ZERO],
      availableEvidence: ["4H_OHLCV", "60M_CONTEXT_OHLCV", "HISTORICAL_QUOTE_VOLUME"],
      unavailableEvidence: ["HISTORICAL_BID_ASK_SPREAD"],
      exactScannerReplayAllowed: false,
      crossStrategyTransferAllowed: false,
      oosWalkForwardMaterialized: false,
      nextAfterSpread: "EXACT_SCANNER_OOS_WF_PACKET_REQUIRED",
    },
    qualityArtifactWritten: false,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    automaticPromotionAuthority: false,
    safety: {
      executionAuthority: "NONE",
      financialMutationAllowed: false,
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
    },
  });

  return {
    result,
    manifest,
    componentInput: {
      datasetSnapshotManifest: manifest,
      datasetId,
      symbol,
      rows: primaryRows,
      splitAssignments: splits,
      metadata,
      observedAtMs,
      nowMs,
    },
    contextRows,
  };
}

export function buildScannerSpot4hDatasetMaterializationV1(input = {}) {
  return prepare(input).result;
}

export async function persistScannerSpot4hDatasetMaterializationV1({ stateRoot, ...input } = {}) {
  const prepared = prepare(input);
  const snapshot = await persistResearchDatasetSnapshotManifestV1({
    stateRoot,
    manifest: prepared.manifest,
  });
  const component = await persistCanonicalDatasetComponentV1({
    componentRoot: stateRoot,
    ...prepared.componentInput,
  });
  const root = resolve(String(stateRoot ?? ""));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const contextPath = join(root, "scanner-context-60m.json");
  const contextArtifact = {
    schemaVersion: 1,
    contract: "scanner-spot-60m-context-evidence-v1",
    researchCodeSha: prepared.result.researchCodeSha,
    market: "CRYPTO_SPOT",
    exchange: "UPBIT",
    symbol: prepared.result.symbol,
    timeframe: "60m",
    datasetDigest: prepared.result.contextEvidence.datasetDigest,
    rows: prepared.contextRows,
    safety: {
      executionAuthority: "NONE",
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
    },
  };
  await writeFile(
    contextPath,
    `${JSON.stringify(contextArtifact, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  return deepFreeze({
    ...prepared.result,
    persistence: { snapshot, component, contextPath },
  });
}
