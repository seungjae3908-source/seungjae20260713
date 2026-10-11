import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { deriveResearchTimeframesFromMinuteSourceV1 as derive } from "./research-minute-to-multiframe-v1.js";
import { resolveSelectedResearchWindowV1 } from "./research-selected-window-v1.js";

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
  fullMarketOpportunityDenominatorVerified: false,
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

/**
 * OFFLINE original-slot inventory, intentionally separated from the as-of
 * resampler. A retrospectively downloaded 1m row is a physically stored row
 * even if it was NOT demonstrably available to a historical scanner.
 *
 * Complete minute slots means one native OHLCV row per expected minute, NOT
 * certified no-trade gaps, source-license authenticity, PIT population, or
 * a backtest/OOS profitability PASS.
 */
export async function inspectArchivedResearchMinuteSessionV1({
  root, market, symbol, sessionStartMs, sourceDigestSha256 = null,
} = {}) {
  const directory = await sessionDirectory(root, {
    market, symbol, sessionStartMs,
  }, false);
  if (sourceDigestSha256 != null && !SHA.test(sourceDigestSha256))
    throw new TypeError("MINUTE_ARCHIVE_SOURCE_REVISION_INVALID");
  if (!directory) {
    return safety({ status: "BLOCKED_DATA",
      reason: "ARCHIVED_SESSION_NOT_FOUND", market, symbol, sessionStartMs });
  }
  const filenames = (await readdir(directory)).filter(name =>
    name.endsWith(".json.gz"));
  if (filenames.some(name => !/^[0-9a-f]{64}\.json\.gz$/u.test(name)))
    throw new TypeError("MINUTE_ARCHIVE_REVISION_FILENAME_INVALID");
  const revisions = filenames.map(name => name.slice(0, 64)).sort();
  if (!revisions.length || (sourceDigestSha256 != null
    && !revisions.includes(sourceDigestSha256))) {
    return safety({ status: "BLOCKED_DATA",
      reason: "ARCHIVED_REVISION_NOT_FOUND", market, symbol, sessionStartMs,
      archivedRevisionCount: revisions.length });
  }
  if (sourceDigestSha256 == null && revisions.length > 1) {
    return safety({ status: "BLOCKED_DATA",
      reason: "MULTIPLE_SOURCE_REVISIONS_REQUIRE_EXPLICIT_SELECTION",
      market, symbol, sessionStartMs,
      archivedRevisionCount: revisions.length });
  }
  const digest = sourceDigestSha256 ?? revisions[0];
  const source = await loadRecord(join(directory, digest + ".json.gz"), digest);
  if (source.market !== market || source.symbol !== symbol
    || source.session.startMs !== sessionStartMs)
    throw new TypeError("MINUTE_ARCHIVE_PATH_IDENTITY_MISMATCH");
  const sessionMinuteSlots =
    (source.session.endMs - source.session.startMs) / 60_000;
  const storedMinuteRows = source.minuteBars.length;
  const historicallyUnavailableRows = source.minuteBars.filter(bar =>
    bar.availableAtMs > source.session.endMs).length;
  const missingUnverifiedMinuteSlots = sessionMinuteSlots - storedMinuteRows;
  return safety({
    status: missingUnverifiedMinuteSlots > 0
      ? "PARTIAL_OBSERVED_MINUTE_SLOTS_SOURCE_ONLY"
      : "OBSERVED_ALL_MINUTE_SLOTS_SOURCE_ONLY",
    market, venue: source.venue, symbol,
    sourceId: source.sourceId,
    sessionStartMs, archiveSessionEndMs: source.session.endMs,
    sessionKind: source.session.kind,
    sessionTimeZone: source.session.timeZone,
    archiveSourceDigestSha256: digest,
    archivedRevisionCount: revisions.length,
    sourceMinuteRowsSha256: source.sourceMinuteRowsSha256,
    sourceMinuteIntegrityVerified: true,
    sourceMinuteRows: storedMinuteRows,
    sessionExpectedMinuteSlots: sessionMinuteSlots,
    missingUnverifiedSourceMinuteSlots: missingUnverifiedMinuteSlots,
    nativeMinuteSlotInventoryComplete: missingUnverifiedMinuteSlots === 0,
    originalRowsUnavailableBySessionEnd: historicallyUnavailableRows,
    originalMinuteObservationTimesRetrospective:
      historicallyUnavailableRows > 0,
    // A self-attested old availability timestamp cannot itself prove it
    // was available to a historical scanner at decision time.
    originalScannerAvailabilityIndependentlyVerified: false,
    originalNoTradeGapsIndependentlyAuthenticated: false,
    independentHistoricalSourceAuthenticityVerified: false,
    originalScannerEarlyDiscoveryVerified: false,
    fullMarketOpportunityDenominatorVerified: false,
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
    archiveSessionEndMs: source.session.endMs,
    historicalWholeMarketSourceCoverageVerified: false,
    // A derived candle is NOT evidence of an original contemporaneous signal.
    originalScannerEarlyDiscoveryVerified: false,
    executionAuthority: "NONE", profitabilityProven: false,
  });
}



/**
 * Enumerate a bounded page of sessions ALREADY stored under an immutable
 * PRIVATE 1m archive. A caller never supplies a pathname for a session.
 * Symbol identity is SHA-256 addressed as the existing archive writer does.
 * This is a read-only retrospective inventory, never a data-provider call,
 * an official exchange calendar, an original-time signal or an OOS PASS.
 *
 * Stocks filter on EXCHANGE LOCAL date (KR premarket may begin on the
 * preceding UTC date, US DST remains America/New_York). Returning no
 * session is BLOCKED_DATA rather than proof that no trade was possible.
 */
export async function listArchivedResearchMinuteSessionsV1({
  root, market, symbol, researchWindow,
  cursorStartMs = null, maxSessions = 16,
} = {}) {
  const base=absoluteRoot(root);
  validSelection({ market, symbol, sessionStartMs: 60_000 });
  const period=resolveSelectedResearchWindowV1(researchWindow);
  if(!Number.isSafeInteger(maxSessions)||maxSessions<1||maxSessions>31
    ||(cursorStartMs!==null&&(!Number.isSafeInteger(cursorStartMs)
      ||cursorStartMs<=0||cursorStartMs%60_000!==0)))
    throw new TypeError("MINUTE_ARCHIVE_SESSION_INDEX_PAGE_INVALID");
  const zone=market==="KR_STOCK"?"Asia/Seoul":
    market==="US_STOCK"?"America/New_York":"UTC";
  const localDate=ms=>{
    const parts=Object.fromEntries(
      new Intl.DateTimeFormat("en-US",{timeZone:zone,
        year:"numeric",month:"2-digit",day:"2-digit"})
        .formatToParts(new Date(ms)).map(part=>[part.type,part.value]));
    return parts.year+"-"+parts.month+"-"+parts.day;
  };
  await checkAncestorsNoSymlinks(base);
  const symbolParent=join(base,"minute-sessions-v1",market,hash(symbol));
  try{
    await privateDirectory(base,false);
    let current=base;
    for(const piece of ["minute-sessions-v1",market,hash(symbol)]){
      current=join(current,piece);
      await privateDirectory(current,false);
    }
  }catch(error){
    if(error?.code==="ENOENT")
      return safety({status:"BLOCKED_DATA",reason:"PRIVATE_ORIGINAL_SESSION_INDEX_NOT_FOUND",
        market,symbol,selectedStartDate:period.startDate,
        selectedEndDate:period.endDate,sourceSessions:[],
        nextCursorStartMs:null,sessionCount:null,
        historicalMarketSourceComplete:false});
    throw error;
  }
  const names=await readdir(symbolParent,{withFileTypes:true});
  if(names.length>50_000)
    throw new TypeError("MINUTE_ARCHIVE_SESSION_INDEX_TOO_LARGE");
  const included=[];
  for(const entry of names){
    if(!entry.isDirectory()||!/^[1-9][0-9]{9,15}$/.test(entry.name))
      throw new TypeError("MINUTE_ARCHIVE_SESSION_INDEX_DIRECTORY_INVALID");
    const start=Number(entry.name);
    if(!Number.isSafeInteger(start)||start%60_000!==0)
      throw new TypeError("MINUTE_ARCHIVE_SESSION_INDEX_TIMESTAMP_INVALID");
    const local=localDate(start);
    if(local>=period.startDate&&local<=period.endDate
      &&(cursorStartMs==null||start>=cursorStartMs))
      included.push({start,date:local});
  }
  included.sort((a,b)=>a.start-b.start);
  if(included.length===0)
    return safety({status:"BLOCKED_DATA",reason:"SELECTED_PRIVATE_ORIGINAL_SESSIONS_ABSENT",
      market,symbol,selectedStartDate:period.startDate,
      selectedEndDate:period.endDate,sourceSessions:[],
      nextCursorStartMs:null,sessionCount:null,
      historicalMarketSourceComplete:false});
  const page=included.slice(0,maxSessions);
  const sourceSessions=[];
  for(const {start,date} of page){
    const observed=await inspectArchivedResearchMinuteSessionV1({
      root:base,market,symbol,sessionStartMs:start,
    });
    if(observed.status==="BLOCKED_DATA"
      ||observed.sourceMinuteIntegrityVerified!==true
      ||observed.archivedRevisionCount!==1
      ||!Number.isSafeInteger(observed.archiveSessionEndMs)
      ||observed.archiveSessionEndMs<=start
      ||!["PREMARKET","REGULAR","AFTERMARKET","UTC_24H"]
        .includes(observed.sessionKind)
      ||observed.sessionTimeZone!==zone
      ||!SHA.test(observed.archiveSourceDigestSha256??""))
      return safety({status:"BLOCKED_DATA",
        reason:"PRIVATE_ORIGINAL_SESSION_REVISION_OR_INTEGRITY_UNVERIFIED",
        market,symbol,selectedStartDate:period.startDate,
        selectedEndDate:period.endDate,
        blockedSessionStartMs:start,
        blockedArchiveReason:String(observed.reason??observed.status).slice(0,100),
        sourceSessions:[],nextCursorStartMs:null,sessionCount:null,
        historicalMarketSourceComplete:false});
    sourceSessions.push(Object.freeze({
      market,symbol,date,startMs:start,endMs:observed.archiveSessionEndMs,
      kind:observed.sessionKind,zone:observed.sessionTimeZone,
      sourceDigestSha256:observed.archiveSourceDigestSha256,
      nativeMinuteSlotInventoryComplete:
        observed.nativeMinuteSlotInventoryComplete===true,
      originalScannerAsOfEvidenceVerified:false,
    }));
  }
  const next=included[maxSessions]?.start??null;
  return safety({status:"LOCAL_ORIGINAL_SESSION_INDEX_PAGE_ONLY",
    reason:"SELF_ATTESTED_RETROSPECTIVE_ARCHIVE_INDEX_NOT_FULL_MARKET_PROOF",
    market,symbol,selectedStartDate:period.startDate,
    selectedEndDate:period.endDate,
    sourceSessions:Object.freeze(sourceSessions),
    sessionCount:sourceSessions.length,
    nextCursorStartMs:next,
    selectedPrivateOriginalSessionsAcrossPeriodIndependentlyVerified:false,
    historicalMarketSourceComplete:false,
    sourceRowsNotProofOfNoTradeGap:true,
    providerGETCount:0,financialMutationCount:0,
  });
}
