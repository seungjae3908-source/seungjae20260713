import { createHash } from "node:crypto";
import { GatewayError } from "./gateway.mjs";

export const PAPER_COMPOUNDING_CAPITAL_POLICY = Object.freeze({
  currency: "KRW",
  initialCapitalLimitKrw: 1_000_000,
  profitTriggerBps: 1_000,
  profitReserveBps: 500,
  maxReserveStepsPerSettlement: 64,
});

const MODE = "PAPER_COMPOUNDING_CAPITAL_ONLY";
const SCHEMA_VERSION = 1;
const MAX_RECENT_RESERVE_EVENTS = 256;

function object(value, code, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayError(code, message, 503);
  return value;
}

function integerKrw(value, code, message, { allowZero = true } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || (!allowZero && number === 0)) {
    throw new GatewayError(code, message, 400);
  }
  return number;
}

function positiveInteger(value, code, message) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new GatewayError(code, message, 400);
  return number;
}

function text(value, code, message, max = 128) {
  if (typeof value !== "string") throw new GatewayError(code, message, 400);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new GatewayError(code, message, 400);
  return normalized;
}

function timestamp(value, code, message) {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) throw new GatewayError(code, message, 400);
  return parsed;
}

function ceilBps(baseKrw, bps) {
  return Math.ceil((baseKrw * bps) / 10_000);
}

function floorBps(baseKrw, bps) {
  return Math.floor((baseKrw * bps) / 10_000);
}

function nextTrigger(baseKrw) {
  if (!Number.isSafeInteger(baseKrw) || baseKrw <= 0) return null;
  return baseKrw + ceilBps(baseKrw, PAPER_COMPOUNDING_CAPITAL_POLICY.profitTriggerBps);
}

function settlementDigest(input) {
  const canonical = JSON.stringify({
    settlementId: input.settlementId,
    sequence: input.sequence,
    source: input.source,
    settledAccountEquityKrw: input.settledAccountEquityKrw,
    observedAt: input.observedAt,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: MODE,
    currency: "KRW",
    initialized: false,
    compoundBaseKrw: null,
    highWatermarkBaseKrw: null,
    profitReserveKrw: 0,
    lifetimeReservedKrw: 0,
    initialExcludedCapitalKrw: 0,
    reportedAccountEquityKrw: null,
    managedActiveEquityKrw: null,
    effectiveTradingCapitalKrw: 0,
    nextProfitTriggerKrw: null,
    reserveEventCount: 0,
    recentReserveEvents: [],
    lastSettlement: null,
    externalWithdrawalPerformed: false,
    liveAuthorityGranted: false,
    autoTradingEnabled: false,
    privateTradingApiAllowed: false,
  };
}

function validateRestoredState(snapshot) {
  if (snapshot == null) return emptyState();
  object(snapshot, "CAPITAL_STATE_INVALID", "capital state must be an object");
  if (snapshot.schemaVersion !== SCHEMA_VERSION || snapshot.mode !== MODE || snapshot.currency !== "KRW") {
    throw new GatewayError("CAPITAL_STATE_SCHEMA_MISMATCH", "capital state schema is unsupported", 503);
  }
  if (snapshot.externalWithdrawalPerformed !== false || snapshot.liveAuthorityGranted !== false || snapshot.autoTradingEnabled !== false || snapshot.privateTradingApiAllowed !== false) {
    throw new GatewayError("UNSAFE_CAPITAL_STATE_REJECTED", "capital state may contain Paper-only non-withdrawal evidence only", 503);
  }
  const initialized = snapshot.initialized === true;
  const reserve = integerKrw(snapshot.profitReserveKrw, "CAPITAL_STATE_INVALID", "profitReserveKrw is invalid");
  const lifetimeReserved = integerKrw(snapshot.lifetimeReservedKrw, "CAPITAL_STATE_INVALID", "lifetimeReservedKrw is invalid");
  if (reserve !== lifetimeReserved) {
    throw new GatewayError("CAPITAL_STATE_INVALID", "Paper reserve and lifetime reserve must match before external withdrawal support exists", 503);
  }
  const reserveEventCount = integerKrw(snapshot.reserveEventCount, "CAPITAL_STATE_INVALID", "reserveEventCount is invalid");
  const recentReserveEvents = Array.isArray(snapshot.recentReserveEvents) ? structuredClone(snapshot.recentReserveEvents) : null;
  if (!recentReserveEvents || recentReserveEvents.length > MAX_RECENT_RESERVE_EVENTS || reserveEventCount < recentReserveEvents.length) {
    throw new GatewayError("CAPITAL_STATE_INVALID", "reserve event history is invalid", 503);
  }

  if (!initialized) {
    if (snapshot.compoundBaseKrw != null || snapshot.highWatermarkBaseKrw != null || snapshot.nextProfitTriggerKrw != null) {
      throw new GatewayError("CAPITAL_STATE_INVALID", "uninitialized capital state cannot contain a compound base", 503);
    }
  } else {
    const base = integerKrw(snapshot.compoundBaseKrw, "CAPITAL_STATE_INVALID", "compoundBaseKrw is invalid", { allowZero: false });
    const high = integerKrw(snapshot.highWatermarkBaseKrw, "CAPITAL_STATE_INVALID", "highWatermarkBaseKrw is invalid", { allowZero: false });
    if (base !== high || snapshot.nextProfitTriggerKrw !== nextTrigger(base)) {
      throw new GatewayError("CAPITAL_HIGH_WATERMARK_INVALID", "compound base/high-watermark/next-trigger are inconsistent", 503);
    }
  }

  integerKrw(snapshot.initialExcludedCapitalKrw ?? 0, "CAPITAL_STATE_INVALID", "initialExcludedCapitalKrw is invalid");
  if (snapshot.reportedAccountEquityKrw != null) integerKrw(snapshot.reportedAccountEquityKrw, "CAPITAL_STATE_INVALID", "reportedAccountEquityKrw is invalid");
  if (snapshot.managedActiveEquityKrw != null) integerKrw(snapshot.managedActiveEquityKrw, "CAPITAL_STATE_INVALID", "managedActiveEquityKrw is invalid");
  integerKrw(snapshot.effectiveTradingCapitalKrw, "CAPITAL_STATE_INVALID", "effectiveTradingCapitalKrw is invalid");

  let lastSettlement = null;
  if (snapshot.lastSettlement != null) {
    object(snapshot.lastSettlement, "CAPITAL_STATE_INVALID", "lastSettlement is invalid");
    lastSettlement = structuredClone(snapshot.lastSettlement);
    text(lastSettlement.settlementId, "CAPITAL_STATE_INVALID", "settlementId is invalid");
    positiveInteger(lastSettlement.sequence, "CAPITAL_STATE_INVALID", "settlement sequence is invalid");
    text(lastSettlement.digest, "CAPITAL_STATE_INVALID", "settlement digest is invalid", 64);
    timestamp(lastSettlement.observedAt, "CAPITAL_STATE_INVALID", "settlement observedAt is invalid");
  }

  return {
    ...emptyState(),
    ...structuredClone(snapshot),
    initialized,
    profitReserveKrw: reserve,
    lifetimeReservedKrw: lifetimeReserved,
    reserveEventCount,
    recentReserveEvents,
    lastSettlement,
  };
}

function normalizeSettlement(input, nowMs) {
  object(input, "CAPITAL_SETTLEMENT_REQUIRED", "Paper capital settlement evidence is required");
  if (input.mode !== "PAPER" || input.settled !== true || input.simulated !== true || input.source !== "PAPER_SETTLEMENT_ENGINE") {
    throw new GatewayError("CAPITAL_SETTLEMENT_AUTHORITY_INVALID", "only settled simulated PAPER_SETTLEMENT_ENGINE evidence is accepted", 400);
  }
  if (input.serverAttested === true || input.privateApiUsed === true || input.realAccountMutation === true || input.externalWithdrawalPerformed === true) {
    throw new GatewayError("UNSAFE_CAPITAL_SETTLEMENT_REJECTED", "capital settlement cannot claim server/private/live/withdrawal authority", 403);
  }
  const settlementId = text(input.settlementId, "CAPITAL_SETTLEMENT_ID_INVALID", "settlementId is required");
  if (!/^[A-Za-z0-9._:-]+$/.test(settlementId)) throw new GatewayError("CAPITAL_SETTLEMENT_ID_INVALID", "settlementId contains unsupported characters", 400);
  const sequence = positiveInteger(input.sequence, "CAPITAL_SETTLEMENT_SEQUENCE_INVALID", "settlement sequence must be a positive integer");
  const settledAccountEquityKrw = integerKrw(input.settledAccountEquityKrw, "CAPITAL_EQUITY_INVALID", "settledAccountEquityKrw must be a non-negative integer KRW amount");
  const observedMs = timestamp(input.observedAt, "CAPITAL_SETTLEMENT_TIMESTAMP_INVALID", "settlement observedAt is invalid");
  if (observedMs > nowMs + 1_000) throw new GatewayError("CAPITAL_SETTLEMENT_FROM_FUTURE", "capital settlement is from the future", 400);
  const normalized = {
    settlementId,
    sequence,
    source: "PAPER_SETTLEMENT_ENGINE",
    settledAccountEquityKrw,
    observedAt: new Date(observedMs).toISOString(),
  };
  return { ...normalized, digest: settlementDigest(normalized), observedMs };
}

export class PaperCompoundingCapitalManager {
  #state;
  #persistState;
  #admissionGateEnabled;

  constructor({ initialState = null, persistState = null, admissionGateEnabled = false } = {}) {
    if (persistState != null && typeof persistState !== "function") {
      throw new GatewayError("CAPITAL_STATE_PERSISTENCE_INVALID", "persistState must be a function", 500);
    }
    this.#state = validateRestoredState(initialState);
    this.#persistState = persistState;
    this.#admissionGateEnabled = admissionGateEnabled === true;
  }

  exportState() {
    return structuredClone(this.#state);
  }

  getState() {
    return Object.freeze({
      ...structuredClone(this.#state),
      policy: PAPER_COMPOUNDING_CAPITAL_POLICY,
      admissionGateEnabled: this.#admissionGateEnabled,
      reserveMeaning: "PAPER_LOCKED_NON_TRADEABLE_ONLY",
      externalWithdrawalSupported: false,
      recoveryProfitResetAllowed: false,
      executionAuthority: "NONE",
    });
  }

  getSafetyState() {
    return Object.freeze({
      mode: MODE,
      currency: "KRW",
      initialCapitalLimitKrw: PAPER_COMPOUNDING_CAPITAL_POLICY.initialCapitalLimitKrw,
      profitTriggerPercent: 10,
      profitReservePercent: 5,
      highWatermarkNeverDecreasesOnLoss: true,
      drawdownReducesEffectiveTradingCapital: true,
      admissionGateEnabled: this.#admissionGateEnabled,
      externalWithdrawalPerformed: false,
      externalWithdrawalSupported: false,
      liveTrading: false,
      autoTrading: false,
      privateTradingApiAllowed: false,
      executionAuthority: "NONE",
    });
  }

  async #persist(reason) {
    if (!this.#persistState) return null;
    try {
      return await this.#persistState(this.exportState(), reason);
    } catch (error) {
      throw new GatewayError("CAPITAL_STATE_PERSIST_FAILED", `durable capital state persistence failed: ${error?.code ?? error?.message ?? "unknown"}`, 503);
    }
  }

  async applySettlement(input, options = {}) {
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const settlement = normalizeSettlement(input, nowMs);
    const previous = this.#state.lastSettlement;
    if (previous) {
      if (settlement.sequence === previous.sequence && settlement.settlementId === previous.settlementId) {
        if (settlement.digest !== previous.digest) {
          throw new GatewayError("CAPITAL_SETTLEMENT_IDEMPOTENCY_CONFLICT", "replayed settlement identity has different evidence", 409);
        }
        return Object.freeze({ ...this.getState(), idempotentReplay: true, reserveStepsCreated: 0 });
      }
      if (settlement.sequence <= previous.sequence || settlement.settlementId === previous.settlementId) {
        throw new GatewayError("CAPITAL_SETTLEMENT_SEQUENCE_REGRESSION", "capital settlement sequence must advance monotonically", 409);
      }
      if (settlement.observedMs < Date.parse(previous.observedAt)) {
        throw new GatewayError("CAPITAL_SETTLEMENT_TIME_REGRESSION", "capital settlement time cannot move backward", 409);
      }
    }

    let base = this.#state.compoundBaseKrw;
    let high = this.#state.highWatermarkBaseKrw;
    let reserve = this.#state.profitReserveKrw;
    let excluded = this.#state.initialExcludedCapitalKrw;
    let active = 0;
    let initialized = this.#state.initialized;
    let reserveEventCount = this.#state.reserveEventCount;
    const recentReserveEvents = [...this.#state.recentReserveEvents];
    const createdSteps = [];

    if (!initialized && settlement.settledAccountEquityKrw > 0) {
      base = Math.min(PAPER_COMPOUNDING_CAPITAL_POLICY.initialCapitalLimitKrw, settlement.settledAccountEquityKrw);
      high = base;
      excluded = settlement.settledAccountEquityKrw - base;
      active = base;
      initialized = true;
    } else if (initialized) {
      const lockedAndExcluded = reserve + excluded;
      if (settlement.settledAccountEquityKrw < lockedAndExcluded) {
        throw new GatewayError("CAPITAL_LOCKED_FUNDS_INTEGRITY_BREACH", "settled account equity is below locked reserve plus excluded capital", 503);
      }
      active = settlement.settledAccountEquityKrw - lockedAndExcluded;
    }

    if (initialized && this.#state.initialized) {
      let stepCount = 0;
      while (active >= nextTrigger(base)) {
        if (stepCount >= PAPER_COMPOUNDING_CAPITAL_POLICY.maxReserveStepsPerSettlement) {
          throw new GatewayError("CAPITAL_RESERVE_STEP_LIMIT", "capital settlement crosses too many reserve milestones", 503);
        }
        const baseBeforeKrw = base;
        const triggerKrw = nextTrigger(baseBeforeKrw);
        const reserveAmountKrw = floorBps(baseBeforeKrw, PAPER_COMPOUNDING_CAPITAL_POLICY.profitReserveBps);
        if (reserveAmountKrw < 1) break;
        reserve += reserveAmountKrw;
        active -= reserveAmountKrw;
        base += reserveAmountKrw;
        high = base;
        reserveEventCount += 1;
        stepCount += 1;
        const event = Object.freeze({
          reserveSequence: reserveEventCount,
          settlementId: settlement.settlementId,
          settlementSequence: settlement.sequence,
          baseBeforeKrw,
          triggerKrw,
          reserveAmountKrw,
          compoundIncreaseKrw: reserveAmountKrw,
          baseAfterKrw: base,
          activeEquityAfterReserveKrw: active,
          externalWithdrawalPerformed: false,
          executionAuthority: "NONE",
        });
        createdSteps.push(event);
        recentReserveEvents.push(event);
        if (recentReserveEvents.length > MAX_RECENT_RESERVE_EVENTS) recentReserveEvents.shift();
      }
    }

    const effectiveTradingCapitalKrw = initialized ? Math.min(base, active) : 0;
    this.#state = {
      schemaVersion: SCHEMA_VERSION,
      mode: MODE,
      currency: "KRW",
      initialized,
      compoundBaseKrw: initialized ? base : null,
      highWatermarkBaseKrw: initialized ? high : null,
      profitReserveKrw: reserve,
      lifetimeReservedKrw: reserve,
      initialExcludedCapitalKrw: excluded,
      reportedAccountEquityKrw: settlement.settledAccountEquityKrw,
      managedActiveEquityKrw: active,
      effectiveTradingCapitalKrw,
      nextProfitTriggerKrw: initialized ? nextTrigger(base) : null,
      reserveEventCount,
      recentReserveEvents,
      lastSettlement: {
        settlementId: settlement.settlementId,
        sequence: settlement.sequence,
        digest: settlement.digest,
        observedAt: settlement.observedAt,
        reportedAccountEquityKrw: settlement.settledAccountEquityKrw,
        managedActiveEquityAfterReserveKrw: active,
      },
      externalWithdrawalPerformed: false,
      liveAuthorityGranted: false,
      autoTradingEnabled: false,
      privateTradingApiAllowed: false,
    };
    await this.#persist(createdSteps.length > 0 ? "PAPER_CAPITAL_RESERVE_MILESTONE" : "PAPER_CAPITAL_SETTLEMENT");
    return Object.freeze({ ...this.getState(), idempotentReplay: false, reserveStepsCreated: createdSteps.length, reserveSteps: Object.freeze(createdSteps) });
  }

  assessAdmission(input) {
    object(input, "CAPITAL_ADMISSION_EVIDENCE_REQUIRED", "capital admission evidence is required");
    if (!this.#admissionGateEnabled) {
      return Object.freeze({ accepted: true, gateEnabled: false, executionAuthority: "NONE", liveAuthorityGranted: false });
    }
    if (!this.#state.initialized || !this.#state.lastSettlement) {
      throw new GatewayError("CAPITAL_NOT_INITIALIZED", "a positive settled Paper capital snapshot is required before new exposure", 503);
    }
    const settlementId = text(input.settlementId, "CAPITAL_ADMISSION_EVIDENCE_INVALID", "latest settlementId is required");
    const settlementSequence = positiveInteger(input.settlementSequence, "CAPITAL_ADMISSION_EVIDENCE_INVALID", "latest settlementSequence is required");
    if (settlementId !== this.#state.lastSettlement.settlementId || settlementSequence !== this.#state.lastSettlement.sequence) {
      throw new GatewayError("CAPITAL_ADMISSION_STALE_SETTLEMENT", "capital admission must bind to the latest settled capital state", 409);
    }
    const requestedNewExposureKrw = integerKrw(input.requestedNewExposureKrw, "CAPITAL_ADMISSION_EVIDENCE_INVALID", "requestedNewExposureKrw must be non-negative integer KRW");
    const currentManagedExposureKrw = integerKrw(input.currentManagedExposureKrw, "CAPITAL_ADMISSION_EVIDENCE_INVALID", "currentManagedExposureKrw must be non-negative integer KRW");
    const availableNewExposureKrw = Math.max(0, this.#state.effectiveTradingCapitalKrw - currentManagedExposureKrw);
    if (requestedNewExposureKrw > availableNewExposureKrw) {
      throw new GatewayError("COMPOUNDING_CAPITAL_LIMIT_EXCEEDED", "requested new exposure exceeds the current Paper compounding capital limit", 409);
    }
    return Object.freeze({
      accepted: true,
      gateEnabled: true,
      settlementId,
      settlementSequence,
      compoundBaseKrw: this.#state.compoundBaseKrw,
      highWatermarkBaseKrw: this.#state.highWatermarkBaseKrw,
      profitReserveKrw: this.#state.profitReserveKrw,
      effectiveTradingCapitalKrw: this.#state.effectiveTradingCapitalKrw,
      currentManagedExposureKrw,
      requestedNewExposureKrw,
      availableNewExposureKrw,
      externalWithdrawalPerformed: false,
      executionAuthority: "NONE",
      liveAuthorityGranted: false,
    });
  }
}
