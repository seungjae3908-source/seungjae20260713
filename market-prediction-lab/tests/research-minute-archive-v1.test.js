import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, statSync,
  chmodSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  persistResearchMinuteSessionV1 as store,
  deriveArchivedResearchTimeframesV1 as read,
} from "../src/research-minute-archive-v1.js";
import {
  parseResearchMinuteArchiveArgsV1 as parseCli,
  runResearchMinuteArchiveCliV1 as cli,
} from "../scripts/research-minute-archive-v1.mjs";

const MIN = 60_000, DAY = 86_400_000;
const sha = v => createHash("sha256").update(v).digest("hex");
const START = Date.parse("2026-09-18T00:00:00Z");
const VENUE = {
  KR_STOCK: "KRX", US_STOCK: "US_SIP",
  CRYPTO_SPOT: "UPBIT_KRW", CRYPTO_FUTURES: "BITGET_USDT_FUTURES",
};
const SYMBOL = {
  KR_STOCK: "005930", US_STOCK: "AAPL",
  CRYPTO_SPOT: "KRW-BTC", CRYPTO_FUTURES: "BTCUSDT",
};
function fixture(market, options = {}) {
  const start = options.start ?? (market === "US_STOCK"
    ? Date.parse("2026-09-18T13:30:00Z") : START);
  const crypto = market.startsWith("CRYPTO_");
  const session = {
    startMs: start, endMs: start + (crypto ? DAY : 30 * MIN),
    kind: crypto ? "UTC_24H" : "REGULAR",
    timeZone: market === "KR_STOCK" ? "Asia/Seoul"
      : market === "US_STOCK" ? "America/New_York" : "UTC",
    calendarSourceId: "TEST_ONLY_EXCHANGE_SESSION_ATTESTATION",
  };
  const sourceId = "TEST_ONLY_NATIVE_ONE_MINUTE_PROVENANCE";
  const minuteBars = Array.from({ length: 10 }, (_, i) => ({
    market, venue: VENUE[market], symbol: SYMBOL[market], sourceId,
    timestampMs: start + i * MIN, availableAtMs: start + (i + 1) * MIN,
    open: 100 + i, high: 102 + i, low: 99 + i,
    close: 101 + i, volume: 10 + i,
  }));
  if (options.missingMinute != null)
    minuteBars.splice(options.missingMinute, 1);
  if (options.delayMinute != null)
    minuteBars[options.delayMinute].availableAtMs = start + 30 * MIN;
  return {
    market, venue: VENUE[market], symbol: SYMBOL[market],
    sourceId, session, minuteBars,
    sourceMinuteRowsSha256: sha(JSON.stringify(minuteBars)),
    asOfMs: start + (options.delayMinute == null ? 10 : 30) * MIN,
  };
}
function temp() { return mkdtempSync(join(tmpdir(), "research-minute-archive-")); }
function request(root, source, extra = {}) {
  return {
    root, market: source.market, symbol: source.symbol,
    sessionStartMs: source.session.startMs,
    asOfMs: source.session.startMs + 10 * MIN,
    timeframes: ["1m", "3m", "5m"], ...extra,
  };
}

test("all 4 market sessions preserve immutable original and resample only closed 1m", async () => {
  const root = temp();
  try {
    for (const market of Object.keys(VENUE)) {
      const source = fixture(market);
      const first = await store({ root, source });
      assert.equal(first.status, "STORED_IMMUTABLE_ORIGINAL");
      assert.equal(first.storedOneMinuteRows, 10);
      assert.equal(first.wholeHistoricMarketPopulationVerified, false);
      assert.equal(first.trueMarketWideRecall, null);
      assert.equal(first.executionAuthority, "NONE");
      const second = await store({ root, source });
      assert.equal(second.status, "REUSED_IDENTICAL_ORIGINAL");
      assert.equal(second.sourceDigestSha256, first.sourceDigestSha256);
      assert.equal(statSync(first.path).mode & 0o077, 0);
      const out = await read(request(root, source));
      assert.equal(out.archiveSourceDigestSha256, first.sourceDigestSha256);
      assert.equal(out.intervalData["1m"].completeBarCount, 10);
      assert.equal(out.intervalData["3m"].completeBarCount, 3);
      assert.equal(out.intervalData["5m"].completeBarCount, 2);
      assert.equal(out.intervalData["5m"].bars[0].open, 100);
      assert.equal(out.intervalData["5m"].bars[0].close, 105);
      assert.equal(out.intervalData["5m"].bars[0].volume, 60);
      assert.equal(out.historicalWholeMarketSourceCoverageVerified, false);
      assert.equal(out.originalScannerEarlyDiscoveryVerified, false);
      assert.equal(out.profitabilityProven, false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("concurrent same session upload remains idempotent, no overwrite", async () => {
  const root = temp(), source = fixture("CRYPTO_SPOT");
  try {
    const result = await Promise.all([
      store({ root, source }), store({ root, source }),
      store({ root, source }),
    ]);
    assert.equal(result.filter(x => x.status === "STORED_IMMUTABLE_ORIGINAL").length, 1);
    assert.equal(result.filter(x => x.status === "REUSED_IDENTICAL_ORIGINAL").length, 2);
    assert.equal(new Set(result.map(x => x.sourceDigestSha256)).size, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("different source revisions are never guessed or silently overwritten", async () => {
  const root = temp(), a = fixture("CRYPTO_FUTURES");
  const b = structuredClone(a);
  b.minuteBars[0].high += 7;
  b.sourceMinuteRowsSha256 = sha(JSON.stringify(b.minuteBars));
  try {
    const first = await store({ root, source: a });
    const second = await store({ root, source: b });
    assert.notEqual(first.sourceDigestSha256, second.sourceDigestSha256);
    const ambiguous = await read(request(root, a));
    assert.equal(ambiguous.status, "BLOCKED_DATA");
    assert.equal(ambiguous.reason,
      "MULTIPLE_SOURCE_REVISIONS_REQUIRE_EXPLICIT_SELECTION");
    assert.equal(ambiguous.trueMarketWideRecall, null);
    const chosen = await read(request(root, a, {
      sourceDigestSha256: second.sourceDigestSha256,
    }));
    assert.equal(chosen.archiveRevisionCount, 2);
    assert.equal(chosen.intervalData["5m"].bars[0].high, 109);
    const notFound = await read(request(root, a, {
      sourceDigestSha256: "f".repeat(64),
    }));
    assert.equal(notFound.reason, "ARCHIVED_REVISION_NOT_FOUND");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing 1m and delayed availability cannot produce a fake complete 5m", async () => {
  const root = temp(), a = fixture("CRYPTO_SPOT", { missingMinute: 2 });
  const b = fixture("CRYPTO_FUTURES", { delayMinute: 4 });
  try {
    await store({ root, source: a });
    await store({ root, source: b });
    const sparse = await read(request(root, a));
    assert.equal(sparse.intervalData["5m"].completeBarCount, 1);
    assert.equal(sparse.intervalData["5m"].missingUnverifiedSourceBuckets, 1);
    assert.equal(sparse.status, "SOURCE_LIMITED_PARTIAL_MULTI_TIMEFRAME_BARS");
    const delayed = await read(request(root, b));
    assert.equal(delayed.intervalData["5m"].completeBarCount, 1);
    assert.equal(delayed.intervalData["5m"].barDataUnavailableAtCutoffBuckets, 1);
    assert.equal(delayed.status, "SOURCE_LIMITED_PARTIAL_MULTI_TIMEFRAME_BARS");
    assert.equal(delayed.actualFillCount, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("raw digest, tampered compressed file and unsafe root fail closed", async () => {
  const root = temp(), a = fixture("KR_STOCK");
  try {
    const bad = structuredClone(a);
    bad.minuteBars[0].close += 1;
    await assert.rejects(() => store({ root, source: bad }),
      /MINUTE_ARCHIVE_ORIGINAL_SOURCE_DIGEST_INVALID/);
    const inserted = await store({ root, source: a });
    writeFileSync(inserted.path, Buffer.from("tampered bytes"));
    await assert.rejects(() => read(request(root, a)),
      /MINUTE_ARCHIVE_COMPRESSED_ORIGINAL_INVALID/);
    const loose = join(root, "loose");
    const other = fixture("US_STOCK");
    writeFileSync(loose, "bad", { mode: 0o644 });
    await assert.rejects(() => store({ root: loose, source: other }),
      /MINUTE_ARCHIVE_SYMLINK_OR_PARENT_INVALID/);
    const alias = root + "-link";
    symlinkSync(root, alias, "dir");
    try {
      await assert.rejects(() => store({ root: alias, source: other }),
        /MINUTE_ARCHIVE_SYMLINK_OR_PARENT_INVALID/);
    } finally { rmSync(alias, { force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing archive remains BLOCKED, never claims zero market opportunities", async () => {
  const root = temp(), a = fixture("CRYPTO_SPOT");
  try {
    const missing = await read(request(root, a));
    assert.equal(missing.status, "BLOCKED_DATA");
    assert.equal(missing.reason, "ARCHIVED_SESSION_NOT_FOUND");
    assert.equal(missing.actualMarketWideOpportunityCount, null);
    assert.equal(missing.trueMarketWideRecall, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("private CLI ingests and queries one session without network, duplicate output blocked", async () => {
  const root = temp(), a = fixture("CRYPTO_SPOT");
  const input = join(root, "raw.json"), output = join(root, "derived.json");
  try {
    writeFileSync(input, JSON.stringify(a), { mode: 0o600 });
    const ingested = await cli(parseCli([
      "--mode", "ingest", "--root", root, "--input", input,
    ]));
    assert.equal(ingested.status, "STORED_IMMUTABLE_ORIGINAL");
    assert.equal(ingested.executionAuthority, "NONE");
    const params = ["--mode", "derive", "--root", root,
      "--market", a.market, "--symbol", a.symbol,
      "--session-start", "2026-09-18T00:00:00Z",
      "--as-of", "2026-09-18T00:10:00Z",
      "--timeframes", "1m,5m,15m", "--output", output];
    const result = await cli(parseCli(params));
    assert.equal(result.derivedCandleCount, 12);
    assert.equal(result.profitabilityProven, false);
    const saved = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(saved.intervalData["5m"].completeBarCount, 2);
    assert.equal(saved.intervalData["15m"].completeBarCount, 0);
    assert.equal(statSync(output).mode & 0o077, 0);
    await assert.rejects(() => cli(parseCli(params)),
      /MINUTE_ARCHIVE_CLI_OUTPUT_ALREADY_EXISTS/);
    assert.throws(() => parseCli(params.map(x =>
      x === "2026-09-18T00:10:00Z" ? "2026-09-18T99:10:00Z" : x)),
    /MINUTE_ARCHIVE_CLI_EXPLICIT_UTC_TIME_REQUIRED/);
    chmodSync(input, 0o644);
    await assert.rejects(() => cli(parseCli([
      "--mode", "ingest", "--root", root, "--input", input,
    ])), /MINUTE_ARCHIVE_CLI_PRIVATE_SOURCE_REQUIRED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
