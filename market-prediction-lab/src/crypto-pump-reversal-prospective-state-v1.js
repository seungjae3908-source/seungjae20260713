import { createHash } from "node:crypto";
import {
  admitPumpProspectiveSignalV1,
  verifyPumpProspectivePolicyV1,
} from "./crypto-pump-reversal-prospective-policy-v1.js";
import {
  detectPumpProspectiveExit,
  openPumpProspectiveResearchPosition,
} from "./crypto-pump-reversal-clean-v1.js";

export const PUMP_PROSPECTIVE_STATE_VERSION = "crypto-pump-reversal-prospective-state-v1";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const RISK_SIZING_CAPTURE_WINDOW_MS = 30_000;
const RECORD_STATUSES = new Set([
  "WAITING_NEXT_BAR",
  "ENTRY_MISSED",
  "OPEN",
  "EXIT_TRIGGERED",
]);

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clone(value) {
  return structuredClone(value);
}

function exactDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safety() {
  return Object.freeze({
    profitabilityProven: false,
    profitabilityClaimAllowed: false,
    profitabilityCredit: 0,
    canonicalProfitAdmissionEligible: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  });
}

function stateDigestPayload(state) {
  const { stateDigest: _stateDigest, ...payload } = state;
  return payload;
}

function withDigest(payload) {
  return deepFreeze({ ...payload, stateDigest: sha256(payload) });
}

function validatePathCursor(record) {
  if (!Number.isSafeInteger(record.pathMinuteCount) || record.pathMinuteCount < 0) {
    throw new Error("PUMP_PROSPECTIVE_PATH_COUNT_INVALID");
  }
  if (record.lastMinuteObservedAtMs != null
    && (!Number.isSafeInteger(record.lastMinuteObservedAtMs) || record.lastMinuteObservedAtMs <= 0)) {
    throw new Error("PUMP_PROSPECTIVE_PATH_CURSOR_INVALID");
  }
  if (record.position && record.lastMinuteObservedAtMs != null
    && record.lastMinuteObservedAtMs < record.position.entryTimestampMs) {
    throw new Error("PUMP_PROSPECTIVE_PATH_CURSOR_BEFORE_ENTRY");
  }
}

function validateReadyRiskSizing(record) {
  const evidence = record.riskSizing;
  const result = evidence?.result;
  if (!evidence
    || evidence.schemaVersion !== "crypto-pump-reversal-risk-sizing-evidence-v1"
    || !Number.isSafeInteger(evidence.attachedAtMs)
    || evidence.attachedAtMs < record.position.entryTimestampMs
    || evidence.attachedAtMs - record.position.entryTimestampMs > RISK_SIZING_CAPTURE_WINDOW_MS
    || !exactDigest(evidence.evidenceDigest)) {
    throw new Error("PUMP_PROSPECTIVE_RISK_SIZING_EVIDENCE_INVALID");
  }
  const { evidenceDigest, ...payload } = evidence;
  if (sha256(payload) !== evidenceDigest) {
    throw new Error("PUMP_PROSPECTIVE_RISK_SIZING_DIGEST_MISMATCH");
  }
  if (result?.status !== "READY"
    || result?.version !== "pump-reversal-paper-risk-sizing-v1"
    || !Array.isArray(result?.blockers)
    || result.blockers.length !== 0
    || !(Number.isFinite(result?.finalQuantity) && result.finalQuantity > 0)
    || !(Number.isFinite(result?.finalNotional) && result.finalNotional > 0)
    || !(Number.isFinite(result?.maximumProbeNotional) && result.maximumProbeNotional > 0)
    || result.finalNotional > result.maximumProbeNotional + 1e-9
    || result.riskPercent !== 0.25
    || result.leverage !== 2
    || result.marginMode !== "isolated"
    || result.fundingDirectionalFilterUsed !== false
    || result.fundingCountsAsProfitabilityEvidence !== false
    || result.simulatedOnly !== true
    || result.canonicalProfitAdmissionEligible !== false
    || result.profitabilityClaimAllowed !== false
    || result.executionAuthority !== "NONE"
    || result.liveOrderAllowed !== false
    || result.privateTradingApiAllowed !== false
    || result.orderSubmitted !== false
    || result.exchangeRequestSent !== false) {
    throw new Error("PUMP_PROSPECTIVE_RISK_SIZING_RESULT_INVALID");
  }
  const input = result.riskInput;
  const risk = result.riskResult;
  if (input?.market !== "crypto-futures"
    || input?.symbol !== record.observation.symbol
    || input?.side !== "short"
    || input?.entryPrice !== record.position.entryPrice
    || input?.stopLossPrice !== record.position.stopPrice
    || input?.leverage !== 2
    || input?.riskPercent !== 0.25
    || risk?.allowed !== true
    || !Array.isArray(risk?.blockCodes)
    || risk.blockCodes.length !== 0
    || !(Number.isFinite(risk?.recommendedQuantity) && risk.recommendedQuantity > 0)
    || result.finalQuantity > risk.recommendedQuantity + 1e-12) {
    throw new Error("PUMP_PROSPECTIVE_RISK_SIZING_LINEAGE_INVALID");
  }
  const calculatedAtMs = Date.parse(risk.calculatedAt);
  if (!Number.isFinite(calculatedAtMs)
    || calculatedAtMs > evidence.attachedAtMs
    || evidence.attachedAtMs - calculatedAtMs > RISK_SIZING_CAPTURE_WINDOW_MS) {
    throw new Error("PUMP_PROSPECTIVE_RISK_SIZING_TIME_INVALID");
  }
}

function validateRecord(record, policy) {
  if (!record
    || record.schemaVersion !== "crypto-pump-reversal-prospective-record-v1"
    || !exactDigest(record.recordId)
    || record.observation?.candidateId !== policy.candidate.candidateId
    || record.observation?.candidateDigest !== policy.candidateDigest
    || record.observation?.policyDigest !== policy.policyDigest
    || record.signal?.signalId !== record.observation?.signalId
    || record.signal?.symbol !== record.observation?.symbol
    || !RECORD_STATUSES.has(record.status)) {
    throw new Error("PUMP_PROSPECTIVE_RECORD_INVALID");
  }

  validatePathCursor(record);
  if (record.riskSizingStatus !== "MISSING" && record.riskSizingStatus !== "READY") {
    throw new Error("PUMP_PROSPECTIVE_RISK_SIZING_STATUS_INVALID");
  }
  if (record.riskSizingStatus === "MISSING" && record.riskSizing != null) {
    throw new Error("PUMP_PROSPECTIVE_RISK_SIZING_MISSING_MUTATED");
  }
  if (record.riskSizingStatus === "READY") validateReadyRiskSizing(record);

  if (record.status === "WAITING_NEXT_BAR") {
    if (record.position != null || record.exitTrigger != null || record.entryBlocker != null
      || record.lastMinuteObservedAtMs != null || record.pathMinuteCount !== 0
      || record.riskSizingStatus !== "MISSING") {
      throw new Error("PUMP_PROSPECTIVE_WAITING_RECORD_MUTATED");
    }
  }
  if (record.status === "ENTRY_MISSED") {
    if (record.position != null || record.exitTrigger != null || !nonEmpty(record.entryBlocker)
      || record.lastMinuteObservedAtMs != null || record.pathMinuteCount !== 0
      || record.riskSizingStatus !== "MISSING") {
      throw new Error("PUMP_PROSPECTIVE_MISSED_RECORD_INVALID");
    }
  }
  if (record.status === "OPEN") {
    if (!record.position || record.exitTrigger != null || record.entryBlocker != null) {
      throw new Error("PUMP_PROSPECTIVE_OPEN_RECORD_INVALID");
    }
  }
  if (record.status === "EXIT_TRIGGERED") {
    if (!record.position || !record.exitTrigger || record.entryBlocker != null) {
      throw new Error("PUMP_PROSPECTIVE_EXIT_RECORD_INVALID");
    }
  }

  if (record.netReturnPercent !== null || record.netPnl !== null
    || record.fullCostSettlementStatus !== "MISSING_CANONICAL_FULL_COST") {
    throw new Error("PUMP_PROSPECTIVE_PRE_FULL_COST_ECONOMICS_FORBIDDEN");
  }
}

export function validatePumpProspectiveStateV1(state) {
  if (!state || state.schemaVersion !== PUMP_PROSPECTIVE_STATE_VERSION) {
    throw new Error("PUMP_PROSPECTIVE_STATE_VERSION_INVALID");
  }
  const verdict = verifyPumpProspectivePolicyV1(state.policy);
  if (!verdict.valid) throw new Error(`PUMP_PROSPECTIVE_STATE_POLICY_INVALID:${verdict.blockers.join(",")}`);
  if (state.policyDigest !== state.policy.policyDigest
    || state.candidateId !== state.policy.candidate.candidateId
    || state.candidateDigest !== state.policy.candidateDigest) {
    throw new Error("PUMP_PROSPECTIVE_STATE_IDENTITY_MISMATCH");
  }
  if (!Array.isArray(state.records)) throw new Error("PUMP_PROSPECTIVE_STATE_RECORDS_INVALID");

  const recordIds = new Set();
  const signalIds = new Set();
  const openSymbols = new Set();
  for (const record of state.records) {
    validateRecord(record, state.policy);
    if (recordIds.has(record.recordId)) throw new Error("PUMP_PROSPECTIVE_DUPLICATE_RECORD_ID");
    if (signalIds.has(record.observation.signalId)) throw new Error("PUMP_PROSPECTIVE_DUPLICATE_SIGNAL_ID");
    recordIds.add(record.recordId);
    signalIds.add(record.observation.signalId);
    if (record.status === "OPEN") {
      if (openSymbols.has(record.observation.symbol)) throw new Error("PUMP_PROSPECTIVE_DUPLICATE_OPEN_SYMBOL");
      openSymbols.add(record.observation.symbol);
    }
  }

  if (!Number.isSafeInteger(state.createdAtMs) || !Number.isSafeInteger(state.updatedAtMs)
    || state.createdAtMs <= 0 || state.updatedAtMs < state.createdAtMs) {
    throw new Error("PUMP_PROSPECTIVE_STATE_TIME_INVALID");
  }
  if (state.lastSignalScanBarCloseMs != null
    && (!Number.isSafeInteger(state.lastSignalScanBarCloseMs)
      || state.lastSignalScanBarCloseMs <= 0
      || state.lastSignalScanBarCloseMs > state.updatedAtMs
      || state.lastSignalScanBarCloseMs % HOUR_MS !== 0)) {
    throw new Error("PUMP_PROSPECTIVE_SIGNAL_SCAN_CURSOR_INVALID");
  }
  if (!state.lastEntryAtBySymbol || typeof state.lastEntryAtBySymbol !== "object" || Array.isArray(state.lastEntryAtBySymbol)) {
    throw new Error("PUMP_PROSPECTIVE_COOLDOWN_STATE_INVALID");
  }
  for (const value of Object.values(state.lastEntryAtBySymbol)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > state.updatedAtMs) {
      throw new Error("PUMP_PROSPECTIVE_COOLDOWN_TIMESTAMP_INVALID");
    }
  }
  if (state.profitabilityProven !== false
    || state.profitabilityClaimAllowed !== false
    || state.profitabilityCredit !== 0
    || state.canonicalProfitAdmissionEligible !== false
    || state.liveTrading !== false
    || state.autoTrading !== false
    || state.realOrderEnabled !== false
    || state.privateTradingApiAllowed !== false
    || state.executionAuthority !== "NONE") {
    throw new Error("PUMP_PROSPECTIVE_STATE_SAFETY_INVALID");
  }
  if (!exactDigest(state.stateDigest)
    || sha256(stateDigestPayload(state)) !== state.stateDigest) {
    throw new Error("PUMP_PROSPECTIVE_STATE_DIGEST_MISMATCH");
  }
  return state;
}

export function createPumpProspectiveStateV1({ policy, createdAtMs } = {}) {
  const verdict = verifyPumpProspectivePolicyV1(policy);
  if (!verdict.valid) throw new Error(`PUMP_PROSPECTIVE_POLICY_INVALID:${verdict.blockers.join(",")}`);
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs <= 0) throw new Error("PUMP_PROSPECTIVE_STATE_CREATED_AT_INVALID");
  return withDigest({
    schemaVersion: PUMP_PROSPECTIVE_STATE_VERSION,
    policy: clone(policy),
    policyDigest: policy.policyDigest,
    candidateId: policy.candidate.candidateId,
    candidateDigest: policy.candidateDigest,
    createdAtMs,
    updatedAtMs: createdAtMs,
    records: Object.freeze([]),
    lastSignalScanBarCloseMs: null,
    lastEntryAtBySymbol: Object.freeze({}),
    ...safety(),
  });
}

export function serializePumpProspectiveStateV1(state) {
  validatePumpProspectiveStateV1(state);
  return `${stableSerialize(state)}\n`;
}

export function restorePumpProspectiveStateV1(serialized, expectedPolicy) {
  const parsed = typeof serialized === "string" ? JSON.parse(serialized) : clone(serialized);
  validatePumpProspectiveStateV1(parsed);
  const verdict = verifyPumpProspectivePolicyV1(expectedPolicy);
  if (!verdict.valid
    || parsed.policyDigest !== expectedPolicy.policyDigest
    || parsed.candidateId !== expectedPolicy.candidate.candidateId
    || parsed.candidateDigest !== expectedPolicy.candidateDigest) {
    throw new Error("PUMP_PROSPECTIVE_RESTORE_POLICY_MISMATCH");
  }
  return deepFreeze(parsed);
}

export function markPumpProspectiveSignalScanCompletedV1(state, {
  scanBarCloseMs,
  observedAtMs,
} = {}) {
  validatePumpProspectiveStateV1(state);
  if (!Number.isSafeInteger(scanBarCloseMs) || scanBarCloseMs <= 0 || scanBarCloseMs % HOUR_MS !== 0) {
    throw new Error("PUMP_PROSPECTIVE_SIGNAL_SCAN_BAR_CLOSE_INVALID");
  }
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < scanBarCloseMs || observedAtMs < state.updatedAtMs) {
    throw new Error("PUMP_PROSPECTIVE_SIGNAL_SCAN_OBSERVED_AT_INVALID");
  }
  if (state.lastSignalScanBarCloseMs != null && scanBarCloseMs < state.lastSignalScanBarCloseMs) {
    throw new Error("PUMP_PROSPECTIVE_SIGNAL_SCAN_CURSOR_REGRESSION");
  }
  if (state.lastSignalScanBarCloseMs === scanBarCloseMs) {
    return deepFreeze({ status: "ALREADY_SCANNED", state });
  }
  const next = withDigest({
    ...stateDigestPayload(state),
    updatedAtMs: observedAtMs,
    lastSignalScanBarCloseMs: scanBarCloseMs,
  });
  return deepFreeze({ status: "MARKED", state: next });
}

export function admitPumpProspectiveSignalToStateV1(state, signal, observedAtMs) {
  validatePumpProspectiveStateV1(state);
  const admission = admitPumpProspectiveSignalV1(state.policy, signal, { observedAtMs });
  if (state.records.some((record) => record.observation.signalId === admission.observation.signalId)) {
    return deepFreeze({ status: "DUPLICATE_SIGNAL", state, record: null });
  }
  const recordCore = {
    schemaVersion: "crypto-pump-reversal-prospective-record-v1",
    observation: clone(admission.observation),
    signal: clone(signal),
    status: "WAITING_NEXT_BAR",
    entryBlocker: null,
    riskSizingStatus: "MISSING",
    riskSizing: null,
    position: null,
    exitTrigger: null,
    lastMinuteObservedAtMs: null,
    pathMinuteCount: 0,
    grossReturnPercent: null,
    netReturnPercent: null,
    netPnl: null,
    fullCostSettlementStatus: "MISSING_CANONICAL_FULL_COST",
    fullCostSettlementId: null,
    profitabilityCredit: 0,
    profitabilityClaimAllowed: false,
    executionAuthority: "NONE",
  };
  const record = deepFreeze({ ...recordCore, recordId: sha256(recordCore) });
  const next = withDigest({
    ...stateDigestPayload(state),
    updatedAtMs: observedAtMs,
    records: Object.freeze([...state.records.map(clone), record]),
  });
  return deepFreeze({ status: "ADMITTED", state: next, record });
}

export function markPumpProspectiveEntryMissedV1(state, {
  recordId,
  blocker,
  observedAtMs,
} = {}) {
  validatePumpProspectiveStateV1(state);
  const index = state.records.findIndex((record) => record.recordId === recordId);
  if (index < 0) throw new Error("PUMP_PROSPECTIVE_RECORD_NOT_FOUND");
  const current = state.records[index];
  if (current.status !== "WAITING_NEXT_BAR") {
    return deepFreeze({ status: "NOT_WAITING", state, record: current });
  }
  if (!nonEmpty(blocker)) throw new Error("PUMP_PROSPECTIVE_ENTRY_BLOCKER_REQUIRED");
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < current.observation.nextBarOpenTimestampMs) {
    throw new Error("PUMP_PROSPECTIVE_ENTRY_MISSED_TIME_INVALID");
  }

  const updatedRecord = deepFreeze({
    ...current,
    status: "ENTRY_MISSED",
    entryBlocker: blocker,
  });
  const records = state.records.map((record, rowIndex) => rowIndex === index ? updatedRecord : clone(record));
  const next = withDigest({
    ...stateDigestPayload(state),
    updatedAtMs: Math.max(state.updatedAtMs, observedAtMs),
    records: Object.freeze(records),
  });
  return deepFreeze({ status: "ENTRY_MISSED", state: next, record: updatedRecord });
}

export function openPumpProspectiveRecordV1(state, {
  recordId,
  nextHourCandle,
  observedAtMs,
} = {}) {
  validatePumpProspectiveStateV1(state);
  const index = state.records.findIndex((record) => record.recordId === recordId);
  if (index < 0) throw new Error("PUMP_PROSPECTIVE_RECORD_NOT_FOUND");
  const current = state.records[index];
  if (current.status !== "WAITING_NEXT_BAR") {
    return deepFreeze({ status: "ALREADY_OPENED_OR_EXITED", state, record: current });
  }
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < current.observation.nextBarOpenTimestampMs) {
    throw new Error("PUMP_PROSPECTIVE_ENTRY_OBSERVED_AT_INVALID");
  }

  const positionBase = openPumpProspectiveResearchPosition({
    signal: current.signal,
    nextHourCandle,
  });
  const positionId = sha256({
    candidateId: state.candidateId,
    recordId,
    signalId: current.signal.signalId,
    symbol: current.signal.symbol,
    entryTimestampMs: positionBase.entryTimestampMs,
    entryPrice: positionBase.entryPrice,
  });
  const position = deepFreeze({
    ...positionBase,
    positionId,
    entryObservedAtMs: observedAtMs,
    fillModel: "NEXT_BAR_OPEN_REFERENCE_ONLY",
    actualExchangeFillClaim: false,
    canonicalProfitAdmissionEligible: false,
    profitabilityClaimAllowed: false,
    executionAuthority: "NONE",
  });
  const updatedRecord = deepFreeze({
    ...current,
    status: "OPEN",
    entryBlocker: null,
    position,
    lastMinuteObservedAtMs: null,
    pathMinuteCount: 0,
  });
  const records = state.records.map((record, rowIndex) => rowIndex === index ? updatedRecord : clone(record));
  const lastEntryAtBySymbol = Object.freeze({
    ...state.lastEntryAtBySymbol,
    [current.observation.symbol]: position.entryTimestampMs,
  });
  const next = withDigest({
    ...stateDigestPayload(state),
    updatedAtMs: Math.max(state.updatedAtMs, observedAtMs),
    records: Object.freeze(records),
    lastEntryAtBySymbol,
  });
  return deepFreeze({ status: "OPENED", state: next, record: updatedRecord });
}

function shortGrossReturnPercent(entryPrice, exitPrice) {
  return ((entryPrice - exitPrice) / entryPrice) * 100;
}

function normalizeIncrementalMinuteCandles(record, minuteCandles) {
  if (!Array.isArray(minuteCandles)) throw new Error("PUMP_PROSPECTIVE_1M_CANDLES_REQUIRED");
  const normalized = minuteCandles
    .map((candle) => ({
      timestampMs: Number(candle?.timestampMs ?? candle?.timestamp),
      open: Number(candle?.open),
      high: Number(candle?.high),
      low: Number(candle?.low),
      close: Number(candle?.close),
      quoteVolume: candle?.quoteVolume == null ? null : Number(candle.quoteVolume),
    }))
    .filter((candle) => record.lastMinuteObservedAtMs == null
      || candle.timestampMs > record.lastMinuteObservedAtMs)
    .sort((left, right) => left.timestampMs - right.timestampMs);

  for (let index = 0; index < normalized.length; index += 1) {
    const candle = normalized[index];
    if (!Number.isSafeInteger(candle.timestampMs)
      || ![candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(value) && value > 0)
      || candle.high < candle.low || candle.open > candle.high || candle.open < candle.low
      || candle.close > candle.high || candle.close < candle.low) {
      throw new Error("PUMP_PROSPECTIVE_1M_CANDLE_INVALID");
    }
    if (index > 0 && candle.timestampMs - normalized[index - 1].timestampMs !== MINUTE_MS) {
      throw new Error("PUMP_PROSPECTIVE_1M_PATH_GAP");
    }
  }

  if (normalized.length > 0) {
    const expectedFirst = record.lastMinuteObservedAtMs == null
      ? record.position.entryTimestampMs
      : record.lastMinuteObservedAtMs + MINUTE_MS;
    if (normalized[0].timestampMs !== expectedFirst) {
      throw new Error("PUMP_PROSPECTIVE_1M_PATH_CURSOR_GAP");
    }
  }
  return normalized;
}

export function attachPumpProspectiveRiskSizingV1(state, {
  recordId,
  sizing,
  observedAtMs,
} = {}) {
  validatePumpProspectiveStateV1(state);
  const index = state.records.findIndex((record) => record.recordId === recordId);
  if (index < 0) throw new Error("PUMP_PROSPECTIVE_RECORD_NOT_FOUND");
  const current = state.records[index];
  if (current.status !== "OPEN") {
    throw new Error("PUMP_PROSPECTIVE_RISK_SIZING_OPEN_RECORD_REQUIRED");
  }
  if (current.riskSizingStatus === "READY") {
    return deepFreeze({ status: "ALREADY_READY", state, record: current });
  }
  if (!Number.isSafeInteger(observedAtMs)
    || observedAtMs < current.position.entryTimestampMs
    || observedAtMs - current.position.entryTimestampMs > RISK_SIZING_CAPTURE_WINDOW_MS) {
    throw new Error("PUMP_PROSPECTIVE_RISK_SIZING_CAPTURE_WINDOW_EXPIRED");
  }
  const result = clone(sizing);
  const evidenceCore = {
    schemaVersion: "crypto-pump-reversal-risk-sizing-evidence-v1",
    attachedAtMs: observedAtMs,
    result,
  };
  const riskSizing = deepFreeze({
    ...evidenceCore,
    evidenceDigest: sha256(evidenceCore),
  });
  const updatedRecord = deepFreeze({
    ...current,
    riskSizingStatus: "READY",
    riskSizing,
  });
  validateReadyRiskSizing(updatedRecord);
  const records = state.records.map((record, rowIndex) => rowIndex === index ? updatedRecord : clone(record));
  const next = withDigest({
    ...stateDigestPayload(state),
    updatedAtMs: Math.max(state.updatedAtMs, observedAtMs),
    records: Object.freeze(records),
  });
  return deepFreeze({ status: "READY", state: next, record: updatedRecord });
}

export function advancePumpProspectiveRecordV1(state, {
  recordId,
  minuteCandles,
  observedAtMs,
} = {}) {
  validatePumpProspectiveStateV1(state);
  const index = state.records.findIndex((record) => record.recordId === recordId);
  if (index < 0) throw new Error("PUMP_PROSPECTIVE_RECORD_NOT_FOUND");
  const current = state.records[index];
  if (current.status === "WAITING_NEXT_BAR") throw new Error("PUMP_PROSPECTIVE_POSITION_NOT_OPEN");
  if (current.status === "ENTRY_MISSED") {
    return deepFreeze({ status: "ENTRY_MISSED", state, record: current });
  }
  if (current.status === "EXIT_TRIGGERED") {
    return deepFreeze({ status: "ALREADY_EXIT_TRIGGERED", state, record: current });
  }
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < current.position.entryTimestampMs) {
    throw new Error("PUMP_PROSPECTIVE_EXIT_OBSERVED_AT_INVALID");
  }

  const incremental = normalizeIncrementalMinuteCandles(current, minuteCandles);
  if (incremental.length === 0) {
    return deepFreeze({ status: "HOLD", state, record: current });
  }

  const trigger = detectPumpProspectiveExit({
    position: current.position,
    minuteCandles: incremental,
    observedAtMs,
  });
  const latestMinute = incremental.at(-1).timestampMs;
  const nextPathMinuteCount = current.pathMinuteCount + incremental.length;

  if (trigger.status !== "EXIT_TRIGGERED") {
    const updatedRecord = deepFreeze({
      ...current,
      lastMinuteObservedAtMs: latestMinute,
      pathMinuteCount: nextPathMinuteCount,
    });
    const records = state.records.map((record, rowIndex) => rowIndex === index ? updatedRecord : clone(record));
    const next = withDigest({
      ...stateDigestPayload(state),
      updatedAtMs: Math.max(state.updatedAtMs, observedAtMs),
      records: Object.freeze(records),
    });
    return deepFreeze({ status: "HOLD", state: next, record: updatedRecord });
  }

  const grossReturnPercent = shortGrossReturnPercent(
    current.position.entryPrice,
    trigger.referenceExitPrice,
  );
  const exitTrigger = deepFreeze({
    ...trigger,
    exitTriggerId: sha256({
      recordId,
      positionId: current.position.positionId,
      reason: trigger.reason,
      triggerTimestampMs: trigger.triggerTimestampMs,
      referenceExitPrice: trigger.referenceExitPrice,
    }),
    grossReturnPercent,
    netReturnPercent: null,
    netPnl: null,
    fullCostSettlementStatus: "MISSING_CANONICAL_FULL_COST",
    profitabilityCredit: 0,
    profitabilityClaimAllowed: false,
    executionAuthority: "NONE",
  });
  const updatedRecord = deepFreeze({
    ...current,
    status: "EXIT_TRIGGERED",
    exitTrigger,
    lastMinuteObservedAtMs: latestMinute,
    pathMinuteCount: nextPathMinuteCount,
    grossReturnPercent,
    netReturnPercent: null,
    netPnl: null,
    fullCostSettlementStatus: "MISSING_CANONICAL_FULL_COST",
    fullCostSettlementId: null,
  });
  const records = state.records.map((record, rowIndex) => rowIndex === index ? updatedRecord : clone(record));
  const next = withDigest({
    ...stateDigestPayload(state),
    updatedAtMs: Math.max(state.updatedAtMs, observedAtMs),
    records: Object.freeze(records),
  });
  return deepFreeze({ status: "EXIT_TRIGGERED", state: next, record: updatedRecord });
}

export function pumpProspectiveStateSummaryV1(state) {
  validatePumpProspectiveStateV1(state);
  const waiting = state.records.filter((record) => record.status === "WAITING_NEXT_BAR").length;
  const missed = state.records.filter((record) => record.status === "ENTRY_MISSED").length;
  const open = state.records.filter((record) => record.status === "OPEN").length;
  const exited = state.records.filter((record) => record.status === "EXIT_TRIGGERED").length;
  const riskSized = state.records.filter((record) => record.riskSizingStatus === "READY").length;
  const riskSizedOpen = state.records.filter(
    (record) => record.status === "OPEN" && record.riskSizingStatus === "READY",
  ).length;
  const riskSizedExitTriggered = state.records.filter(
    (record) => record.status === "EXIT_TRIGGERED" && record.riskSizingStatus === "READY",
  ).length;
  const fullCostSettled = state.records.filter(
    (record) => record.fullCostSettlementStatus === "CANONICAL_FULL_COST_SETTLED",
  ).length;
  return deepFreeze({
    schemaVersion: "crypto-pump-reversal-prospective-state-summary-v1",
    candidateId: state.candidateId,
    records: state.records.length,
    waitingNextBar: waiting,
    entryMissed: missed,
    openPositions: open,
    exitTriggered: exited,
    riskSized,
    riskSizedOpen,
    riskSizedExitTriggered,
    fullCostSettled,
    rawExitOutcomesAvailable: exited,
    netEconomicOutcomesAvailable: fullCostSettled,
    profitabilityProven: false,
    currentValidatedChampion: "NONE",
    executionAuthority: "NONE",
  });
}
