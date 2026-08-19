import assert from "node:assert/strict";
import test from "node:test";

import { buildFourMarketPaperSample } from "../src/four-market-paper-sampler-v1.js";
import {
  FOUR_MARKET_PAPER_SETTLEMENT_MINIMUM_SAMPLE_SIZE,
  settleFourMarketPaperSample,
  summarizeSettledPaperSamples,
} from "../src/four-market-paper-settlement-v1.js";

const NOW = 1_800_000_000_000;
const RESEARCH_SHA = "b".repeat(40);

const adapterByMarket = Object.freeze({
  KR_STOCK: { id: "kr-stock-toss-execution", version: "v2" },
  US_STOCK: { id: "us-stock-toss-execution", version: "v2" },
  CRYPTO_SPOT: { id: "crypto-spot-upbit-execution", version: "v2" },
  CRYPTO_FUTURES: { id: "crypto-futures-bitget-execution", version: "v2" },
});
const providerByMarket = Object.freeze({ KR_STOCK: "toss", US_STOCK: "toss", CRYPTO_SPOT: "upbit", CRYPTO_FUTURES: "bitget" });

function strategyIdentity() {
  return { strategyId: "profit-first-v2", strategyVersion: "v2", parameterHash: "params-v2", researchCodeSha: RESEARCH_SHA };
}

function signal(market, direction, id = "001") {
  return { signalId: `${market}-${direction}-${id}`, market, style: "SWING", timeframe: "1h", horizon: 12, direction, strategyIdentity: strategyIdentity() };
}

function evidence(market) {
  return { status: "READY", market, expectedNetEdge: 1.2, expectedNetReturn: 1.4, riskRewardRatio: 1.8, sampleSize: 120, costPolicyId: `${market}-cost-v1`, executionAuthority: "NONE" };
}

function gate() {
  return { decision: "ELIGIBLE", eligible: true, reasons: [], executionAuthority: "NONE" };
}

function dataEvidence(market, asOfMs = NOW - 1_000) {
  const common = { provider: providerByMarket[market], publicOnly: true, dataQuality: "READY", provenance: `${market}-public-v1`, asOfMs, barProxyRealtimeAllowed: true };
  if (market === "KR_STOCK") return { ...common, tickSize: 1, taxPolicyKnown: true, session: { version: "kr-v1", status: "OPEN" }, volatilityInterruptionKnown: true, volatilityInterruptionActive: false };
  if (market === "US_STOCK") return { ...common, tickSize: 0.01, taxPolicyKnown: true, session: { version: "us-v1", status: "OPEN", kind: "REGULAR" } };
  if (market === "CRYPTO_SPOT") return { ...common, marketStatus: "TRADABLE", tickSize: 1, minOrderNotional: 5_000 };
  return { ...common, contractStatus: "TRADABLE", tickSize: 0.1, minQty: 0.001, qtyStep: 0.001, markPrice: 100, indexPrice: 100, fundingRate: 0.0001, openInterest: 100_000, leverage: 2, maxLeverage: 20, marginMode: "ISOLATED", liquidationDistancePct: 30 };
}

function execution(market, evaluatedAtMs = NOW, overrides = {}) {
  return {
    marketAdapterIdentity: adapterByMarket[market],
    costPolicy: {
      version: `${market}-cost-v1`,
      commissionRate: 0.001,
      taxRate: market.includes("STOCK") ? 0.001 : 0,
      spreadRate: 0.002,
      slippageRate: 0.001,
      latencyRate: 0.0005,
      liquidityImpactRate: 0.0005,
      partialFillImpactRate: 0.001,
      fundingRate: market === "CRYPTO_FUTURES" ? 0.0001 : 0,
    },
    executionPolicy: { version: "paper-fill-v1", fillModel: "BAR_PROXY", sameBarPolicy: "STOP_FIRST", allowPartialFill: true, maxParticipationRate: 0.1, nextBarOnly: false },
    dataEvidence: dataEvidence(market, evaluatedAtMs - 1_000),
    ...overrides,
  };
}

function openSample(market, direction, id = "001", entryOpen = 100) {
  return buildFourMarketPaperSample({
    signal: signal(market, direction, id),
    profitGate: gate(),
    profitEvidence: evidence(market),
    execution: execution(market, NOW),
    order: { type: "MARKET", quantity: 10, direction },
    bar: { nextOpen: entryOpen, high: entryOpen + 1, low: entryOpen - 1 },
    evaluatedAtMs: NOW,
  });
}

function fundingNone() { return { complete: true, payments: [] }; }

for (const [market, direction, exitOpen, expectedCloseDirection] of [
  ["KR_STOCK", "BUY", 110, "SELL_EXIT"],
  ["US_STOCK", "BUY", 110, "SELL_EXIT"],
  ["CRYPTO_SPOT", "BUY", 110, "SELL_EXIT"],
  ["CRYPTO_FUTURES", "LONG", 110, "SHORT"],
  ["CRYPTO_FUTURES", "SHORT", 90, "LONG"],
]) {
  test(`settles ${market} ${direction} with explicit close side and net costs`, () => {
    const sample = openSample(market, direction);
    assert.equal(sample.status, "OPEN");
    const settledAt = NOW + 60_000;
    const fundingEvidence = market === "CRYPTO_FUTURES"
      ? { complete: true, payments: [{ asOfMs: NOW + 30_000, amount: 0.25, source: "bitget-public", provenance: "funding-v1", version: "v1" }] }
      : fundingNone();
    const settled = settleFourMarketPaperSample({
      sample,
      exitExecution: execution(market, settledAt),
      exitBar: { nextOpen: exitOpen, high: exitOpen + 1, low: exitOpen - 1 },
      pathBars: [{ timestampMs: NOW + 30_000, high: 112, low: 98 }],
      fundingEvidence,
      evaluatedAtMs: settledAt,
    });
    assert.equal(settled.status, "SETTLED");
    assert.equal(settled.closeDirection, expectedCloseDirection);
    assert.equal(settled.quantity, sample.fill.filledQuantity);
    assert.equal(settled.netPnl, settled.grossPnl - settled.entryCost - settled.exitCost - settled.fundingCost);
    assert.ok(settled.totalExplicitCost >= 0);
    assert.ok(Number.isFinite(settled.netReturnPercent));
    assert.ok(Number.isFinite(settled.mfePercent));
    assert.ok(Number.isFinite(settled.maePercent));
    assert.equal(settled.orderSubmitted, false);
    assert.equal(settled.exchangeRequestSent, false);
    assert.equal(settled.privateTradingApiAllowed, false);
    assert.equal(settled.profitabilityClaimAllowed, false);
  });
}

test("futures settlement requires complete timestamped funding evidence", () => {
  const sample = openSample("CRYPTO_FUTURES", "LONG");
  assert.throws(() => settleFourMarketPaperSample({
    sample,
    exitExecution: execution("CRYPTO_FUTURES", NOW + 60_000),
    exitBar: { nextOpen: 110, high: 111, low: 109 },
    fundingEvidence: { complete: false, payments: [] },
    evaluatedAtMs: NOW + 60_000,
  }), /PAPER_FUNDING_EVIDENCE_INCOMPLETE/);

  assert.throws(() => settleFourMarketPaperSample({
    sample,
    exitExecution: execution("CRYPTO_FUTURES", NOW + 60_000),
    exitBar: { nextOpen: 110, high: 111, low: 109 },
    fundingEvidence: { complete: true, payments: [{ asOfMs: NOW + 70_000, amount: 1, source: "bitget", provenance: "future", version: "v1" }] },
    evaluatedAtMs: NOW + 60_000,
  }), /PAPER_FUNDING_TIMESTAMP_INVALID/);
});

test("cost policy mismatch blocks settlement instead of mixing incomparable costs", () => {
  const sample = openSample("KR_STOCK", "BUY");
  const result = settleFourMarketPaperSample({
    sample,
    exitExecution: execution("KR_STOCK", NOW + 60_000, { costPolicy: { ...execution("KR_STOCK").costPolicy, version: "wrong-cost-v9" } }),
    exitBar: { nextOpen: 110, high: 111, low: 109 },
    fundingEvidence: fundingNone(),
    evaluatedAtMs: NOW + 60_000,
  });
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.blockers, ["PAPER_COST_POLICY_VERSION_MISMATCH"]);
  assert.equal(result.orderSubmitted, false);
});

test("future exit market evidence blocks settlement", () => {
  const sample = openSample("CRYPTO_SPOT", "BUY");
  const evaluatedAt = NOW + 60_000;
  const result = settleFourMarketPaperSample({
    sample,
    exitExecution: execution("CRYPTO_SPOT", evaluatedAt, { dataEvidence: dataEvidence("CRYPTO_SPOT", evaluatedAt + 1) }),
    exitBar: { nextOpen: 110, high: 111, low: 109 },
    fundingEvidence: fundingNone(),
    evaluatedAtMs: evaluatedAt,
  });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.blockers.includes("FUTURE_DATA_FORBIDDEN"));
});

test("path excursion rejects future bars rather than leaking them", () => {
  const sample = openSample("KR_STOCK", "BUY");
  const evaluatedAt = NOW + 60_000;
  const result = settleFourMarketPaperSample({
    sample,
    exitExecution: execution("KR_STOCK", evaluatedAt),
    exitBar: { nextOpen: 110, high: 111, low: 109 },
    pathBars: [
      { timestampMs: NOW + 30_000, high: 112, low: 98 },
      { timestampMs: NOW + 70_000, high: 999, low: 1 },
    ],
    fundingEvidence: fundingNone(),
    evaluatedAtMs: evaluatedAt,
  });
  assert.equal(result.status, "SETTLED");
  assert.equal(result.usablePathBars, 1);
  assert.equal(result.rejectedFuturePathBars, 1);
});

test("settled sample statistics remain insufficient before canonical 30 outcomes", () => {
  assert.equal(FOUR_MARKET_PAPER_SETTLEMENT_MINIMUM_SAMPLE_SIZE, 30);
  const sample = openSample("KR_STOCK", "BUY");
  const one = settleFourMarketPaperSample({
    sample,
    exitExecution: execution("KR_STOCK", NOW + 60_000),
    exitBar: { nextOpen: 110, high: 111, low: 109 },
    fundingEvidence: fundingNone(),
    evaluatedAtMs: NOW + 60_000,
  });
  const summary = summarizeSettledPaperSamples([one]);
  assert.equal(summary.sampleStatus, "INSUFFICIENT_SAMPLE");
  assert.equal(summary.minimumSampleSize, 30);
  assert.equal(summary.sampleSize, 1);
  assert.equal(summary.promotionEvidenceReady, false);
  assert.equal(summary.profitabilityClaimAllowed, false);
});

test("30 unique settled samples can satisfy sample-count readiness but still cannot authorize profit claims", () => {
  const settlements = [];
  for (let index = 0; index < 30; index += 1) {
    const sample = openSample("KR_STOCK", "BUY", String(index).padStart(3, "0"), 100 + index * 0.01);
    settlements.push(settleFourMarketPaperSample({
      sample,
      exitExecution: execution("KR_STOCK", NOW + 60_000 + index),
      exitBar: { nextOpen: 110 + index * 0.01, high: 111 + index * 0.01, low: 109 + index * 0.01 },
      fundingEvidence: fundingNone(),
      evaluatedAtMs: NOW + 60_000 + index,
    }));
  }
  const summary = summarizeSettledPaperSamples(settlements);
  assert.equal(summary.sampleStatus, "READY");
  assert.equal(summary.sampleSize, 30);
  assert.equal(summary.promotionEvidenceReady, true);
  assert.ok(summary.hitRate >= 0 && summary.hitRate <= 1);
  assert.ok(Number.isFinite(summary.averageNetReturnPercent));
  assert.ok(Number.isFinite(summary.expectancyNetPnl));
  assert.ok(Number.isFinite(summary.maxDrawdownPercent));
  assert.equal(summary.profitabilityClaimAllowed, false, "sample count alone must never claim profitability");
});

test("duplicate settlement IDs fail closed", () => {
  const sample = openSample("KR_STOCK", "BUY");
  const settled = settleFourMarketPaperSample({
    sample,
    exitExecution: execution("KR_STOCK", NOW + 60_000),
    exitBar: { nextOpen: 110, high: 111, low: 109 },
    fundingEvidence: fundingNone(),
    evaluatedAtMs: NOW + 60_000,
  });
  assert.throws(() => summarizeSettledPaperSamples([settled, settled]), /PAPER_SETTLEMENT_DUPLICATE_SAMPLE/);
});
