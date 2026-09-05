import { createHash } from "node:crypto";

export const CRYPTO_FUTURES_POSITION_TIER_HISTORY_CONTRACT = "canonical-futures-position-tier-history/v1";
export const CRYPTO_FUTURES_POSITION_TIER_HISTORY_VERSION = "1.0.0";
export const CRYPTO_FUTURES_POSITION_TIER_EXHAUSTIVE_HISTORY_SOURCES = Object.freeze([]);
export const CRYPTO_FUTURES_POSITION_TIER_CURRENT_SOURCE = Object.freeze({
  providerId: "bitget-public",
  host: "api.bitget.com",
  path: "/api/v3/market/position-tier",
  category: "USDT-FUTURES",
  publicOnly: true,
});

const SYMBOL = /^[A-Z0-9_-]+$/u;
const SUPPORT_ARTICLE_PATH = /\/support\/articles\/([0-9]+)\/?$/u;
const MAX_PUBLIC_SNAPSHOT_CAPTURE_LAG_MS = 5 * 60_000;

function fail(code, detail = "") {
  throw new Error(detail ? `${code}:${detail}` : code);
}

function plain(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  return value;
}

function text(value, code) {
  if (typeof value !== "string" || !value.trim()) fail(code);
  return value.trim();
}

function normalizeSymbol(value, code) {
  const symbol = text(value, code).toUpperCase();
  if (!SYMBOL.test(symbol)) fail(code, symbol);
  return symbol;
}

function timestamp(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}

function numberish(value, code) {
  if (typeof value === "string" && !value.trim()) fail(code);
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(result) || Object.is(result, -0)) fail(code);
  return result;
}

function positive(value, code) {
  const result = numberish(value, code);
  if (!(result > 0)) fail(code);
  return result;
}

function nonNegative(value, code) {
  const result = numberish(value, code);
  if (result < 0) fail(code);
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function canonical(value, stack = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("POSITION_TIER_HISTORY_CANONICAL_NON_FINITE");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") fail("POSITION_TIER_HISTORY_CANONICAL_UNSUPPORTED");
  if (stack.has(value)) fail("POSITION_TIER_HISTORY_CANONICAL_CYCLE");
  stack.add(value);
  let normalized;
  if (Array.isArray(value)) normalized = value.map((entry) => canonical(entry, stack));
  else {
    plain(value, "POSITION_TIER_HISTORY_CANONICAL_NON_PLAIN_OBJECT");
    normalized = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) fail("POSITION_TIER_HISTORY_CANONICAL_UNDEFINED");
      normalized[key] = canonical(value[key], stack);
    }
  }
  stack.delete(value);
  return normalized;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function exactKeys(value, expected, code) {
  const keys = Object.keys(plain(value, code)).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) fail(code);
}

function normalizeTierRows(rows, codePrefix = "POSITION_TIER_HISTORY") {
  if (!Array.isArray(rows) || rows.length === 0) fail(`${codePrefix}_ROWS_EMPTY`);
  let previousMax = null;
  let previousMmr = null;
  let previousLeverage = null;
  const normalized = rows.map((raw, index) => {
    exactKeys(raw, ["tier", "minTierValue", "maxTierValue", "leverage", "mmr"], `${codePrefix}_ROW_SHAPE_INVALID`);
    const tier = numberish(raw.tier, `${codePrefix}_TIER_INVALID`);
    const minTierValue = nonNegative(raw.minTierValue, `${codePrefix}_MIN_INVALID`);
    const maxTierValue = positive(raw.maxTierValue, `${codePrefix}_MAX_INVALID`);
    const leverage = positive(raw.leverage, `${codePrefix}_LEVERAGE_INVALID`);
    const mmr = nonNegative(raw.mmr, `${codePrefix}_MMR_INVALID`);
    if (!Number.isSafeInteger(tier) || tier !== index + 1) fail(`${codePrefix}_TIER_SEQUENCE_INVALID`, String(raw.tier));
    if (maxTierValue <= minTierValue) fail(`${codePrefix}_RANGE_INVALID`, String(tier));
    if (mmr >= 1) fail(`${codePrefix}_MMR_INVALID`, String(tier));
    if (index === 0 && minTierValue !== 0) fail(`${codePrefix}_FIRST_FLOOR_INVALID`);
    if (index > 0) {
      if (minTierValue !== previousMax) fail(`${codePrefix}_RANGE_NOT_CONTIGUOUS`, String(tier));
      if (mmr < previousMmr) fail(`${codePrefix}_MMR_NOT_MONOTONIC`, String(tier));
      if (leverage > previousLeverage) fail(`${codePrefix}_LEVERAGE_NOT_MONOTONIC`, String(tier));
    }
    previousMax = maxTierValue;
    previousMmr = mmr;
    previousLeverage = leverage;
    return deepFreeze({ tier, minTierValue, maxTierValue, leverage, mmr });
  });
  return deepFreeze(normalized);
}

function scheduleDigest(symbol, rows) {
  return digest({ symbol, rows });
}

function normalizeOfficialArticleUrl(value) {
  const raw = text(value, "POSITION_TIER_HISTORY_NOTICE_URL_INVALID");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail("POSITION_TIER_HISTORY_NOTICE_URL_INVALID");
  }
  if (parsed.protocol !== "https:") fail("POSITION_TIER_HISTORY_NOTICE_URL_NOT_HTTPS");
  const host = parsed.hostname.toLowerCase();
  if (host !== "www.bitget.com" && host !== "bitget.com") fail("POSITION_TIER_HISTORY_NOTICE_HOST_INVALID", host);
  if (parsed.search || parsed.hash) fail("POSITION_TIER_HISTORY_NOTICE_URL_DECORATED");
  const match = parsed.pathname.match(SUPPORT_ARTICLE_PATH);
  if (!match) fail("POSITION_TIER_HISTORY_NOTICE_PATH_INVALID", parsed.pathname);
  const articleId = match[1];
  return {
    articleId,
    sourceUrl: `https://www.bitget.com/support/articles/${articleId}`,
  };
}

export function normalizeCryptoFuturesTierAdjustmentNoticeV1({
  symbol,
  sourceUrl,
  publishedAt,
  effectiveAt,
  beforeRows,
  afterRows,
} = {}) {
  const normalizedSymbol = normalizeSymbol(symbol, "POSITION_TIER_HISTORY_NOTICE_SYMBOL_INVALID");
  const source = normalizeOfficialArticleUrl(sourceUrl);
  const normalizedPublishedAt = timestamp(publishedAt, "POSITION_TIER_HISTORY_NOTICE_PUBLISHED_AT_INVALID");
  const normalizedEffectiveAt = timestamp(effectiveAt, "POSITION_TIER_HISTORY_NOTICE_EFFECTIVE_AT_INVALID");
  if (normalizedPublishedAt > normalizedEffectiveAt) fail("POSITION_TIER_HISTORY_NOTICE_PUBLISHED_AFTER_EFFECTIVE");
  const normalizedBeforeRows = normalizeTierRows(beforeRows, "POSITION_TIER_HISTORY_NOTICE_BEFORE");
  const normalizedAfterRows = normalizeTierRows(afterRows, "POSITION_TIER_HISTORY_NOTICE_AFTER");
  const beforeScheduleDigest = scheduleDigest(normalizedSymbol, normalizedBeforeRows);
  const afterScheduleDigest = scheduleDigest(normalizedSymbol, normalizedAfterRows);
  if (beforeScheduleDigest === afterScheduleDigest) fail("POSITION_TIER_HISTORY_NOTICE_NO_CHANGE");
  const core = {
    contract: CRYPTO_FUTURES_POSITION_TIER_HISTORY_CONTRACT,
    schemaVersion: 1,
    evidenceType: "BITGET_OFFICIAL_ADJUSTMENT_NOTICE",
    symbol: normalizedSymbol,
    articleId: source.articleId,
    sourceUrl: source.sourceUrl,
    publishedAt: normalizedPublishedAt,
    effectiveAt: normalizedEffectiveAt,
    beforeRows: normalizedBeforeRows,
    afterRows: normalizedAfterRows,
    beforeScheduleDigest,
    afterScheduleDigest,
    publicDataOnly: true,
    executionAuthority: "NONE",
  };
  return deepFreeze({ ...core, evidenceDigest: digest(core) });
}

export function buildCryptoFuturesProspectiveTierSnapshotV1({
  symbol,
  rows,
  providerRequestTime,
  capturedAt,
} = {}) {
  const normalizedSymbol = normalizeSymbol(symbol, "POSITION_TIER_HISTORY_SNAPSHOT_SYMBOL_INVALID");
  const normalizedProviderRequestTime = timestamp(providerRequestTime, "POSITION_TIER_HISTORY_SNAPSHOT_REQUEST_TIME_INVALID");
  const normalizedCapturedAt = timestamp(capturedAt, "POSITION_TIER_HISTORY_SNAPSHOT_CAPTURED_AT_INVALID");
  if (normalizedProviderRequestTime > normalizedCapturedAt) fail("POSITION_TIER_HISTORY_SNAPSHOT_FUTURE_PROVIDER_TIME");
  if (normalizedCapturedAt - normalizedProviderRequestTime > MAX_PUBLIC_SNAPSHOT_CAPTURE_LAG_MS) {
    fail("POSITION_TIER_HISTORY_SNAPSHOT_CAPTURE_LAG_EXCEEDED");
  }
  const normalizedRows = normalizeTierRows(rows, "POSITION_TIER_HISTORY_SNAPSHOT");
  const normalizedScheduleDigest = scheduleDigest(normalizedSymbol, normalizedRows);
  const core = {
    contract: CRYPTO_FUTURES_POSITION_TIER_HISTORY_CONTRACT,
    schemaVersion: 1,
    evidenceType: "BITGET_PUBLIC_POSITION_TIER_SNAPSHOT",
    provider: CRYPTO_FUTURES_POSITION_TIER_CURRENT_SOURCE,
    symbol: normalizedSymbol,
    observedAt: normalizedProviderRequestTime,
    capturedAt: normalizedCapturedAt,
    rows: normalizedRows,
    scheduleDigest: normalizedScheduleDigest,
    publicDataOnly: true,
    executionAuthority: "NONE",
  };
  return deepFreeze({ ...core, evidenceDigest: digest(core) });
}

function assertNotice(value, expectedSymbol) {
  exactKeys(value, [
    "contract", "schemaVersion", "evidenceType", "symbol", "articleId", "sourceUrl",
    "publishedAt", "effectiveAt", "beforeRows", "afterRows", "beforeScheduleDigest",
    "afterScheduleDigest", "publicDataOnly", "executionAuthority", "evidenceDigest",
  ], "POSITION_TIER_HISTORY_NOTICE_EVIDENCE_SHAPE_INVALID");
  if (value.contract !== CRYPTO_FUTURES_POSITION_TIER_HISTORY_CONTRACT || value.schemaVersion !== 1) {
    fail("POSITION_TIER_HISTORY_NOTICE_CONTRACT_INVALID");
  }
  if (value.evidenceType !== "BITGET_OFFICIAL_ADJUSTMENT_NOTICE" || value.publicDataOnly !== true || value.executionAuthority !== "NONE") {
    fail("POSITION_TIER_HISTORY_NOTICE_EVIDENCE_UNSAFE");
  }
  const rebuilt = normalizeCryptoFuturesTierAdjustmentNoticeV1({
    symbol: value.symbol,
    sourceUrl: value.sourceUrl,
    publishedAt: value.publishedAt,
    effectiveAt: value.effectiveAt,
    beforeRows: value.beforeRows,
    afterRows: value.afterRows,
  });
  if (rebuilt.articleId !== value.articleId || rebuilt.evidenceDigest !== value.evidenceDigest) {
    fail("POSITION_TIER_HISTORY_NOTICE_DIGEST_MISMATCH");
  }
  if (rebuilt.beforeScheduleDigest !== value.beforeScheduleDigest || rebuilt.afterScheduleDigest !== value.afterScheduleDigest) {
    fail("POSITION_TIER_HISTORY_NOTICE_SCHEDULE_DIGEST_MISMATCH");
  }
  if (rebuilt.symbol !== expectedSymbol) fail("POSITION_TIER_HISTORY_NOTICE_SYMBOL_MISMATCH", `${rebuilt.symbol}->${expectedSymbol}`);
  return rebuilt;
}

function assertSnapshot(value, expectedSymbol) {
  exactKeys(value, [
    "contract", "schemaVersion", "evidenceType", "provider", "symbol", "observedAt", "capturedAt",
    "rows", "scheduleDigest", "publicDataOnly", "executionAuthority", "evidenceDigest",
  ], "POSITION_TIER_HISTORY_SNAPSHOT_EVIDENCE_SHAPE_INVALID");
  if (value.contract !== CRYPTO_FUTURES_POSITION_TIER_HISTORY_CONTRACT || value.schemaVersion !== 1) {
    fail("POSITION_TIER_HISTORY_SNAPSHOT_CONTRACT_INVALID");
  }
  if (value.evidenceType !== "BITGET_PUBLIC_POSITION_TIER_SNAPSHOT" || value.publicDataOnly !== true || value.executionAuthority !== "NONE") {
    fail("POSITION_TIER_HISTORY_SNAPSHOT_EVIDENCE_UNSAFE");
  }
  if (JSON.stringify(value.provider) !== JSON.stringify(CRYPTO_FUTURES_POSITION_TIER_CURRENT_SOURCE)) {
    fail("POSITION_TIER_HISTORY_SNAPSHOT_PROVIDER_INVALID");
  }
  const rebuilt = buildCryptoFuturesProspectiveTierSnapshotV1({
    symbol: value.symbol,
    rows: value.rows,
    providerRequestTime: value.observedAt,
    capturedAt: value.capturedAt,
  });
  if (rebuilt.evidenceDigest !== value.evidenceDigest || rebuilt.scheduleDigest !== value.scheduleDigest) {
    fail("POSITION_TIER_HISTORY_SNAPSHOT_DIGEST_MISMATCH");
  }
  if (rebuilt.symbol !== expectedSymbol) fail("POSITION_TIER_HISTORY_SNAPSHOT_SYMBOL_MISMATCH", `${rebuilt.symbol}->${expectedSymbol}`);
  return rebuilt;
}

function buildEvidencePoints(notices, snapshots) {
  const byTimestamp = new Map();
  function addPoint({ asOf, rows, scheduleDigest: rowDigest, evidenceType, sourceRef }) {
    const existing = byTimestamp.get(asOf);
    if (existing) {
      if (existing.scheduleDigest !== rowDigest) fail("POSITION_TIER_HISTORY_EXACT_TIME_CONFLICT", String(asOf));
      existing.sourceRefs.push(sourceRef);
      existing.evidenceTypes.push(evidenceType);
      return;
    }
    byTimestamp.set(asOf, {
      asOf,
      rows,
      scheduleDigest: rowDigest,
      evidenceTypes: [evidenceType],
      sourceRefs: [sourceRef],
    });
  }
  for (const notice of notices) {
    if (notice.publishedAt < notice.effectiveAt) {
      addPoint({
        asOf: notice.publishedAt,
        rows: notice.beforeRows,
        scheduleDigest: notice.beforeScheduleDigest,
        evidenceType: "NOTICE_BEFORE_AT_PUBLICATION",
        sourceRef: `support:${notice.articleId}`,
      });
    }
    addPoint({
      asOf: notice.effectiveAt,
      rows: notice.afterRows,
      scheduleDigest: notice.afterScheduleDigest,
      evidenceType: "NOTICE_AFTER_AT_EFFECTIVE_TIME",
      sourceRef: `support:${notice.articleId}`,
    });
  }
  for (const snapshot of snapshots) {
    addPoint({
      asOf: snapshot.observedAt,
      rows: snapshot.rows,
      scheduleDigest: snapshot.scheduleDigest,
      evidenceType: "PUBLIC_API_EXACT_SNAPSHOT",
      sourceRef: `snapshot:${snapshot.evidenceDigest}`,
    });
  }
  return [...byTimestamp.values()]
    .sort((left, right) => left.asOf - right.asOf)
    .map((point) => deepFreeze({
      ...point,
      evidenceTypes: deepFreeze([...point.evidenceTypes].sort()),
      sourceRefs: deepFreeze([...point.sourceRefs].sort()),
    }));
}

export function buildCryptoFuturesPositionTierHistoryManifestV1({
  symbol,
  notices = [],
  snapshots = [],
} = {}) {
  const normalizedSymbol = normalizeSymbol(symbol, "POSITION_TIER_HISTORY_MANIFEST_SYMBOL_INVALID");
  if (!Array.isArray(notices) || !Array.isArray(snapshots)) fail("POSITION_TIER_HISTORY_MANIFEST_EVIDENCE_INVALID");
  const normalizedNotices = notices.map((notice) => assertNotice(notice, normalizedSymbol))
    .sort((left, right) => left.effectiveAt - right.effectiveAt || left.articleId.localeCompare(right.articleId));
  const normalizedSnapshots = snapshots.map((snapshot) => assertSnapshot(snapshot, normalizedSymbol))
    .sort((left, right) => left.observedAt - right.observedAt);

  for (let index = 1; index < normalizedNotices.length; index += 1) {
    const previous = normalizedNotices[index - 1];
    const current = normalizedNotices[index];
    if (current.effectiveAt === previous.effectiveAt) fail("POSITION_TIER_HISTORY_DUPLICATE_EFFECTIVE_AT", String(current.effectiveAt));
  }
  for (let index = 1; index < normalizedSnapshots.length; index += 1) {
    const previous = normalizedSnapshots[index - 1];
    const current = normalizedSnapshots[index];
    if (current.observedAt === previous.observedAt) fail("POSITION_TIER_HISTORY_DUPLICATE_SNAPSHOT_TIME", String(current.observedAt));
  }

  let transitionChainContinuous = true;
  const transitionGaps = [];
  for (let index = 1; index < normalizedNotices.length; index += 1) {
    const previous = normalizedNotices[index - 1];
    const current = normalizedNotices[index];
    if (previous.afterScheduleDigest !== current.beforeScheduleDigest) {
      transitionChainContinuous = false;
      transitionGaps.push(deepFreeze({
        afterEffectiveAt: previous.effectiveAt,
        beforeEffectiveAt: current.effectiveAt,
        expectedScheduleDigest: previous.afterScheduleDigest,
        observedBeforeDigest: current.beforeScheduleDigest,
      }));
    }
  }

  let latestTransitionAnchoredToPublicSnapshot = false;
  if (normalizedNotices.length > 0 && normalizedSnapshots.length > 0) {
    const latestNotice = normalizedNotices[normalizedNotices.length - 1];
    const candidateSnapshots = normalizedSnapshots.filter((snapshot) => snapshot.observedAt >= latestNotice.effectiveAt);
    latestTransitionAnchoredToPublicSnapshot = candidateSnapshots.some(
      (snapshot) => snapshot.scheduleDigest === latestNotice.afterScheduleDigest,
    );
  }

  const evidencePoints = buildEvidencePoints(normalizedNotices, normalizedSnapshots);
  const readiness = {
    status: evidencePoints.length > 0 ? "POINT_IN_TIME_ONLY_HISTORY_BLOCKED" : "NO_POINT_IN_TIME_EVIDENCE_HISTORY_BLOCKED",
    exactPointInTimeEvidenceReady: evidencePoints.length > 0,
    historyCoverageMode: "EXACT_EVIDENCE_TIMESTAMPS_ONLY",
    transitionChainContinuous,
    latestTransitionAnchoredToPublicSnapshot,
    exhaustiveProviderHistorySourceAvailable: CRYPTO_FUTURES_POSITION_TIER_EXHAUSTIVE_HISTORY_SOURCES.length > 0,
    continuousHistoricalCoverage: false,
    formulaTournamentUnblocked: false,
    blocker: "EXHAUSTIVE_PROVIDER_TIER_HISTORY_SOURCE_UNAVAILABLE",
    profitabilityClaimAllowed: false,
    finalHoldoutAccessAllowed: false,
    executionAuthority: "NONE",
  };
  const core = {
    contract: CRYPTO_FUTURES_POSITION_TIER_HISTORY_CONTRACT,
    schemaVersion: 1,
    version: CRYPTO_FUTURES_POSITION_TIER_HISTORY_VERSION,
    symbol: normalizedSymbol,
    notices: normalizedNotices,
    snapshots: normalizedSnapshots,
    transitionGaps,
    evidencePoints,
    readiness,
    publicDataOnly: true,
    executionAuthority: "NONE",
  };
  return deepFreeze({ ...core, manifestDigest: digest(core) });
}

function assertManifest(value) {
  exactKeys(value, [
    "contract", "schemaVersion", "version", "symbol", "notices", "snapshots", "transitionGaps",
    "evidencePoints", "readiness", "publicDataOnly", "executionAuthority", "manifestDigest",
  ], "POSITION_TIER_HISTORY_MANIFEST_SHAPE_INVALID");
  if (value.contract !== CRYPTO_FUTURES_POSITION_TIER_HISTORY_CONTRACT || value.schemaVersion !== 1 || value.version !== CRYPTO_FUTURES_POSITION_TIER_HISTORY_VERSION) {
    fail("POSITION_TIER_HISTORY_MANIFEST_CONTRACT_INVALID");
  }
  if (value.publicDataOnly !== true || value.executionAuthority !== "NONE") fail("POSITION_TIER_HISTORY_MANIFEST_UNSAFE");
  const core = {
    contract: value.contract,
    schemaVersion: value.schemaVersion,
    version: value.version,
    symbol: value.symbol,
    notices: value.notices,
    snapshots: value.snapshots,
    transitionGaps: value.transitionGaps,
    evidencePoints: value.evidencePoints,
    readiness: value.readiness,
    publicDataOnly: value.publicDataOnly,
    executionAuthority: value.executionAuthority,
  };
  if (digest(core) !== value.manifestDigest) fail("POSITION_TIER_HISTORY_MANIFEST_DIGEST_MISMATCH");
  return value;
}

export function resolveCryptoFuturesPositionTierAtExactEvidenceTimeV1({ manifest, asOf } = {}) {
  const normalizedManifest = assertManifest(manifest);
  const normalizedAsOf = timestamp(asOf, "POSITION_TIER_HISTORY_RESOLVE_AS_OF_INVALID");
  const point = normalizedManifest.evidencePoints.find((candidate) => candidate.asOf === normalizedAsOf);
  if (!point) fail("POSITION_TIER_HISTORY_GAP", String(normalizedAsOf));
  return deepFreeze({
    contract: CRYPTO_FUTURES_POSITION_TIER_HISTORY_CONTRACT,
    symbol: normalizedManifest.symbol,
    asOf: normalizedAsOf,
    rows: point.rows,
    scheduleDigest: point.scheduleDigest,
    evidenceTypes: point.evidenceTypes,
    sourceRefs: point.sourceRefs,
    historyCoverageMode: "EXACT_EVIDENCE_TIMESTAMP",
    continuousHistoricalCoverage: false,
    formulaTournamentEligible: false,
    profitabilityClaimAllowed: false,
    finalHoldoutUsed: false,
    executionAuthority: "NONE",
  });
}

export function cryptoFuturesPositionTierHistoryReadinessV1(manifest) {
  const normalizedManifest = assertManifest(manifest);
  return normalizedManifest.readiness;
}
