import test from "node:test";
import assert from "node:assert/strict";
import {
  KR_FSC_STOCK_PROVIDER,
  US_ALPHA_VANTAGE_ADJUSTED_PROVIDER,
  US_ALPHA_VANTAGE_RAW_PROVIDER,
  buildStockHistoricalDataset,
  buildStockHistoryProviderCapability,
  collectKrFscStockHistory,
  collectUsAlphaVantageHistory,
} from "../src/stock-history-provider.js";

const START = Date.UTC(2026, 0, 2);
const END = Date.UTC(2026, 0, 6);
const GENERATED_AT = Date.UTC(2026, 0, 7);

function okJson(payload) {
  return Promise.resolve({ ok: true, status: 200, json: async () => payload });
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
  assert.equal(krConfigured.credentialPresent, true);
  assert.equal(JSON.stringify(krConfigured).includes("secret-value"), false);
  assert.equal(krConfigured.finalHoldoutReady, false);

  const usRaw = buildStockHistoryProviderCapability({
    market: "US_STOCK",
    env: { ALPHA_VANTAGE_API_KEY: "alpha-key" },
  });
  assert.equal(usRaw.provider, US_ALPHA_VANTAGE_RAW_PROVIDER);
  assert.equal(usRaw.corporateActionAdjustmentAvailable, false);
  assert.equal(usRaw.finalHoldoutReady, false);

  const usAdjusted = buildStockHistoryProviderCapability({
    market: "US_STOCK",
    env: { ALPHA_VANTAGE_API_KEY: "alpha-key", ALPHA_VANTAGE_USE_DAILY_ADJUSTED: "true" },
  });
  assert.equal(usAdjusted.provider, US_ALPHA_VANTAGE_ADJUSTED_PROVIDER);
  assert.equal(usAdjusted.corporateActionAdjustmentAvailable, true);
  assert.equal(usAdjusted.finalHoldoutReady, false);
  assert.equal(JSON.stringify(usAdjusted).includes("alpha-key"), false);
});

test("KR FSC collector uses bounded official range parameters and normalizes OHLCV", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(new URL(url));
    return okJson({
      response: {
        header: { resultCode: "00", resultMsg: "NORMAL SERVICE." },
        body: {
          totalCount: 2,
          pageNo: 1,
          numOfRows: 1000,
          items: {
            item: [
              { basDt: "20260102", srtnCd: "005930", mkp: "70000", hipr: "71000", lopr: "69500", clpr: "70500", trqu: "1000000" },
              { basDt: "20260105", srtnCd: "005930", mkp: "70600", hipr: "72000", lopr: "70400", clpr: "71800", trqu: "1200000" },
            ],
          },
        },
      },
    });
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
  assert.equal(result.candles.length, 2);
  assert.equal(result.candles[0].timestamp, Date.UTC(2026, 0, 2));
  assert.equal(result.candles[0].close, 70500);
  assert.equal(result.candles[1].volume, 1200000);
  assert.equal(result.syntheticDataUsed, false);
  assert.equal(result.privateApiUsed, false);
  assert.equal(result.corporateActions, "unverified");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].hostname, "apis.data.go.kr");
  assert.equal(requests[0].searchParams.get("beginBasDt"), "20260102");
  assert.equal(requests[0].searchParams.get("endBasDt"), "20260107");
  assert.equal(requests[0].searchParams.get("likeSrtnCd"), "005930");
  assert.equal(requests[0].searchParams.get("resultType"), "json");
});

test("KR FSC collector fails on duplicate dates and provider errors", async () => {
  const duplicateFetch = async () => okJson({
    response: {
      header: { resultCode: "00" },
      body: {
        totalCount: 2,
        items: { item: [
          { basDt: "20260102", srtnCd: "005930", mkp: "70000", hipr: "71000", lopr: "69500", clpr: "70500", trqu: "100" },
          { basDt: "20260102", srtnCd: "005930", mkp: "70000", hipr: "71000", lopr: "69500", clpr: "70500", trqu: "100" },
        ] },
      },
    },
  });
  await assert.rejects(() => collectKrFscStockHistory({
    symbol: "005930", requestedStart: START, requestedEnd: END,
    serviceKey: "x", fetchImpl: duplicateFetch, generatedAt: GENERATED_AT,
  }), /KR_FSC_DUPLICATE_CANDLE/);

  const rejectedFetch = async () => okJson({ response: { header: { resultCode: "22" }, body: {} } });
  await assert.rejects(() => collectKrFscStockHistory({
    symbol: "005930", requestedStart: START, requestedEnd: END,
    serviceKey: "x", fetchImpl: rejectedFetch, generatedAt: GENERATED_AT,
  }), /KR_FSC_PROVIDER_ERROR:22/);
});

test("US Alpha Vantage raw daily history remains explicitly unadjusted", async () => {
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
  assert.deepEqual(result.candles.map((row) => row.timestamp), [Date.UTC(2026, 0, 2), Date.UTC(2026, 0, 5)]);
  assert.equal(requests[0].searchParams.get("function"), "TIME_SERIES_DAILY");
  assert.equal(requests[0].searchParams.get("outputsize"), "full");
});

test("US Alpha Vantage adjusted daily applies adjusted-close ratio and split-aware volume", async () => {
  const fetchImpl = async () => okJson({
    "Time Series (Daily)": {
      "2026-01-06": {
        "1. open": "50", "2. high": "52", "3. low": "49", "4. close": "51", "5. adjusted close": "51",
        "6. volume": "4000", "7. dividend amount": "0", "8. split coefficient": "1.0",
      },
      "2026-01-05": {
        "1. open": "100", "2. high": "104", "3. low": "98", "4. close": "102", "5. adjusted close": "51",
        "6. volume": "1000", "7. dividend amount": "0", "8. split coefficient": "2.0",
      },
      "2026-01-02": {
        "1. open": "96", "2. high": "100", "3. low": "94", "4. close": "98", "5. adjusted close": "49",
        "6. volume": "900", "7. dividend amount": "0", "8. split coefficient": "1.0",
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
  assert.equal(result.adjustmentMode, "adjusted_close_ratio_with_split_volume");
  assert.equal(result.candles[0].close, 49);
  assert.equal(result.candles[0].open, 48);
  assert.equal(result.candles[0].volume, 1800);
  assert.equal(result.candles[1].close, 51);
  assert.equal(result.candles[1].volume, 1000);
  assert.equal(result.candles[2].close, 51);
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

test("dataset integration preserves fail-closed stock provenance", async () => {
  const fetchImpl = async () => okJson({
    response: {
      header: { resultCode: "00" },
      body: {
        totalCount: 2,
        items: { item: [
          { basDt: "20260102", srtnCd: "005930", mkp: "70000", hipr: "71000", lopr: "69500", clpr: "70500", trqu: "1000000" },
          { basDt: "20260105", srtnCd: "005930", mkp: "70600", hipr: "72000", lopr: "70400", clpr: "71800", trqu: "1200000" },
        ] },
      },
    },
  });
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
  assert.equal(result.dataset.corporateActions, "unverified");
  assert.equal(result.dataset.survivorshipSafeguard, "unverified");
  assert.equal(result.capability.finalHoldoutReady, false);
  assert.equal(result.collection.syntheticDataUsed, false);
});
