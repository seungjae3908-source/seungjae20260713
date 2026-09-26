import assert from "node:assert/strict";
import test from "node:test";
import {
  PAPER_KRW_USDT_SIZING_CONTRACT,
  loadUpbitPublicKrwPerUsdt,
  sizeOnePercentRiskKrwFuturesPosition,
} from "../src/paper-krw-usdt-sizing-v1.js";

const NOW = Date.UTC(2026, 7, 19, 8, 0, 0);

test("Upbit public BTC cross derives KRW per USDT without private credentials", async () => {
  let requestedUrl = null;
  const result = await loadUpbitPublicKrwPerUsdt({
    nowMs: NOW,
    fetchImpl: async (url, options) => {
      requestedUrl = String(url);
      assert.equal(options.headers.accept, "application/json");
      assert.equal(options.headers.authorization, undefined);
      return {
        ok: true,
        async json() {
          return [
            { market: "KRW-BTC", trade_price: 135_000_000, trade_timestamp: NOW - 2_000 },
            { market: "USDT-BTC", trade_price: 100_000, trade_timestamp: NOW - 3_000 },
          ];
        },
      };
    },
  });
  assert.match(requestedUrl, /\/v1\/ticker\?markets=/);
  assert.equal(result.krwPerUsdt, 1350);
  assert.equal(result.asOfMs, NOW - 3_000);
  assert.equal(result.publicOnly, true);
  assert.equal(result.privateRequestCount, 0);
  assert.equal(result.source, PAPER_KRW_USDT_SIZING_CONTRACT.fxSource);
});

test("stale or missing public FX fails closed", async () => {
  await assert.rejects(() => loadUpbitPublicKrwPerUsdt({
    nowMs: NOW,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return [
          { market: "KRW-BTC", trade_price: 135_000_000, trade_timestamp: NOW - 16 * 60 * 1000 },
          { market: "USDT-BTC", trade_price: 100_000, trade_timestamp: NOW - 1_000 },
        ];
      },
    }),
  }), /STALE_EVIDENCE_FORBIDDEN/);

  await assert.rejects(() => loadUpbitPublicKrwPerUsdt({
    nowMs: NOW,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return [{ market: "KRW-BTC", trade_price: 135_000_000, trade_timestamp: NOW - 1_000 }];
      },
    }),
  }), /USDT_BTC_MISSING/);
});

test("one-percent KRW risk sizing is bounded by both stop risk and one-times capital", () => {
  const sized = sizeOnePercentRiskKrwFuturesPosition({
    entryPrice: 4000,
    stopPrice: 3900,
    krwPerUsdt: 1350,
    qtyStep: 0.01,
    minQty: 0.01,
    minNotionalUsdt: 5,
    maxMarketQty: 10,
  });
  assert.equal(sized.quantity, 0.07);
  assert.equal(sized.riskBudgetKrw, 10_000);
  assert.equal(sized.stopRiskKrw, 9_450);
  assert.equal(sized.entryNotionalKrw, 378_000);
  assert.ok(sized.stopRiskKrw <= sized.riskBudgetKrw);
  assert.ok(sized.entryNotionalKrw <= sized.initialCapitalKrw);
  assert.equal(sized.leverage, 1);
});

test("very tight stop cannot exceed the one-times KRW capital bound", () => {
  const sized = sizeOnePercentRiskKrwFuturesPosition({
    entryPrice: 4000,
    stopPrice: 3999,
    krwPerUsdt: 1350,
    qtyStep: 0.01,
    minQty: 0.01,
    minNotionalUsdt: 5,
    maxMarketQty: 10,
  });
  assert.ok(sized.entryNotionalKrw <= 1_000_000);
  assert.ok(sized.stopRiskKrw <= 10_000);
});

test("minimum quantity is never rounded up beyond the risk contract", () => {
  assert.throws(() => sizeOnePercentRiskKrwFuturesPosition({
    entryPrice: 4000,
    stopPrice: 3000,
    krwPerUsdt: 1350,
    qtyStep: 0.01,
    minQty: 0.02,
    minNotionalUsdt: 5,
    maxMarketQty: 10,
  }), /BELOW_MIN_QTY/);
});
