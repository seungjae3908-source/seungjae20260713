import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CRYPTO_FUTURES_POSITION_TIER_HISTORY_CONTRACT,
  buildCryptoFuturesProspectiveTierSnapshotV1,
} from "./crypto-futures-position-tier-history-provenance-v1.js";

export const CRYPTO_FUTURES_POSITION_TIER_CAPTURE_CONTRACT = "bitget-public-position-tier-capture/v1";
export const CRYPTO_FUTURES_POSITION_TIER_CAPTURE_VERSION = "1.0.0";
export const BITGET_PUBLIC_API_ORIGIN = "https://api.bitget.com";
export const BITGET_USDT_FUTURES_CONTRACTS_PATH = "/api/v2/mix/market/contracts";
export const BITGET_POSITION_TIER_PATH = "/api/v3/market/position-tier";
export const BITGET_USDT_FUTURES_PRODUCT_TYPE = "USDT-FUTURES";

const SYMBOL = /^[A-Z0-9_-]+$/u;
const DEFAULT_MAX_SYMBOLS = 1000;
const DEFAULT_REQUEST_DELAY_MS = 100;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_TIMEOUT_MS = 10_000;

function fail(code, detail = "") {
  throw new Error(detail ? `${code}:${detail}` : code);
}

function plain(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function text(value, code) {
  if (typeof value !== "string" || !value.trim()) fail(code);
  return value.trim();
}

function safeInteger(value, code, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const normalized = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) fail(code, String(value));
  return normalized;
}

function normalizeSymbol(value) {
  const symbol = text(value, "POSITION_TIER_CAPTURE_SYMBOL_INVALID").toUpperCase();
  if (!SYMBOL.test(symbol)) fail("POSITION_TIER_CAPTURE_SYMBOL_INVALID", symbol);
  return symbol;
}

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("POSITION_TIER_CAPTURE_CANONICAL_NON_FINITE");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  plain(value, "POSITION_TIER_CAPTURE_CANONICAL_NON_OBJECT");
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) fail("POSITION_TIER_CAPTURE_CANONICAL_UNDEFINED", key);
    normalized[key] = canonical(value[key]);
  }
  return normalized;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFailure(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/[\r\n\t]+/gu, " ").slice(0, 240) || "POSITION_TIER_CAPTURE_UNKNOWN_FAILURE";
}

async function fetchJson(url, { fetchFn, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response || response.ok !== true) {
      fail("POSITION_TIER_CAPTURE_HTTP_FAILURE", String(response?.status ?? "unknown"));
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function assertBitgetEnvelope(payload, codePrefix) {
  const value = plain(payload, `${codePrefix}_PAYLOAD_INVALID`);
  if (String(value.code) !== "00000") fail(`${codePrefix}_PROVIDER_ERROR`, String(value.code ?? "missing"));
  if (!Array.isArray(value.data)) fail(`${codePrefix}_DATA_INVALID`);
  return value;
}

export async function discoverBitgetUsdtFuturesSymbolsV1({
  fetchFn = globalThis.fetch,
  maxSymbols = DEFAULT_MAX_SYMBOLS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchFn !== "function") fail("POSITION_TIER_CAPTURE_FETCH_INVALID");
  const boundedMaxSymbols = safeInteger(maxSymbols, "POSITION_TIER_CAPTURE_MAX_SYMBOLS_INVALID", { min: 1, max: 5000 });
  const boundedTimeoutMs = safeInteger(timeoutMs, "POSITION_TIER_CAPTURE_TIMEOUT_INVALID", { min: 100, max: 60_000 });
  const url = `${BITGET_PUBLIC_API_ORIGIN}${BITGET_USDT_FUTURES_CONTRACTS_PATH}?productType=USDT-FUTURES`;
  const envelope = assertBitgetEnvelope(
    await fetchJson(url, { fetchFn, timeoutMs: boundedTimeoutMs }),
    "POSITION_TIER_CAPTURE_UNIVERSE",
  );

  const symbols = [];
  const seen = new Set();
  for (const raw of envelope.data) {
    const row = plain(raw, "POSITION_TIER_CAPTURE_CONTRACT_ROW_INVALID");
    if (String(row.symbolStatus).toLowerCase() !== "normal") continue;
    if (String(row.symbolType).toLowerCase() !== "perpetual") continue;
    if (String(row.quoteCoin).toUpperCase() !== "USDT") continue;
    const symbol = normalizeSymbol(row.symbol);
    if (seen.has(symbol)) fail("POSITION_TIER_CAPTURE_DUPLICATE_SYMBOL", symbol);
    seen.add(symbol);
    symbols.push(symbol);
  }
  symbols.sort();
  if (symbols.length === 0) fail("POSITION_TIER_CAPTURE_UNIVERSE_EMPTY");
  if (symbols.length > boundedMaxSymbols) {
    fail("POSITION_TIER_CAPTURE_UNIVERSE_CAP_EXCEEDED", `${symbols.length}>${boundedMaxSymbols}`);
  }
  return deepFreeze(symbols);
}

export async function captureBitgetPositionTierSnapshotForSymbolV1({
  symbol,
  fetchFn = globalThis.fetch,
  nowFn = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchFn !== "function") fail("POSITION_TIER_CAPTURE_FETCH_INVALID");
  if (typeof nowFn !== "function") fail("POSITION_TIER_CAPTURE_CLOCK_INVALID");
  const normalizedSymbol = normalizeSymbol(symbol);
  const boundedTimeoutMs = safeInteger(timeoutMs, "POSITION_TIER_CAPTURE_TIMEOUT_INVALID", { min: 100, max: 60_000 });
  const url = `${BITGET_PUBLIC_API_ORIGIN}${BITGET_POSITION_TIER_PATH}?category=USDT-FUTURES&symbol=${encodeURIComponent(normalizedSymbol)}`;
  const envelope = assertBitgetEnvelope(
    await fetchJson(url, { fetchFn, timeoutMs: boundedTimeoutMs }),
    "POSITION_TIER_CAPTURE_TIER",
  );
  const providerRequestTime = safeInteger(
    envelope.requestTime,
    "POSITION_TIER_CAPTURE_PROVIDER_REQUEST_TIME_INVALID",
    { min: 1 },
  );
  const capturedAt = safeInteger(nowFn(), "POSITION_TIER_CAPTURE_CAPTURED_AT_INVALID", { min: 1 });
  return buildCryptoFuturesProspectiveTierSnapshotV1({
    symbol: normalizedSymbol,
    rows: envelope.data,
    providerRequestTime,
    capturedAt,
  });
}

export function buildCryptoFuturesPositionTierCaptureManifestV1({
  startedAt,
  completedAt,
  universeSymbols,
  snapshots,
  failures,
} = {}) {
  const normalizedStartedAt = safeInteger(startedAt, "POSITION_TIER_CAPTURE_STARTED_AT_INVALID", { min: 1 });
  const normalizedCompletedAt = safeInteger(completedAt, "POSITION_TIER_CAPTURE_COMPLETED_AT_INVALID", { min: normalizedStartedAt });
  if (!Array.isArray(universeSymbols) || universeSymbols.length === 0) fail("POSITION_TIER_CAPTURE_MANIFEST_UNIVERSE_INVALID");
  if (!Array.isArray(snapshots) || !Array.isArray(failures)) fail("POSITION_TIER_CAPTURE_MANIFEST_RESULTS_INVALID");
  const normalizedUniverse = universeSymbols.map(normalizeSymbol);
  const uniqueUniverse = new Set(normalizedUniverse);
  if (uniqueUniverse.size !== normalizedUniverse.length) fail("POSITION_TIER_CAPTURE_MANIFEST_DUPLICATE_UNIVERSE_SYMBOL");
  const sortedUniverse = [...normalizedUniverse].sort();

  const snapshotSymbols = new Set();
  const normalizedSnapshots = snapshots.map((snapshot) => {
    const value = plain(snapshot, "POSITION_TIER_CAPTURE_MANIFEST_SNAPSHOT_INVALID");
    if (value.contract !== CRYPTO_FUTURES_POSITION_TIER_HISTORY_CONTRACT) fail("POSITION_TIER_CAPTURE_MANIFEST_SNAPSHOT_CONTRACT_INVALID");
    if (value.evidenceType !== "BITGET_PUBLIC_POSITION_TIER_SNAPSHOT") fail("POSITION_TIER_CAPTURE_MANIFEST_SNAPSHOT_TYPE_INVALID");
    if (value.publicDataOnly !== true || value.executionAuthority !== "NONE") fail("POSITION_TIER_CAPTURE_MANIFEST_SNAPSHOT_UNSAFE");
    const symbol = normalizeSymbol(value.symbol);
    if (!uniqueUniverse.has(symbol)) fail("POSITION_TIER_CAPTURE_MANIFEST_SNAPSHOT_OUTSIDE_UNIVERSE", symbol);
    if (snapshotSymbols.has(symbol)) fail("POSITION_TIER_CAPTURE_MANIFEST_DUPLICATE_SNAPSHOT", symbol);
    snapshotSymbols.add(symbol);
    return value;
  }).sort((left, right) => left.symbol.localeCompare(right.symbol));

  const failureSymbols = new Set();
  const normalizedFailures = failures.map((failure) => {
    const value = plain(failure, "POSITION_TIER_CAPTURE_MANIFEST_FAILURE_INVALID");
    const symbol = normalizeSymbol(value.symbol);
    if (!uniqueUniverse.has(symbol)) fail("POSITION_TIER_CAPTURE_MANIFEST_FAILURE_OUTSIDE_UNIVERSE", symbol);
    if (snapshotSymbols.has(symbol) || failureSymbols.has(symbol)) fail("POSITION_TIER_CAPTURE_MANIFEST_DUPLICATE_RESULT", symbol);
    failureSymbols.add(symbol);
    return deepFreeze({ symbol, error: text(value.error, "POSITION_TIER_CAPTURE_MANIFEST_FAILURE_ERROR_INVALID") });
  }).sort((left, right) => left.symbol.localeCompare(right.symbol));

  if (snapshotSymbols.size + failureSymbols.size !== uniqueUniverse.size) {
    fail("POSITION_TIER_CAPTURE_MANIFEST_MISSING_RESULT");
  }

  const completeUniverseCapture = normalizedFailures.length === 0 && normalizedSnapshots.length === sortedUniverse.length;
  const core = {
    contract: CRYPTO_FUTURES_POSITION_TIER_CAPTURE_CONTRACT,
    version: CRYPTO_FUTURES_POSITION_TIER_CAPTURE_VERSION,
    category: BITGET_USDT_FUTURES_PRODUCT_TYPE,
    startedAt: normalizedStartedAt,
    completedAt: normalizedCompletedAt,
    universeSource: {
      providerId: "bitget-public",
      origin: BITGET_PUBLIC_API_ORIGIN,
      path: BITGET_USDT_FUTURES_CONTRACTS_PATH,
      productType: BITGET_USDT_FUTURES_PRODUCT_TYPE,
    },
    tierSource: {
      providerId: "bitget-public",
      origin: BITGET_PUBLIC_API_ORIGIN,
      path: BITGET_POSITION_TIER_PATH,
      category: BITGET_USDT_FUTURES_PRODUCT_TYPE,
    },
    universeSymbols: sortedUniverse,
    snapshots: normalizedSnapshots,
    failures: normalizedFailures,
    requestedSymbolCount: sortedUniverse.length,
    capturedSymbolCount: normalizedSnapshots.length,
    failedSymbolCount: normalizedFailures.length,
    completeUniverseCapture,
    historicalCoverageMode: "EXACT_EVIDENCE_TIMESTAMPS_ONLY",
    continuousHistoricalCoverage: false,
    formulaTournamentUnblocked: false,
    profitabilityClaimAllowed: false,
    finalHoldoutAccessAllowed: false,
    publicDataOnly: true,
    privateAccountDataUsed: false,
    executionAuthority: "NONE",
  };
  return deepFreeze({ ...core, manifestDigest: digest(core) });
}

export async function captureBitgetUsdtFuturesPositionTierUniverseV1({
  fetchFn = globalThis.fetch,
  nowFn = Date.now,
  maxSymbols = DEFAULT_MAX_SYMBOLS,
  requestDelayMs = DEFAULT_REQUEST_DELAY_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const boundedDelay = safeInteger(requestDelayMs, "POSITION_TIER_CAPTURE_DELAY_INVALID", { min: 0, max: 5000 });
  const boundedAttempts = safeInteger(maxAttempts, "POSITION_TIER_CAPTURE_ATTEMPTS_INVALID", { min: 1, max: 3 });
  const startedAt = safeInteger(nowFn(), "POSITION_TIER_CAPTURE_STARTED_AT_INVALID", { min: 1 });
  const universeSymbols = await discoverBitgetUsdtFuturesSymbolsV1({ fetchFn, maxSymbols, timeoutMs });
  const snapshots = [];
  const failures = [];

  for (let index = 0; index < universeSymbols.length; index += 1) {
    const symbol = universeSymbols[index];
    let snapshot = null;
    let lastError = null;
    for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
      try {
        snapshot = await captureBitgetPositionTierSnapshotForSymbolV1({ symbol, fetchFn, nowFn, timeoutMs });
        break;
      } catch (error) {
        lastError = error;
        if (attempt < boundedAttempts) await sleep(boundedDelay);
      }
    }
    if (snapshot) snapshots.push(snapshot);
    else failures.push({ symbol, error: sanitizeFailure(lastError) });
    if (index < universeSymbols.length - 1) await sleep(boundedDelay);
  }

  const completedAt = safeInteger(nowFn(), "POSITION_TIER_CAPTURE_COMPLETED_AT_INVALID", { min: startedAt });
  return buildCryptoFuturesPositionTierCaptureManifestV1({
    startedAt,
    completedAt,
    universeSymbols,
    snapshots,
    failures,
  });
}

async function runCli() {
  const outputPath = process.env.POSITION_TIER_CAPTURE_OUTPUT || "position-tier-capture-v1.json";
  const manifest = await captureBitgetUsdtFuturesPositionTierUniverseV1({
    maxSymbols: process.env.POSITION_TIER_CAPTURE_MAX_SYMBOLS || DEFAULT_MAX_SYMBOLS,
    requestDelayMs: process.env.POSITION_TIER_CAPTURE_DELAY_MS || DEFAULT_REQUEST_DELAY_MS,
    maxAttempts: process.env.POSITION_TIER_CAPTURE_MAX_ATTEMPTS || DEFAULT_MAX_ATTEMPTS,
    timeoutMs: process.env.POSITION_TIER_CAPTURE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    outputPath,
    requestedSymbolCount: manifest.requestedSymbolCount,
    capturedSymbolCount: manifest.capturedSymbolCount,
    failedSymbolCount: manifest.failedSymbolCount,
    completeUniverseCapture: manifest.completeUniverseCapture,
    manifestDigest: manifest.manifestDigest,
    executionAuthority: manifest.executionAuthority,
  })}\n`);
  if (!manifest.completeUniverseCapture) process.exitCode = 2;
}

const executedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (executedDirectly) {
  runCli().catch((error) => {
    process.stderr.write(`${sanitizeFailure(error)}\n`);
    process.exitCode = 1;
  });
}
