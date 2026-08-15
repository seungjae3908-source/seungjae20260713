import test from "node:test";
import assert from "node:assert/strict";
import {
  collectYahooStockHistory,
  yahooStockProviderCandidates,
} from "../src/yahoo-stock-history.js";
import {
  classifyProviderFailure,
  providerFailureDiagnostic,
  summarizeProviderFailureClassifications,
  withPublicProviderRetry,
} from "../src/public-coverage-audit-v1.js";

function yahooPayload(count = 80) {
  const nowSeconds = Math.floor(Date.now() / 1000) - count * 86_400;
  const timestamps = Array.from({ length: count }, (_, index) => nowSeconds + index * 86_400);
  const values = Array.from({ length: count }, (_, index) => 100 + index);
  return {
    chart: {
      result: [{
        timestamp: timestamps,
        indicators: {
          quote: [{
            open: values,
            high: values.map((value) => value + 1),
            low: values.map((value) => value - 1),
            close: values.map((value) => value + 0.5),
            volume: values.map(() => 1_000),
          }],
        },
      }],
      error: null,
    },
  };
}

test("KR Yahoo public collector keeps the requested exchange first and has a bounded alternate exchange fallback", () => {
  assert.deepEqual(yahooStockProviderCandidates("KR_STOCK", "005930.KS"), ["005930.KS", "005930.KQ"]);
  assert.deepEqual(yahooStockProviderCandidates("KR_STOCK", "035720.KQ"), ["035720.KQ", "035720.KS"]);
});

test("US Yahoo public collector handles class-share dot/dash aliases without changing ordinary symbols", () => {
  assert.deepEqual(yahooStockProviderCandidates("US_STOCK", "BRK-B"), ["BRK-B", "BRK.B"]);
  assert.deepEqual(yahooStockProviderCandidates("US_STOCK", "BRK.B"), ["BRK.B", "BRK-B"]);
  assert.deepEqual(yahooStockProviderCandidates("US_STOCK", "AAPL"), ["AAPL"]);
});

test("Yahoo collector uses alternate provider symbol only after the preferred symbol is unavailable", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes("005930.KS")) {
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => yahooPayload(),
    };
  };
  const endTime = Date.now();
  const result = await collectYahooStockHistory({
    market: "KR_STOCK",
    symbol: "005930.KS",
    startTime: endTime - 120 * 86_400_000,
    endTime,
    timeoutMs: 2_000,
    fetchImpl,
  });
  assert.equal(result.providerSymbol, "005930.KQ");
  assert.equal(result.providerFallbackUsed, true);
  assert.ok(urls.some((url) => url.includes("005930.KS")));
  assert.ok(urls.some((url) => url.includes("005930.KQ")));
});

test("insufficient real history is an explained exclusion, not an unresolved provider outage", () => {
  const diagnostic = providerFailureDiagnostic(new Error("YAHOO_STOCK_INSUFFICIENT_HISTORY_24"));
  assert.deepEqual(diagnostic, {
    classification: "INSUFFICIENT_HISTORY",
    required: true,
    countsAsRequiredFailure: false,
    explainedUnsupported: true,
  });
});

test("unsupported symbols are explained while rate limits remain unresolved required failures", () => {
  assert.equal(classifyProviderFailure(Object.assign(new Error("YAHOO_STOCK_HTTP_404"), { status: 404 })), "SYMBOL_UNSUPPORTED");
  assert.equal(classifyProviderFailure(Object.assign(new Error("PUBLIC_HTTP_429"), { status: 429 })), "RATE_LIMITED");
  const summary = summarizeProviderFailureClassifications({
    SYMBOL_UNSUPPORTED: 8,
    INSUFFICIENT_HISTORY: 3,
    RATE_LIMITED: 1,
    FALLBACK_USED: 20,
    OPTIONAL_ENRICHMENT_MISSING: 2,
  });
  assert.deepEqual(summary, {
    explainedUnsupported: 11,
    unresolvedRequiredFailures: 1,
    optionalMissing: 2,
    fallbackUsed: 20,
  });
});

test("transient network errors remain bounded-retry eligible", async () => {
  let attempts = 0;
  const value = await withPublicProviderRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("ECONNRESET");
    return "ok";
  }, { maxAttempts: 3, baseBackoffMs: 1, sleep: async () => {} });
  assert.equal(value, "ok");
  assert.equal(attempts, 3);
});
