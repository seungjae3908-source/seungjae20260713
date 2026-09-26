import test from "node:test";
import assert from "node:assert/strict";
import {
  CRYPTO_FUTURES_POSITION_TIER_EXHAUSTIVE_HISTORY_SOURCES,
  buildCryptoFuturesPositionTierHistoryManifestV1,
  buildCryptoFuturesProspectiveTierSnapshotV1,
  cryptoFuturesPositionTierHistoryReadinessV1,
  normalizeCryptoFuturesTierAdjustmentNoticeV1,
  resolveCryptoFuturesPositionTierAtExactEvidenceTimeV1,
} from "../src/crypto-futures-position-tier-history-provenance-v1.js";

// Synthetic rows below are unit-test fixtures only. They are never market evidence.
const SYMBOL = "BTCUSDT";
const PUBLISHED_1 = Date.UTC(2025, 6, 30, 9, 32, 0, 0);
const EFFECTIVE_1 = Date.UTC(2025, 6, 31, 10, 0, 0, 0);
const PUBLISHED_2 = Date.UTC(2025, 8, 26, 8, 0, 0, 0);
const EFFECTIVE_2 = Date.UTC(2025, 8, 26, 8, 22, 0, 0);
const SNAPSHOT_AT = Date.UTC(2026, 7, 27, 1, 0, 0, 0);

function rowsA() {
  return [
    { tier: "1", minTierValue: "0", maxTierValue: "100000", leverage: "100", mmr: "0.004" },
    { tier: "2", minTierValue: "100000", maxTierValue: "500000", leverage: "50", mmr: "0.01" },
  ];
}

function rowsB() {
  return [
    { tier: "1", minTierValue: "0", maxTierValue: "200000", leverage: "125", mmr: "0.004" },
    { tier: "2", minTierValue: "200000", maxTierValue: "1000000", leverage: "75", mmr: "0.007" },
  ];
}

function rowsC() {
  return [
    { tier: "1", minTierValue: "0", maxTierValue: "200000", leverage: "150", mmr: "0.004" },
    { tier: "2", minTierValue: "200000", maxTierValue: "1000000", leverage: "100", mmr: "0.005" },
  ];
}

function rowsGap() {
  return [
    { tier: "1", minTierValue: "0", maxTierValue: "150000", leverage: "125", mmr: "0.004" },
    { tier: "2", minTierValue: "150000", maxTierValue: "900000", leverage: "75", mmr: "0.008" },
  ];
}

function noticeOne(overrides = {}) {
  return normalizeCryptoFuturesTierAdjustmentNoticeV1({
    symbol: SYMBOL,
    sourceUrl: "https://www.bitget.com/en-CA/support/articles/12560603834416",
    publishedAt: PUBLISHED_1,
    effectiveAt: EFFECTIVE_1,
    beforeRows: rowsA(),
    afterRows: rowsB(),
    ...overrides,
  });
}

function noticeTwo(overrides = {}) {
  return normalizeCryptoFuturesTierAdjustmentNoticeV1({
    symbol: SYMBOL,
    sourceUrl: "https://www.bitget.com/support/articles/12560603838668",
    publishedAt: PUBLISHED_2,
    effectiveAt: EFFECTIVE_2,
    beforeRows: rowsB(),
    afterRows: rowsC(),
    ...overrides,
  });
}

function snapshot(overrides = {}) {
  return buildCryptoFuturesProspectiveTierSnapshotV1({
    symbol: SYMBOL,
    rows: rowsC(),
    providerRequestTime: SNAPSHOT_AT,
    capturedAt: SNAPSHOT_AT + 2_000,
    ...overrides,
  });
}

test("official support notice provenance is canonicalized and symbol-bound", () => {
  const notice = noticeOne();
  assert.equal(notice.sourceUrl, "https://www.bitget.com/support/articles/12560603834416");
  assert.equal(notice.articleId, "12560603834416");
  assert.equal(notice.symbol, SYMBOL);
  assert.notEqual(notice.beforeScheduleDigest, notice.afterScheduleDigest);
  assert.equal(notice.publicDataOnly, true);
  assert.equal(notice.executionAuthority, "NONE");
  assert.ok(Object.isFrozen(notice));
});

test("notice provenance rejects non-Bitget, decorated, and post-effective sources", () => {
  assert.throws(() => noticeOne({
    sourceUrl: "https://example.com/support/articles/12560603834416",
  }), /POSITION_TIER_HISTORY_NOTICE_HOST_INVALID/);
  assert.throws(() => noticeOne({
    sourceUrl: "https://www.bitget.com/support/articles/12560603834416?copy=1",
  }), /POSITION_TIER_HISTORY_NOTICE_URL_DECORATED/);
  assert.throws(() => noticeOne({
    publishedAt: EFFECTIVE_1 + 1,
  }), /POSITION_TIER_HISTORY_NOTICE_PUBLISHED_AFTER_EFFECTIVE/);
});

test("prospective public snapshot is exact-time evidence and enforces capture freshness", () => {
  const value = snapshot();
  assert.equal(value.observedAt, SNAPSHOT_AT);
  assert.equal(value.capturedAt, SNAPSHOT_AT + 2_000);
  assert.equal(value.symbol, SYMBOL);
  assert.equal(value.publicDataOnly, true);
  assert.equal(value.executionAuthority, "NONE");

  assert.throws(() => snapshot({
    capturedAt: SNAPSHOT_AT + 5 * 60_000 + 1,
  }), /POSITION_TIER_HISTORY_SNAPSHOT_CAPTURE_LAG_EXCEEDED/);
  assert.throws(() => snapshot({
    providerRequestTime: SNAPSHOT_AT + 1,
    capturedAt: SNAPSHOT_AT,
  }), /POSITION_TIER_HISTORY_SNAPSHOT_FUTURE_PROVIDER_TIME/);
});

test("continuous-looking notice chain plus current anchor still remains historical BLOCKED", () => {
  const manifest = buildCryptoFuturesPositionTierHistoryManifestV1({
    symbol: SYMBOL,
    notices: [noticeOne(), noticeTwo()],
    snapshots: [snapshot()],
  });
  const readiness = cryptoFuturesPositionTierHistoryReadinessV1(manifest);

  assert.equal(manifest.transitionGaps.length, 0);
  assert.equal(readiness.transitionChainContinuous, true);
  assert.equal(readiness.latestTransitionAnchoredToPublicSnapshot, true);
  assert.equal(readiness.exactPointInTimeEvidenceReady, true);
  assert.equal(readiness.historyCoverageMode, "EXACT_EVIDENCE_TIMESTAMPS_ONLY");
  assert.equal(readiness.exhaustiveProviderHistorySourceAvailable, false);
  assert.equal(readiness.continuousHistoricalCoverage, false);
  assert.equal(readiness.formulaTournamentUnblocked, false);
  assert.equal(readiness.blocker, "EXHAUSTIVE_PROVIDER_TIER_HISTORY_SOURCE_UNAVAILABLE");
  assert.equal(readiness.profitabilityClaimAllowed, false);
  assert.equal(readiness.finalHoldoutAccessAllowed, false);
  assert.equal(readiness.executionAuthority, "NONE");
  assert.deepEqual(CRYPTO_FUTURES_POSITION_TIER_EXHAUSTIVE_HISTORY_SOURCES, []);
});

test("notice transition mismatch is preserved as an explicit provenance gap", () => {
  const brokenSecond = noticeTwo({ beforeRows: rowsGap() });
  const manifest = buildCryptoFuturesPositionTierHistoryManifestV1({
    symbol: SYMBOL,
    notices: [noticeOne(), brokenSecond],
    snapshots: [snapshot()],
  });

  assert.equal(manifest.readiness.transitionChainContinuous, false);
  assert.equal(manifest.transitionGaps.length, 1);
  assert.equal(manifest.readiness.continuousHistoricalCoverage, false);
  assert.equal(manifest.readiness.formulaTournamentUnblocked, false);
});

test("resolver allows only directly evidenced timestamps and never fills historical gaps", () => {
  const manifest = buildCryptoFuturesPositionTierHistoryManifestV1({
    symbol: SYMBOL,
    notices: [noticeOne(), noticeTwo()],
    snapshots: [snapshot()],
  });

  const beforeAtPublication = resolveCryptoFuturesPositionTierAtExactEvidenceTimeV1({
    manifest,
    asOf: PUBLISHED_1,
  });
  assert.equal(beforeAtPublication.scheduleDigest, noticeOne().beforeScheduleDigest);
  assert.deepEqual(beforeAtPublication.evidenceTypes, ["NOTICE_BEFORE_AT_PUBLICATION"]);

  const afterAtEffective = resolveCryptoFuturesPositionTierAtExactEvidenceTimeV1({
    manifest,
    asOf: EFFECTIVE_1,
  });
  assert.equal(afterAtEffective.scheduleDigest, noticeOne().afterScheduleDigest);
  assert.deepEqual(afterAtEffective.evidenceTypes, ["NOTICE_AFTER_AT_EFFECTIVE_TIME"]);

  const exactSnapshot = resolveCryptoFuturesPositionTierAtExactEvidenceTimeV1({
    manifest,
    asOf: SNAPSHOT_AT,
  });
  assert.equal(exactSnapshot.scheduleDigest, snapshot().scheduleDigest);
  assert.deepEqual(exactSnapshot.evidenceTypes, ["PUBLIC_API_EXACT_SNAPSHOT"]);
  assert.equal(exactSnapshot.continuousHistoricalCoverage, false);
  assert.equal(exactSnapshot.formulaTournamentEligible, false);

  assert.throws(() => resolveCryptoFuturesPositionTierAtExactEvidenceTimeV1({
    manifest,
    asOf: EFFECTIVE_1 + 60_000,
  }), /POSITION_TIER_HISTORY_GAP/);
});

test("cross-symbol evidence and tampered snapshot identity fail closed", () => {
  assert.throws(() => buildCryptoFuturesPositionTierHistoryManifestV1({
    symbol: "ETHUSDT",
    notices: [noticeOne()],
    snapshots: [],
  }), /POSITION_TIER_HISTORY_NOTICE_SYMBOL_MISMATCH/);

  const valid = snapshot();
  const tampered = { ...valid, scheduleDigest: "0".repeat(64) };
  assert.throws(() => buildCryptoFuturesPositionTierHistoryManifestV1({
    symbol: SYMBOL,
    notices: [],
    snapshots: [tampered],
  }), /POSITION_TIER_HISTORY_SNAPSHOT_DIGEST_MISMATCH/);
});

test("conflicting direct evidence at the same timestamp fails closed", () => {
  const conflictingSnapshot = buildCryptoFuturesProspectiveTierSnapshotV1({
    symbol: SYMBOL,
    rows: rowsA(),
    providerRequestTime: EFFECTIVE_1,
    capturedAt: EFFECTIVE_1 + 1_000,
  });
  assert.throws(() => buildCryptoFuturesPositionTierHistoryManifestV1({
    symbol: SYMBOL,
    notices: [noticeOne()],
    snapshots: [conflictingSnapshot],
  }), /POSITION_TIER_HISTORY_EXACT_TIME_CONFLICT/);
});

test("duplicate transition or snapshot timestamps are rejected", () => {
  const duplicateNotice = normalizeCryptoFuturesTierAdjustmentNoticeV1({
    symbol: SYMBOL,
    sourceUrl: "https://www.bitget.com/support/articles/12560603899999",
    publishedAt: PUBLISHED_1 - 1_000,
    effectiveAt: EFFECTIVE_1,
    beforeRows: rowsA(),
    afterRows: rowsC(),
  });
  assert.throws(() => buildCryptoFuturesPositionTierHistoryManifestV1({
    symbol: SYMBOL,
    notices: [noticeOne(), duplicateNotice],
    snapshots: [],
  }), /POSITION_TIER_HISTORY_DUPLICATE_EFFECTIVE_AT/);

  const duplicateSnapshot = buildCryptoFuturesProspectiveTierSnapshotV1({
    symbol: SYMBOL,
    rows: rowsC(),
    providerRequestTime: SNAPSHOT_AT,
    capturedAt: SNAPSHOT_AT + 3_000,
  });
  assert.throws(() => buildCryptoFuturesPositionTierHistoryManifestV1({
    symbol: SYMBOL,
    notices: [],
    snapshots: [snapshot(), duplicateSnapshot],
  }), /POSITION_TIER_HISTORY_DUPLICATE_SNAPSHOT_TIME/);
});
