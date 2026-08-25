import assert from "node:assert/strict";
import test from "node:test";
import { publicContract, ORDER_STATES, ORDER_TYPES } from "../src/contracts.mjs";
import { estimateExecutionCosts, normalizeExecutionCostSchedule } from "../src/execution-costs.mjs";
import { analyzeExecutionQuality } from "../src/execution-quality.mjs";
import { comparePaperLiveParity } from "../src/parity-contract.mjs";
import { TradeExecutionGateway } from "../src/gateway.mjs";

const AT = "2026-08-24T11:00:00.000Z";
const BEFORE = "2026-08-24T10:59:58.000Z";

function schedule(overrides = {}) {
  return {
    market: "KR_STOCK",
    provider: null,
    symbol: "005930",
    source: "TEST_CALLER_COST_SCHEDULE",
    scheduleVersion: "test-v1",
    currency: "KRW",
    effectiveFrom: "2026-08-24T00:00:00.000Z",
    effectiveTo: "2026-08-25T00:00:00.000Z",
    rates: { makerFeeBps: 1, takerFeeBps: 2, buyTaxBps: 0, sellTaxBps: 10, fxConversionBps: 0 },
    ...overrides,
  };
}

function futuresSchedule() {
  return {
    market: "CRYPTO_FUTURES",
    provider: "bitget",
    symbol: "BTCUSDT",
    source: "TEST_CALLER_COST_SCHEDULE",
    scheduleVersion: "test-futures-v1",
    currency: "USDT",
    effectiveFrom: "2026-08-24T00:00:00.000Z",
    effectiveTo: "2026-08-25T00:00:00.000Z",
    rates: { makerFeeBps: 1, takerFeeBps: 2, buyTaxBps: 0, sellTaxBps: 0, fxConversionBps: 0 },
  };
}

function benchmark(overrides = {}) {
  return {
    market: "KR_STOCK",
    symbol: "005930",
    arrivalPrice: 1000,
    observedAt: BEFORE,
    source: "TEST_BENCHMARK",
    serverAttested: false,
    ...overrides,
  };
}

function fullCandidate(overrides = {}) {
  return {
    runtimeStatus: "DISABLED",
    privateTradingApiEnabled: false,
    orderSubmissionEnabled: false,
    cancelEnabled: false,
    amendEnabled: false,
    intentFields: ["market", "symbol", "side", "orderType", "quantity", "idempotencyKey"],
    orderTypes: [...ORDER_TYPES],
    sides: ["BUY", "SELL"],
    orderStates: Object.values(ORDER_STATES),
    features: {
      idempotency: true,
      strictPrecision: true,
      partialFills: true,
      cancel: true,
      replace: true,
      riskRevalidation: true,
      costEvidence: true,
      reconciliation: true,
    },
    ...overrides,
  };
}

test("v0.7 preserves v0.6 TCA, explicit-cost, and parity preview contracts without live authority", () => {
  const contract = publicContract();
  assert.equal(contract.safety.version, "0.7.0");
  assert.equal(contract.executionQuality.hardCodedBrokerFees, false);
  assert.equal(contract.executionQuality.hardCodedTaxes, false);
  assert.equal(contract.executionQuality.hardCodedFundingConvention, false);
  assert.equal(contract.executionQuality.callerMaySelfAssertServerAttestation, false);
  assert.equal(contract.executionQuality.executionAuthority, "NONE");
  assert.equal(contract.parity.activationAllowed, false);
});

test("cost schedule requires exact identity and active effective window", () => {
  assert.throws(
    () => normalizeExecutionCostSchedule(schedule(), { market: "US_STOCK", symbol: "005930", atMs: Date.parse(AT) }),
    (error) => error.code === "COST_EVIDENCE_IDENTITY_MISMATCH",
  );
  assert.throws(
    () => normalizeExecutionCostSchedule(schedule(), { market: "KR_STOCK", symbol: "005930", atMs: Date.parse("2026-08-26T00:00:00Z") }),
    (error) => error.code === "COST_EVIDENCE_NOT_EFFECTIVE",
  );
});

test("caller cannot self-assert cost or funding server attestation", () => {
  assert.throws(
    () => normalizeExecutionCostSchedule(schedule({ serverAttested: true }), { market: "KR_STOCK", symbol: "005930", atMs: Date.parse(AT) }),
    (error) => error.code === "CALLER_ATTESTATION_REJECTED",
  );
  assert.throws(
    () => estimateExecutionCosts({
      market: "CRYPTO_FUTURES", provider: "bitget", symbol: "BTCUSDT", side: "LONG", liquidityRole: "MAKER",
      quantity: 1, price: 10_000, executionAt: AT, schedule: futuresSchedule(),
      fundingEvents: [{ rateBps: 5, payerSide: "LONG", effectiveAt: AT, source: "TEST", serverAttested: true }],
    }),
    (error) => error.code === "CALLER_ATTESTATION_REJECTED",
  );
});

test("explicit maker/taker, tax, and FX evidence produces estimated components only", () => {
  const result = estimateExecutionCosts({
    market: "KR_STOCK", symbol: "005930", side: "SELL", liquidityRole: "TAKER",
    quantity: 10, price: 1000, executionAt: AT,
    schedule: schedule({ rates: { makerFeeBps: 1, takerFeeBps: 2, buyTaxBps: 0, sellTaxBps: 10, fxConversionBps: 5 } }),
  });
  assert.equal(result.notional, 10_000);
  assert.equal(result.components.estimatedTradingFee, 2);
  assert.equal(result.components.estimatedTax, 10);
  assert.equal(result.components.estimatedFxConversionCost, 5);
  assert.equal(result.estimatedExecutionCost, 17);
  assert.equal(result.estimatedTotalCost, 17);
  assert.equal(result.actualBrokerChargeEvidence, false);
});

test("funding direction is explicit in evidence instead of hard-coded provider convention", () => {
  const fundingEvents = [{ rateBps: 5, payerSide: "LONG", effectiveAt: AT, source: "TEST_PUBLIC_FUNDING" }];
  const longCost = estimateExecutionCosts({
    market: "CRYPTO_FUTURES", provider: "bitget", symbol: "BTCUSDT", side: "LONG", liquidityRole: "MAKER",
    quantity: 1, price: 10_000, executionAt: AT, schedule: futuresSchedule(), fundingEvents,
  });
  const shortCost = estimateExecutionCosts({
    market: "CRYPTO_FUTURES", provider: "bitget", symbol: "BTCUSDT", side: "SHORT", liquidityRole: "MAKER",
    quantity: 1, price: 10_000, executionAt: AT, schedule: futuresSchedule(), fundingEvents,
  });
  assert.equal(longCost.components.estimatedFundingCost, 5);
  assert.equal(shortCost.components.estimatedFundingCost, -5);
});

test("funding after the requested analysis window is rejected", () => {
  assert.throws(
    () => estimateExecutionCosts({
      market: "CRYPTO_FUTURES", provider: "bitget", symbol: "BTCUSDT", side: "LONG", liquidityRole: "MAKER",
      quantity: 1, price: 10_000, executionAt: AT, schedule: futuresSchedule(),
      fundingEvents: [{ rateBps: 5, payerSide: "LONG", effectiveAt: "2026-08-24T11:00:01Z", source: "TEST" }],
    }),
    (error) => error.code === "FUNDING_EVENT_AFTER_ANALYSIS_WINDOW",
  );
});

test("Paper TCA computes fill VWAP, implementation shortfall, and all-in cost without claiming live evidence", async () => {
  const gateway = new TradeExecutionGateway({
    policy: { maxQuantityByMarket: { KR_STOCK: 100 }, maxNotionalByMarket: { KR_STOCK: 1_000_000 } },
  });
  const order = await gateway.placeOrder({
    mode: "PAPER", market: "KR_STOCK", symbol: "005930", side: "BUY", orderType: "LIMIT",
    quantity: 2, limitPrice: 1000, idempotencyKey: "v06-tca-paper-0001",
  });
  await gateway.applyPaperFill(order.orderId, { quantity: 1, price: 999, observedAt: "2026-08-24T10:59:59Z" });
  const filled = await gateway.applyPaperFill(order.orderId, { quantity: 1, price: 1000, observedAt: AT });
  const tca = analyzeExecutionQuality({
    order: filled,
    benchmark: benchmark({ arrivalPrice: 998, decisionPrice: 997, expectedFillPrice: 999 }),
    liquidityRole: "TAKER",
    costSchedule: schedule(),
  });
  assert.equal(tca.completion, "COMPLETE");
  assert.equal(tca.fillVwap, 999.5);
  assert.ok(tca.metrics.implementationShortfallBps > 0);
  assert.ok(tca.metrics.allInShortfallBps > tca.metrics.implementationShortfallBps);
  assert.equal(tca.benchmark.authority, "CALLER_SUPPLIED_UNATTESTED");
  assert.equal(tca.actualLiveExecutionMeasured, false);
  assert.equal(tca.executionAuthority, "NONE");
});

test("TCA benchmark identity, timing, and attestation fail closed", () => {
  const order = {
    intent: { market: "KR_STOCK", symbol: "005930", side: "BUY", quantity: 1 },
    paperFillEvidence: [{ quantity: 1, price: 1000, observedAt: AT, source: "PAPER_SIMULATION_ONLY", realExchangeFill: false }],
  };
  const base = { order, liquidityRole: "MAKER", costSchedule: schedule() };
  assert.throws(
    () => analyzeExecutionQuality({ ...base, benchmark: benchmark({ market: "US_STOCK" }) }),
    (error) => error.code === "TCA_BENCHMARK_IDENTITY_MISMATCH",
  );
  assert.throws(
    () => analyzeExecutionQuality({ ...base, benchmark: benchmark({ observedAt: "2026-08-24T11:00:01Z" }) }),
    (error) => error.code === "TCA_BENCHMARK_AFTER_FILL",
  );
  assert.throws(
    () => analyzeExecutionQuality({ ...base, benchmark: benchmark({ serverAttested: true }) }),
    (error) => error.code === "CALLER_ATTESTATION_REJECTED",
  );
});

test("partial fill TCA remains explicitly partial", () => {
  const order = {
    intent: { market: "KR_STOCK", symbol: "005930", side: "BUY", quantity: 10 },
    paperFillEvidence: [{ quantity: 4, price: 1000, observedAt: AT, source: "PAPER_SIMULATION_ONLY", realExchangeFill: false }],
  };
  const tca = analyzeExecutionQuality({ order, benchmark: benchmark(), liquidityRole: "MAKER", costSchedule: schedule() });
  assert.equal(tca.completion, "PARTIAL");
  assert.equal(tca.fillRatio, 0.4);
});

test("TCA rejects overfill, fill time regression, and claimed real-exchange evidence", () => {
  const order = { intent: { market: "KR_STOCK", symbol: "005930", side: "BUY", quantity: 1 } };
  const base = { order, benchmark: benchmark(), liquidityRole: "TAKER", costSchedule: schedule() };
  assert.throws(
    () => analyzeExecutionQuality({ ...base, fills: [{ quantity: 2, price: 1000, observedAt: AT, source: "CALLER_SUPPLIED_READ_ONLY" }] }),
    (error) => error.code === "TCA_OVERFILL_REJECTED",
  );
  assert.throws(
    () => analyzeExecutionQuality({ ...base, fills: [
      { quantity: 0.5, price: 1000, observedAt: AT, source: "CALLER_SUPPLIED_READ_ONLY" },
      { quantity: 0.5, price: 1000, observedAt: BEFORE, source: "CALLER_SUPPLIED_READ_ONLY" },
    ] }),
    (error) => error.code === "TCA_FILL_TIME_REGRESSION",
  );
  assert.throws(
    () => analyzeExecutionQuality({ ...base, fills: [{ quantity: 1, price: 1000, observedAt: AT, source: "CALLER_SUPPLIED_READ_ONLY", realExchangeFill: true }] }),
    (error) => error.code === "LIVE_FILL_EVIDENCE_REJECTED",
  );
});

test("explicit TCA thresholds classify breaches without changing order authority", () => {
  const order = {
    intent: { market: "KR_STOCK", symbol: "005930", side: "BUY", quantity: 1 },
    paperFillEvidence: [{ quantity: 1, price: 1010, observedAt: AT, source: "PAPER_SIMULATION_ONLY", realExchangeFill: false }],
  };
  const tca = analyzeExecutionQuality({
    order,
    benchmark: benchmark({ arrivalPrice: 1000, expectedFillPrice: 1000 }),
    liquidityRole: "TAKER",
    costSchedule: schedule(),
    policy: { maxAllInShortfallBps: 50, maxPredictionErrorBps: 50 },
  });
  assert.equal(tca.state, "BREACHED");
  assert.ok(tca.breaches.includes("ALL_IN_SHORTFALL_EXCEEDED"));
  assert.equal(tca.executionAuthority, "NONE");
});

test("disabled stock candidate can match Paper semantics without becoming live-ready", () => {
  const report = comparePaperLiveParity({ market: "KR_STOCK", provider: "toss", candidate: fullCandidate() });
  assert.equal(report.parityState, "CONTRACT_MATCH_DISABLED");
  assert.equal(report.activationAllowed, false);
  assert.equal(report.actualPaperLiveRuntimeParityProven, false);
});

test("futures parity exposes reduceOnly gap", () => {
  const candidate = fullCandidate({
    sides: ["LONG", "SHORT"],
    features: { ...fullCandidate().features, reduceOnly: false },
  });
  const report = comparePaperLiveParity({ market: "CRYPTO_FUTURES", provider: "bitget", candidate });
  assert.equal(report.parityState, "GAPS_FOUND");
  assert.ok(report.gaps.includes("MISSING_FEATURE:reduceOnly"));
});

test("parity inspection rejects enabled private/live candidates", () => {
  assert.throws(
    () => comparePaperLiveParity({ market: "CRYPTO_SPOT", provider: "upbit", candidate: fullCandidate({ privateTradingApiEnabled: true }) }),
    (error) => error.code === "UNSAFE_LIVE_PARITY_CANDIDATE",
  );
  assert.throws(
    () => comparePaperLiveParity({ market: "US_STOCK", provider: "kis", candidate: fullCandidate() }),
    (error) => error.code === "PARITY_PROVIDER_MISMATCH",
  );
});
