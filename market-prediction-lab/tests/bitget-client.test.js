import test from "node:test";
import assert from "node:assert/strict";
import { BitgetPublicApiError, BitgetPublicClient } from "../src/bitget-public-client.js";

function response({ status = 200, payload, headers = {} }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(payload),
  };
}

test("public client returns successful payload without auth headers", async () => {
  let request;
  const client = new BitgetPublicClient({
    fetchImpl: async (url, options) => {
      request = { url: url.toString(), options };
      return response({ payload: { code: "00000", msg: "success", data: [1] } });
    },
    minIntervalMs: 1,
    maxRetries: 0,
  });
  const result = await client.get("/api/test", { symbol: "BTCUSDT", optional: undefined });
  assert.deepEqual(result.data, [1]);
  assert.match(request.url, /symbol=BTCUSDT/);
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers["ACCESS-KEY"], undefined);
});

test("public client retries 429 and succeeds", async () => {
  let calls = 0;
  const sleeps = [];
  const client = new BitgetPublicClient({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return response({ status: 429, payload: { code: "429", msg: "too many" }, headers: { "retry-after": "0" } });
      return response({ payload: { code: "00000", msg: "success", data: [] } });
    },
    minIntervalMs: 1,
    maxRetries: 2,
    sleepImpl: async (ms) => sleeps.push(ms),
    randomImpl: () => 0,
  });
  await client.get("/api/test");
  assert.equal(calls, 2);
  assert.ok(sleeps.length >= 1);
});

test("public client fails closed for non-retryable Bitget code", async () => {
  const client = new BitgetPublicClient({
    fetchImpl: async () => response({ payload: { code: "40017", msg: "invalid symbol", data: null } }),
    minIntervalMs: 1,
    maxRetries: 2,
  });
  await assert.rejects(() => client.get("/api/test"), (error) => {
    assert.ok(error instanceof BitgetPublicApiError);
    assert.equal(error.details.code, "40017");
    return true;
  });
});
