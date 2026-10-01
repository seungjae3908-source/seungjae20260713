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

function validateRecord(record, policy) {
  if (!record
    || record.schemaVersion !== "crypto-pump-reversal-prospective-record-v1"
    || !exactDigest(record.recordId)
    || record.observation?.candidateId !== policy.candidate.candidateId
    || record.observation?.candidateDigest !== policy.candidateDigest
    || record.observation?.policyDigest !== policy.policyDigest
    || record.signal?.signalId !== record.observation?.signalId
    || record.signal?.symbol !== record.observation?.symbol
    || !["WAITING_NEXT_BAR", "OPEN", "EXIT_TRIGGERED"].includes(record.status)) {
    throw new Error("PUMP_PROSPECTIVE_RECORD_INVALID");
  }
  if (record.status === "WAITING_NEXT_BAR" && (record.position != null || record.exitTrigger != null)) {
    throw new Error("PUMP_PROSPECTIVE_WAITING_RECORD_MUTATED");
  }
  if (record.status === "OPEN" && (!record.position || record.exitTrigger != null)) {
    throw new Error("PUMP_PROSPECTIVE_OPEN_RECORD_INVALID");
  }
  if (record.status === "EXIT_TRIGGERED" && (!record.position || !record.exitTrigger)) {
    throw new Error("PUMP_PROSPECTIVE_EXIT_RECORD_INVALID");
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
    position: null,
    exitTrigger: null,
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
  const updatedRecord = deepFreeze({ ...current, status: "OPEN", position });
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
  if (current.status === "EXIT_TRIGGERED") {
    return deepFreeze({ status: "ALREADY_EXIT_TRIGGERED", state, record: current });
  }
  const trigger = detectPumpProspectiveExit({
    position: current.position,
    minuteCandles,
    observedAtMs,
  });
  if (trigger.status !== "EXIT_TRIGGERED") {
    return deepFreeze({ status: "HOLD", state, record: current });
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
  const open = state.records.filter((record) => record.status === "OPEN").length;
  const exited = state.records.filter((record) => record.status === "EXIT_TRIGGERED").length;
  const fullCostSettled = state.records.filter(
    (record) => record.fullCostSettlementStatus === "CANONICAL_FULL_COST_SETTLED",
  ).length;
  return deepFreeze({
    schemaVersion: "crypto-pump-reversal-prospective-state-summary-v1",
    candidateId: state.candidateId,
    records: state.records.length,
    waitingNextBar: waiting,
    openPositions: open,
    exitTriggered: exited,
    fullCostSettled,
    rawExitOutcomesAvailable: exited,
    netEconomicOutcomesAvailable: fullCostSettled,
    profitabilityProven: false,
    currentValidatedChampion: "NONE",
    executionAuthority: "NONE",
  });
}
