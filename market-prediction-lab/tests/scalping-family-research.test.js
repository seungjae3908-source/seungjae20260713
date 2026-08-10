import test from "node:test";
import assert from "node:assert/strict";
import { RESEARCH_BACKTEST_PERIOD } from "../src/multi-market-backtest-engine.js";
import { SCALPING_ADAPTER_CONTRACTS, SCALPING_FAMILY_RESEARCH_BUDGET, runScalpingFamilyResearch } from "../src/scalping-family-research.js";

test("scalping adapter contracts are 15m-only and preserve distinct structural families", () => {
  assert.deepEqual(Object.keys(SCALPING_ADAPTER_CONTRACTS), ["V2", "V3", "V4", "V5", "V6"]);
  for (const contract of Object.values(SCALPING_ADAPTER_CONTRACTS)) {
    assert.equal(contract.timeframeAssumption, "15m_only");
    assert.match(contract.parameterProvenance, /15m/u);
  }
  assert.equal(SCALPING_ADAPTER_CONTRACTS.V2.structuralFamily, "EMA_ATR_SHARED");
  assert.equal(SCALPING_ADAPTER_CONTRACTS.V6.structuralFamily, "INDEPENDENT_BREAKOUT_RETEST");
  assert.ok(SCALPING_FAMILY_RESEARCH_BUDGET.maxCoarseCandidates <= 16);
  assert.ok(SCALPING_FAMILY_RESEARCH_BUDGET.maxFineCandidates <= 16);
  assert.ok(SCALPING_FAMILY_RESEARCH_BUDGET.oosAdmissions <= 6);
});

test("final holdout candles are rejected before any scalping family research", () => {
  assert.throws(() => runScalpingFamilyResearch({
    backtestInput: {
      market: "CRYPTO_SPOT",
      symbol: "USDT-BTC",
      side: "long",
      timeframe: "15m",
      initialCapital: 1_000_000,
      candles: [{ timestamp: RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime, open: 1, high: 1, low: 1, close: 1, volume: 1 }],
      fundingRates: [],
      costModel: {},
      riskModel: {},
      dataCoverage: { sufficient: true, ratio: 1 },
    },
  }), /SCALPING_FAMILY_FINAL_HOLDOUT_INPUT_FORBIDDEN/u);
});


test("workflow shards accept only explicit existing family versions", () => {
  assert.throws(() => runScalpingFamilyResearch({
    versions: ["V7"],
    backtestInput: {
      market: "CRYPTO_SPOT", symbol: "USDT-BTC", side: "long", timeframe: "15m", initialCapital: 1_000_000,
      candles: [{ timestamp: RESEARCH_BACKTEST_PERIOD.startTime, open: 1, high: 1, low: 1, close: 1, volume: 1 }],
      fundingRates: [], costModel: {}, riskModel: {}, dataCoverage: { sufficient: true, ratio: 1 },
    },
  }), /unsupported scalping family version/u);
});
