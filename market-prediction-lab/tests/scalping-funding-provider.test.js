import test from "node:test";
import assert from "node:assert/strict";
import {
  assertScalpingFundingIntegrity,
  collectScalpingFundingHistory,
  inspectFundingHistory,
} from "../src/scalping-funding-provider.js";

const H8 = 8 * 60 * 60 * 1000;

function rows(start, count) {
  return Array.from({ length: count }, (_, index) => ({
    fundingTime: String(start + index * H8),
    fundingRate: String((index % 3 - 1) * 0.0001),
  }));
}

function v3Rows(start, count) {
  return Array.from({ length: count }, (_, index) => ({
    symbol: "BTCUSDT",
    fundingRateTimestamp: String(start + index * H8),
    fundingRate: String((index % 3 - 1) * 0.0001),
  }));
}

function pagedV3Client(allRowsDescending) {
  return {
    async get(path, params) {
      assert.equal(path, "/api/v3/market/history-fund-rate");
      assert.equal(params.category, "USDT-FUTURES");
      const page = Number(params.cursor);
      const size = Number(params.limit);
      assert.ok(page >= 1 && page <= 100);
      assert.ok(size >= 1 && size <= 100);
      const slice = allRowsDescending.slice((page - 1) * size, page * size);
      return { code: "00000", data: { resultList: slice } };
    },
  };
}

test("funding diagnostics require real edge coverage and reject duplicates", () => {
  const start = Date.UTC(2025, 0, 1);
  const requestedEnd = start + 10 * H8;
  const ready = inspectFundingHistory({ records: rows(start, 11).reverse(), requestedStart: start, requestedEnd });
  assert.equal(ready.status, "DATA_READY");
  assert.equal(ready.sourceOrder, "descending");
  assert.equal(ready.normalizedOrder, "ascending");
  assert.equal(ready.duplicateCount, 0);
  const duplicate = inspectFundingHistory({ records: [...rows(start, 11).reverse(), rows(start, 1)[0]], requestedStart: start, requestedEnd });
  assert.equal(duplicate.status, "BLOCKED_DATA");
  assert.equal(duplicate.duplicateCount, 1);
  const partial = inspectFundingHistory({ records: rows(start + 4 * H8, 7).reverse(), requestedStart: start, requestedEnd });
  assert.equal(partial.status, "BLOCKED_DATA");
  assert.equal(partial.reachesStart, false);
});

test("collector paginates public funding history without synthetic/private fallback", async () => {
  const start = Date.UTC(2025, 0, 1);
  const all = v3Rows(start, 205).reverse();
  const result = await collectScalpingFundingHistory({
    client: pagedV3Client(all),
    symbol: "BTCUSDT",
    requestedStart: start,
    requestedEnd: start + 204 * H8,
    pageSize: 100,
    maxPages: 5,
    collectionCodeSHA: "a".repeat(40),
  });
  assert.equal(result.status, "DATA_READY");
  assert.equal(result.recordCount, 205);
  assert.equal(result.pageCount, 3);
  assert.equal(result.pagesRequested, 3);
  assert.equal(result.cursorDirection, "increasing_page_number_to_older_history");
  assert.equal(result.sourceOrder, "descending");
  assert.equal(result.normalizedOrder, "ascending");
  assert.equal(result.actualFirstFunding, start);
  assert.equal(result.actualLastFunding, start + 204 * H8);
  assert.equal(result.duplicateCount, 0);
  assert.equal(result.outOfOrderCount, 0);
  assert.equal(result.syntheticDataUsed, false);
  assert.equal(result.interpolationUsed, false);
  assert.equal(result.privateApiUsed, false);
  assert.equal(result.orderSubmitted, false);
  assert.equal(assertScalpingFundingIntegrity(result), true);
});

test("funding cache corruption and provenance mismatches are detected synchronously", async () => {
  const start = Date.UTC(2025, 0, 1);
  const all = v3Rows(start, 3).reverse();
  const artifact = await collectScalpingFundingHistory({
    client: pagedV3Client(all),
    symbol: "BTCUSDT",
    requestedStart: start,
    requestedEnd: start + 2 * H8,
    pageSize: 100,
    maxPages: 2,
    collectionCodeSHA: "b".repeat(40),
  });
  assert.equal(artifact.status, "DATA_READY");
  assert.equal(assertScalpingFundingIntegrity(artifact), true);
  assert.throws(() => assertScalpingFundingIntegrity({ ...artifact, normalizedDigest: "0".repeat(64) }), /SCALPING_FUNDING_CACHE_CORRUPTION/);
  assert.throws(() => assertScalpingFundingIntegrity({ ...artifact, rawDigest: "0".repeat(64) }), /SCALPING_FUNDING_RAW_CACHE_CORRUPTION/);
  assert.throws(() => assertScalpingFundingIntegrity({ ...artifact, providerVersion: "wrong-provider-version" }), /SCALPING_FUNDING_PROVENANCE_MISMATCH/);
});
