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
  assert.equal(result.executionAuthority, "NONE");
});

test("next cycle can trigger stop but still exposes no net economics", async () => {
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

  const second = await runPumpProspectivePaperCycleV1({
    state: first.state,
    nowMs: firstNow + 2 * MINUTE,
    collectSignals: async () => sourceResult(),
    collectNextBarOpen: async () => ({ status: "BLOCKED_DATA", blocker: "SHOULD_NOT_BE_USED" }),
    collectMinutePath: async ({ startTime }) => ({
      status: "READY",
      candles: [{
        timestampMs: startTime,
        open: 130, high: 131, low: 129, close: 130, quoteVolume: 1000,
      }],
    }),
  });

  assert.equal(second.summary.exitTriggered, 1);
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
