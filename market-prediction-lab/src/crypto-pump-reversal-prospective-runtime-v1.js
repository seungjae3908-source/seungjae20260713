import { BitgetPublicClient } from "./bitget-public-client.js";
import { collectPumpReversalCleanPublicSignals } from "./crypto-pump-reversal-public-source-v1.js";
import {
  collectPumpClosedOneMinutePathV1,
  collectPumpNextBarOpenReferenceV1,
} from "./crypto-pump-reversal-execution-public-source-v1.js";
import {
  admitPumpProspectiveSignalToStateV1,
  advancePumpProspectiveRecordV1,
  markPumpProspectiveEntryMissedV1,
  markPumpProspectiveSignalScanCompletedV1,
  openPumpProspectiveRecordV1,
  pumpProspectiveStateSummaryV1,
  validatePumpProspectiveStateV1,
} from "./crypto-pump-reversal-prospective-state-v1.js";

export const PUMP_PROSPECTIVE_RUNTIME_VERSION =
  "crypto-pump-reversal-prospective-runtime-v1";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function publicSafety() {
  return Object.freeze({
    publicOnly: true,
    privateRequestCount: 0,
    financialMutationCount: 0,
    realOrderCount: 0,
    executionAuthority: "NONE",
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    profitabilityProven: false,
    profitabilityClaimAllowed: false,
    profitabilityCredit: 0,
  });
}

function nextMinuteStart(record) {
  return record.lastMinuteObservedAtMs == null
    ? record.position.entryTimestampMs
    : record.lastMinuteObservedAtMs + MINUTE_MS;
}

export async function runPumpProspectivePaperCycleV1({
  state,
  nowMs = Date.now(),
  collectSignals,
  collectNextBarOpen,
  collectMinutePath,
} = {}) {
  validatePumpProspectiveStateV1(state);
  if (!Number.isSafeInteger(nowMs) || nowMs < state.updatedAtMs) {
    throw new Error("PUMP_RUNTIME_CLOCK_INVALID");
  }
  for (const dependency of [collectSignals, collectNextBarOpen, collectMinutePath]) {
    if (typeof dependency !== "function") throw new TypeError("Pump runtime dependencies must be functions");
  }

  let nextState = state;
  const events = [];
  const blockers = [];

  const scanBarCloseMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const scanRequired = nextState.lastSignalScanBarCloseMs !== scanBarCloseMs;
  let source = null;

  if (scanRequired) {
    try {
      source = await collectSignals({
        nowMs,
        lastEntryAtBySymbol: nextState.lastEntryAtBySymbol,
      });
    } catch (error) {
      blockers.push(String(error?.code ?? error?.message ?? "PUMP_SIGNAL_SOURCE_FAILED"));
      source = null;
    }

    if (source && source.status === "READY") {
      for (const item of source.signals ?? []) {
        try {
          const admitted = admitPumpProspectiveSignalToStateV1(
            nextState,
            item.signal,
            nowMs,
          );
          nextState = admitted.state;
          events.push(Object.freeze({
            stage: "SIGNAL",
            symbol: item.signal.symbol,
            signalId: item.signal.signalId,
            status: admitted.status,
            recordId: admitted.record?.recordId ?? null,
          }));
        } catch (error) {
          const code = String(error?.code ?? error?.message ?? "PUMP_SIGNAL_ADMISSION_FAILED");
          blockers.push(code);
          events.push(Object.freeze({
            stage: "SIGNAL",
            symbol: item?.signal?.symbol ?? null,
            signalId: item?.signal?.signalId ?? null,
            status: "BLOCKED",
            blocker: code,
          }));
        }
      }
      nextState = markPumpProspectiveSignalScanCompletedV1(nextState, {
        scanBarCloseMs,
        observedAtMs: nowMs,
      }).state;
    } else if (source) {
      blockers.push(source.blocker ?? "PUMP_SIGNAL_SOURCE_BLOCKED");
    }
  }

  // Entry is attempted only while the exact next 1H bar is still current.
  const waiting = nextState.records.filter((record) => record.status === "WAITING_NEXT_BAR");
  for (const record of waiting) {
    if (nowMs < record.observation.nextBarOpenTimestampMs) continue;
    try {
      const entry = await collectNextBarOpen({
        symbol: record.observation.symbol,
        expectedOpenAtMs: record.observation.nextBarOpenTimestampMs,
        observedAtMs: nowMs,
      });
      if (entry?.status === "READY") {
        const opened = openPumpProspectiveRecordV1(nextState, {
          recordId: record.recordId,
          nextHourCandle: {
            timestampMs: entry.sourceCandleTimestampMs,
            open: entry.entryReferencePrice,
          },
          observedAtMs: nowMs,
        });
        nextState = opened.state;
        events.push(Object.freeze({
          stage: "ENTRY",
          symbol: record.observation.symbol,
          recordId: record.recordId,
          status: opened.status,
          entryTimestampMs: opened.record?.position?.entryTimestampMs ?? null,
          entryReferencePrice: opened.record?.position?.entryPrice ?? null,
          actualExchangeFillClaim: false,
        }));
      } else if (entry?.status === "MISSED") {
        const missed = markPumpProspectiveEntryMissedV1(nextState, {
          recordId: record.recordId,
          blocker: entry.blocker ?? "PUMP_NEXT_BAR_CAPTURE_WINDOW_EXPIRED",
          observedAtMs: nowMs,
        });
        nextState = missed.state;
        events.push(Object.freeze({
          stage: "ENTRY",
          symbol: record.observation.symbol,
          recordId: record.recordId,
          status: "ENTRY_MISSED",
          blocker: missed.record.entryBlocker,
        }));
      } else {
        const blocker = entry?.blocker ?? "PUMP_NEXT_BAR_OPEN_BLOCKED";
        blockers.push(blocker);
        events.push(Object.freeze({
          stage: "ENTRY",
          symbol: record.observation.symbol,
          recordId: record.recordId,
          status: "BLOCKED_DATA",
          blocker,
        }));
      }
    } catch (error) {
      const code = String(error?.code ?? error?.message ?? "PUMP_ENTRY_SOURCE_FAILED");
      blockers.push(code);
      events.push(Object.freeze({
        stage: "ENTRY",
        symbol: record.observation.symbol,
        recordId: record.recordId,
        status: "BLOCKED_DATA",
        blocker: code,
      }));
    }
  }

  // Process all currently open positions, including positions opened above.
  const openRecords = nextState.records.filter((record) => record.status === "OPEN");
  for (const record of openRecords) {
    const startTime = nextMinuteStart(record);
    if (Math.floor(nowMs / MINUTE_MS) * MINUTE_MS <= startTime) continue;
    try {
      const path = await collectMinutePath({
        symbol: record.observation.symbol,
        startTime,
        endTime: nowMs,
      });
      if (path?.status !== "READY") {
        const blocker = path?.blocker ?? "PUMP_1M_PATH_BLOCKED";
        blockers.push(blocker);
        events.push(Object.freeze({
          stage: "POSITION",
          symbol: record.observation.symbol,
          recordId: record.recordId,
          status: "BLOCKED_DATA",
          blocker,
        }));
        continue;
      }
      if (!Array.isArray(path.candles) || path.candles.length === 0) continue;
      const advanced = advancePumpProspectiveRecordV1(nextState, {
        recordId: record.recordId,
        minuteCandles: path.candles,
        observedAtMs: nowMs,
      });
      nextState = advanced.state;
      events.push(Object.freeze({
        stage: "POSITION",
        symbol: record.observation.symbol,
        recordId: record.recordId,
        status: advanced.status,
        exitReason: advanced.record?.exitTrigger?.reason ?? null,
        grossReturnPercent: advanced.record?.grossReturnPercent ?? null,
        netReturnPercent: null,
        fullCostSettlementStatus: advanced.record?.fullCostSettlementStatus
          ?? "MISSING_CANONICAL_FULL_COST",
      }));
    } catch (error) {
      const code = String(error?.code ?? error?.message ?? "PUMP_1M_PATH_FAILED");
      blockers.push(code);
      events.push(Object.freeze({
        stage: "POSITION",
        symbol: record.observation.symbol,
        recordId: record.recordId,
        status: "BLOCKED_DATA",
        blocker: code,
      }));
    }
  }

  const summary = pumpProspectiveStateSummaryV1(nextState);
  const uniqueBlockers = unique(blockers);
  return deepFreeze({
    schemaVersion: PUMP_PROSPECTIVE_RUNTIME_VERSION,
    status: scanRequired && (source == null || (source.status !== "READY" && events.length === 0))
      ? "BLOCKED_DATA"
      : "COMPLETED",
    observedAtMs: nowMs,
    signalScanRequired: scanRequired,
    scanBarCloseMs,
    sourceStatus: scanRequired ? (source?.status ?? "FAILED") : "SKIPPED_ALREADY_SCANNED",
    sourceDecision: source?.decision ?? null,
    sourceSignalCount: Number(source?.signalCount ?? 0),
    events,
    blockers: uniqueBlockers,
    state: nextState,
    summary,
    canonicalFullCostSettlementConnected: false,
    canonicalProfitAdmissionConnected: false,
    nextBlocker: summary.exitTriggered > 0
      ? "CANONICAL_FULL_COST_SETTLEMENT_NOT_CONNECTED"
      : "COLLECT_GENUINE_FUTURE_PROSPECTIVE_EVENTS",
    ...publicSafety(),
  });
}

export function createPumpProspectivePaperRuntimeV1({
  client = new BitgetPublicClient(),
  collectSignals = collectPumpReversalCleanPublicSignals,
  collectNextBarOpen = collectPumpNextBarOpenReferenceV1,
  collectMinutePath = collectPumpClosedOneMinutePathV1,
} = {}) {
  if (!client || typeof client.get !== "function") throw new TypeError("Bitget public client is required");
  return Object.freeze({
    async run({ state, nowMs = Date.now() } = {}) {
      return runPumpProspectivePaperCycleV1({
        state,
        nowMs,
        collectSignals: (input) => collectSignals({ ...input, client }),
        collectNextBarOpen: (input) => collectNextBarOpen({ ...input, client }),
        collectMinutePath: (input) => collectMinutePath({ ...input, client }),
      });
    },
    executionAuthority: "NONE",
    liveTrading: false,
    privateTradingApiAllowed: false,
  });
}
