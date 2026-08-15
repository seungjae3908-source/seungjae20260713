import test from "node:test";
import assert from "node:assert/strict";
import {
  assertFuturesFeatureParity, createSearchFunnel, evaluateHardFilters, evaluateProfitGate,
  marketSearchContract, rankSoftCandidate, runOpportunityAuction,
} from "../src/meaningful-search-profit-gate-v1.js";

function candidate(market, overrides = {}) {
  return {
    market, strategy: "SWING", quoteSuccess: true, historySufficient: true, indicatorsReady: true,
    dataQualityPass: true, tradable: true, priceValid: true, liquidityPass: true, spreadPass: true,
    closedCandleComplete: true, futureData: false,
    features: { marketRelativeStrength: .9, sectorRelativeStrength: .8, turnover: .8, dollarVolume: .8,
      relativeVolume: .8, trend: .8, momentum: .8, volatilityFit: .8, marketRegime: .8, pullback: .8,
      riskReward: .8, btcRegime: .8, btcRelativeStrength: .9, usdtTrend: .8, breadth: .8,
      basis: .6, funding: .6, aggressiveFlow: .7, orderBookImbalance: .7, liquidity: .9, spreadQuality: .9 },
    ...overrides,
  };
}

function gate(market, overrides = {}) {
  return evaluateProfitGate({
    market, probabilities: { tp: .62, sl: .28, expire: .1 }, returns: { target: .05, stop: .02, expire: 0 },
    costs: { status: "READY", components: { commission: .001, spread: .001, slippage: .001 } },
    calibration: { status: "READY", sampleSize: 200, tpFirstCount: 124 }, minimumSample: 30, minimumEdge: 0,
    featureParity: { pass: true }, ...overrides,
  });
}

test("four markets have separate discovery contracts and one common no-live boundary", () => {
  const contract = marketSearchContract();
  assert.deepEqual(contract.markets, ["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);
  assert.notDeepEqual(contract.marketFeatures.KR_STOCK, contract.marketFeatures.CRYPTO_SPOT);
  assert.equal(contract.liveTrading, false);
  for (const market of contract.markets) assert.notEqual(rankSoftCandidate(candidate(market)).grade, "REJECT");
});

test("one missing RSI-style condition cannot erase a strong relative candidate", () => {
  const result = rankSoftCandidate(candidate("KR_STOCK", { features: { ...candidate("KR_STOCK").features, rsi: .1 } }));
  assert.ok(["S", "A"].includes(result.grade));
  assert.ok(result.setupScore > 65);
});

test("bad data is a hard reject and cannot be recovered by soft scores", () => {
  const input = candidate("US_STOCK", { dataQualityPass: false, features: Object.fromEntries(Object.keys(candidate("US_STOCK").features).map((key) => [key, 1])) });
  assert.deepEqual(evaluateHardFilters(input).reasons, ["STALE_PRICE"]);
  assert.equal(rankSoftCandidate(input).hardRejected, true);
});

test("funnel distinguishes search failure from valid NO_TRADE", () => {
  const failed = createSearchFunnel("KR_STOCK"); failed.increment("TOTAL_UNIVERSE", 100); failed.increment("QUOTE_REQUESTED", 100);
  assert.equal(failed.snapshot().outcome, "SEARCH_FAILURE");
  const valid = createSearchFunnel("CRYPTO_SPOT"); valid.increment("TOTAL_UNIVERSE", 100); valid.increment("QUOTE_REQUESTED", 100); valid.increment("QUOTE_SUCCESS", 95);
  assert.equal(valid.snapshot().outcome, "VALID_NO_TRADE");
});

test("costs can turn positive gross EV into a rejected negative net EV", () => {
  const result = gate("US_STOCK", { probabilities: { tp: .55, sl: .45, expire: 0 }, returns: { target: .02, stop: .02, expire: 0 }, costs: { status: "READY", components: { commission: .002, tax: .001, spread: .002, slippage: .002 } } });
  assert.equal(result.decision, "NO_TRADE");
  assert.ok(result.reasons.includes("NEGATIVE_NET_EV"));
});

test("high raw win rate cannot pass a negative cost-adjusted EV", () => {
  const result = gate("CRYPTO_SPOT", { probabilities: { tp: .8, sl: .2, expire: 0 }, returns: { target: .005, stop: .04, expire: 0 }, costs: { status: "READY", components: { commission: .001, spread: .001 } }, calibration: { status: "READY", sampleSize: 200, tpFirstCount: 160 } });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("NEGATIVE_NET_EV"));
});

test("missing costs and small calibration samples fail closed without fake probabilities", () => {
  const result = gate("KR_STOCK", { costs: { status: "MISSING", components: {} }, calibration: { status: "INSUFFICIENT_SAMPLE", sampleSize: 4, tpFirstCount: 3 } });
  assert.equal(result.netEv, null);
  assert.ok(result.reasons.includes("COST_NOT_EVIDENCED"));
  assert.ok(result.reasons.includes("INSUFFICIENT_SAMPLE"));
});

test("futures OI is blocked when runtime/training parity is absent", () => {
  const parity = assertFuturesFeatureParity({ market: "CRYPTO_FUTURES", runtimeFeatures: ["trend", "openInterestChange"], trainingFeatures: ["trend"] });
  assert.equal(parity.pass, false);
  assert.deepEqual(parity.blockedFeatures, ["openInterestChange"]);
  assert.ok(gate("CRYPTO_FUTURES", { featureParity: parity }).reasons.includes("FEATURE_PARITY_BLOCKED"));
});

test("grades are evidence-derived and never force-fill a top N", () => {
  const weak = candidate("US_STOCK", { features: Object.fromEntries(Object.keys(candidate("US_STOCK").features).map((key) => [key, .2])) });
  assert.equal(rankSoftCandidate(weak).grade, "REJECT");
});

test("cross-market auction chooses cash when no conservative gate passes and de-correlates survivors", () => {
  assert.equal(runOpportunityAuction([{ symbol: "A", market: "KR_STOCK", profitGate: gate("KR_STOCK", { minimumEdge: 1 }) }]).decision, "CASH/NO_TRADE");
  const positive = gate("CRYPTO_SPOT");
  const auction = runOpportunityAuction([
    { symbol: "BTC", market: "CRYPTO_SPOT", correlationGroup: "CRYPTO_LONG", profitGate: positive },
    { symbol: "ETH", market: "CRYPTO_SPOT", correlationGroup: "CRYPTO_LONG", profitGate: positive },
  ]);
  assert.equal(auction.selected.length, 1);
});
