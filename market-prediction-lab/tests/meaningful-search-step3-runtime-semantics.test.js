import test from "node:test";
import assert from "node:assert/strict";
import { runCanonicalMeaningfulSearchMarket } from "../src/canonical-scanner-meaningful-search-runtime-v1.js";

function batch({ classification, partial = true, accepted = 1 } = {}) {
  const providerFailureClassifications = classification ? { [classification]: 1 } : {};
  return {
    universe: { totalCount: 2, nextCursor: null, source: "public-live", partial: false, stale: false },
    execution: {
      requestedCount: 2,
      startedCount: 2,
      completedCount: 2,
      providerAcceptedCount: accepted,
      requiredProviderFailureCount: classification ? 1 : 0,
      providerErrorCount: classification ? 1 : 0,
      timeoutCount: 0,
      insufficientDataCount: classification === "INSUFFICIENT_HISTORY" ? 1 : 0,
      hardFilterPassCount: accepted,
      hardFilterRejectedCount: 0,
      softCandidateCount: 0,
      filteredByStrategyCount: 0,
      providerFailureClassifications,
      partial,
      timedOut: false,
      cancelled: false,
    },
    audit: {
      rangeEnd: 2,
      universeScope: { rawTotal: 2, eligibleScopeDefined: true, exclusionReasons: {} },
      providerFailureClassifications,
      historyOkCount: accepted,
      historyFailCount: classification === "INSUFFICIENT_HISTORY" ? 1 : 0,
    },
    cards: [],
    failures: classification ? [{ classification }] : [],
  };
}

test("explained insufficient history preserves full sweep integrity without pretending it succeeded", async () => {
  const result = await runCanonicalMeaningfulSearchMarket({
    market: "KR_STOCK",
    scanBatch: async () => batch({ classification: "INSUFFICIENT_HISTORY" }),
  });
  assert.equal(result.providerFailed, 1);
  assert.equal(result.explainedProviderExclusions, 1);
  assert.equal(result.unresolvedRequiredFailures, 0);
  assert.equal(result.providerIntegrityComplete, true);
  assert.equal(result.universe.coverageComplete, true);
  assert.equal(result.outcome, "VALID_NO_TRADE");
  assert.equal(result.liveTrading, false);
});

test("unsupported symbol is explained but remains visible in raw provider failure accounting", async () => {
  const result = await runCanonicalMeaningfulSearchMarket({
    market: "US_STOCK",
    scanBatch: async () => batch({ classification: "SYMBOL_UNSUPPORTED" }),
  });
  assert.equal(result.providerFailed, 1);
  assert.equal(result.explainedProviderExclusions, 1);
  assert.equal(result.unresolvedRequiredFailures, 0);
  assert.equal(result.providerFailureClassifications.SYMBOL_UNSUPPORTED, 1);
  assert.equal(result.searchFailure, false);
});

test("rate limit remains an unresolved required failure and cannot become VALID_NO_TRADE", async () => {
  const result = await runCanonicalMeaningfulSearchMarket({
    market: "CRYPTO_SPOT",
    scanBatch: async () => batch({ classification: "RATE_LIMITED" }),
  });
  assert.equal(result.explainedProviderExclusions, 0);
  assert.equal(result.unresolvedRequiredFailures, 1);
  assert.equal(result.providerIntegrityComplete, false);
  assert.equal(result.outcome, "SEARCH_FAILURE");
  assert.equal(result.validNoTrade, false);
});

test("unclassified legacy required failures remain fail-closed", async () => {
  const response = batch({ classification: null, partial: true, accepted: 1 });
  response.execution.requiredProviderFailureCount = 1;
  response.execution.providerErrorCount = 1;
  const result = await runCanonicalMeaningfulSearchMarket({
    market: "CRYPTO_FUTURES",
    scanBatch: async () => response,
  });
  assert.equal(result.providerFailed, 1);
  assert.equal(result.unresolvedRequiredFailures, 1);
  assert.equal(result.outcome, "SEARCH_FAILURE");
});
