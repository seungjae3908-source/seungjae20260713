import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { deriveResearchTimeframesFromMinuteSourceV1 as derive } from "./research-minute-to-multiframe-v1.js";

/**
 * OFFLINE private, immutable 1-minute source archive. A session is indexed by
 * market / hashed symbol / exchange session start and a content SHA-256 revision.
 * No provider fetch, DB changes, network activity, Paper, LIVE or server activation.
 *
 * Source presence is NOT proof of historical PIT coverage, official exchange
 * sessions, intrabar first crossing, actual fills or profitable strategies.
 * Missing sessions and competing revisions are never silently backfilled.
 */
const SCHEMA = "research-private-minute-session-archive-v1";
const MAX_ORIGINAL_BYTES = 3 * 1024 * 1024;
const SHA = /^[0-9a-f]{64}$/u;
const SYMBOL = /^[A-Z0-9][A-Z0-9._:-]{0,39}$/u;
const MARKETS = Object.freeze({
  KR_STOCK: "KRX", US_STOCK: "US_SIP",
  CRYPTO_SPOT: "UPBIT_KRW", CRYPTO_FUTURES: "BITGET_USDT_FUTURES",
});
const SOURCE_KEYS = ["market", "venue", "symbol", "sourceId", "session",
  "minuteBars", "sourceMinuteRowsSha256", "asOfMs"];
const SESSION_KEYS = ["startMs", "endMs", "kind", "timeZone", "calendarSourceId"];
const BAR_KEYS = ["market", "venue", "symbol", "sourceId", "timestampMs",
  "availableAtMs", "open", "high", "low", "close", "volume"];
const hash = value => createHash("sha256").update(value).digest("hex");
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const safety = values => Object.freeze({
  schemaVersion: SCHEMA, actualMarketWideOpportunityCount: null,
  trueMarketWideRecall: null, actualFillCount: null, netProfitPct: null,
  independentPITAndSourceAuthentication: false,
  wholeHistoricMarketPopulationVerified: false,
  profitabilityProven: false, executionAuthority: "NONE",
  liveTrading: false, autoTrading: false, realOrders: false,
  ...values,
});

function exactly(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every(key => own(value, key));
}
function validSelection({ market, symbol, sessionStartMs }) {
  if (!own(MARKETS, market) || typeof symbol !== "string"
    || !SYMBOL.test(symbol) || !Number.isSafeInteger(sessionStartMs)
    || sessionStartMs <= 0 || sessionStartMs % 60_000 !== 0) {
    throw new TypeError("MINUTE_ARCHIVE_IDENTITY_INVALID");
  }
}
function validateOriginal(source) {
  if (!exactly(source, SOURCE_KEYS) || !exactly(source.session, SESSION_KEYS)
    || !Array.isArray(source.minuteBars)
    || source.minuteBars.length < 1 || source.minuteBars.length > 1440
    || source.minuteBars.some(bar => !exactly(bar, BAR_KEYS))
    || typeof source.sourceMinuteRowsSha256 !== "string"
    || !SHA.test(source.sourceMinuteRowsSha256)) {
    throw new TypeError("MINUTE_ARCHIVE_SOURCE_SCHEMA_INVALID");
  }
  validSelection({ market: source.market, symbol: source.symbol,
    sessionStartMs: source.session.startMs });
  if (source.venue !== MARKETS[source.market]
    || hash(JSON.stringify(source.minuteBars)) !== source.sourceMinuteRowsSha256) {
    throw new TypeError("MINUTE_ARCHIVE_ORIGINAL_SOURCE_DIGEST_INVALID");
  }
  // Reuse the proven one-minute parser, causal availability and venue/session
  // gates. It may return PARTIAL; incomplete data must remain incomplete.
  const check = derive({ ...source, timeframes: ["1m"] });
  if (check.status === "BLOCKED_DATA"
    || !check.sourceMinuteIntegrityVerified) {
    throw new TypeError("MINUTE_ARCHIVE_SOURCE_" + String(check.reason));
  }
  return check;
}

function absoluteRoot(root) {
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root)
    throw new TypeError("MINUTE_ARCHIVE_ABSOLUTE_ROOT_REQUIRED");
  return root;
}
async function privateDirectory(path, create) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0)
    throw new TypeError("MINUTE_ARCHIVE_PRIVATE_DIRECTORY_REQUIRED");
}
async function checkAncestorsNoSymlinks(root) {
  // An existing parent link could redirect a seemingly-private path.
  let cursor = root;
  while (true) {
    try {
      const st = await lstat(cursor);
      if (st.isSymbolicLink() || !st.isDirectory())
        throw new TypeError("MINUTE_ARCHIVE_SYMLINK_OR_PARENT_INVALID");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
async function sessionDirectory(root, input, create) {
  const base = absoluteRoot(root);
  validSelection(input);
  await checkAncestorsNoSymlinks(base);
  try {
    await privateDirectory(base, create);
    const parts = ["minute-sessions-v1", input.market, hash(input.symbol),
      String(input.sessionStartMs)];
    let current = base;
    for (const part of parts) {
      current = join(current, part);
      await privateDirectory(current, create);
    }
    return current;
  } catch (error) {
    if (!create && error?.code === "ENOENT") return null;
    throw error;
  }
}
async function loadRecord(filePath, expectedDigest) {
  const st = await lstat(filePath);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1
    || (st.mode & 0o077) !== 0 || st.size < 15 || st.size > MAX_ORIGINAL_BYTES)
    throw new TypeError("MINUTE_ARCHIVE_PRIVATE_FILE_INVALID");
  const zipped = await readFile(filePath);
  let plain;
  try {
    plain = gunzipSync(zipped, { maxOutputLength: MAX_ORIGINAL_BYTES }).toString("utf8");
  } catch {
    throw new TypeError("MINUTE_ARCHIVE_COMPRESSED_ORIGINAL_INVALID");
  }
  if (hash(plain) !== expectedDigest)
    throw new TypeError("MINUTE_ARCHIVE_ORIGINAL_DIGEST_CHANGED");
  let source;
  try { source = JSON.parse(plain); }
  catch { throw new TypeError("MINUTE_ARCHIVE_ORIGINAL_JSON_INVALID"); }
  validateOriginal(source);
  return source;
}
async function syncDirectory(path) {
  const h = await open(path, "r");
  try { await h.sync(); } finally { await h.close(); }
}

/** Create-only, compressed, content-addressed write with concurrent-safe reuse. */
export async function persistResearchMinuteSessionV1({ root, source } = {}) {
  const verified = validateOriginal(source);
  const plain = JSON.stringify(source);
  if (Buffer.byteLength(plain) > MAX_ORIGINAL_BYTES)
    throw new RangeError("MINUTE_ARCHIVE_ORIGINAL_TOO_LARGE");
  const digest = hash(plain);
  const directory = await sessionDirectory(root, {
    market: source.market, symbol: source.symbol,
    sessionStartMs: source.session.startMs,
  }, true);
  const target = join(directory, digest + ".json.gz");
  const tmp = join(directory, "." + digest + "." + randomUUID() + ".tmp");
  let inserted = false;
  try {
    const h = await open(tmp, "wx", 0o600);
    try {
      await h.writeFile(gzipSync(Buffer.from(plain), { level: 6 }));
      await h.sync();
    } finally { await h.close(); }
    try {
      await link(tmp, target);
      inserted = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  } finally {
    try { await unlink(tmp); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await syncDirectory(directory);
  }
  const retained = await loadRecord(target, digest);
  if (JSON.stringify(retained) !== plain)
    throw new TypeError("MINUTE_ARCHIVE_EXISTING_CONTENT_CONFLICT");
  return safety({
    status: inserted ? "STORED_IMMUTABLE_ORIGINAL" : "REUSED_IDENTICAL_ORIGINAL",
    market: source.market, venue: source.venue, symbol: source.symbol,
    sessionStartMs: source.session.startMs, sourceDigestSha256: digest,
    sourceMinuteRowsSha256: source.sourceMinuteRowsSha256,
    storedOneMinuteRows: source.minuteBars.length,
    sourceAtIngestStatus: verified.status,
    physicalOriginalCompression: "GZIP",
    path: target,
  });
}

/** Read a specified session/revision and derive bars only available at cutoff. */
export async function deriveArchivedResearchTimeframesV1({
  root, market, symbol, sessionStartMs, sourceDigestSha256 = null,
  asOfMs, timeframes = ["1m", "3m", "5m", "15m", "30m", "1h", "4h"],
} = {}) {
  const directory = await sessionDirectory(root, { market, symbol, sessionStartMs }, false);
  if (sourceDigestSha256 != null && !SHA.test(sourceDigestSha256))
    throw new TypeError("MINUTE_ARCHIVE_SOURCE_REVISION_INVALID");
  if (!Number.isSafeInteger(asOfMs) || asOfMs <= 0)
    throw new TypeError("MINUTE_ARCHIVE_CUTOFF_REQUIRED");
  if (!Array.isArray(timeframes) || !timeframes.length)
    throw new TypeError("MINUTE_ARCHIVE_TIMEFRAMES_REQUIRED");
  if (!directory) return safety({ status: "BLOCKED_DATA", reason: "ARCHIVED_SESSION_NOT_FOUND",
    market, symbol, sessionStartMs });
  const filenames = (await readdir(directory)).filter(x => x.endsWith(".json.gz"));
  if (filenames.some(x => !/^[0-9a-f]{64}\.json\.gz$/u.test(x)))
    throw new TypeError("MINUTE_ARCHIVE_REVISION_FILENAME_INVALID");
  const revisions = filenames.map(x => x.slice(0, 64)).sort();
  if (!revisions.length || (sourceDigestSha256 != null
    && !revisions.includes(sourceDigestSha256)))
    return safety({ status: "BLOCKED_DATA", reason: "ARCHIVED_REVISION_NOT_FOUND",
      market, symbol, sessionStartMs, archivedRevisionCount: revisions.length });
  if (sourceDigestSha256 == null && revisions.length > 1)
    return safety({ status: "BLOCKED_DATA",
      reason: "MULTIPLE_SOURCE_REVISIONS_REQUIRE_EXPLICIT_SELECTION",
      market, symbol, sessionStartMs, archivedRevisionCount: revisions.length });
  const digest = sourceDigestSha256 ?? revisions[0];
  const source = await loadRecord(join(directory, digest + ".json.gz"), digest);
  if (source.market !== market || source.symbol !== symbol
    || source.session.startMs !== sessionStartMs)
    throw new TypeError("MINUTE_ARCHIVE_PATH_IDENTITY_MISMATCH");
  const result = derive({ ...source, asOfMs, timeframes });
  return Object.freeze({
    ...result, archiveSchemaVersion: SCHEMA,
    archiveSourceDigestSha256: digest, archiveRevisionCount: revisions.length,
    historicalWholeMarketSourceCoverageVerified: false,
    // A derived candle is NOT evidence of an original contemporaneous signal.
    originalScannerEarlyDiscoveryVerified: false,
    executionAuthority: "NONE", profitabilityProven: false,
  });
}
