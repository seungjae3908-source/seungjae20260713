import test from "node:test";
import assert from "node:assert/strict";
import { createRetryingPublicFetch } from "../src/retrying-public-fetch.js";

const VISION_URL = "https://data.binance.vision/data/futures/um/monthly/klines/ETHUSDT/1d/example.zip";

test("Binance Vision transient network failure retries and succeeds without changing the response", async () => {
  let calls = 0;
  const delays = [];
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    return new Response("ok", { status: 200 });
  };
  const retryingFetch = createRetryingPublicFetch({
    fetchImpl,
    baseDelayMs: 10,
    sleepImpl: async (delay) => { delays.push(delay); },
  });

  const response = await retryingFetch(VISION_URL);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  assert.equal(calls, 2);
  assert.deepEqual(delays, [10]);
});

test("Binance Vision retryable HTTP failures are bounded", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("unavailable", { status: 503 });
  };
  const retryingFetch = createRetryingPublicFetch({
    fetchImpl,
    maxAttempts: 3,
    baseDelayMs: 0,
    sleepImpl: async () => {},
  });

  const response = await retryingFetch(VISION_URL);
  assert.equal(response.status, 503);
  assert.equal(calls, 3);
});

test("non-retryable Binance Vision HTTP failures fail closed immediately", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("missing", { status: 404 });
  };
  const retryingFetch = createRetryingPublicFetch({ fetchImpl, sleepImpl: async () => {} });

  const response = await retryingFetch(VISION_URL);
  assert.equal(response.status, 404);
  assert.equal(calls, 1);
});

test("retry wrapper does not alter non-Binance providers", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("busy", { status: 503 });
  };
  const retryingFetch = createRetryingPublicFetch({ fetchImpl, sleepImpl: async () => {} });

  const response = await retryingFetch("https://api.bitget.com/api/v2/spot/market/candles");
  assert.equal(response.status, 503);
  assert.equal(calls, 1);
});
