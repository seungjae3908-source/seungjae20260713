import assert from "node:assert/strict";
import test from "node:test";

import { buildFourMarketExecutionContext } from "../src/four-market-execution-v2.js";

const NOW = 1_800_000_000_000;
const SHA = "a".repeat(40);

function input(overrides = {}) {
  return {
    market: "CRYPTO_FUTURES",
    stage: "PAPER",
    style: "SWING",
    timeframe: "1d",
    horizon: 1,
    direction: "SHORT",
    executionPurpose: "SETTLEMENT",
    marketAdapterIdentity: { id: "crypto-futures-bitget-execution", version: "v2" },
    strategyIdentity: {
      strategyId: "v6_independent_breakout_retest",
      strategyVersion: "V6_FROZEN_FINAL_HOLDOUT",
      parameterHash: "params",
      researchCodeSha: SHA,
    },
    costPolicy: {
      version: "bitget-standard-taker-research-v1",
      commissionRate: 0.0006,
      taxRate: 0,
      spreadRate: 0.0004,
      slippageRate: 0.0005,
      latencyRate: 0,
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
      provenance: "bitget-public-v2:closed-daily-settlement",
      asOfMs: NOW,
      contractStatus: "TRADABLE",
      tickSize: 0.01,
      minQty: 0.01,
      qtyStep: 0.01,
      markPrice: 4000,
      indexPrice: 3999,
      fundingRate: 0.0001,
      openInterest: 1000,
      leverage: 1,
      maxLeverage: 125,
      marginMode: "ISOLATED",
      liquidationDistancePct: 99,
      barProxyRealtimeAllowed: false,
      closedDataOnly: true,
      historicalSettlementEvidence: true,
      historicalSettlementEffectiveAtMs: NOW - 1,
    },
    evaluatedAtMs: NOW,
    ...overrides,
  };
}

test("PAPER settlement accepts truthful closed historical BAR_PROXY evidence without labeling it realtime", () => {
  const context = buildFourMarketExecutionContext(input());
  assert.equal(context.status, "READY");
  assert.equal(context.executionPurpose, "SETTLEMENT");
  assert.equal(context.blockers.length, 0);
});

test("historical settlement evidence cannot be reused for a PAPER entry", () => {
  const context = buildFourMarketExecutionContext(input({ executionPurpose: "ENTRY" }));
  assert.equal(context.status, "BLOCKED");
  assert.ok(context.blockers.includes("HISTORICAL_SETTLEMENT_PURPOSE_REQUIRED"));
  assert.ok(context.blockers.includes("BAR_PROXY_EVIDENCE_NOT_READY"));
});

test("future-dated historical settlement evidence fails closed", () => {
  const context = buildFourMarketExecutionContext(input({
    dataEvidence: {
      ...input().dataEvidence,
      historicalSettlementEffectiveAtMs: NOW + 1,
    },
  }));
  assert.equal(context.status, "BLOCKED");
  assert.ok(context.blockers.includes("FUTURE_HISTORICAL_SETTLEMENT_FORBIDDEN"));
  assert.ok(context.blockers.includes("BAR_PROXY_EVIDENCE_NOT_READY"));
});
