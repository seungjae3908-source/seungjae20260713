import assert from "node:assert/strict";
import test from "node:test";

import { buildPumpProspectiveExecutionSampleV1 } from "../src/crypto-pump-reversal-prospective-execution-sample-v1.js";

const NOW = 1_800_000_000_000;
const SHA = "a".repeat(40);

function record() {
  return {
    recordId: "b".repeat(64),
    status: "OPEN",
    observation: {
      candidateId: "paper-candidate-v1:" + "c".repeat(64),
      strategyVersion: "clean-v1",
      parameterHash: "d".repeat(64),
      researchCodeSha: SHA,
    },
    signal: {
      strategyId: "CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1",
      market: "CRYPTO_FUTURES",
      direction: "SHORT",
      symbol: "ALTUSDT",
      signalId: "e".repeat(64),
    },
  };
}

function sizing() {
  return {
    status: "READY",
    version: "pump-reversal-paper-risk-sizing-v1",
    blockers: [],
    finalQuantity: 0.1,
    finalNotional: 10,
    canonicalProfitAdmissionEligible: false,
    profitabilityClaimAllowed: false,
    executionAuthority: "NONE",
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    prospectiveEntryExecution: {
      schemaVersion: "crypto-pump-reversal-prospective-entry-execution-v1",
      style: "SWING",
      timeframe: "1h",
      horizon: 72,
      quantity: 0.1,
      evaluatedAtMs: NOW,
      marketAdapterIdentity: { id: "crypto-futures-bitget-execution", version: "v2" },
      costPolicy: {
        version: "pump-cost-v1",
        commissionRate: 0.0006,
        taxRate: 0,
        spreadRate: 0.002,
        slippageRate: 0.001,
        fundingRate: 0,
        latencyRate: 0.0001,
        liquidityImpactRate: 0.0002,
        partialFillImpactRate: 0.0001,
      },
      executionPolicy: {
        version: "crypto-pump-reversal-prospective-entry-execution-v1",
        fillModel: "DEPTH_PARTICIPATION",
        sameBarPolicy: "STOP_FIRST",
        allowPartialFill: false,
        maxParticipationRate: 1,
      },
      dataEvidence: {
        provider: "bitget",
        provenance: "BITGET_PUBLIC_V2+BITGET_PUBLIC_UTA_V3_ORDERBOOK+public-L2",
        publicOnly: true,
        dataQuality: "READY",
        asOfMs: NOW - 100,
        maxAgeMs: 30_000,
        tickSize: 0.01,
        barProxyRealtimeAllowed: false,
        quoteEvidence: {
          available: true,
          bid: 99.9,
          ask: 100.1,
          last: 100,
          asOfMs: NOW - 100,
          maxAgeMs: 30_000,
        },
        depthEvidence: { available: true, bidSize: 10, askSize: 10 },
        contractStatus: "TRADABLE",
        minQty: 0.001,
        qtyStep: 0.001,
        quantityPrecision: 3,
        markPrice: 100,
        indexPrice: 100,
        fundingRate: 0.0001,
        openInterest: 1000,
        leverage: 2,
        maxLeverage: 20,
        marginMode: "ISOLATED",
        liquidationDistancePct: 40,
      },
      quote: { bid: 99.9, ask: 100.1, last: 100, asOfMs: NOW - 100, maxAgeMs: 30_000 },
      depth: { bidSize: 10, askSize: 10 },
      observedSlippagePercent: 0.1,
      visibleCoverageRatio: 1,
      projectedFundingRiskRate: 0.0009,
      fundingChargedAtEntry: false,
      actualExchangeFillClaim: false,
    },
  };
}

test("builds an OPEN simulated prospective execution sample without inventing Profit Gate evidence", () => {
  const sample = buildPumpProspectiveExecutionSampleV1({ record: record(), sizingResult: sizing() });
  assert.equal(sample.status, "OPEN");
  assert.equal(sample.sampleClass, "GENUINE_FUTURE_PROSPECTIVE_EXECUTION_ONLY");
  assert.equal(sample.profitGate.decision, "NOT_PROFIT_ADMITTED");
  assert.equal(sample.profitGate.eligible, false);
  assert.equal(sample.profitEvidence.expectedNetEdge, null);
  assert.equal(sample.profitEvidence.sampleSize, 0);
  assert.equal(sample.canonicalProfitAdmissionEligible, false);
  assert.equal(sample.profitabilityCredit, 0);
  assert.equal(sample.profitabilityClaimAllowed, false);
  assert.equal(sample.fill.status, "FILLED");
  assert.equal(sample.fill.filledQuantity, 0.1);
  assert.ok(sample.fill.fillPrice < 99.9);
  assert.equal(sample.fundingChargedAtEntry, false);
  assert.equal(sample.executionAuthority, "NONE");
});

test("partial visible depth cannot masquerade as a full entry sample", () => {
  const value = sizing();
  value.prospectiveEntryExecution.depth.bidSize = 0.05;
  assert.throws(
    () => buildPumpProspectiveExecutionSampleV1({ record: record(), sizingResult: value }),
    /PUMP_PROSPECTIVE_ENTRY_FULL_SIMULATED_FILL_REQUIRED/,
  );
});

test("canonical Profit admission flags remain false even when entry simulation is complete", () => {
  const sample = buildPumpProspectiveExecutionSampleV1({ record: record(), sizingResult: sizing() });
  assert.equal(sample.prospectiveExecutionSampleOnly, true);
  assert.equal(sample.canonicalProfitAdmissionEligible, false);
  assert.equal(sample.profitabilityCredit, 0);
  assert.equal(sample.profitabilityClaimAllowed, false);
  assert.equal(sample.liveOrderAllowed, false);
  assert.equal(sample.privateTradingApiAllowed, false);
  assert.equal(sample.orderSubmitted, false);
  assert.equal(sample.exchangeRequestSent, false);
});
