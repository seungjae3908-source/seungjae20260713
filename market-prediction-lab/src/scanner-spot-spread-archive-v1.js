import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { buildMicrostructureSnapshotV1 } from "./market-digital-twin-microstructure-v1.js";
import { sha256Canonical as hash } from "./research-cache-provenance.js";

export const SCANNER_SPOT_SPREAD_ARCHIVE_V1 = "scanner-spot-spread-archive-v1";
export const SPOT_SPREAD_OWNER_RESOLVES = "SPOT_SCANNER_HISTORICAL_SPREAD_SERIES_MISSING";
export const SPOT_SPREAD_ARCHIVE_FIRST_ZERO = "SPOT_SCANNER_SPREAD_ARCHIVE_FORWARD_COVERAGE_INSUFFICIENT";

const SHA40 = /^[0-9a-f]{40}$/iu;
const SYMBOL = /^[A-Z0-9]{1,20}$/u;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const MAX_PROVIDER_AGE_MS = 2 * 60 * 1000;
const MAX_PROVIDER_FUTURE_SKEW_MS = 5 * 1000;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function exactResearchSha(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return SHA40.test(normalized) ? normalized : null;
}
function exactSymbol(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  return SYMBOL.test(normalized) ? normalized : null;
}
function blocked(blockers, details = {}) {
  return deepFreeze({
    schemaVersion: SCANNER_SPOT_SPREAD_ARCHIVE_V1,
    artifactType: "SPOT_SPREAD_OBSERVATION",
    status: "BLOCKED_DATA",
    blockers: [...new Set(blockers)].sort(),
    observation: null,
    details,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    automaticPromotionAuthority: false,
    safety: {
      executionAuthority: "NONE",
      financialMutationAllowed: false,
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
      historicalBackfillAllowed: false,
      syntheticSpreadAllowed: false,
      currentSpreadHistoricalBackfillAllowed: false,
    },
  });
}
function normalizeOrderbook(raw, symbol) {
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const providerMarket = String(row.market ?? "").trim().toUpperCase();
  if (providerMarket !== `KRW-${symbol}`) return null;
  const providerTimestamp = finite(row.timestamp);
  const units = Array.isArray(row.orderbook_units) ? row.orderbook_units : [];
  if (!Number.isSafeInteger(providerTimestamp) || providerTimestamp <= 0 || units.length === 0) return null;
  const normalizedUnits = units.map((unit) => ({
    bidPrice: finite(unit?.bid_price),
    bidSize: finite(unit?.bid_size),
    askPrice: finite(unit?.ask_price),
    askSize: finite(unit?.ask_size),
  }));
  if (normalizedUnits.some((unit) =>
    unit.bidPrice == null || unit.bidPrice <= 0
    || unit.askPrice == null || unit.askPrice <= 0
    || unit.bidSize == null || unit.bidSize <= 0
    || unit.askSize == null || unit.askSize <= 0)) {
    return null;
  }
  return {
    providerMarket,
    providerTimestamp,
    units: normalizedUnits,
  };
}
function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

export function buildScannerSpotSpreadObservationV1({
  researchCodeSha,
  symbol = "BTC",
  capturedAtMs,
  orderbook,
} = {}) {
  const blockers = [];
  const sha = exactResearchSha(researchCodeSha);
  const normalizedSymbol = exactSymbol(symbol);
  const capturedAt = finite(capturedAtMs);

  if (!sha) blockers.push("SPOT_SPREAD_EXACT_RESEARCH_SHA_REQUIRED");
  if (!normalizedSymbol) blockers.push("SPOT_SPREAD_SYMBOL_INVALID");
  if (!Number.isSafeInteger(capturedAt) || capturedAt <= 0) blockers.push("SPOT_SPREAD_CAPTURE_TIME_INVALID");
  if (blockers.length) return blocked(blockers);

  const normalized = normalizeOrderbook(orderbook, normalizedSymbol);
  if (!normalized) return blocked(["SPOT_SPREAD_ORDERBOOK_INVALID"]);

  const ageMs = capturedAt - normalized.providerTimestamp;
  if (normalized.providerTimestamp > capturedAt + MAX_PROVIDER_FUTURE_SKEW_MS) {
    return blocked(["SPOT_SPREAD_PROVIDER_TIMESTAMP_FROM_FUTURE"], { ageMs });
  }
  if (ageMs > MAX_PROVIDER_AGE_MS) {
    return blocked(["SPOT_SPREAD_PROVIDER_TIMESTAMP_STALE"], { ageMs });
  }

  const sourceCore = {
    exchange: "UPBIT",
    providerMarket: normalized.providerMarket,
    providerTimestamp: normalized.providerTimestamp,
    units: normalized.units,
  };
  const sourceDigest = hash(sourceCore);
  const microstructure = buildMicrostructureSnapshotV1({
    market: "CRYPTO_SPOT",
    symbol: normalizedSymbol,
    observedAt: new Date(normalized.providerTimestamp).toISOString(),
    sourceDigest,
    bids: normalized.units.map((unit) => [unit.bidPrice, unit.bidSize]),
    asks: normalized.units.map((unit) => [unit.askPrice, unit.askSize]),
    trades: [],
    depthLevels: Math.min(5, normalized.units.length),
    executionAuthority: "NONE",
  });
  if (microstructure.status !== "MICROSTRUCTURE_SNAPSHOT_READY") {
    return blocked(
      ["SPOT_SPREAD_MICROSTRUCTURE_SNAPSHOT_BLOCKED", ...(microstructure.blockers ?? [])],
    );
  }

  const observationCore = {
    contract: SCANNER_SPOT_SPREAD_ARCHIVE_V1,
    producerCodeSha: sha,
    researchCodeSha: sha,
    market: "CRYPTO_SPOT",
    exchange: "UPBIT",
    providerMarket: normalized.providerMarket,
    symbol: normalizedSymbol,
    observedAt: microstructure.observedAt,
    providerTimestamp: normalized.providerTimestamp,
    capturedAtMs: capturedAt,
    sourceDigest,
    bestBid: microstructure.features.bestBid,
    bestAsk: microstructure.features.bestAsk,
    spreadBps: microstructure.features.spreadBps,
    bidDepthNotional: microstructure.features.bidDepthNotional,
    askDepthNotional: microstructure.features.askDepthNotional,
    depthLevels: microstructure.features.depthLevels,
    microstructureSnapshotDigest: microstructure.snapshotDigest,
  };
  const observation = deepFreeze({
    schemaVersion: 1,
    artifactType: "SPOT_SPREAD_OBSERVATION",
    status: "SPOT_SPREAD_OBSERVATION_READY",
    ...observationCore,
    observationDigest: hash(observationCore),
    rawPrivateDataUsed: false,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    automaticPromotionAuthority: false,
    safety: {
      executionAuthority: "NONE",
      financialMutationAllowed: false,
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
      publicDataOnly: true,
      immutable: true,
      historicalBackfillAllowed: false,
      syntheticSpreadAllowed: false,
      currentSpreadHistoricalBackfillAllowed: false,
    },
  });

  return deepFreeze({
    schemaVersion: SCANNER_SPOT_SPREAD_ARCHIVE_V1,
    artifactType: "SPOT_SPREAD_OBSERVATION_RESULT",
    status: "READY",
    blockers: [],
    observation,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    automaticPromotionAuthority: false,
    safety: observation.safety,
  });
}

async function safeRoot(value) {
  const raw = String(value ?? "").trim();
  if (!raw || !isAbsolute(raw)) throw new Error("SPOT_SPREAD_STATE_ROOT_MUST_BE_ABSOLUTE");
  const root = resolve(raw);
  let probe = root;
  while (true) {
    try {
      const info = await lstat(probe);
      if (info.isSymbolicLink() || resolve(await realpath(probe)) !== probe) {
        throw new Error("SPOT_SPREAD_STATE_ROOT_SYMLINK_FORBIDDEN");
      }
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return root;
}

export async function persistScannerSpotSpreadObservationV1({ stateRoot, ...input } = {}) {
  const built = buildScannerSpotSpreadObservationV1(input);
  if (built.status !== "READY") return built;
  const root = await safeRoot(stateRoot);
  const directory = join(root, "spread-observations", built.observation.symbol);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = `${built.observation.providerTimestamp}-${built.observation.observationDigest}.json`;
  const path = join(directory, filename);
  const bytes = `${JSON.stringify(built.observation, null, 2)}\n`;
  try {
    await writeFile(path, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return deepFreeze({ ...built, persistence: { status: "created", path } });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = JSON.parse(await readFile(path, "utf8"));
    if (hash(existing) !== hash(built.observation)) {
      throw new Error("SPOT_SPREAD_OBSERVATION_CONTENT_CONFLICT");
    }
    return deepFreeze({ ...built, persistence: { status: "already_present", path } });
  }
}

export function summarizeScannerSpotSpreadArchiveV1({
  observations = [],
  researchCodeSha,
  symbol = "BTC",
  requiredStartTime,
  requiredEndTime,
} = {}) {
  const sha = exactResearchSha(researchCodeSha);
  const normalizedSymbol = exactSymbol(symbol);
  if (!sha || !normalizedSymbol) {
    return deepFreeze({
      schemaVersion: SCANNER_SPOT_SPREAD_ARCHIVE_V1,
      artifactType: "SPOT_SPREAD_ARCHIVE_READINESS",
      status: "BLOCKED_DATA",
      blockers: [
        ...(!sha ? ["SPOT_SPREAD_EXACT_RESEARCH_SHA_REQUIRED"] : []),
        ...(!normalizedSymbol ? ["SPOT_SPREAD_SYMBOL_INVALID"] : []),
      ],
      ownerReady: false,
      historicalReplayReady: false,
      resolvesFirstZero: null,
      nextFirstZero: SPOT_SPREAD_OWNER_RESOLVES,
      economicSampleCredit: 0,
      safety: { executionAuthority: "NONE" },
    });
  }

  const valid = observations.filter((row) => {
    const producerSha = exactResearchSha(row?.producerCodeSha ?? row?.researchCodeSha);
    return row?.schemaVersion === 1
    && row?.artifactType === "SPOT_SPREAD_OBSERVATION"
    && row?.status === "SPOT_SPREAD_OBSERVATION_READY"
    && producerSha != null
    && row?.symbol === normalizedSymbol
    && row?.market === "CRYPTO_SPOT"
    && row?.exchange === "UPBIT"
    && row?.safety?.executionAuthority === "NONE"
    && row?.safety?.publicDataOnly === true
    && row?.safety?.historicalBackfillAllowed === false
    && typeof row?.observationDigest === "string"
    && /^[0-9a-f]{64}$/u.test(row.observationDigest)
    && Number.isSafeInteger(row.providerTimestamp)
    && Number.isFinite(row.spreadBps)
    && row.spreadBps >= 0;
  });

  const dedup = new Map();
  for (const row of valid) dedup.set(row.observationDigest, row);
  const ordered = [...dedup.values()].sort(
    (left, right) => left.providerTimestamp - right.providerTimestamp
      || left.observationDigest.localeCompare(right.observationDigest),
  );

  const start = finite(requiredStartTime);
  const end = finite(requiredEndTime);
  const rangeValid = Number.isSafeInteger(start) && Number.isSafeInteger(end) && end > start;
  const expectedBucketCount = rangeValid ? Math.ceil((end - start) / FOUR_HOURS_MS) : null;
  const covered = new Set();
  if (rangeValid) {
    for (const row of ordered) {
      if (row.providerTimestamp < start || row.providerTimestamp >= end) continue;
      covered.add(Math.floor((row.providerTimestamp - start) / FOUR_HOURS_MS));
    }
  }
  const missingBucketCount = expectedBucketCount == null ? null : Math.max(0, expectedBucketCount - covered.size);
  const historicalReplayReady = expectedBucketCount != null && expectedBucketCount > 0 && missingBucketCount === 0;
  const spreads = ordered.map((row) => row.spreadBps);
  const producerCodeShas = [...new Set(ordered
    .map((row) => exactResearchSha(row?.producerCodeSha ?? row?.researchCodeSha))
    .filter(Boolean))].sort();
  const status = historicalReplayReady
    ? "READY"
    : ordered.length > 0
      ? "FORWARD_ACCUMULATING"
      : "BLOCKED_DATA";

  const core = {
    contract: SCANNER_SPOT_SPREAD_ARCHIVE_V1,
    consumerResearchCodeSha: sha,
    market: "CRYPTO_SPOT",
    exchange: "UPBIT",
    symbol: normalizedSymbol,
    observationCount: ordered.length,
    producerCodeShaCount: producerCodeShas.length,
    producerCodeShas,
    firstObservedAt: ordered[0]?.observedAt ?? null,
    lastObservedAt: ordered.at(-1)?.observedAt ?? null,
    requiredStartTime: rangeValid ? start : null,
    requiredEndTime: rangeValid ? end : null,
    expected4hBucketCount: expectedBucketCount,
    covered4hBucketCount: rangeValid ? covered.size : null,
    missing4hBucketCount: missingBucketCount,
    spreadStats: {
      minimumBps: spreads.length ? Math.min(...spreads) : null,
      medianBps: median(spreads),
      maximumBps: spreads.length ? Math.max(...spreads) : null,
    },
  };

  return deepFreeze({
    schemaVersion: SCANNER_SPOT_SPREAD_ARCHIVE_V1,
    artifactType: "SPOT_SPREAD_ARCHIVE_READINESS",
    status,
    blockers: historicalReplayReady
      ? []
      : [ordered.length > 0 ? SPOT_SPREAD_ARCHIVE_FIRST_ZERO : SPOT_SPREAD_OWNER_RESOLVES],
    researchCodeSha: sha,
    ...core,
    archiveDigest: hash(core),
    ownerReady: ordered.length > 0,
    historicalReplayReady,
    resolvesFirstZero: ordered.length > 0 ? SPOT_SPREAD_OWNER_RESOLVES : null,
    nextFirstZero: historicalReplayReady
      ? "SPOT_SCANNER_EXACT_OOS_WF_PACKET_NOT_MATERIALIZED"
      : ordered.length > 0
        ? SPOT_SPREAD_ARCHIVE_FIRST_ZERO
        : SPOT_SPREAD_OWNER_RESOLVES,
    economicSampleCredit: 0,
    profitabilityClaimAllowed: false,
    automaticPromotionAuthority: false,
    safety: {
      executionAuthority: "NONE",
      financialMutationAllowed: false,
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
      publicDataOnly: true,
      historicalBackfillAllowed: false,
      syntheticSpreadAllowed: false,
      currentSpreadHistoricalBackfillAllowed: false,
      scheduleActivated: false,
      crossProducerShaAccumulationAllowed: true,
      producerShaProvenanceRequired: true,
    },
  });
}
