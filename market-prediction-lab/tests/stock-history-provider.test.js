import test from "node:test";
import assert from "node:assert/strict";
import {
  KR_FSC_STOCK_PROVIDER,
  US_ALPHA_VANTAGE_ADJUSTED_PROVIDER,
  US_ALPHA_VANTAGE_RAW_PROVIDER,
  buildStockAutomatedResearchProviderCapability,
  buildStockHistoricalDataset,
  buildStockHistoryProviderCapability,
  collectKrFscStockHistory,
  collectUsAlphaVantageHistory,
  prepareStockAutomatedResearchHistory,
} from "../src/stock-history-provider.js";

const START = Date.UTC(2026, 0, 2);
const END = Date.UTC(2026, 0, 6);
const GENERATED_AT = Date.UTC(2026, 0, 7);
const SHA = "1234567890abcdef1234567890abcdef12345678";

function okJson(payload) {
  return Promise.resolve({ ok: true, status: 200, json: async () => payload });
}

function krPayload(items) {
  return {
    response: {
      header: { resultCode: "00", resultMsg: "NORMAL SERVICE." },
      body: { totalCount: items.length, pageNo: 1, numOfRows: 1000, items: { item: items } },
    },
  };
}

test("provider capability is fail-closed and never exposes credentials", () => {
  const krBlocked = buildStockHistoryProviderCapability({ market: "KR_STOCK", env: {} });
  assert.equal(krBlocked.status, "blocked_provider");
  assert.equal(krBlocked.provider, KR_FSC_STOCK_PROVIDER);
  assert.equal(krBlocked.credentialPresent, false);
  assert.equal(krBlocked.credentialValueExposed, false);
  assert.equal(krBlocked.finalHoldoutReady, false);

  const krConfigured = buildStockHistoryProviderCapability({
    market: "KR_STOCK",
    env: { KR_FSC_OPEN_DATA_SERVICE_KEY: "secret-value" },
  });
  assert.equal(krConfigured.status, "configured");
  assert.equal(krConfigured.selectionReady, true);
  assert.equal(krConfigured.corporateActions, "unverified");
  assert.equal(JSON.stringify(krConfigured).includes("secret-value"), false);
  assert.equal(krConfigured.finalHoldoutReady, false);

  const usRaw = buildStockHistoryProviderCapability({
    market: "US_STOCK",
    env: { ALPHA_VANTAGE_API_KEY: "alpha-key" },
  });
  assert.equal(usRaw.provider, US_ALPHA_VANTAGE_RAW_PROVIDER);
  assert.equal(usRaw.corporateActionAdjustmentAvailable, false);
  assert.equal(usRaw.corporateActions, "unverified");
  assert.equal(usRaw.finalHoldoutReady, false);

  const usAdjusted = buildStockHistoryProviderCapability({
    market: "US_STOCK",
    env: { ALPHA_VANTAGE_API_KEY: "alpha-key", ALPHA_VANTAGE_USE_DAILY_ADJUSTED: "true" },
  });
  assert.equal(usAdjusted.provider, US_ALPHA_VANTAGE_ADJUSTED_PROVIDER);
  assert.equal(usAdjusted.corporateActionAdjustmentAvailable, true);
  assert.equal(usAdjusted.corporateActions, "verified_provider_events");
  assert.equal(usAdjusted.survivorshipSafeguard, "unverified");
  assert.equal(usAdjusted.finalHoldoutReady, false);
  assert.equal(JSON.stringify(usAdjusted).includes("alpha-key"), false);
});

test("automated research provider capability connects configured stock providers without weakening final holdout gate", () => {
  const kr = buildStockAutomatedResearchProviderCapability({
    market: "KR_STOCK",
    env: { KR_FSC_OPEN_DATA_SERVICE_KEY: "secret-kr" },
  });
  assert.equal(kr.publicHistoricalOhlcv, true);
  assert.equal(kr.selectionReady, true);
  assert.equal(kr.finalHoldoutReady, false);
  assert.equal(kr.corporateActions, "unverified");
  assert.equal(kr.fakeHistoricalDataAllowed, false);

  const raw = buildStockAutomatedResearchProviderCapability({
    market: "US_STOCK",
    env: { ALPHA_VANTAGE_API_KEY: "secret-us" },
  });
  assert.equal(raw.publicHistoricalOhlcv, true);
  assert.equal(raw.corporateActions, "unverified");
  assert.equal(raw.finalHoldoutReady, false);

  const adjusted = buildStockAutomatedResearchProviderCapability({
    market: "US_STOCK",
    env: { ALPHA_VANTAGE_API_KEY: "secret-us", ALPHA_VANTAGE_USE_DAILY_ADJUSTED: "true" },
  });
  assert.equal(adjusted.corporateActions, "verified_provider_events");
  assert.equal(adjusted.survivorshipSafeguard, "unverified");
  assert.equal(adjusted.finalHoldoutReady, false);
  assert.equal(JSON.stringify({ kr, raw, adjusted }).includes("secret-"), false);
});

test("KR FSC collector uses bounded official range parameters and records sanitized provenance", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(new URL(url));
    return okJson(krPayload([
      { basDt: "20260102", srtnCd: "005930", mkp: "70000", hipr: "71000", lopr: "69500", clpr: "70500", trqu: "1000000" },
      { basDt: "20260105", srtnCd: "005930", mkp: "70600", hipr: "72000", lopr: "70400", clpr: "71800", trqu: "1200000" },
    ]));
  };

  const result = await collectKrFscStockHistory({
    symbol: "005930",
    requestedStart: START,
    requestedEnd: END,
    serviceKey: "test-service-key",
    fetchImpl,
    generatedAt: GENERATED_AT,
  });

  assert.equal(result.provider, KR_FSC_STOCK_PROVIDER);
  assert.equal(result.market, "KR_STOCK");
  assert.equal(result.source, "FSC/KRX getStockPriceInfo");
  assert.equal(result.candles.length, 2);
  assert.equal(result.candles[0].timestamp, Date.UTC(2026, 0, 2));
  assert.equal(result.candles[0].close, 70500);
  assert.equal(result.candles[1].volume, 1200000);
  assert.ok(result.candles.every((candle) => candle.isClosed === true));
  assert.equal(result.syntheticDataUsed, false);
  assert.equal(result.privateApiUsed, false);
  assert.equal(result.corporateActions, "unverified");
  assert.equal(result.provenance.closedCandlesOnly, true);
  assert.equal(result.provenance.credentialValueExposed, false);
  assert.equal(JSON.stringify(result).includes("test-service-key"), false);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].hostname, "apis.data.go.kr");
  assert.equal(requests[0].searchParams.get("beginBasDt"), "20260102");
  assert.equal(requests[0].searchParams.get("endBasDt"), "20260107");
  assert.equal(requests[0].searchParams.get("likeSrtnCd"), "005930");
  assert.equal(requests[0].searchParams.get("resultType"), "json");
});

test("KR FSC collector fails closed on duplicate, mixed out-of-order and invalid OHLC", async () => {
  const duplicateFetch = async () => okJson(krPayload([
    { basDt: "20260102", srtnCd: "005930", mkp: "70000", hipr: "71000", lopr: "69500", clpr: "70500", trqu: "100" },
    { basDt: "20260102", srtnCd: "005930", mkp: "70000", hipr: "71000", lopr: "69500", clpr: "70500", trqu: "100" },
  ]));
  await assert.rejects(() => collectKrFscStockHistory({
    symbol: "005930", requestedStart: START, requestedEnd: END,
    serviceKey: "x", fetchImpl: duplicateFetch, generatedAt: GENERATED_AT,
  }), /KR_FSC_DUPLICATE_CANDLE/);

  const outOfOrderFetch = async () => okJson(krPayload([
    { basDt: "20260102", srtnCd: "005930", mkp: "70000", hipr: "71000", lopr: "69500", clpr: "70500", trqu: "100" },
    { basDt: "20260105", srtnCd: "005930", mkp: "70600", hipr: "72000", lopr: "70400", clpr: "71800", trqu: "100" },
    { basDt: "20260103", srtnCd: "005930", mkp: "70500", hipr: "71500", lopr: "70000", clpr: "71000", trqu: "100" },
  ]));
  await assert.rejects(() => collectKrFscStockHistory({
    symbol: "005930", requestedStart: START, requestedEnd: END,
    serviceKey: "x", fetchImpl: outOfOrderFetch, generatedAt: GENERATED_AT,
  }), /KR_FSC_OUT_OF_ORDER_CANDLE/);

  const invalidFetch = async () => okJson(krPayload([
    { basDt: "20260102", srtnCd: "005930", mkp: "70000", hipr: "69000", lopr: "69500", clpr: "70500", trqu: "100" },
  ]));
  await assert.rejects(() => collectKrFscStockHistory({
    symbol: "005930", requestedStart: START, requestedEnd: END,
    serviceKey: "x", fetchImpl: invalidFetch, generatedAt: GENERATED_AT,
  }), /KR_FSC_INVALID_OHLC/);
});

test("KR FSC collector removes out-of-range and not-yet-closed daily candles", async () => {
  const generatedAt = Date.UTC(2026, 0, 6, 12);
  const fetchImpl = async () => okJson(krPayload([
    { basDt: "20260101", srtnCd: "005930", mkp: "69000", hipr: "70000", lopr: "68500", clpr: "69500", trqu: "90" },
    { basDt: "20260102", srtnCd: "005930", mkp: "70000", hipr: "71000", lopr: "69500", clpr: "70500", trqu: "100" },
    { basDt: "20260105", srtnCd: "005930", mkp: "70600", hipr: "72000", lopr: "70400", clpr: "71800", trqu: "110" },
    { basDt: "20260106", srtnCd: "005930", mkp: "71800", hipr: "72500", lopr: "71000", clpr: "72000", trqu: "120" },
  ]));
  const result = await collectKrFscStockHistory({
    symbol: "005930", requestedStart: START, requestedEnd: END,
    serviceKey: "x", fetchImpl, generatedAt,
  });
  assert.deepEqual(result.candles.map((candle) => candle.timestamp), [Date.UTC(2026, 0, 2), Date.UTC(2026, 0, 5)]);
  assert.equal(result.provenance.outOfRangeCandleCountDropped, 1);
  assert.equal(result.provenance.openCandleCountDropped, 1);
});

test("KR FSC provider errors are sanitized", async () => {
  const rejectedFetch = async () => okJson({ response: { header: { resultCode: "22" }, body: {} } });
  await assert.rejects(() => collectKrFscStockHistory({
    symbol: "005930", requestedStart: START, requestedEnd: END,
    serviceKey: "secret-value", fetchImpl: rejectedFetch, generatedAt: GENERATED_AT,
  }), (error) => {
    assert.equal(error.message, "KR_FSC_PROVIDER_ERROR:22");
    assert.equal(error.message.includes("secret-value"), false);
    return true;
  });
});

test("US Alpha Vantage raw daily history remains explicitly unadjusted and accepts provider descending order", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(new URL(url));
    return okJson({
      "Time Series (Daily)": {
        "2026-01-05": { "1. open": "200", "2. high": "205", "3. low": "198", "4. close": "203", "5. volume": "2000" },
        "2026-01-02": { "1. open": "100", "2. high": "105", "3. low": "98", "4. close": "103", "5. volume": "1000" },
      },
    });
  };

  const result = await collectUsAlphaVantageHistory({
    symbol: "AAPL",
    requestedStart: START,
    requestedEnd: END,
    apiKey: "test-key",
    fetchImpl,
    generatedAt: GENERATED_AT,
  });
  assert.equal(result.provider, US_ALPHA_VANTAGE_RAW_PROVIDER);
  assert.equal(result.adjustmentMode, "none");
  assert.equal(result.corporateActions, "unverified");
  assert.equal(result.survivorshipSafeguard, "unverified");
  assert.deepEqual(result.candles.map((row) => row.timestamp), [Date.UTC(2026, 0, 2), Date.UTC(2026, 0, 5)]);
  assert.equal(requests[0].searchParams.get("function"), "TIME_SERIES_DAILY");
  assert.equal(requests[0].searchParams.get("outputsize"), "full");
  assert.equal(JSON.stringify(result).includes("test-key"), false);
});

test("US Alpha Vantage adjusted daily reads 6. volume and applies adjusted-close ratio with split-aware volume", async () => {
  const fetchImpl = async () => okJson({
    "Time Series (Daily)": {
      "2026-01-06": {
        "1. open": "50", "2. high": "52", "3. low": "49", "4. close": "51", "5. adjusted close": "51",
        "5. volume": "999999", "6. volume": "4000", "7. dividend amount": "0", "8. split coefficient": "1.0",
      },
      "2026-01-05": {
        "1. open": "100", "2. high": "104", "3. low": "98", "4. close": "102", "5. adjusted close": "51",
        "5. volume": "999999", "6. volume": "1000", "7. dividend amount": "0", "8. split coefficient": "2.0",
      },
      "2026-01-02": {
        "1. open": "96", "2. high": "100", "3. low": "94", "4. close": "98", "5. adjusted close": "49",
        "5. volume": "999999", "6. volume": "900", "7. dividend amount": "0", "8. split coefficient": "1.0",
      },
    },
  });

  const result = await collectUsAlphaVantageHistory({
    symbol: "AAPL",
    requestedStart: START,
    requestedEnd: END,
    apiKey: "test-key",
    adjusted: true,
    fetchImpl,
    generatedAt: GENERATED_AT,
  });
  assert.equal(result.provider, US_ALPHA_VANTAGE_ADJUSTED_PROVIDER);
  assert.equal(result.corporateActions, "verified_provider_events");
  assert.equal(result.survivorshipSafeguard, "unverified");
  assert.equal(result.adjustmentMode, "adjusted_close_ratio_with_split_volume");
  assert.equal(result.candles[0].close, 49);
  assert.equal(result.candles[0].open, 48);
  assert.equal(result.candles[0].volume, 1800);
  assert.equal(result.candles[1].close, 51);
  assert.equal(result.candles[1].volume, 1000);
  assert.equal(result.candles[2].volume, 4000);
  assert.notEqual(result.candles[2].volume, 999999);
});

test("US Alpha Vantage fails closed on mixed out-of-order and invalid OHLC", async () => {
  const outOfOrderFetch = async () => okJson({
    "Time Series (Daily)": {
      "2026-01-02": { "1. open": "100", "2. high": "105", "3. low": "98", "4. close": "103", "5. volume": "1000" },
      "2026-01-05": { "1. open": "200", "2. high": "205", "3. low": "198", "4. close": "203", "5. volume": "2000" },
      "2026-01-03": { "1. open": "110", "2. high": "115", "3. low": "108", "4. close": "112", "5. volume": "1500" },
    },
  });
  await assert.rejects(() => collectUsAlphaVantageHistory({
    symbol: "AAPL", requestedStart: START, requestedEnd: END,
    apiKey: "x", fetchImpl: outOfOrderFetch, generatedAt: GENERATED_AT,
  }), /US_ALPHA_OUT_OF_ORDER_CANDLE/);

  const invalidFetch = async () => okJson({
    "Time Series (Daily)": {
      "2026-01-02": { "1. open": "100", "2. high": "99", "3. low": "98", "4. close": "103", "5. volume": "1000" },
    },
  });
  await assert.rejects(() => collectUsAlphaVantageHistory({
    symbol: "AAPL", requestedStart: START, requestedEnd: END,
    apiKey: "x", fetchImpl: invalidFetch, generatedAt: GENERATED_AT,
  }), /US_ALPHA_INVALID_OHLC/);
});

test("US Alpha Vantage removes out-of-range and not-yet-closed daily candles", async () => {
  const generatedAt = Date.UTC(2026, 0, 6, 12);
  const fetchImpl = async () => okJson({
    "Time Series (Daily)": {
      "2026-01-06": { "1. open": "210", "2. high": "215", "3. low": "208", "4. close": "212", "5. volume": "2200" },
      "2026-01-05": { "1. open": "200", "2. high": "205", "3. low": "198", "4. close": "203", "5. volume": "2000" },
      "2026-01-02": { "1. open": "100", "2. high": "105", "3. low": "98", "4. close": "103", "5. volume": "1000" },
      "2026-01-01": { "1. open": "90", "2. high": "95", "3. low": "88", "4. close": "93", "5. volume": "900" },
    },
  });
  const result = await collectUsAlphaVantageHistory({
    symbol: "AAPL", requestedStart: START, requestedEnd: END,
    apiKey: "x", fetchImpl, generatedAt,
  });
  assert.deepEqual(result.candles.map((row) => row.timestamp), [Date.UTC(2026, 0, 2), Date.UTC(2026, 0, 5)]);
  assert.equal(result.provenance.outOfRangeCandleCountDropped, 1);
  assert.equal(result.provenance.openCandleCountDropped, 1);
});

test("US Alpha Vantage provider rejection is sanitized", async () => {
  const fetchImpl = async () => okJson({ Note: "rate limited and key text should not be surfaced" });
  await assert.rejects(() => collectUsAlphaVantageHistory({
    symbol: "AAPL", requestedStart: START, requestedEnd: END,
    apiKey: "super-secret", fetchImpl, generatedAt: GENERATED_AT,
  }), (error) => {
    assert.equal(error.message, "US_ALPHA_VANTAGE_PROVIDER_REJECTED");
    assert.equal(error.message.includes("super-secret"), false);
    return true;
  });
});

test("dataset integration preserves stock provenance and final holdout blocks", async () => {
  const fetchImpl = async () => okJson(krPayload([
    { basDt: "20260102", srtnCd: "005930", mkp: "70000", hipr: "71000", lopr: "69500", clpr: "70500", trqu: "1000000" },
    { basDt: "20260105", srtnCd: "005930", mkp: "70600", hipr: "72000", lopr: "70400", clpr: "71800", trqu: "1200000" },
  ]));
  const result = await buildStockHistoricalDataset({
    market: "KR_STOCK",
    symbol: "005930",
    requestedStart: START,
    requestedEnd: END,
    generatedAt: GENERATED_AT,
    env: { KR_FSC_OPEN_DATA_SERVICE_KEY: "service-key" },
    fetchImpl,
  });
  assert.equal(result.dataset.market, "KR_STOCK");
  assert.equal(result.dataset.provider, KR_FSC_STOCK_PROVIDER);
  assert.equal(result.dataset.source, "FSC/KRX getStockPriceInfo");
  assert.equal(result.dataset.corporateActions, "unverified");
  assert.equal(result.dataset.survivorshipSafeguard, "unverified");
  assert.equal(result.capability.finalHoldoutReady, false);
  assert.equal(result.collection.syntheticDataUsed, false);
  assert.equal(JSON.stringify(result).includes("service-key"), false);
});

test("unconfigured stock research history returns blocked_provider without any external request", async () => {
  let fetchCount = 0;
  const result = await prepareStockAutomatedResearchHistory({
    market: "US_STOCK",
    symbol: "AAPL",
    requestedStart: START,
    requestedEnd: END,
    researchCodeSha: SHA,
    generatedAt: GENERATED_AT,
    env: {},
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error("must not be called");
    },
  });
  assert.equal(result.status, "blocked_provider");
  assert.equal(result.finalHoldoutReady, false);
  assert.equal(result.dataset, null);
  assert.equal(result.cacheProvenance, null);
  assert.equal(fetchCount, 0);
  assert.equal(result.liveOrderAllowed, false);
  assert.equal(result.privateAccountRequestAllowed, false);
  assert.equal(result.orderSubmitted, false);
});

test("configured stock research history binds isolated cache provenance to dataset digest and research code SHA", async () => {
  const fetchImpl = async () => okJson({
    "Time Series (Daily)": {
      "2026-01-05": { "1. open": "200", "2. high": "205", "3. low": "198", "4. close": "203", "5. volume": "2000" },
      "2026-01-02": { "1. open": "100", "2. high": "105", "3. low": "98", "4. close": "103", "5. volume": "1000" },
    },
  });
  const result = await prepareStockAutomatedResearchHistory({
    market: "US_STOCK",
    symbol: "AAPL",
    requestedStart: START,
    requestedEnd: END,
    researchCodeSha: SHA,
    generatedAt: GENERATED_AT,
    env: { ALPHA_VANTAGE_API_KEY: "do-not-persist" },
    fetchImpl,
  });
  assert.equal(result.status, "ready_for_research");
  assert.equal(result.finalHoldoutReady, false);
  assert.equal(result.cacheProvenance.identity.market, "US_STOCK");
  assert.equal(result.cacheProvenance.identity.symbol, "AAPL");
  assert.equal(result.cacheProvenance.identity.timeframe, "1d");
  assert.equal(result.cacheProvenance.identity.provider, US_ALPHA_VANTAGE_RAW_PROVIDER);
  assert.equal(result.cacheProvenance.identity.providerVersion, "TIME_SERIES_DAILY");
  assert.equal(result.cacheProvenance.identity.adjustmentMode, "none");
  assert.equal(result.cacheProvenance.identity.datasetDigest, result.dataset.datasetDigest);
  assert.equal(result.cacheProvenance.identity.researchCodeSha, SHA);
  assert.ok(result.cacheProvenance.cacheNamespace.startsWith("historical:"));
  assert.equal(JSON.stringify(result).includes("do-not-persist"), false);
});
