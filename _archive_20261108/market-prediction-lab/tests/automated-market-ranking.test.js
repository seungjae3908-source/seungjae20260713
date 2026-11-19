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

const promotionPolicy = Object.freeze({
  status: "empirically_calibrated",
  minTrials: 3,
  maxPbo: 0.25,
  minDsrProbability: 0.95,
  minOosTrades: 40,
  minWalkForwardWindows: 4,
  minShadowSettled: 300,
  minShadowElapsedMs: 28 * 24 * 60 * 60 * 1000,
  minPaperSettled: 200,
  minPaperProfitFactor: 1.2,
  minPaperExpectancyCiLower: 0,
  maxPaperMdd: 0.15,
});

function promotionEvidence(strategyFingerprint) {
  return Object.freeze({
    strategyFingerprint,
    backtest: Object.freeze({
      strategyFingerprint,
      lineageValid: true,
      finalHoldoutRetuned: false,
      finalHoldoutStatus: "PASS",
      oos: Object.freeze({ tradeCount: 80, expectancy: 0.01 }),
      walkForward: Object.freeze({ windows: 8, stabilityPass: true }),
      costStress: Object.freeze({ passed: true }),
      regime: Object.freeze({ passed: true }),
      crossSymbol: Object.freeze({ passed: true }),
    }),
    selectionBias: Object.freeze({
      strategyFingerprint,
      registryComplete: true,
      trialCount: 30,
      pbo: 0.1,
      dsrProbability: 0.98,
      forwardEvidenceUsedForSelection: false,
    }),
    shadow: Object.freeze({
      strategyFingerprint,
      lineageValid: true,
      frozenIdentity: true,
      naturalScheduleObserved: true,
      forwardRetuned: false,
      settled: 400,
      elapsedMs: 35 * 24 * 60 * 60 * 1000,
      neutralCollapse: false,
      directionalQualityPass: true,
    }),
    paper: Object.freeze({
      strategyFingerprint,
      lineageValid: true,
      scheduleActive: true,
      naturalCronObserved: true,
      settlementLinked: true,
      settledTrades: 250,
      profitFactor: 1.3,
      expectancyCiLower: 0.001,
      maximumDrawdown: 0.09,
      actualOrders: 0,
      privateAccountRequests: 0,
    }),
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
  assert.equal(item.promotionAssessment.status, "RESEARCH_HOLD");
  assert.deepEqual(item.promotionAssessment.reasons, ["promotion:unified_evidence_not_supplied"]);
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

test("canonical ranking invokes the unified Backtest+PBO/DSR+Shadow+Paper promotion gate", () => {
  const strategyFingerprint = "immutable-strategy-fingerprint";
  const grouped = aggregateMarketGroupCandidates([
    row("BTCUSDT", [candidate("same", { symbolReturn: 0.1, quality: 90, trades: 60 })]),
    row("ETHUSDT", [candidate("same", { symbolReturn: 0.08, quality: 88, trades: 60 })]),
  ], {
    requiredSymbolsByGroup: { CRYPTO_FUTURES_SWING_LONG: ["BTCUSDT", "ETHUSDT"] },
    promotionPolicy,
    promotionEvidenceByCandidate: {
      "CRYPTO_FUTURES_SWING_LONG:same": promotionEvidence(strategyFingerprint),
    },
  });
  const assessment = grouped.CRYPTO_FUTURES_SWING_LONG.candidates[0].promotionAssessment;
  assert.equal(assessment.strategyFingerprint, strategyFingerprint);
  assert.equal(assessment.status, "PROMOTION_REVIEW_READY");
  assert.equal(assessment.promotionEligible, true);
  assert.equal(assessment.safety.liveTradingAllowed, false);
  assert.equal(assessment.safety.orderAuthority, false);
});
