import assert from "node:assert/strict";
import test from "node:test";
import { loadBitgetEthV6PaperSettlement } from "../src/eth-v6-paper-settlement-source-v1.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ENTRY = Date.UTC(2026, 7, 19, 1, 0, 0);
const EXIT = Date.UTC(2026, 7, 21, 0, 0, 0);
const NOW = EXIT + DAY_MS + 60_000;
const SHA = "a".repeat(40);

function position() {
  return {
    positionId: "paper-position-1",
    signalId: "ETH-V6-signal-1",
    market: "CRYPTO_FUTURES",
    direction: "LONG",
    strategyId: "v6_independent_breakout_retest",
    researchCodeSha: SHA,
    lifecycleState: "OPEN",
    sample: {
      identity: { researchCodeSha: SHA, evaluatedAtMs: ENTRY },
      fill: { notional: 280, filledQuantity: 0.07 },
      orderSubmitted: false,
      exchangeRequestSent: false,
      liveOrderAllowed: false,
    },
  };
}

function settledRecord(reason = "take_profit") {
  return {
    status: "settled",
    signalId: "ETH-V6-signal-1",
    strategy: "v6_independent_breakout_retest",
    asset: "ETHUSDT",
    market: "CRYPTO_FUTURES",
    entryPlan: { action: "LONG", source: "bitget-public-forward-paper" },
    stop: 3900,
    targets: [4200],
    orderSubmitted: false,
    privateAccountRequested: false,
    subsequentMarketResult: {
      exitReason: reason,
      exitPrice: 999999,
      exitTimestamp: EXIT,
    },
  };
}

function fakeClient() {
  return {
    async get(path) {
      if (path.endsWith("/contracts")) return { data: [{
        symbol: "ETHUSDT", symbolStatus: "normal", minTradeNum: "0.01", sizeMultiplier: "0.01",
        pricePlace: "2", priceEndStep: "1", maxLever: "125", takerFeeRate: "0.0006",
      }] };
      if (path.endsWith("/query-position-lever")) return { data: [{ startUnit: "0", keepMarginRate: "0.004" }] };
      if (path.endsWith("/open-interest")) return { data: { openInterestList: [{ size: "1234.5" }] } };
      throw new Error(`unexpected path ${path}`);
    },
  };
}

function candles() {
  return [
    { timestamp: EXIT - DAY_MS, open: 4000, high: 4100, low: 3950, close: 4050 },
    { timestamp: EXIT, open: 4210, high: 4230, low: 4190, close: 4220 },
  ];
}

test("settlement ignores Shadow exitPrice and rebuilds target exit from closed Bitget public evidence", async () => {
  const result = await loadBitgetEthV6PaperSettlement({
    client: fakeClient(),
    record: settledRecord("take_profit"),
    position: position(),
    researchCodeSha: SHA,
    nowMs: NOW,
    collectCandles: async () => ({ candles: candles() }),
    collectDerived: async ({ kind }) => ({
      candles: candles().map((row) => ({ ...row, close: kind === "mark" ? row.close + 1 : row.close - 1 })),
    }),
    collectFunding: async () => ({
      exhausted: true,
      records: [
        { timestamp: ENTRY + 7 * 60 * 60 * 1000, rate: 0.0001, rateRaw: "0.0001" },
        { timestamp: ENTRY + 15 * 60 * 60 * 1000, rate: -0.00005, rateRaw: "-0.00005" },
      ],
    }),
  });
  assert.equal(result.status, "READY");
  assert.equal(result.settlementInput.exitOrderType, "LIMIT");
  assert.equal(result.settlementInput.exitLimitPrice, 4200);
  assert.equal(result.settlementInput.exitStopPrice, null);
  assert.equal(result.settlementInput.exitBar.nextOpen, 4210);
  assert.notEqual(result.settlementInput.exitBar.nextOpen, 999999);
  assert.equal(result.evidence.shadowExitPriceIgnored, true);
  assert.equal(result.settlementInput.fundingEvidence.payments.length, 2);
  assert.equal(result.settlementInput.fundingEvidence.payments[0].amount, 0.028);
  assert.equal(result.settlementInput.fundingEvidence.payments[1].amount, -0.014);
  assert.equal(result.settlementInput.exitExecution.dataEvidence.historicalSettlementEvidence, true);
  assert.equal(result.settlementInput.exitExecution.dataEvidence.historicalSettlementEffectiveAtMs, EXIT);
  assert.equal(result.settlementInput.exitExecution.dataEvidence.barProxyRealtimeAllowed, false);
  assert.equal(result.settlementInput.exitExecution.dataEvidence.publicOnly, true);
  assert.equal(result.safety.privateApi, false);
  assert.equal(result.safety.liveTrading, false);
});

test("stop-loss settlement carries the frozen stop into STOP_MARKET instead of inventing a market exit", async () => {
  const result = await loadBitgetEthV6PaperSettlement({
    client: fakeClient(),
    record: settledRecord("stop_loss_gap"),
    position: position(),
    researchCodeSha: SHA,
    nowMs: NOW,
    collectCandles: async () => ({ candles: candles().map((row) => row.timestamp === EXIT ? { ...row, open: 3880, high: 3920, low: 3850 } : row) }),
    collectDerived: async () => ({ candles: candles() }),
    collectFunding: async () => ({ exhausted: true, records: [{ timestamp: ENTRY + 7 * 60 * 60 * 1000, rate: 0, rateRaw: "0" }] }),
  });
  assert.equal(result.status, "READY");
  assert.equal(result.settlementInput.exitOrderType, "STOP_MARKET");
  assert.equal(result.settlementInput.exitStopPrice, 3900);
  assert.equal(result.settlementInput.exitLimitPrice, null);
  assert.equal(result.settlementInput.exitBar.nextOpen, 3880);
});

test("open-only Shadow exit waits for the same daily candle to close before public verification", async () => {
  let calls = 0;
  const result = await loadBitgetEthV6PaperSettlement({
    client: { async get() { calls += 1; throw new Error("network must not be called yet"); } },
    record: settledRecord("take_profit_gap"),
    position: position(),
    researchCodeSha: SHA,
    nowMs: EXIT + DAY_MS - 1,
    collectCandles: async () => { calls += 1; throw new Error("collector must not be called yet"); },
    collectDerived: async () => { calls += 1; throw new Error("collector must not be called yet"); },
    collectFunding: async () => { calls += 1; throw new Error("collector must not be called yet"); },
  });
  assert.equal(result.status, "WAITING_CLOSED_EXIT_BAR");
  assert.equal(result.settlementInput, null);
  assert.equal(calls, 0);
});
