import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createNaturalPaperAuthoritativeSettlementCostCollector,
} from "../src/natural-paper-authoritative-settlement-cost-collector-v1.js";
import {
  createNaturalPaperTriggerBoundSettlementCostProducer,
} from "../src/natural-paper-trigger-bound-settlement-cost-producer-v1.js";

const T0 = 1_800_000_000_000;
const SHA = "a".repeat(40);
const CANDIDATE_ID = `paper-candidate-v1:${"c".repeat(64)}`;

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stable(value)).digest("hex");
}

function fixture() {
  const position = {
    positionId: "position-1",
    paperSampleId: "sample-1",
    signalId: "signal-1",
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    direction: "LONG",
    candidateId: CANDIDATE_ID,
    strategyFamily: "MOMENTUM_CROSS",
    strategyId: "strategy-1",
    strategyVersion: "v1",
    parameterHash: "params-1",
    parameterDigest: "params-1",
    researchCodeSha: SHA,
    costPolicyVersion: "cost-v1",
    accountMode: "PAPER",
    entryTimestampMs: T0 - 60_000,
    quantity: 0.01,
    sample: {
      identity: { timeframe: "15m", horizon: 4 },
      fill: { notional: 1_000, filledQuantity: 0.01 },
    },
    settlementExecutionPolicy: {
      marketAdapterIdentity: { market: "CRYPTO_FUTURES", provider: "BITGET_PUBLIC" },
      executionPolicy: {
        version: "execution-v1",
        fillModel: "TOP_OF_BOOK",
        sameBarPolicy: "STOP_FIRST",
        allowPartialFill: true,
        maxParticipationRate: 1,
      },
      strategyIdentity: {
        candidateId: CANDIDATE_ID,
        strategyFamily: "MOMENTUM_CROSS",
        strategyId: "strategy-1",
        strategyVersion: "v1",
        parameterHash: "params-1",
        parameterDigest: "params-1",
        researchCodeSha: SHA,
        accountMode: "PAPER",
      },
      costPolicyIdentity: { version: "cost-v1" },
      entryDataEvidence: {
        provider: "bitget",
        leverage: 2,
        maxLeverage: 5,
        marginMode: "ISOLATED",
        liquidationDistancePct: 40,
      },
    },
    lifecycle: {
      immutableContractDigest: "immutable-contract",
      sampleEligibility: { provenanceClass: "NATURAL_FORWARD" },
    },
  };
  const triggerPayload = {
    positionId: position.positionId,
    paperSampleId: position.paperSampleId,
    candidateId: position.candidateId,
    strategyId: position.strategyId,
    strategyIdentity: {
      candidateId: position.candidateId,
      strategyFamily: position.strategyFamily,
      strategyId: position.strategyId,
      strategyVersion: position.strategyVersion,
      parameterHash: position.parameterHash,
      parameterDigest: position.parameterDigest,
      researchCodeSha: position.researchCodeSha,
      accountMode: position.accountMode,
    },
    researchCodeSha: position.researchCodeSha,
    costPolicyVersion: position.costPolicyVersion,
    positionLifecycleDigest: position.lifecycle.immutableContractDigest,
    triggerObservationId: "obs-1",
    triggeredAtMs: T0,
    bar: { open: 100, high: 102, low: 98, close: 101 },
    source: "bitget-public-v2",
  };
  const trigger = { ...triggerPayload, exitTriggerId: digest(triggerPayload) };
  position.lifecycle.pendingExit = trigger;
  const observation = {
    observationId: "obs-1",
    positionId: position.positionId,
    observedAtMs: T0,
    maxAgeMs: 60_000,
    naturalEvidence: {
      provenanceClass: "NATURAL_FORWARD",
      synthetic: false,
      replay: false,
      testOnly: false,
      backfill: false,
      historical: false,
      duplicate: false,
    },
  };
  return { position, trigger, observation };
}

function runtimePackage() {
  return {
    buildPaperSimulatedExecutionEvidence() {},
    collectAuthoritativePaperLatencyCostEvidence() {},
    readBitgetPublicLatencyMidpointQuote() {},
  };
}

function snapshot(collectedAtMs = T0 + 200) {
  return {
    status: "PRESENT",
    collectedAtMs,
    observedAtMs: T0 + 100,
    bid: { price: 100, size: 10 },
    ask: { price: 101, size: 10 },
    quote: { bid: 100, ask: 101, last: 100.5, asOfMs: T0 + 100, maxAgeMs: 30_000 },
    depth: { bidSize: 10, askSize: 10 },
    spreadPercent: ((101 - 100) / 100.5) * 100,
    slippagePercent: 0.02,
    slippageSource: "VISIBLE_L2_BOOK_WALK_ONLY",
    latencyEvidence: {
      valuePercent: 0.01,
      quality: "ESTIMATED",
      source: "PUBLIC_MIDPOINT_ADVERSE_MOVE",
      observedAtMs: T0 + 150,
    },
    markPrice: 100.5,
    indexPrice: 100.4,
    currentFundingRate: 0.0001,
    openInterest: 1000,
    tickSize: 0.1,
    minQty: 0.001,
    qtyStep: 0.001,
    quantityPrecision: 3,
    maxLeverage: 50,
    takerFeeRate: 0.0006,
    provenance: "BITGET_PUBLIC_EXIT_L2_TICKER_FUNDING_OI_CONTRACT",
  };
}

function supplemental() {
  return {
    costPolicyId: "cost-v1",
    observedAtMs: T0 + 100,
    liquidityImpact: {
      valuePercent: 0.03,
      quality: "ESTIMATED",
      source: "authoritative-paper-liquidity-impact-cost-evidence",
      observedAtMs: T0 + 100,
    },
    partialFillImpact: {
      valuePercent: 0.01,
      quality: "ESTIMATED",
      source: "authoritative-paper-partial-fill-cost-evidence",
      observedAtMs: T0 + 100,
    },
  };
}

test("collector binds genuine 8/8 cost evidence when the holding period has no funding settlement", async () => {
  const row = fixture();
  const collector = createNaturalPaperAuthoritativeSettlementCostCollector({
    runtimePackage: runtimePackage(),
    readSupplementalCostInput: async () => supplemental(),
    bitgetClient: { get: async () => ({}) },
    collectExitSnapshot: async () => snapshot(),
    collectFundingHistory: async () => ({
      exhausted: true,
      startTime: row.position.entryTimestampMs,
      endTime: row.trigger.triggeredAtMs,
      records: [],
    }),
    now: () => T0 + 200,
  });
  const producer = createNaturalPaperTriggerBoundSettlementCostProducer({
    collectAuthoritativeEvidence: collector,
    clock: () => T0 + 250,
  });
  const result = await producer({
    position: row.position,
    observation: row.observation,
    evaluatedAtMs: T0 + 50,
  });
  assert.equal(result.status, "PRESENT");
  assert.equal(result.fullCostReady, true);
  assert.equal(result.evaluatedAtMs, T0 + 250);
  assert.deepEqual(
    Object.keys(result.observation.settlementCostEvidence.components).sort(),
    ["commission", "funding", "latency", "liquidityImpact", "partialFillImpact", "slippage", "spread", "tax"].sort(),
  );
  assert.equal(result.observation.settlementCostEvidence.components.funding.quality, "OBSERVED");
  assert.equal(result.observation.settlementCostEvidence.components.funding.valuePercent, 0);
  assert.equal(result.observation.settlementInput.fundingEvidence.complete, true);
  assert.deepEqual(result.observation.settlementInput.fundingEvidence.payments, []);
  assert.equal(result.observation.triggerBoundSettlementEvidence.executionAuthority, "NONE");
});

test("a funding boundary fails closed when exact funding-minute mark evidence is unavailable", async () => {
  const row = fixture();
  const collector = createNaturalPaperAuthoritativeSettlementCostCollector({
    runtimePackage: runtimePackage(),
    readSupplementalCostInput: async () => supplemental(),
    bitgetClient: { get: async () => ({}) },
    collectExitSnapshot: async () => snapshot(),
    collectFundingCostHistory: async () => ({
      status: "BLOCKED_DATA",
      complete: false,
      fullCoverage: false,
      blockers: ["FUNDING_MARK_PRICE_EVIDENCE_MISSING"],
      unknownIsZero: false,
    }),
    now: () => T0 + 200,
  });
  const result = await collector({
    position: row.position,
    observation: row.observation,
    exitTrigger: row.trigger,
    evaluatedAtMs: T0 + 50,
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.fullCostReady, false);
  assert.deepEqual(result.blockers, ["FUNDING_MARK_PRICE_EVIDENCE_MISSING"]);
  assert.equal(result.unknownIsZero, false);
});

test("a funding boundary becomes 8/8 Full Cost ready with exact owner evidence and excludes receipt credit", async () => {
  const row = fixture();
  const payment = Object.freeze({
    asOfMs: T0,
    amount: 0.1,
    source: "BITGET_PUBLIC_FUNDING_RATE_X_EXACT_1M_MARK_OPEN",
    provenance: "bitget-public-v2:history-fund-rate+history-mark-candles:1m:BTCUSDT",
    version: "bitget-funding-cost-only-owner-v1",
  });
  const collector = createNaturalPaperAuthoritativeSettlementCostCollector({
    runtimePackage: runtimePackage(),
    readSupplementalCostInput: async () => supplemental(),
    bitgetClient: { get: async () => ({}) },
    collectExitSnapshot: async () => snapshot(),
    collectFundingCostHistory: async () => ({
      schemaVersion: "bitget-funding-cost-only-owner-v1",
      status: "PRESENT",
      complete: true,
      fullCoverage: true,
      symbol: "BTCUSDT",
      direction: "LONG",
      quantity: row.position.quantity,
      startTime: row.position.entryTimestampMs,
      endTime: row.trigger.triggeredAtMs,
      collectedAtMs: T0 + 200,
      fundingEventCount: 1,
      markCandleCount: 1,
      payments: [payment],
      totalFundingCost: 0.1,
      excludedFundingCredit: 0.2,
      costOnlyPolicy: "PAYMENTS_COUNT_AS_COST; RECEIPTS_EXCLUDED_FROM_PROFIT",
      markPricePolicy: "EXACT_FUNDING_MINUTE_MARK_CANDLE_OPEN",
      blockers: [],
      unknownIsZero: false,
      unavailableCostConvertedToZero: false,
    }),
    now: () => T0 + 200,
  });
  const producer = createNaturalPaperTriggerBoundSettlementCostProducer({
    collectAuthoritativeEvidence: collector,
    clock: () => T0 + 250,
  });
  const result = await producer({
    position: row.position,
    observation: row.observation,
    evaluatedAtMs: T0 + 50,
  });
  assert.equal(result.status, "PRESENT");
  assert.equal(result.fullCostReady, true);
  assert.equal(result.observation.settlementCostEvidence.components.funding.valuePercent, 0.01);
  assert.equal(result.observation.settlementCostEvidence.components.funding.quality, "OBSERVED");
  assert.equal(
    result.observation.settlementCostEvidence.components.funding.markPricePolicy,
    "EXACT_FUNDING_MINUTE_MARK_CANDLE_OPEN",
  );
  assert.equal(result.observation.settlementCostEvidence.fundingReceiptCreditIncluded, false);
  assert.equal(result.observation.settlementCostEvidence.excludedFundingCredit, 0.2);
  assert.deepEqual(result.observation.settlementInput.fundingEvidence.payments, [payment]);
  assert.equal(result.observation.settlementInput.fundingEvidence.excludedFundingCredit, 0.2);
});

test("missing supplemental liquidity or partial-fill evidence is never converted to zero", async () => {
  const row = fixture();
  const collector = createNaturalPaperAuthoritativeSettlementCostCollector({
    runtimePackage: runtimePackage(),
    readSupplementalCostInput: async () => null,
    bitgetClient: { get: async () => ({}) },
    collectExitSnapshot: async () => snapshot(),
    collectFundingHistory: async () => ({ exhausted: true, records: [] }),
    now: () => T0 + 200,
  });
  const result = await collector({
    position: row.position,
    observation: row.observation,
    exitTrigger: row.trigger,
    evaluatedAtMs: T0 + 50,
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.fullCostReady, false);
  assert.deepEqual(result.blockers, ["CANONICAL_SUPPLEMENTAL_COST_EVIDENCE_MISSING"]);
  assert.equal(result.unknownIsZero, false);
});
