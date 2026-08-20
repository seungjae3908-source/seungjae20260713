import test from "node:test";
import assert from "node:assert/strict";
import {
  composeCanonicalPaperProfitInput,
  createCanonicalPaperProfitInputForCard,
  resolveCanonicalPaperCostInput,
} from "../src/canonical-paper-profit-input-composer-v1.js";
import { evaluateProfitGate } from "../src/meaningful-search-profit-gate-v1.js";
import { profitEvidenceFromMeaningfulSearchGate } from "../src/canonical-meaningful-search-paper-runtime-v1.js";
import { prepareMeaningfulSearchPaperCandidate } from "../src/meaningful-search-paper-bridge-v1.js";

const NOW = 1_800_000_000_000;
const SHA = "a".repeat(40);
const COST_POLICY = "BACKTEST_FEES_SLIPPAGE_FUNDING_V1";

function paperCandidate(market = "KR_STOCK", direction = market === "CRYPTO_FUTURES" ? "LONG" : "BUY") {
  return Object.freeze({
    signal: Object.freeze({
      signalId: `${market}-paper-profit-input`,
      market,
      symbol: market === "CRYPTO_FUTURES" ? "BTCUSDT" : "TEST",
      timestampMs: NOW - 10_000,
      ttlMs: 4 * 60 * 60_000,
      expiresAtMs: NOW - 10_000 + 4 * 60 * 60_000,
      style: "SWING",
      timeframe: "60m",
      horizon: 4,
      direction,
      signalDirection: direction,
      strategyIdentity: Object.freeze({
        strategyId: `${market}_SWING_${direction}`,
        strategyVersion: `${market}_SWING_V1`,
        parameterHash: "params-v1",
        researchCodeSha: SHA,
        costPolicyVersion: COST_POLICY,
      }),
    }),
    executionAuthority: "NONE",
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
}

function calibration(candidate = paperCandidate()) {
  const signal = candidate.signal;
  const identity = signal.strategyIdentity;
  return Object.freeze({
    schemaVersion: "forward-recommendation-profit-calibration-v2",
    source: "LIVE_RECOMMENDATION",
    status: "READY",
    identity: Object.freeze({
      strategyId: identity.strategyId,
      strategyVersion: identity.strategyVersion,
      parameterHash: identity.parameterHash,
      researchCodeSha: identity.researchCodeSha,
      market: signal.market,
      symbol: signal.symbol,
      timeframe: signal.timeframe,
      horizon: signal.horizon,
      direction: signal.direction,
    }),
    calibration: Object.freeze({ status: "READY", sampleSize: 30, tpFirstCount: 18 }),
    probabilities: Object.freeze({ tp: 18 / 30, sl: 8 / 30, expire: 4 / 30 }),
    returns: Object.freeze({ target: 0.05, stop: -0.02, expire: 0.005 }),
    counts: Object.freeze({ tp: 18, sl: 8, expire: 4, conservativeConflicts: 0 }),
    costAdjusted: false,
    executionAuthority: "NONE",
    financialMutationAllowed: false,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    profitabilityClaimAllowed: false,
  });
}

function component(valuePercent, source, quality = "OBSERVED", observedAtMs = NOW - 1_000) {
  return Object.freeze({ valuePercent, quality, source, observedAtMs });
}

function costEvidence(candidate = paperCandidate(), overrides = {}) {
  const market = candidate.signal.market;
  const values = {
    commission: 0.10,
    tax: market === "KR_STOCK" || market === "US_STOCK" ? 0.05 : 0,
    spread: 0.10,
    slippage: 0.15,
    funding: market === "CRYPTO_FUTURES" ? 0.01 : 0,
    latency: 0.01,
    liquidityImpact: 0.02,
    partialFillImpact: 0.03,
  };
  const policy = Object.freeze({
    id: COST_POLICY,
    market,
    commissionPercent: values.commission,
    taxPercent: values.tax,
    spreadPercent: values.spread,
    slippagePercent: values.slippage,
    fundingPercent: values.funding,
    latencyPercent: values.latency,
    liquidityImpactPercent: values.liquidityImpact,
    partialFillImpactPercent: values.partialFillImpact,
    source: "EXPLICIT_RUNTIME_POLICY",
    ...(overrides.policy ?? {}),
  });
  const provenanceComponents = Object.freeze({
    commission: component(values.commission, "public-paper:fee"),
    tax: component(values.tax, market === "KR_STOCK" || market === "US_STOCK" ? "documented:tax" : "market:tax-na", market === "KR_STOCK" || market === "US_STOCK" ? "DOCUMENTED" : "NOT_APPLICABLE"),
    spread: component(values.spread, "public-paper:spread"),
    slippage: component(values.slippage, "public-paper:slippage"),
    funding: component(values.funding, market === "CRYPTO_FUTURES" ? "public-paper:funding" : "market:funding-na", market === "CRYPTO_FUTURES" ? "OBSERVED" : "NOT_APPLICABLE"),
    latency: component(values.latency, "runtime:latency", "ESTIMATED"),
    liquidityImpact: component(values.liquidityImpact, "runtime:liquidity", "ESTIMATED"),
    partialFillImpact: component(values.partialFillImpact, "runtime:partial-fill", "ESTIMATED"),
    ...(overrides.components ?? {}),
  });
  return Object.freeze({
    status: overrides.status ?? "READY",
    policy,
    provenance: Object.freeze({
      market,
      policyId: overrides.policyId ?? COST_POLICY,
      paperCostPolicyVersion: "paper-readiness-v1",
      providerProvenance: "public-paper-readiness-fixture",
      taxPolicyVersion: market === "KR_STOCK" || market === "US_STOCK" ? "tax-v1" : null,
      components: provenanceComponents,
    }),
    blockers: Object.freeze(overrides.blockers ?? []),
    executionAuthority: "NONE",
    orderSubmitted: false,
    exchangeRequestSent: false,
    privateApiUsed: overrides.privateApiUsed ?? false,
    liveTrading: false,
  });
}

function futuresParity() {
  return Object.freeze({ pass: true, allowedFeatures: Object.freeze(["trend", "funding"]), blockedFeatures: Object.freeze([]) });
}

test("maps #322 percent cost evidence into Meaningful Search return-ratio units exactly once", () => {
  const candidate = paperCandidate();
  const resolved = resolveCanonicalPaperCostInput({ costEvidence: costEvidence(candidate), paperCandidate: candidate, nowMs: NOW });
  assert.equal(resolved.status, "READY");
  assert.equal(resolved.costs.unit, "RETURN_RATIO");
  assert.equal(resolved.costs.sourceUnit, "PERCENT");
  assert.equal(resolved.costs.conversion, "PERCENT_DIV_100");
  assert.equal(resolved.costs.components.commission, 0.001);
  assert.equal(resolved.costs.components.tax, 0.0005);
  assert.equal(resolved.costs.components.slippage, 0.0015);
  assert.equal(resolved.costs.components.latency, 0.0001);
});

test("READY Forward calibration plus exact explicit costs produces a Profit Gate eligible input", () => {
  const candidate = paperCandidate();
  const composed = composeCanonicalPaperProfitInput({
    paperCandidate: candidate,
    calibration: calibration(candidate),
    costEvidence: costEvidence(candidate),
    nowMs: NOW,
  });
  assert.equal(composed.status, "PROFIT_INPUT_READY");
  assert.deepEqual(composed.blockers, []);
  assert.equal(composed.profitInput.costs.costPolicyId, COST_POLICY);
  const gate = evaluateProfitGate({ market: candidate.signal.market, ...composed.profitInput });
  assert.equal(gate.eligible, true);
  assert.ok(gate.netEv > 0);
  assert.ok(gate.evLowerBound > 0);
});

test("missing cost evidence stays fail-closed even when calibration is READY", () => {
  const candidate = paperCandidate();
  const composed = composeCanonicalPaperProfitInput({ paperCandidate: candidate, calibration: calibration(candidate), costEvidence: null, nowMs: NOW });
  assert.equal(composed.status, "NO_TRADE");
  assert.equal(composed.profitInput.costs.status, "MISSING");
  assert.ok(composed.blockers.includes("COST_EVIDENCE_NOT_READY"));
  const gate = evaluateProfitGate({ market: candidate.signal.market, ...composed.profitInput });
  assert.equal(gate.eligible, false);
  assert.ok(gate.reasons.includes("COST_NOT_EVIDENCED"));
});

test("cost policy must match canonical StrategyPromotion identity exactly", () => {
  const candidate = paperCandidate();
  const composed = composeCanonicalPaperProfitInput({
    paperCandidate: candidate,
    calibration: calibration(candidate),
    costEvidence: costEvidence(candidate, { policy: { id: "different-cost-policy" } }),
    nowMs: NOW,
  });
  assert.equal(composed.status, "NO_TRADE");
  assert.ok(composed.blockers.includes("COST_POLICY_IDENTITY_MISMATCH"));
  assert.ok(composed.blockers.includes("COST_POLICY_PROVENANCE_ID_MISMATCH"));
});

test("cost provenance value mismatch is rejected instead of silently trusting the numeric policy", () => {
  const candidate = paperCandidate();
  const composed = composeCanonicalPaperProfitInput({
    paperCandidate: candidate,
    calibration: calibration(candidate),
    costEvidence: costEvidence(candidate, { components: { spread: component(9.9, "tampered:spread") } }),
    nowMs: NOW,
  });
  assert.equal(composed.status, "NO_TRADE");
  assert.ok(composed.blockers.includes("COST_SPREAD_VALUE_MISMATCH"));
});

test("stale or unsafe cost evidence cannot become Profit Gate input", () => {
  const candidate = paperCandidate();
  const stale = costEvidence(candidate, { components: { latency: component(0.01, "runtime:latency", "ESTIMATED", NOW - 30_001) } });
  const staleResult = composeCanonicalPaperProfitInput({ paperCandidate: candidate, calibration: calibration(candidate), costEvidence: stale, nowMs: NOW });
  assert.equal(staleResult.status, "NO_TRADE");
  assert.ok(staleResult.blockers.includes("COST_LATENCY_STALE"));

  const unsafe = composeCanonicalPaperProfitInput({
    paperCandidate: candidate,
    calibration: calibration(candidate),
    costEvidence: costEvidence(candidate, { privateApiUsed: true }),
    nowMs: NOW,
  });
  assert.equal(unsafe.status, "NO_TRADE");
  assert.ok(unsafe.blockers.includes("COST_EVIDENCE_SAFETY_INVALID"));
});

test("Futures cannot inherit the runtime default parity pass without explicit parity evidence", () => {
  const candidate = paperCandidate("CRYPTO_FUTURES", "LONG");
  const blocked = composeCanonicalPaperProfitInput({ paperCandidate: candidate, calibration: calibration(candidate), costEvidence: costEvidence(candidate), nowMs: NOW });
  assert.equal(blocked.status, "NO_TRADE");
  assert.equal(blocked.profitInput.featureParity.pass, false);
  assert.ok(blocked.blockers.includes("FUTURES_FEATURE_PARITY_EVIDENCE_REQUIRED"));

  const ready = composeCanonicalPaperProfitInput({
    paperCandidate: candidate,
    calibration: calibration(candidate),
    costEvidence: costEvidence(candidate),
    featureParity: futuresParity(),
    nowMs: NOW,
  });
  assert.equal(ready.status, "PROFIT_INPUT_READY");
  assert.equal(ready.profitInput.featureParity.pass, true);
});

test("non-READY Forward calibration cannot be rescued by complete cost evidence", () => {
  const candidate = paperCandidate();
  const notReady = { ...calibration(candidate), status: "INSUFFICIENT_SAMPLE", calibration: { status: "INSUFFICIENT_SAMPLE", sampleSize: 12, tpFirstCount: 7 } };
  const composed = composeCanonicalPaperProfitInput({ paperCandidate: candidate, calibration: notReady, costEvidence: costEvidence(candidate), nowMs: NOW });
  assert.equal(composed.status, "NO_TRADE");
  assert.ok(composed.blockers.includes("FORWARD_CALIBRATION_NOT_READY"));
  assert.equal(composed.profitInput.costs.status, "MISSING");
});

test("#512 callback seam consumes only caller-supplied authoritative calibration and cost evidence", async () => {
  const candidate = paperCandidate();
  const card = { paperCandidate: candidate };
  let calibrationReads = 0;
  let costReads = 0;
  const profitInputForCard = createCanonicalPaperProfitInputForCard({
    calibrationForCard: async () => { calibrationReads += 1; return calibration(candidate); },
    costEvidenceForCard: async () => { costReads += 1; return costEvidence(candidate); },
    now: () => NOW,
  });
  const input = await profitInputForCard(card, "KR_STOCK");
  assert.equal(calibrationReads, 1);
  assert.equal(costReads, 1);
  assert.equal(input.costs.status, "READY");
  assert.equal(evaluateProfitGate({ market: "KR_STOCK", ...input }).eligible, true);
});

test("Profit Gate readiness does not fabricate missing learning/risk/execution evidence into a Paper entry", () => {
  const candidate = paperCandidate();
  const composed = composeCanonicalPaperProfitInput({ paperCandidate: candidate, calibration: calibration(candidate), costEvidence: costEvidence(candidate), nowMs: NOW });
  const profitGate = evaluateProfitGate({ market: "KR_STOCK", ...composed.profitInput });
  const profitEvidence = profitEvidenceFromMeaningfulSearchGate({ market: "KR_STOCK", profitInput: composed.profitInput, profitGate });
  const bridge = prepareMeaningfulSearchPaperCandidate({ searchOutcome: "TRADE_CANDIDATES", candidate, profitGate, profitEvidence });
  assert.equal(profitGate.eligible, true);
  assert.equal(bridge.submitToPaper, false);
  assert.equal(bridge.status, "BLOCKED");
  assert.ok(bridge.blockers.includes("LEARNING_SNAPSHOT_REQUIRED"));
  assert.ok(bridge.blockers.includes("RISK_EVIDENCE_NOT_APPROVED"));
  assert.ok(bridge.blockers.includes("BLOCKED_DATA"));
});
