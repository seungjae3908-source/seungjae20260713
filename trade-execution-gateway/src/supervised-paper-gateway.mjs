import { GatewayError } from "./gateway.mjs";
import {
  PAPER_MOCK_PROTECTION_CAPABILITIES,
  PROTECTION_STATES,
  ServerFailureProtectionError,
  acknowledgePaperProtection,
  assessUnattendedProtection,
  buildProtectionIntent,
  reconcileProtectionEvidence,
  recoverProtectionAfterRestart,
} from "./server-failure-protection.mjs";

const PROTECTION_MODE = "PAPER_PROTECTION_ONLY";
const CASH_MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT"]);

function object(value, code, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayError(code, message, 503);
  return value;
}

function exposureIncreasingIntent(input) {
  const market = String(input?.market ?? "").trim().toUpperCase();
  const side = String(input?.side ?? "").trim().toUpperCase();
  if (market === "CRYPTO_FUTURES") return !(input?.reduceOnly === true || input?.executionContext?.reduceOnly === true);
  if (CASH_MARKETS.has(market)) return side !== "SELL";
  return true;
}

function normalizePolicy(raw = {}) {
  const heartbeatTimeoutMs = Number(raw.heartbeatTimeoutMs ?? 5_000);
  const maxFutureSkewMs = Number(raw.maxFutureSkewMs ?? 1_000);
  if (!Number.isFinite(heartbeatTimeoutMs) || heartbeatTimeoutMs <= 0) {
    throw new GatewayError("INVALID_SUPERVISION_POLICY", "heartbeatTimeoutMs must be positive", 503);
  }
  if (!Number.isFinite(maxFutureSkewMs) || maxFutureSkewMs <= 0) {
    throw new GatewayError("INVALID_SUPERVISION_POLICY", "maxFutureSkewMs must be positive", 503);
  }
  return Object.freeze({
    enforceNewEntryGate: raw.enforceNewEntryGate === true,
    heartbeatTimeoutMs,
    maxFutureSkewMs,
  });
}

function safeProtectionSnapshot(snapshot) {
  if (snapshot == null) return { protections: [], revision: 0 };
  object(snapshot, "PROTECTION_STATE_INVALID", "protection snapshot must be an object");
  if (snapshot.schemaVersion !== 1 || snapshot.mode !== PROTECTION_MODE || !Array.isArray(snapshot.protections)) {
    throw new GatewayError("PROTECTION_STATE_SCHEMA_MISMATCH", "protection snapshot schema is unsupported", 503);
  }
  const entryIds = new Set();
  const keys = new Set();
  const protections = snapshot.protections.map((raw) => {
    object(raw, "PROTECTION_STATE_INVALID", "protection record must be an object");
    if (raw.kind !== "ENTRY_PROTECTION_INTENT_V1" || typeof raw.entryOrderId !== "string" || !raw.entryOrderId) {
      throw new GatewayError("PROTECTION_STATE_INVALID", "protection identity is invalid", 503);
    }
    if (typeof raw.protectionIdempotencyKey !== "string" || !raw.protectionIdempotencyKey) {
      throw new GatewayError("PROTECTION_STATE_INVALID", "protection idempotency is invalid", 503);
    }
    if (raw.executionMode !== "PAPER_ONLY" || raw.executionAuthority !== "NONE" || raw.realOrderSubmitted !== false || raw.privateApiUsed !== false) {
      throw new GatewayError("UNSAFE_PROTECTION_STATE_REJECTED", "protection state contains execution authority", 503);
    }
    if (entryIds.has(raw.entryOrderId) || keys.has(raw.protectionIdempotencyKey)) {
      throw new GatewayError("PROTECTION_STATE_IDEMPOTENCY_CONFLICT", "duplicate protection identity is forbidden", 503);
    }
    entryIds.add(raw.entryOrderId);
    keys.add(raw.protectionIdempotencyKey);
    try {
      return recoverProtectionAfterRestart(structuredClone(raw));
    } catch (error) {
      if (error instanceof ServerFailureProtectionError) {
        throw new GatewayError(error.code, error.message, 503);
      }
      throw error;
    }
  });
  return {
    protections,
    revision: Number.isInteger(snapshot.revision) && snapshot.revision >= 0 ? snapshot.revision : 0,
  };
}

function mapProtectionError(error, statusCode = 409) {
  if (error instanceof GatewayError) return error;
  if (error instanceof ServerFailureProtectionError) return new GatewayError(error.code, error.message, statusCode);
  return error;
}

export class SupervisedPaperGateway {
  #gateway;
  #protections = new Map();
  #protectionKeys = new Map();
  #persistProtectionState;
  #policy;
  #heartbeat = null;
  #providerCapabilities;
  #recoveredProtectionRecords = 0;
  #reconciliationRequiredOnStart = 0;

  constructor({
    gateway,
    initialProtectionState = null,
    persistProtectionState = null,
    supervisionPolicy = {},
    providerCapabilities = PAPER_MOCK_PROTECTION_CAPABILITIES,
  } = {}) {
    if (!gateway || typeof gateway.placeOrder !== "function" || typeof gateway.exportPaperState !== "function") {
      throw new GatewayError("INVALID_SUPERVISED_GATEWAY", "base TradeExecutionGateway is required", 500);
    }
    if (persistProtectionState != null && typeof persistProtectionState !== "function") {
      throw new GatewayError("PROTECTION_STATE_PERSISTENCE_INVALID", "persistProtectionState must be a function", 500);
    }
    const restored = safeProtectionSnapshot(initialProtectionState);
    this.#gateway = gateway;
    this.#persistProtectionState = persistProtectionState;
    this.#policy = normalizePolicy(supervisionPolicy);
    this.#providerCapabilities = Object.freeze({ ...providerCapabilities });
    for (const protection of restored.protections) {
      this.#protections.set(protection.entryOrderId, protection);
      this.#protectionKeys.set(protection.protectionIdempotencyKey, protection.entryOrderId);
      this.#recoveredProtectionRecords += 1;
      if (protection.state === PROTECTION_STATES.RECONCILIATION_REQUIRED) this.#reconciliationRequiredOnStart += 1;
    }
  }

  exportPaperState() {
    return this.#gateway.exportPaperState();
  }

  exportProtectionState() {
    return {
      schemaVersion: 1,
      mode: PROTECTION_MODE,
      protections: [...this.#protections.values()].map((item) => structuredClone(item)),
    };
  }

  getRecoveryState() {
    return Object.freeze({
      ...this.#gateway.getRecoveryState(),
      recoveredProtectionRecords: this.#recoveredProtectionRecords,
      protectionReconciliationRequiredOnStart: this.#reconciliationRequiredOnStart,
      automaticProtectionResubmissions: 0,
      heartbeatRestoredAfterRestart: false,
    });
  }

  getSafetyState() {
    return Object.freeze({
      ...this.#gateway.getSafetyState(),
      serverFailureProtection: Object.freeze({
        version: "V0_7",
        newEntryGateConfigured: this.#policy.enforceNewEntryGate,
        heartbeatRequiredWhenGateEnabled: true,
        heartbeatPersistedAcrossRestart: false,
        providerNativeProtectionAssumed: false,
        authenticatedProtectionReadAdapterEnabled: false,
        reductionOrdersRemainAllowedDuringEntryBlock: true,
        emergencyIntentExecutionAuthority: "NONE",
        automaticEmergencyExecution: false,
        unattendedLiveEligible: false,
      }),
    });
  }

  async #persist(reason) {
    if (!this.#persistProtectionState) return null;
    try {
      return await this.#persistProtectionState(this.exportProtectionState(), reason);
    } catch (error) {
      throw new GatewayError(
        "PROTECTION_STATE_PERSIST_FAILED",
        `durable protection state persistence failed: ${error?.code ?? error?.message ?? "unknown"}`,
        503,
      );
    }
  }

  recordSupervisorHeartbeat(input) {
    object(input, "SUPERVISOR_HEARTBEAT_INVALID", "supervisor heartbeat is required");
    if (typeof input.ownerId !== "string" || !input.ownerId.trim() || typeof input.leaseId !== "string" || !input.leaseId.trim()) {
      throw new GatewayError("SUPERVISOR_HEARTBEAT_INVALID", "heartbeat ownerId and leaseId are required", 400);
    }
    const observedMs = Date.parse(String(input.observedAt ?? ""));
    if (!Number.isFinite(observedMs)) throw new GatewayError("SUPERVISOR_HEARTBEAT_INVALID", "heartbeat observedAt is invalid", 400);
    this.#heartbeat = Object.freeze({
      ownerId: input.ownerId.trim(),
      leaseId: input.leaseId.trim(),
      observedAt: new Date(observedMs).toISOString(),
    });
    return Object.freeze({
      accepted: true,
      heartbeat: this.#heartbeat,
      persistedAcrossRestart: false,
      executionAuthority: "NONE",
    });
  }

  getProtectionHealth(nowMs = Date.now()) {
    try {
      const paperState = this.#gateway.exportPaperState();
      const exposureIncreasingOrders = paperState.orders.filter((order) => exposureIncreasingIntent(order?.intent));
      const assessment = assessUnattendedProtection({
        orders: exposureIncreasingOrders,
        protections: [...this.#protections.values()],
        heartbeat: this.#heartbeat,
        policy: this.#policy,
        nowMs,
      });
      return Object.freeze({
        ...assessment,
        gateEnabled: this.#policy.enforceNewEntryGate,
        effectiveNewEntryAllowed: !this.#policy.enforceNewEntryGate || assessment.newEntryAllowed,
        protectionRecords: this.#protections.size,
        reductionOrdersExemptFromNewEntryGate: true,
        automaticProtectionSubmission: false,
        automaticEmergencyExecutionPerformed: false,
      });
    } catch (error) {
      throw mapProtectionError(error, 503);
    }
  }

  #requireNewEntrySafe() {
    if (!this.#policy.enforceNewEntryGate) return;
    const state = this.getProtectionHealth();
    if (!state.newEntryAllowed) {
      throw new GatewayError(
        "UNATTENDED_NEW_ENTRY_BLOCKED",
        `new Paper entry blocked by server-failure protection: ${state.blockers.join(",")}`,
        503,
      );
    }
  }

  async previewOrder(input) {
    return this.#gateway.previewOrder(input);
  }

  async placeOrder(input) {
    if (exposureIncreasingIntent(input)) this.#requireNewEntrySafe();
    return this.#gateway.placeOrder(input);
  }

  async applyPaperFill(orderId, fill) {
    return this.#gateway.applyPaperFill(orderId, fill);
  }

  async cancelOrder(orderId) {
    return this.#gateway.cancelOrder(orderId);
  }

  async getOrder(orderId) {
    const order = await this.#gateway.getOrder(orderId);
    return Object.freeze({
      ...order,
      serverFailureProtection: this.#protections.get(orderId) ?? null,
    });
  }

  async registerProtectionIntent(orderId, { bracketPlan, protectionIdempotencyKey, createdAt } = {}) {
    const existingByKey = this.#protectionKeys.get(protectionIdempotencyKey);
    if (existingByKey) {
      if (existingByKey !== orderId) throw new GatewayError("PROTECTION_STATE_IDEMPOTENCY_CONFLICT", "protection key belongs to another entry", 409);
      return this.#protections.get(orderId);
    }
    if (this.#protections.has(orderId)) {
      throw new GatewayError("PROTECTION_ALREADY_REGISTERED", "entry already has a protection record", 409);
    }
    try {
      const entryOrder = await this.#gateway.getOrder(orderId);
      if (!exposureIncreasingIntent(entryOrder.intent)) {
        throw new GatewayError("PROTECTION_NOT_REQUIRED_FOR_REDUCTION", "reduction-only orders do not create exposure requiring entry protection", 409);
      }
      const intent = buildProtectionIntent({ entryOrder, bracketPlan, protectionIdempotencyKey, createdAt });
      this.#protections.set(orderId, intent);
      this.#protectionKeys.set(intent.protectionIdempotencyKey, orderId);
      await this.#persist("ENTRY_PROTECTION_INTENT_REGISTERED");
      return intent;
    } catch (error) {
      throw mapProtectionError(error);
    }
  }

  async acknowledgeProtection(orderId, evidence) {
    const intent = this.#protections.get(orderId);
    if (!intent) throw new GatewayError("PROTECTION_INTENT_NOT_FOUND", "protection intent not found", 404);
    try {
      const updated = acknowledgePaperProtection({
        intent,
        evidence,
        providerCapabilities: this.#providerCapabilities,
      });
      this.#protections.set(orderId, updated);
      await this.#persist("PAPER_PROTECTION_ACKNOWLEDGED");
      return updated;
    } catch (error) {
      throw mapProtectionError(error);
    }
  }

  previewProtectionReconciliation(orderId, { observedProtection, observedAt } = {}) {
    const protection = this.#protections.get(orderId);
    if (!protection) throw new GatewayError("PROTECTION_INTENT_NOT_FOUND", "protection intent not found", 404);
    try {
      return reconcileProtectionEvidence({
        protection,
        observedProtection,
        providerCapabilities: this.#providerCapabilities,
        observedAt,
      });
    } catch (error) {
      throw mapProtectionError(error);
    }
  }
}
