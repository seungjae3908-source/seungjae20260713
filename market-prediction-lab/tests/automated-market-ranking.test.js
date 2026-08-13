import test from "node:test";
import assert from "node:assert/strict";
import { aggregateMarketGroupCandidates } from "../src/automated-market-ranking.js";

function candidate(id, { symbolReturn, quality = 80, trades = 20, status = "eligible_for_final_holdout", flags = [] } = {}) {
  return Object.freeze({
    id,
    parameters: Object.freeze({ fastPeriod: 20, slowPeriod: 50 }),
    qualityScore: quality,
    researchStatus: status,
    oosMetrics: Object.freeze({ totalReturn: symbolReturn, expectancy: symbolReturn * 1000, tradeCount: trades }),
    walkForward: Object.freeze({ stability: Object.freeze({ stabilityScore: 75 }) }),
    overfitDiagnostics: Object.freeze({ flags: Object.freeze(flags) }),
  });
}

function row(symbol, candidates) {
  return Object.freeze({
    rankingGroup: "CRYPTO_FUTURES_SWING_LONG",
    datasetId: `${symbol}-dataset`,
    provider: "public-provider",
    crossVenueProxy: true,
    result: Object.freeze({ symbol, candidates: Object.freeze(candidates) }),
  });
}

test("cross-symbol aggregation requires common parameter candidates and penalizes one-symbol dependence", () => {
  const grouped = aggregateMarketGroupCandidates([
    row("BTCUSDT", [candidate("same", { symbolReturn: 0.08, quality: 90 }), candidate("btc-only", { symbolReturn: 0.2 })]),
    row("ETHUSDT", [candidate("same", { symbolReturn: -0.01, quality: 85 }), candidate("eth-only", { symbolReturn: 0.2 })]),
  ], {
    requiredSymbolsByGroup: { CRYPTO_FUTURES_SWING_LONG: ["BTCUSDT", "ETHUSDT"] },
  });
  const group = grouped.CRYPTO_FUTURES_SWING_LONG;
  assert.equal(group.candidateCount, 1);
  const item = group.candidates[0];
  assert.equal(item.id, "same");
  assert.equal(item.diagnostics.positiveSymbolRatio, 0.5);
  assert.ok(item.diagnostics.flags.includes("single_or_partial_symbol_dependency"));
  assert.equal(item.qualityScoreBeforeSymbolPenalty, 85);
  assert.equal(item.symbolDependencyPenaltyPoints, 5);
  assert.equal(item.qualityScore, 80);
});

test("group stays research_hold when a required symbol dataset is missing", () => {
  const grouped = aggregateMarketGroupCandidates([
    row("BTCUSDT", [candidate("same", { symbolReturn: 0.1 })]),
  ], {
    requiredSymbolsByGroup: { CRYPTO_FUTURES_SWING_LONG: ["BTCUSDT", "ETHUSDT"] },
  });
  const group = grouped.CRYPTO_FUTURES_SWING_LONG;
  assert.equal(group.status, "research_hold");
  assert.equal(group.reason, "missing_required_symbol_dataset");
  assert.deepEqual(group.missingSymbols, ["ETHUSDT"]);
  assert.equal(group.candidates.length, 0);
});

test("low sample and winner-concentration warnings propagate to the market group", () => {
  const grouped = aggregateMarketGroupCandidates([
    row("BTCUSDT", [candidate("same", { symbolReturn: 0.1, flags: ["low_oos_trade_sample"] })]),
    row("ETHUSDT", [candidate("same", { symbolReturn: 0.08, flags: ["top_two_winner_dependency"] })]),
  ], {
    requiredSymbolsByGroup: { CRYPTO_FUTURES_SWING_LONG: ["BTCUSDT", "ETHUSDT"] },
  });
  const flags = grouped.CRYPTO_FUTURES_SWING_LONG.candidates[0].diagnostics.flags;
  assert.deepEqual(flags, ["low_oos_trade_sample", "top_two_winner_dependency"]);
});

test("any per-symbol research_hold prevents group eligibility for final holdout", () => {
  const grouped = aggregateMarketGroupCandidates([
    row("BTCUSDT", [candidate("same", { symbolReturn: 0.1, status: "eligible_for_final_holdout" })]),
    row("ETHUSDT", [candidate("same", { symbolReturn: 0.1, status: "research_hold" })]),
  ], {
    requiredSymbolsByGroup: { CRYPTO_FUTURES_SWING_LONG: ["BTCUSDT", "ETHUSDT"] },
  });
  assert.equal(grouped.CRYPTO_FUTURES_SWING_LONG.candidates[0].researchStatus, "research_hold");
});
