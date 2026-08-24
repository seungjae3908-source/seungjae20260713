import test from "node:test";
import assert from "node:assert/strict";
import { runCanonicalMeaningfulSearchPaperMarketWithAdmissionBundles } from "../src/canonical-paper-admission-bundle-injection-runtime-v1.js";

const NOW = Date.UTC(2026, 7, 21, 0, 0, 0);
const RESEARCH_SHA = "0123456789abcdef0123456789abcdef01234567";

function response(cards = []) {
  return {
    universe: { totalCount: cards.length, nextCursor: null, source: "public-live", partial: false, stale: false },
    execution: {
      requestedCount: cards.length,
      completedCount: cards.length,
      providerAcceptedCount: cards.length,
      providerErrorCount: 0,
      timeoutCount: 0,
      insufficientDataCount: 0,
      hardFilterPassCount: cards.length,
      hardFilterRejectedCount: 0,
      softCandidateCount: cards.length,
      filteredByStrategyCount: 0,
    },
    cards,
    failures: [],
  };
}

function paperCandidate(signalId = "spot-injected") {
  return {
    signal: {
      signalId,
      market: "CRYPTO_SPOT",
      symbol: "BTC",
      timestampMs: NOW - 1_000,
      ttlMs: 60_000,
      expiresAtMs: NOW + 59_000,
      direction: "BUY",
      signalDirection: "BUY",
      lifecycle: "ACTIVE",
      positionSide: "FLAT",
      style: "SWING",
      timeframe: "4H",
      horizon: 1,
      strategyIdentity: {
        strategyId: "profit-first-swing",
        strategyVersion: "v1",
        parameterHash: "params-v1",
        researchCodeSha: RESEARCH_SHA,
        costPolicyVersion: "paper-cost-policy-v1",
      },
    },
    executionAuthority: "NONE",
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

function card(signalId = "spot-injected") {
  return {
    market: "CRYPTO_SPOT",
    symbol: "BTC",
    signalId,
    signalGrade: "A",
    paperCandidate: paperCandidate(signalId),
  };
}

function profitableInput() {
  return {
    probabilities: { tp: 0.7, sl: 0.2, expire: 0.1 },
    returns: { target: 0.05, stop: 0.02, expire: 0 },
    costs: {
      status: "READY",
      policyId: "paper-cost-policy-v1",
      components: { commission: 0.001, spread: 0.001, slippage: 0.001 },
    },
    calibration: { status: "READY", sampleSize: 200, tpFirstCount: 140 },
  };
}

function recognizedButTamperedBundle(candidate = paperCandidate()) {
  return {
    schemaVersion: "scanner-paper-admission-evidence-bundle-v1",
    paperCandidate: candidate,
    learningSnapshot: {
      signalId: candidate.signal.signalId,
      market: candidate.signal.market,
      symbol: candidate.signal.symbol,
      timestamp: new Date(candidate.signal.timestampMs).toISOString(),
      dataTimestamp: new Date(candidate.signal.timestampMs - 1_000).toISOString(),
      direction: candidate.signal.direction,
      strategyProfileVersion: candidate.signal.strategyIdentity.strategyVersion,
      timeframes: [candidate.signal.timeframe],
      dataProvenance: ["public-test"],
      immutable: true,
      executionAuthority: "NONE",
    },
    riskEvidence: {
      status: "APPROVED",
      source: "TRADING_RISK_ENGINE",
      evaluatedAtMs: NOW,
      simulatedOnly: true,
      allowed: true,
      blockCodes: [],
      recommendedQuantity: 1,
      actualRiskPercent: 0.5,
      riskReward1: 2,
      riskReward2: null,
      executionAuthority: "NONE",
    },
    executionEvidence: {
      dataEvidence: {
        provider: "upbit",
        provenance: "upbit-public-test",
        publicOnly: true,
        dataQuality: "READY",
        asOfMs: NOW,
        maxAgeMs: 30_000,
        tickSize: 1,
        quoteEvidence: { available: true, bid: 99, ask: 100, last: 100, asOfMs: NOW, maxAgeMs: 30_000 },
      },
      costPolicy: {
        version: "paper-cost-policy-v1",
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
      costProvenance: {
        market: "CRYPTO_SPOT",
        policyId: "paper-cost-policy-v1",
        paperCostPolicyVersion: "paper-cost-policy-v1",
        providerProvenance: "upbit-public-test",
        taxPolicyVersion: null,
        components: {},
      },
    },
    evidenceDigest: "0".repeat(64),
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
  };
}

test("P0-C6 injects a canonical-schema bundle into the existing #531/#532/#533 runtime path", async () => {
  let calls = 0;
  const result = await runCanonicalMeaningfulSearchPaperMarketWithAdmissionBundles({
    market: "CRYPTO_SPOT",
    scanBatch: async () => response([card()]),
    paperAdmissionBundleForCard: async (value, market) => {
      calls += 1;
      assert.equal(value.signalId, "spot-injected");
      assert.equal(market, "CRYPTO_SPOT");
      return recognizedButTamperedBundle(value.paperCandidate);
    },
    profitInputForCard: async () => profitableInput(),
    now: () => NOW,
  });

  assert.equal(calls, 1);
  assert.equal(result.admissionBlockedCandidates, 1);
  assert.equal(result.admissionBridgeReadyCandidates, 0);
  assert.ok(result.admissionBlockers.length > 0);
  assert.ok(result.admissionBlockers.includes("ADMISSION_EVIDENCE_DIGEST_MISMATCH"));
  assert.equal(result.admissionBundleInjection.callbackRequired, true);
  assert.equal(result.admissionBundleInjection.batchEvidenceEvaluation, "COMPLETE_BEFORE_FAIL_CLOSED");
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.exchangeRequestSent, false);
});

test("P0-C6 rejects non-canonical callback payloads instead of silently treating them as missing evidence", async () => {
  await assert.rejects(
    () => runCanonicalMeaningfulSearchPaperMarketWithAdmissionBundles({
      market: "CRYPTO_SPOT",
      scanBatch: async () => response([card()]),
      paperAdmissionBundleForCard: async () => ({ schemaVersion: "wrong" }),
      profitInputForCard: async () => profitableInput(),
      now: () => NOW,
    }),
    /PAPER_ADMISSION_BUNDLE_CALLBACK_INVALID/,
  );
});

test("P0-C6 allows an explicit null bundle and preserves legacy fail-closed behavior", async () => {
  const result = await runCanonicalMeaningfulSearchPaperMarketWithAdmissionBundles({
    market: "CRYPTO_SPOT",
    scanBatch: async () => response([card()]),
    paperAdmissionBundleForCard: async () => null,
    profitInputForCard: async () => profitableInput(),
    now: () => NOW,
  });

  assert.equal(result.admissionBlockedCandidates, 0);
  assert.equal(result.admissionBridgeReadyCandidates, 0);
  assert.equal(result.bridgeEligibleCandidates, 0);
  assert.equal(result.paperBridge.blocked, 1);
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.privateTradingApiAllowed, false);
});

test("P0-C6 requires an explicit bundle provider callback", async () => {
  await assert.rejects(
    () => runCanonicalMeaningfulSearchPaperMarketWithAdmissionBundles({
      market: "CRYPTO_SPOT",
      scanBatch: async () => response([card()]),
      paperAdmissionBundleForCard: null,
    }),
    /paperAdmissionBundleForCard must be a function/,
  );
});

test("P0-C6 evaluates the entire scanned batch before preserving authoritative fail-closed rejection", async () => {
  const calls = [];
  await assert.rejects(
    () => runCanonicalMeaningfulSearchPaperMarketWithAdmissionBundles({
      market: "CRYPTO_SPOT",
      scanBatch: async () => response([card("a"), card("b"), card("c")]),
      paperAdmissionBundleForCard: async (value) => {
        calls.push(value.signalId);
        const error = new Error("AUTHORITATIVE_ADMISSION_EVIDENCE_BLOCKED");
        error.code = "AUTHORITATIVE_ADMISSION_EVIDENCE_BLOCKED";
        error.authoritativeAdmissionBlockers = [`MISSING_${value.signalId}`];
        throw error;
      },
      profitInputForCard: async () => profitableInput(),
      now: () => NOW,
    }),
    (error) => {
      assert.equal(error.code, "AUTHORITATIVE_ADMISSION_EVIDENCE_BLOCKED");
      assert.deepEqual(error.authoritativeAdmissionBlockers, ["MISSING_a", "MISSING_b", "MISSING_c"]);
      return true;
    },
  );
  assert.deepEqual(calls, ["a", "b", "c"]);
});
