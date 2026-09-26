import assert from "node:assert/strict";
import test from "node:test";
import { buildFourMarketPaperSample } from "../src/four-market-paper-sampler-v1.js";
import { settleFourMarketPaperSample } from "../src/four-market-paper-settlement-v1.js";

const ENTRY = 1_800_000_000_000;
const EXIT = ENTRY + 86_400_000;
const SHA = "a".repeat(40);

function execution(asOfMs) {
  return {
    marketAdapterIdentity: { id: "crypto-futures-bitget-execution", version: "v2" },
    costPolicy: {
      version: "bitget-standard-taker-research-v1",
      commissionRate: 0.001,
      taxRate: 0,
      spreadRate: 0.002,
      slippageRate: 0.001,
      latencyRate: 0.0005,
      liquidityImpactRate: 0,
      partialFillImpactRate: 0,
      fundingRate: 0,
    },
    executionPolicy: {
      version: "eth-v6-natural-forward-next-open-v1",
      fillModel: "BAR_PROXY",
      sameBarPolicy: "STOP_FIRST",
      allowPartialFill: false,
      maxParticipationRate: 1,
    },
    dataEvidence: {
      provider: "bitget",
      publicOnly: true,
      dataQuality: "READY",
      provenance: "bitget-public-test",
      asOfMs,
      contractStatus: "TRADABLE",
      tickSize: 0.1,
      minQty: 0.001,
      qtyStep: 0.001,
      markPrice: 100,
      indexPrice: 100,
      fundingRate: 0,
      openInterest: 1000,
      leverage: 1,
      maxLeverage: 20,
      marginMode: "ISOLATED",
      liquidationDistancePct: 90,
      barProxyRealtimeAllowed: true,
    },
  };
}

function openSample() {
  return buildFourMarketPaperSample({
    signal: {
      signalId: "ETH-V6-test",
      market: "CRYPTO_FUTURES",
      symbol: "ETHUSDT",
      style: "SWING",
      timeframe: "1d",
      horizon: 1,
      direction: "LONG",
      strategyIdentity: { strategyId: "v6_independent_breakout_retest", strategyVersion: "V6_FROZEN_FINAL_HOLDOUT", parameterHash: "params", researchCodeSha: SHA },
    },
    profitGate: { decision: "ELIGIBLE", eligible: true, reasons: [], executionAuthority: "NONE" },
    profitEvidence: { status: "READY", market: "CRYPTO_FUTURES", expectedNetEdge: 0.01, expectedNetReturn: 0.02, riskRewardRatio: 2, sampleSize: 3, costPolicyId: "bitget-standard-taker-research-v1", executionAuthority: "NONE" },
    execution: execution(ENTRY - 1000),
    order: { type: "MARKET", quantity: 1, direction: "LONG" },
    bar: { nextOpen: 100 },
    evaluatedAtMs: ENTRY,
  });
}

test("STOP_MARKET settlement receives frozen stopPrice and preserves adverse gap execution", () => {
  const settled = settleFourMarketPaperSample({
    sample: openSample(),
    exitExecution: execution(EXIT - 1000),
    exitOrderType: "STOP_MARKET",
    exitStopPrice: 95,
    exitBar: { nextOpen: 94, high: 96, low: 93 },
    fundingEvidence: { complete: true, payments: [] },
    evaluatedAtMs: EXIT,
  });
  assert.equal(settled.status, "SETTLED");
  assert.equal(settled.exitFill.orderType, "STOP_MARKET");
  assert.ok(settled.exitFill.fillPrice <= 94, "adverse costs may worsen but never improve the stop-gap fill");
  assert.equal(settled.orderSubmitted, false);
  assert.equal(settled.exchangeRequestSent, false);
});

test("LIMIT settlement receives frozen target and captures favorable gap without Shadow exitPrice", () => {
  const settled = settleFourMarketPaperSample({
    sample: openSample(),
    exitExecution: execution(EXIT - 1000),
    exitOrderType: "LIMIT",
    exitLimitPrice: 110,
    exitBar: { nextOpen: 111, high: 112, low: 109 },
    fundingEvidence: { complete: true, payments: [] },
    evaluatedAtMs: EXIT,
  });
  assert.equal(settled.status, "SETTLED");
  assert.equal(settled.exitFill.orderType, "LIMIT");
  assert.equal(settled.exitFill.fillPrice, 111);
  assert.equal(settled.orderSubmitted, false);
  assert.equal(settled.profitabilityClaimAllowed, false);
});