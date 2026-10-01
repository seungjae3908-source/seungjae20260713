import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPumpCanonicalOpenSampleV1,
  buildPumpCanonicalSettlementRequestV1,
} from "../src/crypto-pump-reversal-canonical-paper-sample-v1.js";
import {
  admitPumpProspectiveSignalToStateV1,
  advancePumpProspectiveRecordV1,
  attachPumpProspectiveRiskSizingV1,
  createPumpProspectiveStateV1,
  openPumpProspectiveRecordV1,
} from "../src/crypto-pump-reversal-prospective-state-v1.js";
import { buildPumpProspectivePolicyV1 } from "../src/crypto-pump-reversal-prospective-policy-v1.js";
import {
  CRYPTO_PUMP_REVERSAL_CLEAN_V1_PARAMETER_HASH,
  CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1,
  CRYPTO_PUMP_REVERSAL_VERSION,
} from "../src/crypto-pump-reversal-clean-v1.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FROZEN = Date.parse("2026-10-01T00:00:00.000Z");
const ELIGIBLE = FROZEN + DAY;
const SHA = "9".repeat(40);

function policy() {
  return buildPumpProspectivePolicyV1({
    researchCodeSha: SHA,
    policyFrozenAtMs: FROZEN,
    eligibleAfterMs: ELIGIBLE,
  });
}

function signal() {
  const confirmed = ELIGIBLE + HOUR;
  return Object.freeze({
    schemaVersion: "crypto-pump-reversal-clean-signal-v1",
    strategyId: CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1,
    strategyFamily: "EVENT_SPECIALIST",
    strategyVersion: CRYPTO_PUMP_REVERSAL_VERSION,
    parameterHash: CRYPTO_PUMP_REVERSAL_CLEAN_V1_PARAMETER_HASH,
    market: "CRYPTO_FUTURES",
    direction: "SHORT",
    symbol: "ALTUSDT",
    signalId: "a".repeat(64),
    sourceBarTimestampMs: confirmed - HOUR,
    signalConfirmedAtMs: confirmed,
    nextBarOpenTimestampMs: confirmed,
    eligibleForProspectiveResearchSample: true,
    canonicalProfitAdmissionEligible: false,
    profitabilityProven: false,
    profitabilityClaimAllowed: false,
  });
}

function readySizing(record, observedAtMs) {
  const quote = Object.freeze({
    bid: 99.9, ask: 100.1, last: 100, asOfMs: observedAtMs, maxAgeMs: 30_000,
  });
  const dataEvidence = Object.freeze({
    provider: "bitget",
    provenance: "BITGET_PUBLIC_V2+BITGET_PUBLIC_UTA_V3_ORDERBOOK",
    publicOnly: true,
    dataQuality: "READY",
    asOfMs: observedAtMs,
    maxAgeMs: 30_000,
    tickSize: 0.01,
    barProxyRealtimeAllowed: false,
    quoteEvidence: Object.freeze({
      available: true, bid: 99.9, ask: 100.1, last: 100,
      asOfMs: observedAtMs, maxAgeMs: 30_000,
    }),
    depthEvidence: Object.freeze({ available: true, bidSize: 10, askSize: 10 }),
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
    liquidationDistancePct: 80,
    privateApiUsed: false,
    executionMode: "SIMULATED_EXECUTION_ONLY",
    publicL2Only: true,
    realFillObserved: false,
    realFillClaim: false,
    publicDepthIsFillProof: false,
    liveSubmittedExecutionSampleCredit: 0,
    privateTradingApiAllowed: false,
    liveOrderAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
  return Object.freeze({
    status: "READY",
    version: "pump-reversal-paper-risk-sizing-v1",
    blockers: Object.freeze([]),
    riskInput: Object.freeze({
      market: "crypto-futures",
      symbol: record.observation.symbol,
      side: "short",
      accountBalance: 10_000,
      entryPrice: record.position.entryPrice,
      stopLossPrice: record.position.stopPrice,
      targetPrice1: null,
      targetPrice2: null,
      leverage: 2,
      riskPercent: 0.25,
      entryFeeRate: 0.0006,
      exitFeeRate: 0.0006,
      slippageRate: 0.001,
      estimatedFundingRate: 0.0009,
      dataStatus: "live",
    }),
    riskResult: Object.freeze({
      allowed: true,
      blockCodes: Object.freeze([]),
      recommendedQuantity: 0.1,
      actualRiskPercent: 0.2,
      riskReward1: null,
      riskReward2: null,
      estimatedLiquidationPrice: 180,
      calculatedAt: new Date(observedAtMs - 1_000).toISOString(),
    }),
    maximumProbeNotional: 100,
    maximumProbeQuantity: 1,
    observedSlippagePercent: 0.01,
    observedSpreadPercent: 0.2,
    conservativeFundingRiskRate: 0.0009,
    finalQuantity: 0.1,
    finalNotional: 10,
    prospectiveEntryExecution: Object.freeze({
      schemaVersion: "crypto-pump-reversal-prospective-entry-execution-v1",
      style: "SWING",
      timeframe: "1h",
      horizon: 72,
      quantity: 0.1,
      evaluatedAtMs: observedAtMs,
      marketAdapterIdentity: Object.freeze({ id: "crypto-futures-bitget-execution", version: "v2" }),
      costPolicy: Object.freeze({
        version: "pump-cost-v1",
        commissionRate: 0.0006,
        taxRate: 0,
        spreadRate: 0.002,
        slippageRate: 0.0001,
        fundingRate: 0,
        latencyRate: 0.0001,
        liquidityImpactRate: 0.0002,
        partialFillImpactRate: 0.0001,
      }),
      executionPolicy: Object.freeze({
        version: "crypto-pump-reversal-prospective-entry-execution-v1",
        fillModel: "DEPTH_PARTICIPATION",
        sameBarPolicy: "STOP_FIRST",
        allowPartialFill: false,
        maxParticipationRate: 1,
      }),
      dataEvidence,
      quote,
      depth: Object.freeze({ bidSize: 10, askSize: 10 }),
      observedSlippagePercent: 0.01,
      visibleCoverageRatio: 1,
      projectedFundingRiskRate: 0.0009,
      fundingChargedAtEntry: false,
      actualExchangeFillClaim: false,
    }),
    riskPercent: 0.25,
    leverage: 2,
    marginMode: "isolated",
    fundingDirectionalFilterUsed: false,
    fundingCountsAsProfitabilityEvidence: false,
    simulatedOnly: true,
    canonicalProfitAdmissionEligible: false,
    profitabilityClaimAllowed: false,
    executionAuthority: "NONE",
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
}

function sizedState() {
  const p = policy();
  const admitted = admitPumpProspectiveSignalToStateV1(
    createPumpProspectiveStateV1({ policy: p, createdAtMs: ELIGIBLE }),
    signal(),
    ELIGIBLE + HOUR,
  );
  const opened = openPumpProspectiveRecordV1(admitted.state, {
    recordId: admitted.record.recordId,
    nextHourCandle: { timestampMs: admitted.record.signal.nextBarOpenTimestampMs, open: 100 },
    observedAtMs: admitted.record.signal.nextBarOpenTimestampMs + 1,
  });
  const observedAtMs = admitted.record.signal.nextBarOpenTimestampMs + 10_000;
  const sized = attachPumpProspectiveRiskSizingV1(opened.state, {
    recordId: admitted.record.recordId,
    sizing: readySizing(opened.record, observedAtMs),
    observedAtMs,
  });
  return { admitted, sized };
}

test("risk-sized Pump record builds a research-only canonical OPEN sample with no profitability claim", () => {
  const { admitted, sized } = sizedState();
  const sample = buildPumpCanonicalOpenSampleV1({
    state: sized.state,
    recordId: admitted.record.recordId,
  });
  assert.equal(sample.decision, "RESEARCH_ONLY");
  assert.equal(sample.fill.status, "FILLED");
  assert.equal(sample.fill.filledQuantity, 0.1);
  assert.equal(sample.identity.strategyId, CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1);
  assert.equal(sample.identity.researchCodeSha, SHA);
  assert.equal(sample.profitGate.eligible, false);
  assert.equal(sample.profitEvidence.sampleSize, 0);
  assert.equal(sample.canonicalProfitAdmissionEligible, false);
  assert.equal(sample.profitabilityClaimAllowed, false);
  assert.equal(sample.executionAuthority, "NONE");
});

test("exit-triggered record produces an immutable Full Cost settlement request bound to the same entry fill", () => {
  const { admitted, sized } = sizedState();
  const exited = advancePumpProspectiveRecordV1(sized.state, {
    recordId: admitted.record.recordId,
    minuteCandles: [{
      timestampMs: admitted.record.signal.nextBarOpenTimestampMs,
      open: 100, high: 130, low: 99, close: 125,
    }],
    observedAtMs: admitted.record.signal.nextBarOpenTimestampMs + MINUTE,
  });
  const request = buildPumpCanonicalSettlementRequestV1({
    state: exited.state,
    recordId: admitted.record.recordId,
  });
  assert.equal(request.sample.fill.status, "FILLED");
  assert.equal(request.entryFillPrice, request.sample.fill.fillPrice);
  assert.equal(request.entryNotional, request.sample.fill.notional);
  assert.equal(request.exitTrigger.exitTriggerId, exited.record.exitTrigger.exitTriggerId);
  assert.equal(request.requiredFullCostComponents.length, 8);
  assert.equal(request.missingCostAsZeroAllowed, false);
  assert.equal(request.settlementBeforeFullCostAllowed, false);
  assert.equal(request.profitabilityClaimAllowed, false);
  assert.match(request.settlementRequestId, /^[0-9a-f]{64}$/);
});

test("canonical sample builder refuses unsized records", () => {
  const p = policy();
  const admitted = admitPumpProspectiveSignalToStateV1(
    createPumpProspectiveStateV1({ policy: p, createdAtMs: ELIGIBLE }),
    signal(),
    ELIGIBLE + HOUR,
  );
  const opened = openPumpProspectiveRecordV1(admitted.state, {
    recordId: admitted.record.recordId,
    nextHourCandle: { timestampMs: admitted.record.signal.nextBarOpenTimestampMs, open: 100 },
    observedAtMs: admitted.record.signal.nextBarOpenTimestampMs + 1,
  });
  assert.throws(
    () => buildPumpCanonicalOpenSampleV1({ state: opened.state, recordId: admitted.record.recordId }),
    /PUMP_CANONICAL_RISK_SIZING_REQUIRED/,
  );
});
