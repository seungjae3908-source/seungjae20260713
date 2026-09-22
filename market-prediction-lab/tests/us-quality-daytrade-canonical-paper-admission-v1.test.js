import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createUsQualityDaytradeCanonicalPaperAdmissionBundleForCard,
  resolveUsQualityDaytradeCanonicalPaperAdmission,
} from "../src/us-quality-daytrade-canonical-paper-admission-v1.js";

const NOW = 1_800_000_000_000;
const RESEARCH_SHA = "b".repeat(40);
const EVIDENCE_ID = "c".repeat(64);
const OBSERVATION_DIGEST = "d".repeat(64);
const COST_POLICY = "us-stock-cost-v1";

function stableSerialize(value) {
  if (Array.isArray(value)) return "[" + value.map(stableSerialize).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ":" + stableSerialize(value[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

function digest(value) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function withDigest(payload) {
  const copy = structuredClone(payload);
  delete copy.evidenceDigest;
  return Object.freeze({ ...copy, evidenceDigest: digest(copy) });
}

function binding(overrides = {}) {
  return Object.freeze({
    contractVersion: "us-quality-daytrade-candidate-binding-v1",
    status: "BOUND_CANDIDATE",
    reason: "SOURCE_BOUND_PRE_ENTRY_CANDIDATE",
    candidateBound: true,
    symbol: "MRK",
    qualityTier: "A",
    session: "REGULAR",
    evidenceId: EVIDENCE_ID,
    observationDigest: OBSERVATION_DIGEST,
    strategyIdentity: Object.freeze({
      strategyId: "US_QUALITY_DAYTRADE_A",
      strategyVersion: "us-quality-daytrade-trial-registry-v1",
      parameterHash: "quality-params-v1",
      researchCodeSha: RESEARCH_SHA,
      market: "US_STOCK",
      direction: "LONG",
    }),
    duplicateCountingAllowed: false,
    profitabilityEligible: false,
    selectionEligible: false,
    executionAuthority: "NONE",
    liveTradingAllowed: false,
    privateApiAllowed: false,
    orderAuthority: false,
    ...overrides,
  });
}

function costComponent(valuePercent, source, quality = "OBSERVED") {
  return Object.freeze({ valuePercent, source, quality, observedAtMs: NOW - 1_000 });
}

function validBundle(overrides = {}) {
  const signal = {
    signalId: EVIDENCE_ID,
    market: "US_STOCK",
    symbol: "MRK",
    timestampMs: NOW - 2_000,
    ttlMs: 62_000,
    expiresAtMs: NOW + 60_000,
    style: "SWING",
    timeframe: "1h",
    horizon: 12,
    direction: "BUY",
    signalDirection: "BUY",
    strategyIdentity: {
      strategyId: "US_QUALITY_DAYTRADE_A",
      strategyVersion: "us-quality-daytrade-trial-registry-v1",
      parameterHash: "quality-params-v1",
      researchCodeSha: RESEARCH_SHA,
      costPolicyVersion: COST_POLICY,
    },
  };

  const components = {
    commission: costComponent(0.05, "toss:commission"),
    tax: costComponent(0, "documented:us-stock-tax", "DOCUMENTED"),
    spread: costComponent(0.04, "toss:spread"),
    slippage: costComponent(0.05, "paper:slippage", "ESTIMATED"),
    funding: costComponent(0, "cash:funding-na", "NOT_APPLICABLE"),
    latency: costComponent(0.01, "runtime:latency", "ESTIMATED"),
    liquidityImpact: costComponent(0.02, "runtime:liquidity", "ESTIMATED"),
    partialFillImpact: costComponent(0.01, "runtime:partial-fill", "ESTIMATED"),
  };

  const payload = {
    schemaVersion: "scanner-paper-admission-evidence-bundle-v1",
    paperCandidate: {
      signal,
      executionAuthority: "NONE",
      simulatedOnly: true,
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
      orderSubmitted: false,
      exchangeRequestSent: false,
    },
    learningSnapshot: {
      immutable: true,
      executionAuthority: "NONE",
      signalId: EVIDENCE_ID,
      market: "US_STOCK",
      symbol: "MRK",
      strategyProfileVersion: signal.strategyIdentity.strategyVersion,
      direction: "BUY",
      strategyHorizon: "SWING",
      timeframes: ["1h"],
      timestamp: new Date(signal.timestampMs).toISOString(),
      dataTimestamp: new Date(signal.timestampMs - 1_000).toISOString(),
      dataProvenance: ["toss:public-us-stock", "us-quality-daytrade:" + OBSERVATION_DIGEST],
      marketRegime: "TREND",
    },
    riskEvidence: {
      status: "APPROVED",
      source: "TRADING_RISK_ENGINE",
      evaluatedAtMs: NOW - 1_000,
      simulatedOnly: true,
      allowed: true,
      blockCodes: [],
      recommendedQuantity: 3,
      actualRiskPercent: 0.5,
      riskReward1: 2,
      riskReward2: 3,
      policyIdentity: null,
      executionAuthority: "NONE",
    },
    executionEvidence: {
      dataEvidence: {
        provider: "toss",
        provenance: "toss:public-paper-readiness",
        publicOnly: true,
        dataQuality: "READY",
        asOfMs: NOW - 1_000,
        maxAgeMs: 5_000,
        tickSize: 0.01,
        barProxyRealtimeAllowed: false,
        quoteEvidence: {
          available: true,
          bid: 104.45,
          ask: 104.55,
          last: 104.5,
          asOfMs: NOW - 500,
          maxAgeMs: 5_000,
        },
        taxPolicyKnown: true,
        taxPolicyVersion: "us-stock-tax-v1",
        session: { version: "us-session-v1", status: "OPEN", kind: "REGULAR" },
        privateApiUsed: false,
        privateTradingApiAllowed: false,
        liveOrderAllowed: false,
        orderSubmitted: false,
        exchangeRequestSent: false,
      },
      costPolicy: {
        version: COST_POLICY,
        commissionRate: 0.0005,
        taxRate: 0,
        spreadRate: 0.0004,
        slippageRate: 0.0005,
        fundingRate: 0,
        latencyRate: 0.0001,
        liquidityImpactRate: 0.0002,
        partialFillImpactRate: 0.0001,
        source: "SCANNER_COST_EVIDENCE_PERCENT_DIV_100",
        unitConversion: "PERCENT_DIV_100",
      },
      costProvenance: {
        market: "US_STOCK",
        policyId: COST_POLICY,
        paperCostPolicyVersion: COST_POLICY,
        providerProvenance: "toss:public-paper-readiness",
        taxPolicyVersion: "us-stock-tax-v1",
        components,
      },
    },
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
  };

  const merged = {
    ...payload,
    ...overrides,
    paperCandidate: overrides.paperCandidate ?? payload.paperCandidate,
    learningSnapshot: overrides.learningSnapshot ?? payload.learningSnapshot,
    riskEvidence: overrides.riskEvidence ?? payload.riskEvidence,
    executionEvidence: overrides.executionEvidence ?? payload.executionEvidence,
  };
  return withDigest(merged);
}

test("source-bound US Quality candidate reaches existing canonical simulated Paper authority without live authority", () => {
  const result = resolveUsQualityDaytradeCanonicalPaperAdmission({
    candidateBinding: binding(),
    bundle: validBundle(),
    nowMs: NOW,
  });

  assert.equal(result.status, "READY");
  assert.equal(result.paperAdmissionReady, true);
  assert.equal(result.simulationReady, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.sourceEvidenceId, EVIDENCE_ID);
  assert.equal(result.sourceObservationDigest, OBSERVATION_DIGEST);
  assert.equal(result.admission.status, "BRIDGE_READY");
  assert.equal(result.simulation.status, "READY");
  assert.equal(result.simulation.marketAdapterIdentity.id, "us-stock-toss-execution");
  assert.equal(result.simulation.order.type, "MARKET");
  assert.equal(result.simulation.order.direction, "BUY");
  assert.equal(result.simulation.order.quantity, 3);
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.liveOrderAllowed, false);
  assert.equal(result.privateTradingApiAllowed, false);
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.exchangeRequestSent, false);
  assert.equal(result.profitabilityClaimAllowed, false);
});

test("canonical bundle must use the exact source-bound evidenceId as signalId", () => {
  const base = validBundle();
  const badSignal = { ...base.paperCandidate.signal, signalId: "e".repeat(64) };
  const bad = withDigest({
    ...base,
    paperCandidate: { ...base.paperCandidate, signal: badSignal },
    learningSnapshot: { ...base.learningSnapshot, signalId: badSignal.signalId },
  });

  const result = resolveUsQualityDaytradeCanonicalPaperAdmission({
    candidateBinding: binding(),
    bundle: bad,
    nowMs: NOW,
  });

  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("US_QUALITY_CANONICAL_SIGNAL_ID_MISMATCH"));
  assert.equal(result.paperAdmissionReady, false);
});

test("strategy identity cannot drift between US Quality binding and canonical Paper bundle", () => {
  const base = validBundle();
  const badIdentity = {
    ...base.paperCandidate.signal.strategyIdentity,
    researchCodeSha: "f".repeat(40),
  };
  const badSignal = { ...base.paperCandidate.signal, strategyIdentity: badIdentity };
  const bad = withDigest({
    ...base,
    paperCandidate: { ...base.paperCandidate, signal: badSignal },
  });

  const result = resolveUsQualityDaytradeCanonicalPaperAdmission({
    candidateBinding: binding(),
    bundle: bad,
    nowMs: NOW,
  });

  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("US_QUALITY_CANONICAL_RESEARCH_SHA_MISMATCH"));
});

test("authoritative risk and cost evidence remain mandatory and are never fabricated by US Quality adapter", () => {
  const base = validBundle();
  const denied = withDigest({
    ...base,
    riskEvidence: {
      ...base.riskEvidence,
      status: "BLOCKED",
      allowed: false,
      blockCodes: ["RISK_LIMIT"],
    },
  });

  const result = resolveUsQualityDaytradeCanonicalPaperAdmission({
    candidateBinding: binding(),
    bundle: denied,
    nowMs: NOW,
  });

  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("CANONICAL_ADMISSION:RISK_EVIDENCE_NOT_APPROVED"));
  assert.equal(result.simulationReady, false);
  assert.equal(result.executionAuthority, "NONE");
});

test("factory fits existing admission-bundle injection callback and fail-closes exact identity mismatch", async () => {
  const canonical = validBundle();
  const callback = createUsQualityDaytradeCanonicalPaperAdmissionBundleForCard({
    candidateBindingForCard: async () => binding(),
    canonicalBundleForCard: async () => canonical,
    now: () => NOW,
  });

  const ready = await callback({ id: "quality-card-1" }, "US_STOCK");
  assert.deepEqual(ready, canonical);
  assert.equal(await callback({ id: "other-market" }, "KR_STOCK"), null);

  const blockedCallback = createUsQualityDaytradeCanonicalPaperAdmissionBundleForCard({
    candidateBindingForCard: async () => binding(),
    canonicalBundleForCard: async () => {
      const base = validBundle();
      const signal = { ...base.paperCandidate.signal, signalId: "0".repeat(64) };
      return withDigest({
        ...base,
        paperCandidate: { ...base.paperCandidate, signal },
        learningSnapshot: { ...base.learningSnapshot, signalId: signal.signalId },
      });
    },
    now: () => NOW,
  });

  await assert.rejects(
    () => blockedCallback({ id: "quality-card-bad" }, "US_STOCK"),
    (error) => {
      assert.equal(error.code, "AUTHORITATIVE_ADMISSION_EVIDENCE_BLOCKED");
      assert.ok(error.authoritativeAdmissionBlockers.includes("US_QUALITY_CANONICAL_SIGNAL_ID_MISMATCH"));
      return true;
    },
  );
});
