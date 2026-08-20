import test from "node:test";
import assert from "node:assert/strict";
import {
  projectCanonicalPaperAdmissionBundle,
  runCanonicalMeaningfulSearchPaperMarket,
} from "../src/canonical-meaningful-search-paper-runtime-v1.js";
import { prepareMeaningfulSearchPaperCandidate } from "../src/meaningful-search-paper-bridge-v1.js";
import { resolveLearningStrategyHorizon } from "../src/strategy-horizon-contract-v1.js";

const NOW = Date.UTC(2026, 7, 20, 11, 30, 0);
const RESEARCH_SHA = "0123456789abcdef0123456789abcdef01234567";

function admissionBundle({ style = "SCALPING", learningHorizon = resolveLearningStrategyHorizon(style), signalId = `bundle-${style}` } = {}) {
  return {
    schemaVersion: "scanner-paper-admission-evidence-bundle-v1",
    paperCandidate: {
      signal: {
        signalId,
        market: "CRYPTO_SPOT",
        symbol: "BTC",
        timestampMs: NOW - 2_000,
        ttlMs: 60_000,
        expiresAtMs: NOW + 58_000,
        style,
        timeframe: "1h",
        horizon: 1,
        direction: "BUY",
        signalDirection: "BUY",
        strategyIdentity: {
          strategyId: "canonical-profit-first",
          strategyVersion: "v1",
          parameterHash: "params-v1",
          researchCodeSha: RESEARCH_SHA,
          costPolicyVersion: "cost-v1",
        },
      },
      executionAuthority: "NONE",
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
      orderSubmitted: false,
      exchangeRequestSent: false,
    },
    learningSnapshot: {
      signalId,
      market: "CRYPTO_SPOT",
      symbol: "BTC",
      strategyHorizon: learningHorizon,
      direction: "BUY",
      timeframes: ["1h"],
      strategyProfileVersion: "v1",
      marketRegime: "UNKNOWN",
      immutable: true,
      executionAuthority: "NONE",
    },
    riskEvidence: {
      status: "APPROVED",
      source: "TRADING_RISK_ENGINE",
      evaluatedAtMs: NOW - 1_000,
      simulatedOnly: true,
      allowed: true,
      blockCodes: [],
      recommendedQuantity: 1,
      actualRiskPercent: 0.5,
      riskReward1: 2,
      riskReward2: 3,
      executionAuthority: "NONE",
    },
    executionEvidence: {
      dataEvidence: {
        provider: "upbit",
        provenance: "public-live-test",
        publicOnly: true,
        dataQuality: "READY",
        asOfMs: NOW - 1_000,
        maxAgeMs: 60_000,
        tickSize: 1,
        marketStatus: "TRADABLE",
        minOrderNotional: 5_000,
        quoteEvidence: {
          available: true,
          bid: 99,
          ask: 100,
          asOfMs: NOW - 1_000,
          maxAgeMs: 60_000,
        },
      },
      costPolicy: {
        version: "cost-v1",
        commissionRate: 0.001,
        taxRate: 0,
        spreadRate: 0.001,
        slippageRate: 0.001,
        fundingRate: 0,
        latencyRate: 0,
        liquidityImpactRate: 0,
        partialFillImpactRate: 0,
        source: "SCANNER_COST_EVIDENCE_PERCENT_DIV_100",
        unitConversion: "PERCENT_DIV_100",
      },
      costProvenance: { provider: "public-live-test" },
    },
    evidenceDigest: "a".repeat(64),
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
  };
}

function profitGate() {
  return { decision: "ELIGIBLE", eligible: true, reasons: [], executionAuthority: "NONE" };
}

function profitEvidence() {
  return {
    status: "READY",
    expectedNetEdge: 0.01,
    expectedNetReturn: 0.02,
    riskRewardRatio: 2,
    sampleSize: 30,
    costPolicyId: "cost-v1",
    executionAuthority: "NONE",
  };
}

function profitableInput() {
  return {
    probabilities: { tp: 0.7, sl: 0.2, expire: 0.1 },
    returns: { target: 0.05, stop: 0.02, expire: 0 },
    costs: { status: "READY", policyId: "cost-v1", components: { commission: 0.001, spread: 0.001, slippage: 0.001 } },
    calibration: { status: "READY", sampleSize: 30, tpFirstCount: 21 },
  };
}

function scannerResponse(bundle) {
  return {
    universe: { totalCount: 1, nextCursor: null, source: "public-live", partial: false, stale: false },
    execution: {
      requestedCount: 1,
      completedCount: 1,
      providerAcceptedCount: 1,
      providerErrorCount: 0,
      timeoutCount: 0,
      insufficientDataCount: 0,
      hardFilterPassCount: 1,
      hardFilterRejectedCount: 0,
      softCandidateCount: 1,
      filteredByStrategyCount: 0,
    },
    cards: [{
      market: "CRYPTO_SPOT",
      symbol: "BTC",
      signalId: bundle.paperCandidate.signal.signalId,
      signalGrade: "A",
      paperCandidate: bundle.paperCandidate,
      paperAdmissionEvidenceBundle: bundle,
    }],
    failures: [],
  };
}

test("canonical learning horizon labels preserve SCALPING/SWING/MID_LONG semantics", () => {
  assert.equal(resolveLearningStrategyHorizon("SCALPING"), "SCALP");
  assert.equal(resolveLearningStrategyHorizon("SWING"), "SWING");
  assert.equal(resolveLearningStrategyHorizon("MID_LONG"), "POSITION");
  assert.equal(resolveLearningStrategyHorizon("POSITION"), "POSITION");
});

test("canonical admission projection preserves evidence but never invents Paper simulation authority", () => {
  const bundle = admissionBundle({ style: "SCALPING" });
  const candidate = projectCanonicalPaperAdmissionBundle(bundle);
  assert.ok(candidate);
  assert.equal(candidate.signal.learningSnapshot.strategyHorizon, "SCALP");
  assert.equal(candidate.riskEvidence.status, "APPROVED");
  assert.equal(candidate.execution.dataEvidence.dataQuality, "READY");
  assert.equal(candidate.execution.costPolicy.version, "cost-v1");
  assert.equal(candidate.admissionEvidence.evidenceDigest, bundle.evidenceDigest);
  assert.equal(candidate.execution.marketAdapterIdentity, undefined);
  assert.equal(candidate.execution.executionPolicy, undefined);
  assert.equal(candidate.order, undefined);

  const result = prepareMeaningfulSearchPaperCandidate({
    searchOutcome: "TRADE_CANDIDATES",
    candidate,
    profitGate: profitGate(),
    profitEvidence: profitEvidence(),
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.blockers.includes("LEARNING_HORIZON_STYLE_MISMATCH"), false);
  assert.ok(result.blockers.includes("PAPER_MARKET_ADAPTER_IDENTITY_REQUIRED"));
  assert.ok(result.blockers.includes("PAPER_EXECUTION_POLICY_REQUIRED"));
  assert.ok(result.blockers.includes("PAPER_SIMULATED_ORDER_REQUIRED"));
});

test("MID_LONG/POSITION bundle passes horizon parity while a real mismatch stays blocked", () => {
  const aligned = projectCanonicalPaperAdmissionBundle(admissionBundle({ style: "MID_LONG", learningHorizon: "POSITION" }));
  const alignedResult = prepareMeaningfulSearchPaperCandidate({
    searchOutcome: "TRADE_CANDIDATES",
    candidate: aligned,
    profitGate: profitGate(),
    profitEvidence: profitEvidence(),
  });
  assert.equal(alignedResult.blockers.includes("LEARNING_HORIZON_STYLE_MISMATCH"), false);

  const mismatched = projectCanonicalPaperAdmissionBundle(admissionBundle({ style: "MID_LONG", learningHorizon: "SCALP", signalId: "bundle-mismatch" }));
  const mismatchedResult = prepareMeaningfulSearchPaperCandidate({
    searchOutcome: "TRADE_CANDIDATES",
    candidate: mismatched,
    profitGate: profitGate(),
    profitEvidence: profitEvidence(),
  });
  assert.ok(mismatchedResult.blockers.includes("LEARNING_HORIZON_STYLE_MISMATCH"));
});

test("canonical Meaningful Search runtime consumes nested #529 bundle and fails closed before Natural Paper entry", async () => {
  const bundle = admissionBundle({ style: "SCALPING", signalId: "runtime-bundle" });
  const result = await runCanonicalMeaningfulSearchPaperMarket({
    market: "CRYPTO_SPOT",
    scanBatch: async () => scannerResponse(bundle),
    profitInputForCard: async () => profitableInput(),
  });

  assert.equal(result.search.outcome, "TRADE_CANDIDATES");
  assert.equal(result.bridgeEligibleCandidates, 0);
  assert.equal(result.bridgeBlockedCandidates, 1);
  assert.equal(result.status, "PAPER_CANDIDATE_CONTRACT_BLOCKED");
  const bridgeResult = result.paperBridge.results[0];
  assert.equal(bridgeResult.candidate.admissionEvidence.evidenceDigest, bundle.evidenceDigest);
  assert.equal(bridgeResult.blockers.includes("LEARNING_HORIZON_STYLE_MISMATCH"), false);
  assert.ok(bridgeResult.blockers.includes("PAPER_MARKET_ADAPTER_IDENTITY_REQUIRED"));
  assert.ok(bridgeResult.blockers.includes("PAPER_EXECUTION_POLICY_REQUIRED"));
  assert.ok(bridgeResult.blockers.includes("PAPER_SIMULATED_ORDER_REQUIRED"));
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.exchangeRequestSent, false);
  assert.equal(result.privateTradingApiAllowed, false);
  assert.equal(result.liveOrderAllowed, false);
});
