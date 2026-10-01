import assert from "node:assert/strict";
import test from "node:test";

import { runPumpProspectivePaperCycleV1 } from "../src/crypto-pump-reversal-prospective-runtime-v1.js";
import { createPumpProspectiveStateV1 } from "../src/crypto-pump-reversal-prospective-state-v1.js";
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
const SHA = "c".repeat(40);

function policy() {
  return buildPumpProspectivePolicyV1({
    researchCodeSha: SHA,
    policyFrozenAtMs: FROZEN,
    eligibleAfterMs: ELIGIBLE,
  });
}

function signal(symbol = "ALTUSDT") {
  const confirmed = ELIGIBLE + HOUR;
  return Object.freeze({
    schemaVersion: "crypto-pump-reversal-clean-signal-v1",
    strategyId: CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1,
    strategyFamily: "EVENT_SPECIALIST",
    strategyVersion: CRYPTO_PUMP_REVERSAL_VERSION,
    parameterHash: CRYPTO_PUMP_REVERSAL_CLEAN_V1_PARAMETER_HASH,
    market: "CRYPTO_FUTURES",
    direction: "SHORT",
    symbol,
    signalId: "d".repeat(64),
    sourceBarTimestampMs: confirmed - HOUR,
    signalConfirmedAtMs: confirmed,
    nextBarOpenTimestampMs: confirmed,
    eligibleForProspectiveResearchSample: true,
    canonicalProfitAdmissionEligible: false,
    profitabilityProven: false,
    profitabilityClaimAllowed: false,
  });
}

function sourceResult(item = signal()) {
  return Object.freeze({
    status: "READY",
    decision: "PAPER_RESEARCH_SIGNALS",
    signalCount: 1,
    signals: [{ signal: item }],
  });
}

function readySizing(record, observedAtMs) {
  return Object.freeze({
    status: "READY",
    version: "pump-reversal-paper-risk-sizing-v1",
    blockers: Object.freeze([]),
    riskInput: Object.freeze({
      market: "crypto-futures",
      symbol: record.observation.symbol,
      side: "short",
      accountBalance: 1_000_000,
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
    maximumProbeNotional: 10_000,
    maximumProbeQuantity: 100,
    observedSlippagePercent: 0.1,
    observedSpreadPercent: 0.05,
    conservativeFundingRiskRate: 0.0009,
    finalQuantity: 0.1,
    finalNotional: 10,
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


function settledFullCost(record, observedAtMs) {
  const names = [
    "commission", "tax", "spread", "slippage",
    "funding", "latency", "liquidityImpact", "partialFillImpact",
  ];
  const components = Object.fromEntries(names.map((name) => [name, {
    status: "PRESENT",
    valuePercent: name === "tax" ? 0 : 0.01,
    quality: name === "tax" ? "NOT_APPLICABLE" : name === "commission" ? "DOCUMENTED" : "OBSERVED",
    source: `runtime-${name}`,
    provenance: "runtime-full-cost",
    countsAsExecutionCost: true,
    unavailableIsZero: false,
  }]));
  return Object.freeze({
    schemaVersion: "crypto-pump-reversal-full-cost-settlement-v1",
    status: "SETTLED",
    settlementId: "runtime-settlement-" + record.recordId,
    recordId: record.recordId,
    signalId: record.signal.signalId,
    candidateId: record.observation.candidateId,
    symbol: record.observation.symbol,
    direction: "SHORT",
    exitTriggerId: record.exitTrigger.exitTriggerId,
    riskSizingEvidenceDigest: record.riskSizing.evidenceDigest,
    settledAtMs: observedAtMs,
    grossPnl: -1,
    grossReturnPercent: record.grossReturnPercent,
    netPnl: -1.2,
    netReturnPercent: -1.2,
    costPolicyVersion: "pump-cost-v1",
    fullCostEvidence: Object.freeze({
      schemaVersion: "authoritative-paper-execution-cost-sources-v1",
      fullCostReady: true,
      components: Object.freeze(components),
      unknownIsZero: false,
      unavailableCostConvertedToZero: false,
    }),
    economicSampleCredit: 1,
    profitabilityClaimAllowed: false,
    executionAuthority: "NONE",
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
}

test("one cycle admits a genuine signal, captures exact next-bar open, and advances closed 1m path", async () => {
  const now = ELIGIBLE + HOUR + 2 * MINUTE + 10_000;
  const result = await runPumpProspectivePaperCycleV1({
    state: createPumpProspectiveStateV1({ policy: policy(), createdAtMs: ELIGIBLE }),
    nowMs: now,
    collectSignals: async () => sourceResult(),
    collectNextBarOpen: async ({ expectedOpenAtMs }) => ({
      status: "READY",
      sourceCandleTimestampMs: expectedOpenAtMs,
      entryReferencePrice: 100,
    }),
    collectMinutePath: async ({ startTime }) => ({
      status: "READY",
      candles: [{
        timestampMs: startTime,
        open: 100, high: 101, low: 99, close: 100, quoteVolume: 1000,
      }, {
        timestampMs: startTime + MINUTE,
        open: 100, high: 101, low: 99, close: 100, quoteVolume: 1000,
      }],
    }),
  });

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.summary.records, 1);
  assert.equal(result.summary.openPositions, 1);
  assert.equal(result.state.records[0].pathMinuteCount, 2);
  assert.equal(result.state.records[0].position.entryPrice, 100);
  assert.equal(result.canonicalFullCostSettlementConnected, false);
  assert.equal(result.riskSizingOwnerConnected, false);
  assert.equal(result.summary.riskSized, 0);
  assert.equal(result.nextBlocker, "PUMP_RISK_SIZING_OWNER_NOT_CONNECTED");
  assert.equal(result.executionAuthority, "NONE");
});

test("entry-causal Risk sizing lets a later stop reach the Full Cost blocker without net economics", async () => {
  const entryNow = ELIGIBLE + HOUR + 10_000;
  let sizingCalls = 0;
  const first = await runPumpProspectivePaperCycleV1({
    state: createPumpProspectiveStateV1({ policy: policy(), createdAtMs: ELIGIBLE }),
    nowMs: entryNow,
    collectSignals: async () => sourceResult(),
    collectNextBarOpen: async ({ expectedOpenAtMs }) => ({
      status: "READY",
      sourceCandleTimestampMs: expectedOpenAtMs,
      entryReferencePrice: 100,
    }),
    collectMinutePath: async () => ({ status: "READY", candles: [] }),
    sizePaperRisk: async ({ record, observedAtMs }) => {
      sizingCalls += 1;
      return readySizing(record, observedAtMs);
    },
  });

  assert.equal(sizingCalls, 1);
  assert.equal(first.summary.riskSized, 1);
  assert.equal(first.state.records[0].riskSizingStatus, "READY");
  assert.equal(first.state.records[0].riskSizing.result.finalQuantity, 0.1);

  const second = await runPumpProspectivePaperCycleV1({
    state: first.state,
    nowMs: ELIGIBLE + HOUR + 2 * MINUTE + 10_000,
    collectSignals: async () => sourceResult(),
    collectNextBarOpen: async () => ({ status: "BLOCKED_DATA", blocker: "SHOULD_NOT_BE_USED" }),
    collectMinutePath: async ({ startTime }) => ({
      status: "READY",
      candles: [{
        timestampMs: startTime,
        open: 100, high: 101, low: 99, close: 100, quoteVolume: 1000,
      }, {
        timestampMs: startTime + MINUTE,
        open: 130, high: 131, low: 129, close: 130, quoteVolume: 1000,
      }],
    }),
    sizePaperRisk: async () => {
      throw new Error("SIZING_MUST_NOT_REPEAT_AFTER_READY");
    },
  });

  assert.equal(second.summary.exitTriggered, 1);
  assert.equal(second.summary.riskSizedExitTriggered, 1);
  assert.equal(second.summary.netEconomicOutcomesAvailable, 0);
  assert.equal(second.state.records[0].exitTrigger.reason, "STOP_25_PERCENT");
  assert.equal(second.state.records[0].netReturnPercent, null);
  assert.equal(second.nextBlocker, "CANONICAL_FULL_COST_SETTLEMENT_NOT_CONNECTED");
});

test("missed next-bar reference becomes terminal ENTRY_MISSED", async () => {
  const now = ELIGIBLE + 2 * HOUR;
  const result = await runPumpProspectivePaperCycleV1({
    state: createPumpProspectiveStateV1({ policy: policy(), createdAtMs: ELIGIBLE }),
    nowMs: now,
    collectSignals: async () => sourceResult(),
    collectNextBarOpen: async () => ({
      status: "MISSED",
      blocker: "PUMP_NEXT_BAR_CAPTURE_WINDOW_EXPIRED",
    }),
    collectMinutePath: async () => ({ status: "READY", candles: [] }),
  });

  assert.equal(result.summary.entryMissed, 1);
  assert.equal(result.state.records[0].status, "ENTRY_MISSED");
  assert.equal(result.state.records[0].entryBlocker, "PUMP_NEXT_BAR_CAPTURE_WINDOW_EXPIRED");
});

test("public source failure is fail-closed and never mutates financial state", async () => {
  const state = createPumpProspectiveStateV1({ policy: policy(), createdAtMs: ELIGIBLE });
  const result = await runPumpProspectivePaperCycleV1({
    state,
    nowMs: ELIGIBLE + HOUR,
    collectSignals: async () => ({ status: "BLOCKED_DATA", blocker: "BITGET_DOWN", signals: [] }),
    collectNextBarOpen: async () => { throw new Error("SHOULD_NOT_CALL"); },
    collectMinutePath: async () => { throw new Error("SHOULD_NOT_CALL"); },
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.summary.records, 0);
  assert.deepEqual(result.state, state);
  assert.equal(result.financialMutationCount, 0);
  assert.equal(result.realOrderCount, 0);
});


test("same closed-hour bucket skips the expensive universe scan but continues 1m position monitoring", async () => {
  const firstNow = ELIGIBLE + HOUR + 2 * MINUTE + 10_000;
  const first = await runPumpProspectivePaperCycleV1({
    state: createPumpProspectiveStateV1({ policy: policy(), createdAtMs: ELIGIBLE }),
    nowMs: firstNow,
    collectSignals: async () => sourceResult(),
    collectNextBarOpen: async ({ expectedOpenAtMs }) => ({
      status: "READY",
      sourceCandleTimestampMs: expectedOpenAtMs,
      entryReferencePrice: 100,
    }),
    collectMinutePath: async ({ startTime }) => ({
      status: "READY",
      candles: [{
        timestampMs: startTime,
        open: 100, high: 101, low: 99, close: 100, quoteVolume: 1000,
      }, {
        timestampMs: startTime + MINUTE,
        open: 100, high: 101, low: 99, close: 100, quoteVolume: 1000,
      }],
    }),
  });

  let scans = 0;
  const second = await runPumpProspectivePaperCycleV1({
    state: first.state,
    nowMs: firstNow + MINUTE,
    collectSignals: async () => {
      scans += 1;
      return sourceResult();
    },
    collectNextBarOpen: async () => {
      throw new Error("SHOULD_NOT_CALL_ENTRY");
    },
    collectMinutePath: async ({ startTime }) => ({
      status: "READY",
      candles: [{
        timestampMs: startTime,
        open: 100, high: 101, low: 99, close: 100, quoteVolume: 1000,
      }],
    }),
  });

  assert.equal(scans, 0);
  assert.equal(second.signalScanRequired, false);
  assert.equal(second.sourceStatus, "SKIPPED_ALREADY_SCANNED");
  assert.equal(second.state.records[0].pathMinuteCount, 3);
});


test("blocked entry sizing expires on the next minute and is never retried again", async () => {
  const entryNow = ELIGIBLE + HOUR + 10_000;
  let sizingCalls = 0;
  const first = await runPumpProspectivePaperCycleV1({
    state: createPumpProspectiveStateV1({ policy: policy(), createdAtMs: ELIGIBLE }),
    nowMs: entryNow,
    collectSignals: async () => sourceResult(),
    collectNextBarOpen: async ({ expectedOpenAtMs }) => ({
      status: "READY",
      sourceCandleTimestampMs: expectedOpenAtMs,
      entryReferencePrice: 100,
    }),
    collectMinutePath: async () => ({ status: "READY", candles: [] }),
    sizePaperRisk: async () => {
      sizingCalls += 1;
      return { status: "BLOCKED", blockers: ["PUMP_PAPER_ACCOUNT_EVIDENCE_STALE"] };
    },
  });
  assert.equal(sizingCalls, 1);
  assert.equal(first.state.records[0].riskSizingStatus, "MISSING");

  const secondNow = ELIGIBLE + HOUR + MINUTE + 10_000;
  const second = await runPumpProspectivePaperCycleV1({
    state: first.state,
    nowMs: secondNow,
    collectSignals: async () => sourceResult(),
    collectNextBarOpen: async () => { throw new Error("SHOULD_NOT_CALL_ENTRY"); },
    collectMinutePath: async ({ startTime }) => ({
      status: "READY",
      candles: [{
        timestampMs: startTime,
        open: 100, high: 101, low: 99, close: 100, quoteVolume: 1000,
      }],
    }),
    sizePaperRisk: async () => {
      sizingCalls += 1;
      throw new Error("EXPIRED_SIZING_MUST_NOT_RETRY");
    },
  });
  assert.equal(sizingCalls, 1);
  assert.equal(second.state.records[0].riskSizingStatus, "EXPIRED");
  assert.equal(second.summary.riskSizingExpired, 1);
  assert.equal(second.nextBlocker, "PUMP_RISK_SIZING_EVIDENCE_EXPIRED");

  const third = await runPumpProspectivePaperCycleV1({
    state: second.state,
    nowMs: secondNow + MINUTE,
    collectSignals: async () => sourceResult(),
    collectNextBarOpen: async () => { throw new Error("SHOULD_NOT_CALL_ENTRY"); },
    collectMinutePath: async ({ startTime }) => ({
      status: "READY",
      candles: [{
        timestampMs: startTime,
        open: 100, high: 101, low: 99, close: 100, quoteVolume: 1000,
      }],
    }),
    sizePaperRisk: async () => {
      sizingCalls += 1;
      throw new Error("EXPIRED_SIZING_MUST_NOT_RETRY");
    },
  });
  assert.equal(sizingCalls, 1);
  assert.equal(third.state.records[0].riskSizingStatus, "EXPIRED");
});


test("risk-sized exit becomes one net economic sample only after the eight-component settlement owner returns SETTLED", async () => {
  const entryNow = ELIGIBLE + HOUR + 10_000;
  const first = await runPumpProspectivePaperCycleV1({
    state: createPumpProspectiveStateV1({ policy: policy(), createdAtMs: ELIGIBLE }),
    nowMs: entryNow,
    collectSignals: async () => sourceResult(),
    collectNextBarOpen: async ({ expectedOpenAtMs }) => ({
      status: "READY",
      sourceCandleTimestampMs: expectedOpenAtMs,
      entryReferencePrice: 100,
    }),
    collectMinutePath: async () => ({ status: "READY", candles: [] }),
    sizePaperRisk: async ({ record, observedAtMs }) => readySizing(record, observedAtMs),
    settleFullCost: async () => {
      throw new Error("SETTLEMENT_MUST_WAIT_FOR_EXIT");
    },
  });
  assert.equal(first.summary.riskSized, 1);
  assert.equal(first.summary.fullCostSettled, 0);

  const secondNow = ELIGIBLE + HOUR + 2 * MINUTE + 10_000;
  let settlements = 0;
  const second = await runPumpProspectivePaperCycleV1({
    state: first.state,
    nowMs: secondNow,
    collectSignals: async () => sourceResult(),
    collectNextBarOpen: async () => ({ status: "BLOCKED_DATA", blocker: "SHOULD_NOT_BE_USED" }),
    collectMinutePath: async ({ startTime }) => ({
      status: "READY",
      candles: [{
        timestampMs: startTime,
        open: 100, high: 101, low: 99, close: 100, quoteVolume: 1000,
      }, {
        timestampMs: startTime + MINUTE,
        open: 130, high: 131, low: 129, close: 130, quoteVolume: 1000,
      }],
    }),
    sizePaperRisk: async () => {
      throw new Error("SIZING_MUST_NOT_REPEAT_AFTER_READY");
    },
    settleFullCost: async ({ record, observedAtMs }) => {
      settlements += 1;
      return settledFullCost(record, observedAtMs);
    },
  });

  assert.equal(settlements, 1);
  assert.equal(second.summary.exitTriggered, 1);
  assert.equal(second.summary.riskSizedExitTriggered, 1);
  assert.equal(second.summary.fullCostSettled, 1);
  assert.equal(second.summary.netEconomicOutcomesAvailable, 1);
  assert.equal(second.state.records[0].netPnl, -1.2);
  assert.equal(second.state.records[0].economicSampleCredit, 1);
  assert.equal(second.state.records[0].profitabilityClaimAllowed, false);
  assert.equal(second.canonicalFullCostSettlementConnected, true);
  assert.equal(second.nextBlocker, "COLLECT_GENUINE_FUTURE_PROSPECTIVE_EVENTS");
});
