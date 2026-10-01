import assert from "node:assert/strict";
import test from "node:test";

import { collectBitgetFundingCostOnlyHistory } from "../src/bitget-funding-cost-owner-v1.js";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const FUNDING = T0 + 8 * 60 * MINUTE;

function markRow(timestamp, mark = 100) {
  return [String(timestamp), String(mark), String(mark), String(mark), String(mark), "0", "0"];
}
function fundingHistory(rate = 0.001) {
  return async () => ({
    exhausted: true,
    records: [{ timestamp: FUNDING, rate, rateRaw: String(rate) }],
  });
}
function markClient(mark = 100) {
  return {
    async get(path) {
      assert.match(path, /history-mark-candles$/);
      return { code: "00000", data: [markRow(FUNDING, mark)] };
    },
  };
}

test("no funding events require no mark lookup and produce exact zero cost", async () => {
  let calls = 0;
  const result = await collectBitgetFundingCostOnlyHistory({
    client: { async get() { calls += 1; throw new Error("SHOULD_NOT_CALL"); } },
    symbol: "ALTUSDT",
    direction: "SHORT",
    quantity: 2,
    startTime: T0,
    endTime: T0 + 60 * MINUTE,
    collectFundingHistory: async () => ({ exhausted: true, records: [] }),
    now: () => T0 + 61 * MINUTE,
  });
  assert.equal(result.status, "PRESENT");
  assert.equal(result.totalFundingCost, 0);
  assert.equal(result.excludedFundingCredit, 0);
  assert.equal(calls, 0);
});

test("positive funding charges LONG using exact funding-minute mark price", async () => {
  const result = await collectBitgetFundingCostOnlyHistory({
    client: markClient(100),
    symbol: "ALTUSDT",
    direction: "LONG",
    quantity: 2,
    startTime: T0,
    endTime: FUNDING + MINUTE,
    collectFundingHistory: fundingHistory(0.001),
    now: () => FUNDING + 2 * MINUTE,
  });
  assert.equal(result.status, "PRESENT");
  assert.ok(Math.abs(result.totalFundingCost - 0.2) < 1e-12);
  assert.equal(result.payments[0].markPrice, 100);
  assert.equal(result.payments[0].payer, true);
  assert.equal(result.excludedFundingCredit, 0);
});

test("negative funding charges SHORT and positive funding receipt is excluded from profit", async () => {
  const shortPays = await collectBitgetFundingCostOnlyHistory({
    client: markClient(100),
    symbol: "ALTUSDT",
    direction: "SHORT",
    quantity: 2,
    startTime: T0,
    endTime: FUNDING + MINUTE,
    collectFundingHistory: fundingHistory(-0.001),
    now: () => FUNDING + 2 * MINUTE,
  });
  assert.ok(Math.abs(shortPays.totalFundingCost - 0.2) < 1e-12);
  assert.equal(shortPays.payments[0].payer, true);

  const shortReceives = await collectBitgetFundingCostOnlyHistory({
    client: markClient(100),
    symbol: "ALTUSDT",
    direction: "SHORT",
    quantity: 2,
    startTime: T0,
    endTime: FUNDING + MINUTE,
    collectFundingHistory: fundingHistory(0.001),
    now: () => FUNDING + 2 * MINUTE,
  });
  assert.equal(shortReceives.totalFundingCost, 0);
  assert.ok(Math.abs(shortReceives.excludedFundingCredit - 0.2) < 1e-12);
  assert.equal(shortReceives.payments[0].amount, 0);
  assert.equal(shortReceives.payments[0].payer, false);
  assert.equal(shortReceives.costOnlyPolicy, "PAYMENTS_COUNT_AS_COST; RECEIPTS_EXCLUDED_FROM_PROFIT");
});

test("missing exact funding-minute mark evidence fails closed", async () => {
  const result = await collectBitgetFundingCostOnlyHistory({
    client: {
      async get() {
        return { code: "00000", data: [markRow(FUNDING - MINUTE, 100)] };
      },
    },
    symbol: "ALTUSDT",
    direction: "SHORT",
    quantity: 2,
    startTime: T0,
    endTime: FUNDING + MINUTE,
    collectFundingHistory: fundingHistory(-0.001),
    now: () => FUNDING + 2 * MINUTE,
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("FUNDING_MARK_PRICE_EVIDENCE_MISSING"));
  assert.equal(result.unknownIsZero, false);
});


test("funding evidence collection time is recorded only after exact mark evidence is fetched", async () => {
  let markFetched = false;
  let clockCalls = 0;
  const result = await collectBitgetFundingCostOnlyHistory({
    client: {
      async get(path) {
        assert.match(path, /history-mark-candles$/);
        markFetched = true;
        return { code: "00000", data: [markRow(FUNDING, 100)] };
      },
    },
    symbol: "ALTUSDT",
    direction: "LONG",
    quantity: 2,
    startTime: T0,
    endTime: FUNDING + MINUTE,
    collectFundingHistory: fundingHistory(0.001),
    now: () => {
      clockCalls += 1;
      assert.equal(markFetched, true, "completion clock must be sampled after mark evidence");
      return FUNDING + 2 * MINUTE;
    },
  });
  assert.equal(result.status, "PRESENT");
  assert.equal(result.collectedAtMs, FUNDING + 2 * MINUTE);
  assert.equal(clockCalls, 1);
});
