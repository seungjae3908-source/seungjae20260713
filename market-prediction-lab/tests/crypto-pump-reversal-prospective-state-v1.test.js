import assert from "node:assert/strict";
import test from "node:test";

import {
  admitPumpProspectiveSignalToStateV1,
  advancePumpProspectiveRecordV1,
  createPumpProspectiveStateV1,
  markPumpProspectiveEntryMissedV1,
  openPumpProspectiveRecordV1,
  pumpProspectiveStateSummaryV1,
  restorePumpProspectiveStateV1,
  serializePumpProspectiveStateV1,
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
const SHA = "b".repeat(40);

function policy() {
  return buildPumpProspectivePolicyV1({
    researchCodeSha: SHA,
    policyFrozenAtMs: FROZEN,
    eligibleAfterMs: ELIGIBLE,
  });
}

function signal(symbol = "ALTUSDT", offset = 1) {
  const confirmed = ELIGIBLE + offset * HOUR;
  return Object.freeze({
    schemaVersion: "crypto-pump-reversal-clean-signal-v1",
    strategyId: CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1,
    strategyFamily: "EVENT_SPECIALIST",
    strategyVersion: CRYPTO_PUMP_REVERSAL_VERSION,
    parameterHash: CRYPTO_PUMP_REVERSAL_CLEAN_V1_PARAMETER_HASH,
    market: "CRYPTO_FUTURES",
    direction: "SHORT",
    symbol,
    signalId: String(offset).padStart(64, "a").slice(-64),
    sourceBarTimestampMs: confirmed - HOUR,
    signalConfirmedAtMs: confirmed,
    nextBarOpenTimestampMs: confirmed,
    eligibleForProspectiveResearchSample: true,
    canonicalProfitAdmissionEligible: false,
    profitabilityProven: false,
    profitabilityClaimAllowed: false,
  });
}

test("state persists exact prospective identity and survives deterministic restore", () => {
  const p = policy();
  const state = createPumpProspectiveStateV1({ policy: p, createdAtMs: ELIGIBLE });
  const admitted = admitPumpProspectiveSignalToStateV1(state, signal(), ELIGIBLE + HOUR);
  assert.equal(admitted.status, "ADMITTED");
  const serialized = serializePumpProspectiveStateV1(admitted.state);
  const restored = restorePumpProspectiveStateV1(serialized, p);
  assert.deepEqual(restored, admitted.state);
  assert.equal(restored.records[0].netReturnPercent, null);
  assert.equal(restored.records[0].fullCostSettlementStatus, "MISSING_CANONICAL_FULL_COST");
});

test("next-bar entry creates a restart-safe research position and cooldown state", () => {
  const p = policy();
  let state = createPumpProspectiveStateV1({ policy: p, createdAtMs: ELIGIBLE });
  const admitted = admitPumpProspectiveSignalToStateV1(state, signal("ALTUSDT", 1), ELIGIBLE + HOUR);
  state = admitted.state;
  const opened = openPumpProspectiveRecordV1(state, {
    recordId: admitted.record.recordId,
    nextHourCandle: { timestampMs: admitted.record.signal.nextBarOpenTimestampMs, open: 100 },
    observedAtMs: admitted.record.signal.nextBarOpenTimestampMs + 5_000,
  });
  assert.equal(opened.status, "OPENED");
  assert.equal(opened.record.position.entryPrice, 100);
  assert.equal(opened.record.position.fillModel, "NEXT_BAR_OPEN_REFERENCE_ONLY");
  assert.equal(opened.record.position.actualExchangeFillClaim, false);
  assert.equal(opened.state.lastEntryAtBySymbol.ALTUSDT, admitted.record.signal.nextBarOpenTimestampMs);
  assert.equal(pumpProspectiveStateSummaryV1(opened.state).openPositions, 1);
});

test("a missed next-bar window is terminal and cannot be backfilled later", () => {
  const p = policy();
  const state = createPumpProspectiveStateV1({ policy: p, createdAtMs: ELIGIBLE });
  const admitted = admitPumpProspectiveSignalToStateV1(state, signal(), ELIGIBLE + HOUR);
  const missed = markPumpProspectiveEntryMissedV1(admitted.state, {
    recordId: admitted.record.recordId,
    blocker: "PUMP_NEXT_BAR_CAPTURE_WINDOW_EXPIRED",
    observedAtMs: admitted.record.signal.nextBarOpenTimestampMs + HOUR,
  });
  assert.equal(missed.status, "ENTRY_MISSED");
  assert.equal(missed.record.entryBlocker, "PUMP_NEXT_BAR_CAPTURE_WINDOW_EXPIRED");
  assert.equal(pumpProspectiveStateSummaryV1(missed.state).entryMissed, 1);

  const lateOpen = openPumpProspectiveRecordV1(missed.state, {
    recordId: admitted.record.recordId,
    nextHourCandle: { timestampMs: admitted.record.signal.nextBarOpenTimestampMs, open: 100 },
    observedAtMs: admitted.record.signal.nextBarOpenTimestampMs + HOUR + 1,
  });
  assert.equal(lateOpen.status, "ALREADY_OPENED_OR_EXITED");
  assert.equal(lateOpen.record.status, "ENTRY_MISSED");
});

test("incremental 1m path cursor advances without rereading already processed bars", () => {
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

  const first = advancePumpProspectiveRecordV1(opened.state, {
    recordId: admitted.record.recordId,
    observedAtMs: admitted.record.signal.nextBarOpenTimestampMs + 2 * MINUTE,
    minuteCandles: [{
      timestampMs: admitted.record.signal.nextBarOpenTimestampMs,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      quoteVolume: 100_000,
    }, {
      timestampMs: admitted.record.signal.nextBarOpenTimestampMs + MINUTE,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      quoteVolume: 100_000,
    }],
  });
  assert.equal(first.status, "HOLD");
  assert.equal(first.record.pathMinuteCount, 2);
  assert.equal(first.record.lastMinuteObservedAtMs, admitted.record.signal.nextBarOpenTimestampMs + MINUTE);

  const second = advancePumpProspectiveRecordV1(first.state, {
    recordId: admitted.record.recordId,
    observedAtMs: admitted.record.signal.nextBarOpenTimestampMs + 3 * MINUTE,
    minuteCandles: [{
      timestampMs: admitted.record.signal.nextBarOpenTimestampMs + MINUTE,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      quoteVolume: 100_000,
    }, {
      timestampMs: admitted.record.signal.nextBarOpenTimestampMs + 2 * MINUTE,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      quoteVolume: 100_000,
    }],
  });
  assert.equal(second.status, "HOLD");
  assert.equal(second.record.pathMinuteCount, 3);
  assert.equal(second.record.lastMinuteObservedAtMs, admitted.record.signal.nextBarOpenTimestampMs + 2 * MINUTE);
});

test("exit preserves gross path result but refuses net economics before canonical full cost", () => {
  const p = policy();
  let state = createPumpProspectiveStateV1({ policy: p, createdAtMs: ELIGIBLE });
  const admitted = admitPumpProspectiveSignalToStateV1(state, signal(), ELIGIBLE + HOUR);
  state = openPumpProspectiveRecordV1(admitted.state, {
    recordId: admitted.record.recordId,
    nextHourCandle: { timestampMs: admitted.record.signal.nextBarOpenTimestampMs, open: 100 },
    observedAtMs: admitted.record.signal.nextBarOpenTimestampMs + 1,
  }).state;
  const advanced = advancePumpProspectiveRecordV1(state, {
    recordId: admitted.record.recordId,
    observedAtMs: admitted.record.signal.nextBarOpenTimestampMs + 2 * MINUTE,
    minuteCandles: [{
      timestampMs: admitted.record.signal.nextBarOpenTimestampMs,
      open: 80,
      high: 81,
      low: 79,
      close: 80,
      quoteVolume: 100_000,
    }, {
      timestampMs: admitted.record.signal.nextBarOpenTimestampMs + MINUTE,
      open: 130,
      high: 131,
      low: 129,
      close: 130,
      quoteVolume: 100_000,
    }],
  });
  assert.equal(advanced.status, "EXIT_TRIGGERED");
  assert.equal(advanced.record.exitTrigger.reason, "STOP_25_PERCENT");
  assert.equal(advanced.record.grossReturnPercent, -30);
  assert.equal(advanced.record.netReturnPercent, null);
  assert.equal(advanced.record.netPnl, null);
  assert.equal(advanced.record.fullCostSettlementStatus, "MISSING_CANONICAL_FULL_COST");
  assert.equal(advanced.record.pathMinuteCount, 2);
  const summary = pumpProspectiveStateSummaryV1(advanced.state);
  assert.equal(summary.exitTriggered, 1);
  assert.equal(summary.netEconomicOutcomesAvailable, 0);
});

test("duplicate signal is idempotent and does not create a second record", () => {
  const p = policy();
  const state = createPumpProspectiveStateV1({ policy: p, createdAtMs: ELIGIBLE });
  const first = admitPumpProspectiveSignalToStateV1(state, signal(), ELIGIBLE + HOUR);
  const second = admitPumpProspectiveSignalToStateV1(first.state, signal(), ELIGIBLE + HOUR + 1);
  assert.equal(second.status, "DUPLICATE_SIGNAL");
  assert.equal(second.state.records.length, 1);
});
