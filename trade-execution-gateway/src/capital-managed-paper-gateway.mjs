import { GatewayError } from "./gateway.mjs";

const CASH_MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT"]);
const NONTERMINAL_STATES = new Set(["CREATED", "RISK_ACCEPTED", "SUBMITTED", "ACCEPTED", "PARTIALLY_FILLED"]);
const TERMINAL_NO_EXPOSURE_STATES = new Set(["REJECTED"]);

function object(value, code, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayError(code, message, 503);
  return value;
}

function positiveFinite(value, code, message) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new GatewayError(code, message, 503);
  return number;
}

function nonNegativeIntegerKrw(value, code, message) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new GatewayError(code, message, 503);
  return number;
}

function exposureIncreasingIntent(input) {
  const market = String(input?.market ?? "").trim().toUpperCase();
  const side = String(input?.side ?? "").trim().toUpperCase();
  if (market === "CRYPTO_FUTURES") return !(input?.reduceOnly === true || input?.executionContext?.reduceOnly === true);
  if (CASH_MARKETS.has(market)) return side !== "SELL";
  return true;
}

function directlyKrwValuedIntent(intent) {
  if (intent?.market === "KR_STOCK") return true;
  return (
    intent?.market === "CRYPTO_SPOT"
    && String(intent?.executionContext?.provider ?? intent?.provider ?? "").toLowerCase() === "upbit"
    && String(intent?.symbol ?? "").toUpperCase().startsWith("KRW-")
  );
}

function actualFilledNotional(order) {
  const quantity = Number(order?.filledQuantity);
  const price = Number(order?.averageFillPrice);
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) return 0;
  const notional = quantity * price;
  return Number.isFinite(notional) && notional > 0 ? notional : 0;
}

function committedOrderNotional(order) {
  if (!exposureIncreasingIntent(order?.intent)) return 0;
  if (TERMINAL_NO_EXPOSURE_STATES.has(order?.status)) return 0;

  const filled = actualFilledNotional(order);
  if (order?.status === "CANCELED") return Math.ceil(filled);

  const riskNotional = positiveFinite(
    order?.risk?.notional,
    "CAPITAL_OMS_RISK_NOTIONAL_INVALID",
    "Paper OMS order is missing a positive risk notional",
  );
  return Math.ceil(Math.max(riskNotional, filled));
}

function afterSettlement(order, settlementMs) {
  const createdMs = Date.parse(String(order?.createdAt ?? ""));
  if (!Number.isFinite(createdMs)) {
    throw new GatewayError("CAPITAL_OMS_ORDER_TIMESTAMP_INVALID", "Paper OMS order createdAt is invalid", 503);
  }
  return createdMs > settlementMs;
}

export class CapitalManagedPaperGateway {
  #gateway;
  #capitalManager;
  #entryQueue = Promise.resolve();

  constructor({ gateway, capitalManager } = {}) {
    if (
      !gateway
      || typeof gateway.placeOrder !== "function"
      || typeof gateway.previewOrder !== "function"
      || typeof gateway.exportPaperState !== "function"
    ) {
      throw new GatewayError("INVALID_CAPITAL_MANAGED_GATEWAY", "Paper gateway with OMS state export is required", 500);
    }
    if (
      !capitalManager
      || typeof capitalManager.getState !== "function"
      || typeof capitalManager.assessAdmission !== "function"
      || typeof capitalManager.applySettlement !== "function"
    ) {
      throw new GatewayError("INVALID_CAPITAL_MANAGER", "Paper compounding capital manager is required", 500);
    }
    this.#gateway = gateway;
    this.#capitalManager = capitalManager;
  }

  exportPaperState() {
    return this.#gateway.exportPaperState();
  }

  getRecoveryState() {
    return this.#gateway.getRecoveryState();
  }

  getSafetyState() {
    return Object.freeze({
      ...this.#gateway.getSafetyState(),
      compoundingCapital: this.#capitalManager.getSafetyState(),
    });
  }

  getProtectionHealth(nowMs = Date.now()) {
    return this.#gateway.getProtectionHealth(nowMs);
  }

  recordSupervisorHeartbeat(input) {
    return this.#gateway.recordSupervisorHeartbeat(input);
  }

  async registerProtectionIntent(orderId, input) {
    return this.#gateway.registerProtectionIntent(orderId, input);
  }

  async acknowledgeProtection(orderId, input) {
    return this.#gateway.acknowledgeProtection(orderId, input);
  }

  previewProtectionReconciliation(orderId, input) {
    return this.#gateway.previewProtectionReconciliation(orderId, input);
  }

  async applyPaperFill(orderId, fill) {
    return this.#gateway.applyPaperFill(orderId, fill);
  }

  async cancelOrder(orderId) {
    return this.#gateway.cancelOrder(orderId);
  }

  async getOrder(orderId) {
    return this.#gateway.getOrder(orderId);
  }

  #currentCommittedExposureKrw() {
    const state = this.#capitalManager.getState();
    if (!state.initialized || !state.lastSettlement) {
      return Object.freeze({ exposureKrw: 0, blockers: Object.freeze([]), settlement: state.lastSettlement });
    }

    const settlementMs = Date.parse(state.lastSettlement.observedAt);
    if (!Number.isFinite(settlementMs)) {
      throw new GatewayError("CAPITAL_SETTLEMENT_TIMESTAMP_INVALID", "latest capital settlement timestamp is invalid", 503);
    }

    const paperState = object(
      this.#gateway.exportPaperState(),
      "CAPITAL_OMS_STATE_INVALID",
      "Paper OMS state is required for capital admission",
    );
    if (!Array.isArray(paperState.orders)) {
      throw new GatewayError("CAPITAL_OMS_STATE_INVALID", "Paper OMS state orders are invalid", 503);
    }

    let exposureKrw = 0;
    const blockers = [];
    for (const order of paperState.orders) {
      if (!afterSettlement(order, settlementMs) || !exposureIncreasingIntent(order?.intent)) continue;
      const committed = committedOrderNotional(order);
      if (committed <= 0) continue;
      if (!directlyKrwValuedIntent(order.intent)) {
        blockers.push(`KRW_VALUATION_REQUIRED:${order.orderId}`);
        continue;
      }
      exposureKrw += committed;
      if (!Number.isSafeInteger(exposureKrw)) {
        throw new GatewayError("CAPITAL_OMS_EXPOSURE_OVERFLOW", "managed Paper exposure exceeds safe integer bounds", 503);
      }
    }

    return Object.freeze({
      exposureKrw,
      blockers: Object.freeze(blockers),
      settlement: state.lastSettlement,
    });
  }

  #requestedExposureKrw(preview) {
    if (!directlyKrwValuedIntent(preview?.intent)) {
      throw new GatewayError(
        "CAPITAL_KRW_VALUATION_REQUIRED",
        `${preview?.intent?.market ?? "UNKNOWN"} new exposure requires authoritative KRW valuation before compounding admission`,
        503,
      );
    }
    return nonNegativeIntegerKrw(
      Math.ceil(positiveFinite(preview?.risk?.notional, "CAPITAL_ORDER_NOTIONAL_INVALID", "order risk notional is invalid")),
      "CAPITAL_ORDER_NOTIONAL_INVALID",
      "order KRW notional is invalid",
    );
  }

  #assessNewEntry(preview) {
    const state = this.#capitalManager.getState();
    if (state.admissionGateEnabled !== true) {
      return this.#capitalManager.assessAdmission({});
    }
    const current = this.#currentCommittedExposureKrw();
    if (current.blockers.length > 0) {
      throw new GatewayError(
        "CAPITAL_EXISTING_EXPOSURE_VALUATION_REQUIRED",
        `existing managed exposure is missing KRW valuation: ${current.blockers.join(",")}`,
        503,
      );
    }
    const requestedNewExposureKrw = this.#requestedExposureKrw(preview);
    return this.#capitalManager.assessAdmission({
      settlementId: state.lastSettlement?.settlementId,
      settlementSequence: state.lastSettlement?.sequence,
      currentManagedExposureKrw: current.exposureKrw,
      requestedNewExposureKrw,
    });
  }

  async previewOrder(input) {
    const preview = await this.#gateway.previewOrder(input);
    if (!exposureIncreasingIntent(preview.intent)) {
      return Object.freeze({
        ...preview,
        capitalAdmission: Object.freeze({
          accepted: true,
          gateEnabled: this.#capitalManager.getState().admissionGateEnabled === true,
          reductionOrderExempt: true,
          executionAuthority: "NONE",
          liveAuthorityGranted: false,
        }),
      });
    }
    return Object.freeze({ ...preview, capitalAdmission: this.#assessNewEntry(preview) });
  }

  async #placeExposureIncreasingOrder(input) {
    const preview = await this.#gateway.previewOrder(input);
    const capitalAdmission = this.#assessNewEntry(preview);
    const result = await this.#gateway.placeOrder(input);
    return Object.freeze({ ...result, capitalAdmission });
  }

  async placeOrder(input) {
    if (!exposureIncreasingIntent(input)) {
      const result = await this.#gateway.placeOrder(input);
      return Object.freeze({
        ...result,
        capitalAdmission: Object.freeze({
          accepted: true,
          gateEnabled: this.#capitalManager.getState().admissionGateEnabled === true,
          reductionOrderExempt: true,
          executionAuthority: "NONE",
          liveAuthorityGranted: false,
        }),
      });
    }
    const task = this.#entryQueue.then(() => this.#placeExposureIncreasingOrder(input));
    this.#entryQueue = task.catch(() => undefined);
    return task;
  }

  getCapitalHealth() {
    const state = this.#capitalManager.getState();
    const current = this.#currentCommittedExposureKrw();
    return Object.freeze({
      ...state,
      currentCommittedExposureKrw: current.exposureKrw,
      valuationBlockers: current.blockers,
      availableNewExposureKrw: state.initialized
        ? Math.max(0, state.effectiveTradingCapitalKrw - current.exposureKrw)
        : 0,
      filledExposureReleasedOnlyAfterFreshSettlement: true,
      reductionOrdersExemptFromCapitalGate: true,
      krwDirectValuationMarkets: Object.freeze(["KR_STOCK", "CRYPTO_SPOT:UPBIT:KRW-*"]),
      foreignCurrencyNewExposureRequiresAuthoritativeKrwValuation: true,
      executionAuthority: "NONE",
      liveAuthorityGranted: false,
    });
  }

  async applyCapitalSettlement(input, options = {}) {
    object(input, "CAPITAL_SETTLEMENT_REQUIRED", "capital settlement evidence is required");
    if (input.positionsFlat !== true || Number(input.openOrderCount) !== 0 || Number(input.managedExposureKrw) !== 0) {
      throw new GatewayError(
        "CAPITAL_SETTLEMENT_FLAT_EVIDENCE_REQUIRED",
        "compounding settlement requires simulated positionsFlat=true, openOrderCount=0, managedExposureKrw=0",
        409,
      );
    }

    const state = this.#capitalManager.getState();
    const paperState = object(this.#gateway.exportPaperState(), "CAPITAL_OMS_STATE_INVALID", "Paper OMS state is required");
    const settlementMs = state.lastSettlement ? Date.parse(state.lastSettlement.observedAt) : Number.NEGATIVE_INFINITY;
    if (state.lastSettlement && !Number.isFinite(settlementMs)) {
      throw new GatewayError("CAPITAL_SETTLEMENT_TIMESTAMP_INVALID", "latest capital settlement timestamp is invalid", 503);
    }
    const openEntries = (paperState.orders ?? []).filter(
      (order) => exposureIncreasingIntent(order?.intent)
        && NONTERMINAL_STATES.has(order?.status)
        && (state.lastSettlement ? afterSettlement(order, settlementMs) : true),
    );
    if (openEntries.length > 0) {
      throw new GatewayError(
        "CAPITAL_SETTLEMENT_OPEN_ENTRY_ORDERS",
        "capital settlement is blocked while exposure-increasing Paper orders remain open",
        409,
      );
    }

    const result = await this.#capitalManager.applySettlement(input, options);
    return Object.freeze({
      ...result,
      settlementAuthority: "CALLER_SUPPLIED_SIMULATED_FLAT_EVIDENCE_ONLY",
      runtimePositionReconciliationProven: false,
      externalWithdrawalPerformed: false,
      executionAuthority: "NONE",
      liveAuthorityGranted: false,
    });
  }
}
