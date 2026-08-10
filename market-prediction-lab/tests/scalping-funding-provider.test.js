import test from "node:test";
import assert from "node:assert/strict";
import {
  assertScalpingFundingIntegrity,
  collectScalpingFundingHistory,
  inspectFundingHistory,
  scalpingFundingDigest,
} from "../src/scalping-funding-provider.js";

const H8 = 8 * 60 * 60 * 1000;

function rows(start, count) {
  return Array.from({ length: count }, (_, index) => ({
    fundingTime: String(start + index * H8),
    fundingRate: String((index % 3 - 1) * 0.0001),
  }));
}

test("funding diagnostics require real edge coverage and reject duplicates", () => {
  const start = Date.UTC(2025, 0, 1);
  const requestedEnd = start + 10 * H8;
  const ready = inspectFundingHistory({ records: rows(start, 11), requestedStart: start, requestedEnd });
  assert.equal(ready.status, "DATA_READY");
  assert.equal(ready.duplicateCount, 0);
  const duplicate = inspectFundingHistory({ records: [...rows(start, 11), rows(start, 1)[0]], requestedStart: start, requestedEnd });
  assert.equal(duplicate.status, "BLOCKED_DATA");
  assert.equal(duplicate.duplicateCount, 1);
  const partial = inspectFundingHistory({ records: rows(start + 4 * H8, 7), requestedStart: start, requestedEnd });
  assert.equal(partial.status, "BLOCKED_DATA");
  assert.equal(partial.reachesStart, false);
});

test("collector paginates public funding history without synthetic/private fallback", async () => {
  const start = Date.UTC(2025, 0, 1);
  const all = rows(start, 205).reverse();
  const client = {
    async get(_path, params) {
      const page = Number(params.pageNo);
      const size = Number(params.pageSize);
      const slice = all.slice((page - 1) * size, page * size);
      return { code: "00000", data: slice };
    },
  };
  const result = await collectScalpingFundingHistory({
    client,
    symbol: "BTCUSDT",
    requestedStart: start,
    requestedEnd: start + 204 * H8,
    pageSize: 100,
    maxPages: 5,
    collectionCodeSHA: "a".repeat(40),
  });
  assert.equal(result.status, "DATA_READY");
  assert.equal(result.recordCount, 205);
  assert.equal(result.syntheticDataUsed, false);
  assert.equal(result.privateApiUsed, false);
  assert.equal(result.orderSubmitted, false);
  assert.equal(assertScalpingFundingIntegrity(result), true);
});

test("funding cache corruption is detected", () => {
  const start = Date.UTC(2025, 0, 1);
  const normalized = rows(start, 3).map((row) => ({ timestamp: Number(row.fundingTime), rate: Number(row.fundingRate) }));
  const artifact = {
    status: "DATA_READY",
    symbol: "ETHUSDT",
    productType: "usdt-futures",
    records: normalized,
    normalizedDigest: scalpingFundingDigest({ symbol: "ETHUSDT", productType: "usdt-futures", records: normalized }),
    syntheticDataUsed: false,
    privateApiUsed: false,
    orderSubmitted: false,
  };
  assert.equal(assertScalpingFundingIntegrity(artifact), true);
  assert.throws(() => assertScalpingFundingIntegrity({ ...artifact, normalizedDigest: "0".repeat(64) }), /SCALPING_FUNDING_CACHE_CORRUPTION/);
});
