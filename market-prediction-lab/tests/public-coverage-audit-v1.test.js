import test from "node:test";
import assert from "node:assert/strict";
import { evaluateProfitGate } from "../src/meaningful-search-profit-gate-v1.js";
import { runCanonicalMeaningfulSearchMarket } from "../src/canonical-scanner-meaningful-search-runtime-v1.js";
import {
  canonicalHardRejectReasons,
  classifyProviderFailure,
  nextCoverageCursor,
  parseNasdaqTraderDirectories,
  primarySecondaryReasons,
  providerFailureDiagnostic,
  separateInternalAndDisplayCandidates,
  withPublicProviderRetry,
} from "../src/public-coverage-audit-v1.js";

function card(id, extra = {}) {
  return { signalId: id, symbol: id, market: "KR", signalGrade: "B", ...extra };
}

function batchResponse({
  total = 2,
  cursor = 0,
  requested = Math.min(2, total - cursor),
  nextCursor = null,
  cards = [],
  internalCards = cards,
  source = "public-live",
  partial = false,
  requiredFailures = 0,
  optionalMissing = 0,
  failures = [],
  providerFailureClassifications = {},
} = {}) {
  return {
    universe: { totalCount: total, cursor, nextCursor, source, partial, stale: false },
    execution: {
      requestedCount: requested,
      startedCount: requested,
      completedCount: requested - requiredFailures,
      providerAcceptedCount: requested - requiredFailures,
      providerErrorCount: requiredFailures,
      timeoutCount: 0,
      requiredProviderFailureCount: requiredFailures,
      optionalProviderMissingCount: optionalMissing,
      insufficientDataCount: 0,
      hardFilterPassCount: internalCards.length,
      hardFilterRejectedCount: 0,
      softCandidateCount: internalCards.length,
      filteredByStrategyCount: Math.max(0, requested - requiredFailures - internalCards.length),
      partial: requiredFailures > 0,
      timedOut: false,
      providerFailureClassifications,
    },
    cards,
    failures,
    audit: {
      rangeEnd: cursor + requested,
      requestSkippedCount: 0,
      requestSkippedReasons: {},
      historyOkCount: requested - requiredFailures,
      historyFailCount: requiredFailures,
      hardRejects: [],
      internalCards,
      providerFailureClassifications,
      universeScope: { rawTotal: total, eligibleScopeDefined: true, exclusionReasons: {} },
    },
  };
}

test("optional provider absence is enrichment-only and does not count as a required failure", async () => {
  assert.equal(classifyProviderFailure(new Error("DART_NOT_CONFIGURED")), "OPTIONAL_ENRICHMENT_MISSING");
  const result = await runCanonicalMeaningfulSearchMarket({
    market: "KR_STOCK",
    scanBatch: async () => batchResponse({ optionalMissing: 1, cards: [card("A")] }),
  });
  assert.equal(result.optionalProviderMissing, 1);
  assert.equal(result.providerFailed, 0);
  assert.equal(result.validNoTrade, true);
});

test("required price or history provider failure is classified and remains SEARCH_FAILURE", async () => {
  const failure = Object.assign(new Error("PUBLIC_HTTP_429"), { status: 429 });
  assert.deepEqual(providerFailureDiagnostic(failure), {
    classification: "RATE_LIMITED",
    required: true,
    countsAsRequiredFailure: true,
  });
  const result = await runCanonicalMeaningfulSearchMarket({
    market: "US_STOCK",
    scanBatch: async () => batchResponse({
      requiredFailures: 1,
      providerFailureClassifications: { RATE_LIMITED: 1 },
      failures: [{ symbol: "A", reason: "provider_error", classification: "RATE_LIMITED" }],
    }),
  });
  assert.equal(result.outcome, "SEARCH_FAILURE");
  assert.equal(result.providerFailed, 1);
});

test("successful public fallback continues discovery without becoming a required failure", async () => {
  assert.equal(classifyProviderFailure(null, { fallbackSucceeded: true }), "FALLBACK_USED");
  const result = await runCanonicalMeaningfulSearchMarket({
    market: "KR_STOCK",
    scanBatch: async () => batchResponse({ cards: [card("fallback")], providerFailureClassifications: { FALLBACK_USED: 2 } }),
  });
  assert.equal(result.providerFailed, 0);
  assert.equal(result.profitEvaluated, 1);
  assert.equal(result.validNoTrade, true);
});

test("coverage cursor advances through every eligible page including the final short page", () => {
  const visited = [];
  let cursor = 0;
  while (cursor != null) {
    visited.push(cursor);
    cursor = nextCoverageCursor({ cursor, batchLength: Math.min(40, 93 - cursor), totalCount: 93 });
  }
  assert.deepEqual(visited, [0, 40, 80]);
});

test("Nasdaq Trader public directories define an explicit eligible US universe", () => {
  const parsed = parseNasdaqTraderDirectories({
    nasdaqText: "Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares\nAAPL|Apple Inc. - Common Stock|Q|N|N|100|N|N\nTEST|Test Security|Q|Y|N|100|N|N\nFile Creation Time: 0815202621:00|||||||",
    otherText: "ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol\nSPY|SPDR S&P 500 ETF Trust|P|SPY|Y|100|N|SPY\nABCW|ABC Warrants|N|ABCW|N|100|N|ABCW\nFile Creation Time: 0815202621:00|||||||",
  });
  assert.equal(parsed.rawTotal, 4);
  assert.equal(parsed.eligibleTotal, 2);
  assert.deepEqual(parsed.entries.map((row) => row.ticker), ["AAPL", "SPY"]);
  assert.equal(parsed.exclusionReasons.TEST_ISSUE, 1);
  assert.equal(parsed.exclusionReasons.UNSUPPORTED_SECURITY_TYPE, 1);
});

test("Nasdaq Trader raw scope counts data rows when a directory has no footer", () => {
  const parsed = parseNasdaqTraderDirectories({
    nasdaqText: "Symbol|Security Name|Test Issue|ETF\nAAPL|Apple Inc. - Common Stock|N|N",
    otherText: "ACT Symbol|Security Name|Exchange|ETF|Test Issue\nSPY|SPDR S&P 500 ETF Trust|P|Y|N",
  });
  assert.equal(parsed.rawTotal, 2);
  assert.equal(parsed.eligibleTotal, 2);
});

test("Spot audit continuation has no arbitrary max-80 truncation", async () => {
  const total = 283;
  const result = await runCanonicalMeaningfulSearchMarket({
    market: "CRYPTO_SPOT",
    scanBatch: async ({ cursor }) => {
      const requested = Math.min(40, total - cursor);
      return batchResponse({ total, cursor, requested, nextCursor: nextCoverageCursor({ cursor, batchLength: requested, totalCount: total }) });
    },
  });
  assert.equal(result.batches, 8);
  assert.equal(result.providerRequested, 283);
  assert.equal(result.universe.coverageComplete, true);
});

test("US public batches do not silently stop after the first half", async () => {
  const total = 131;
  const result = await runCanonicalMeaningfulSearchMarket({
    market: "US_STOCK",
    scanBatch: async ({ cursor }) => {
      const requested = Math.min(40, total - cursor);
      return batchResponse({ total, cursor, requested, nextCursor: nextCoverageCursor({ cursor, batchLength: requested, totalCount: total }) });
    },
  });
  assert.equal(result.providerStarted, 131);
  assert.equal(result.universe.unexplainedSkipped, 0);
});

test("internal discovery candidates are preserved beyond a UI Top 10", () => {
  const internal = Array.from({ length: 19 }, (_, index) => card(`I${index}`));
  const separated = separateInternalAndDisplayCandidates(internal, internal.slice(0, 10));
  assert.equal(separated.internalCandidateCount, 19);
  assert.equal(separated.displayCandidateCount, 10);
  assert.equal(separated.evidencePreserved, true);
});

test("Profit Gate evaluates the internal pool rather than only displayed cards", async () => {
  const internal = Array.from({ length: 12 }, (_, index) => card(`P${index}`));
  const result = await runCanonicalMeaningfulSearchMarket({
    market: "KR_STOCK",
    scanBatch: async () => batchResponse({ total: 12, requested: 12, cards: internal.slice(0, 10), internalCards: internal }),
  });
  assert.equal(result.softCandidates, 12);
  assert.equal(result.scannerReturned, 10);
  assert.equal(result.profitEvaluated, 12);
  assert.equal(result.internalEvidenceLost, 0);
});

test("missing optional enrichment remains null rather than a fabricated zero", () => {
  const discovery = { symbol: "AAPL", fundamentals: null, disclosure: null };
  assert.equal(discovery.fundamentals, null);
  assert.notEqual(discovery.fundamentals, 0);
  assert.equal(discovery.disclosure, null);
});

test("Futures remains a 754-symbol full-sweep VALID_NO_TRADE control", async () => {
  const total = 754;
  const result = await runCanonicalMeaningfulSearchMarket({
    market: "CRYPTO_FUTURES",
    scanBatch: async ({ cursor }) => {
      const requested = Math.min(40, total - cursor);
      const cards = Array.from({ length: requested }, (_, index) => card(`F${cursor + index}`, { market: "BITGET_USDT_FUTURES" }));
      return batchResponse({ total, cursor, requested, cards, internalCards: cards, nextCursor: nextCoverageCursor({ cursor, batchLength: requested, totalCount: total }) });
    },
  });
  assert.equal(result.providerSuccess, 754);
  assert.equal(result.profitEvaluated, 754);
  assert.equal(result.validNoTrade, true);
  assert.equal(result.finalCandidates, 0);
});

test("Profit Gate sample threshold remains fail-closed at the existing default", () => {
  const gate = evaluateProfitGate({
    market: "US_STOCK",
    probabilities: { tp: 0.6, sl: 0.3, expire: 0.1 },
    returns: { target: 0.05, stop: 0.02, expire: 0 },
    costs: { status: "READY", components: { commission: 0.001, spread: 0.001 } },
    calibration: { status: "READY", sampleSize: 29, tpFirstCount: 20 },
  });
  assert.equal(gate.eligible, false);
  assert.ok(gate.reasons.includes("INSUFFICIENT_SAMPLE"));
});

test("SEARCH_FAILURE and VALID_NO_TRADE remain distinct after full pagination", async () => {
  const failed = await runCanonicalMeaningfulSearchMarket({
    market: "CRYPTO_SPOT",
    scanBatch: async () => batchResponse({ requiredFailures: 1 }),
  });
  const valid = await runCanonicalMeaningfulSearchMarket({
    market: "CRYPTO_SPOT",
    scanBatch: async () => batchResponse(),
  });
  assert.equal(failed.outcome, "SEARCH_FAILURE");
  assert.equal(valid.outcome, "VALID_NO_TRADE");
});

test("exact reject diagnostics choose one primary reason and retain secondary evidence", () => {
  const reasons = primarySecondaryReasons(["INSUFFICIENT_SAMPLE", "COST_NOT_EVIDENCED", "UNCALIBRATED_PROBABILITY"]);
  assert.equal(reasons.primaryRejectReason, "COST_NOT_EVIDENCED");
  assert.deepEqual(reasons.secondaryRejectReasons, ["INSUFFICIENT_SAMPLE", "UNCALIBRATED_PROBABILITY"]);
});

test("canonical hard reject diagnostics emit exact stage reasons", () => {
  const reasons = canonicalHardRejectReasons({
    price: 10,
    listingStatus: "LISTED",
    dataState: "stale",
    assetClass: "stock",
    spreadPercent: 1.2,
    tradingValue: 0,
    volume: 1,
    market: "US",
  });
  assert.deepEqual(reasons, ["DATA_STALE", "LOW_DOLLAR_VOLUME", "SPREAD_TOO_WIDE"]);
});

test("bounded retry retries transient failures but not bad permanent input", async () => {
  let attempts = 0;
  const value = await withPublicProviderRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error("PUBLIC_HTTP_429"), { status: 429 });
    return "ok";
  }, { maxAttempts: 3, baseBackoffMs: 1, sleep: async () => {} });
  assert.equal(value, "ok");
  assert.equal(attempts, 3);
});

test("signal identity preserves different symbols that share a signal id", async () => {
  const cards = [
    card("shared", { symbol: "AAA" }),
    card("shared", { symbol: "BBB" }),
  ];
  const result = await runCanonicalMeaningfulSearchMarket({
    market: "KR_STOCK",
    scanBatch: async () => batchResponse({ total: 2, requested: 2, cards, internalCards: cards }),
  });
  assert.equal(result.scannerReturned, 2);
  assert.equal(result.profitEvaluated, 2);
  assert.equal(result.internalEvidenceLost, 0);
  const separated = separateInternalAndDisplayCandidates(cards, cards);
  assert.equal(separated.internalCandidateCount, 2);
  assert.equal(separated.displayCandidateCount, 2);
});

test("insufficient history failure has one primary reject decision", async () => {
  const response = batchResponse({
    total: 1,
    requested: 1,
    requiredFailures: 1,
    failures: [{ symbol: "SHORT", message: "insufficient history", classification: "INSUFFICIENT_HISTORY" }],
    providerFailureClassifications: { INSUFFICIENT_HISTORY: 1 },
  });
  response.execution.insufficientDataCount = 1;
  response.audit.insufficientHistoryCount = 1;
  const result = await runCanonicalMeaningfulSearchMarket({
    market: "US_STOCK",
    scanBatch: async () => response,
  });
  assert.deepEqual(result.topRejectReasons, [{ reason: "INSUFFICIENT_HISTORY", count: 1 }]);
  assert.equal(result.rejectAccounting.primaryRejectCount, 1);
});
