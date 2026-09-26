import {
  FOUR_MARKET_EXECUTION_PROFILES,
  buildFourMarketExecutionContext,
} from "./four-market-execution-v2.js";

const SCHEMA_VERSION = "canonical-paper-simulation-authority-v1";
const DEFAULT_MAX_EVIDENCE_AGE_MS = 30_000;
const ENTRY_DIRECTIONS = Object.freeze({
  KR_STOCK: Object.freeze(["BUY"]),
  US_STOCK: Object.freeze(["BUY"]),
  CRYPTO_SPOT: Object.freeze(["BUY"]),
  CRYPTO_FUTURES: Object.freeze(["LONG", "SHORT"]),
});
const STYLE_SET = new Set(["SCALPING", "SWING", "MID_LONG"]);

/**
 * Pre-registered before any Natural Paper outcome is observed.
 *
 * TOP_OF_BOOK is intentionally the only v1 Paper entry fidelity. A candidate
 * with bar-only evidence is blocked instead of silently downgrading fidelity.
 * sameBarPolicy remains STOP_FIRST for cross-stage conservatism.
 * maxParticipationRate is required by the shared execution kernel and is part
 * of the parity fingerprint. It is inert for TOP_OF_BOOK fills; changing it or
 * any other field requires a new execution-policy version.
 */
export const CANONICAL_PAPER_EXECUTION_POLICY = Object.freeze({
  version: "public-evidence-simulated-paper-v1",
  fillModel: "TOP_OF_BOOK",
  sameBarPolicy: "STOP_FIRST",
  allowPartialFill: false,
  maxParticipationRate: 0.1,
  nextBarOnly: false,
});

/**
 * MARKET is the only v1 simulated entry order type. This avoids inventing a
 * limit/stop price. Fill price authority remains the fresh public top of book,
 * while quantity authority remains the approved Trading Risk Engine result.
 */
export const CANONICAL_PAPER_SIMULATED_ORDER_POLICY = Object.freeze({
  version: "public-evidence-simulated-market-order-v1",
  type: "MARKET",
  priceAuthority: "PUBLIC_TOP_OF_BOOK",
  quantityAuthority: "TRADING_RISK_ENGINE",
});

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value) {
  return finite(value) && value > 0;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function digest64(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function immutableSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function add(blockers, code, condition = true) {
  if (condition && !blockers.includes(code)) blockers.push(code);
}

function safetyEnvelope() {
  return Object.freeze({
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
    profitabilityClaimAllowed: false,
  });
}

function quoteBlockers(dataEvidence, nowMs, maxEvidenceAgeMs) {
  const blockers = [];
  const quote = dataEvidence?.quoteEvidence;
  add(blockers, "CANONICAL_TOP_OF_BOOK_QUOTE_REQUIRED", quote?.available !== true);
  add(blockers, "CANONICAL_TOP_OF_BOOK_BID_REQUIRED", !positive(quote?.bid));
  add(blockers, "CANONICAL_TOP_OF_BOOK_ASK_REQUIRED", !positive(quote?.ask));
  if (positive(quote?.bid) && positive(quote?.ask)) {
    add(blockers, "CANONICAL_TOP_OF_BOOK_CROSSED", quote.bid > quote.ask);
  }
  add(blockers, "CANONICAL_TOP_OF_BOOK_TIMESTAMP_REQUIRED", !positive(quote?.asOfMs));
  add(blockers, "CANONICAL_TOP_OF_BOOK_MAX_AGE_REQUIRED", !positive(quote?.maxAgeMs));
  if (positive(quote?.asOfMs)) {
    add(blockers, "CANONICAL_TOP_OF_BOOK_FROM_FUTURE", quote.asOfMs > nowMs);
    if (positive(quote?.maxAgeMs)) {
      const allowedAgeMs = Math.min(quote.maxAgeMs, maxEvidenceAgeMs);
      add(blockers, "CANONICAL_TOP_OF_BOOK_STALE", nowMs - quote.asOfMs > allowedAgeMs);
    }
  }
  return blockers;
}

function riskBlockers(risk, nowMs, maxEvidenceAgeMs) {
  const blockers = [];
  add(blockers, "CANONICAL_RISK_EVIDENCE_NOT_APPROVED", risk?.status !== "APPROVED");
  add(blockers, "CANONICAL_RISK_SOURCE_MISMATCH", risk?.source !== "TRADING_RISK_ENGINE");
  add(blockers, "CANONICAL_RISK_SAFETY_INVALID", risk?.simulatedOnly !== true || risk?.executionAuthority !== "NONE");
  add(blockers, "CANONICAL_RISK_NOT_ALLOWED", risk?.allowed !== true);
  add(blockers, "CANONICAL_RISK_BLOCK_CODES_PRESENT", !Array.isArray(risk?.blockCodes) || risk.blockCodes.length !== 0);
  add(blockers, "CANONICAL_RISK_QUANTITY_REQUIRED", !positive(risk?.recommendedQuantity));
  add(blockers, "CANONICAL_RISK_TIMESTAMP_REQUIRED", !positive(risk?.evaluatedAtMs));
  if (positive(risk?.evaluatedAtMs)) {
    add(blockers, "CANONICAL_RISK_FROM_FUTURE", risk.evaluatedAtMs > nowMs);
    add(blockers, "CANONICAL_RISK_STALE", nowMs - risk.evaluatedAtMs > maxEvidenceAgeMs);
  }
  return blockers;
}

function identityBlockers(candidate, nowMs) {
  const blockers = [];
  const signal = candidate?.signal;
  const identity = signal?.strategyIdentity;
  add(blockers, "CANONICAL_ADMISSION_BRIDGE_REQUIRED", candidate?.admissionEvidence?.crossRuntimeVerified !== true);
  add(blockers, "CANONICAL_ADMISSION_DIGEST_REQUIRED", !digest64(candidate?.admissionEvidence?.evidenceDigest));
  add(blockers, "CANONICAL_PAPER_MARKET_REQUIRED", !FOUR_MARKET_EXECUTION_PROFILES[signal?.market]);
  add(blockers, "CANONICAL_PAPER_STYLE_REQUIRED", !STYLE_SET.has(signal?.style));
  add(blockers, "CANONICAL_PAPER_TIMEFRAME_REQUIRED", !nonEmpty(signal?.timeframe));
  add(blockers, "CANONICAL_PAPER_HORIZON_REQUIRED", !Number.isInteger(signal?.horizon) || signal.horizon <= 0);
  add(blockers, "CANONICAL_PAPER_TIMESTAMP_REQUIRED", !positive(signal?.timestampMs));
  add(blockers, "CANONICAL_PAPER_EXPIRY_REQUIRED", !positive(signal?.expiresAtMs));
  if (positive(signal?.timestampMs)) add(blockers, "CANONICAL_PAPER_FROM_FUTURE", signal.timestampMs > nowMs);
  if (positive(signal?.expiresAtMs)) add(blockers, "CANONICAL_PAPER_EXPIRED", nowMs >= signal.expiresAtMs);
  add(blockers, "CANONICAL_STRATEGY_ID_REQUIRED", !nonEmpty(identity?.strategyId));
  add(blockers, "CANONICAL_STRATEGY_VERSION_REQUIRED", !nonEmpty(identity?.strategyVersion));
  add(blockers, "CANONICAL_PARAMETER_HASH_REQUIRED", !nonEmpty(identity?.parameterHash));
  add(blockers, "CANONICAL_RESEARCH_SHA_REQUIRED", !immutableSha(identity?.researchCodeSha));
  add(blockers, "CANONICAL_COST_POLICY_VERSION_REQUIRED", !nonEmpty(identity?.costPolicyVersion));
  add(blockers, "CANONICAL_PAPER_SAFETY_INVALID",
    candidate?.executionAuthority !== "NONE"
      || candidate?.simulatedOnly !== true
      || candidate?.liveOrderAllowed !== false
      || candidate?.privateTradingApiAllowed !== false
      || candidate?.orderSubmitted !== false
      || candidate?.exchangeRequestSent !== false
      || candidate?.productionMutationAllowed !== false);
  if (FOUR_MARKET_EXECUTION_PROFILES[signal?.market]) {
    add(blockers, "CANONICAL_PAPER_ENTRY_DIRECTION_UNSUPPORTED",
      !ENTRY_DIRECTIONS[signal.market].includes(signal?.direction));
  }
  return blockers;
}

function quantityBlockers(market, quantity, dataEvidence) {
  const blockers = [];
  if (!positive(quantity)) return ["CANONICAL_RISK_QUANTITY_REQUIRED"];
  if (market === "KR_STOCK" || market === "US_STOCK") {
    add(blockers, "STOCK_SIMULATED_QUANTITY_INTEGER_REQUIRED", !Number.isSafeInteger(quantity));
  }
  if (market === "CRYPTO_SPOT") {
    const ask = dataEvidence?.quoteEvidence?.ask;
    const minNotional = dataEvidence?.minOrderNotional;
    add(blockers, "SPOT_SIMULATED_MIN_NOTIONAL_EVIDENCE_REQUIRED", !positive(ask) || !positive(minNotional));
    if (positive(ask) && positive(minNotional)) {
      add(blockers, "SPOT_SIMULATED_MIN_NOTIONAL_NOT_MET", quantity * ask + Number.EPSILON < minNotional);
    }
  }
  if (market === "CRYPTO_FUTURES") {
    const minQty = dataEvidence?.minQty;
    const qtyStep = dataEvidence?.qtyStep;
    add(blockers, "FUTURES_SIMULATED_MIN_QTY_EVIDENCE_REQUIRED", !positive(minQty));
    add(blockers, "FUTURES_SIMULATED_QTY_STEP_EVIDENCE_REQUIRED", !positive(qtyStep));
    if (positive(minQty)) add(blockers, "FUTURES_SIMULATED_MIN_QTY_NOT_MET", quantity + Number.EPSILON < minQty);
    if (positive(qtyStep)) {
      const units = quantity / qtyStep;
      add(blockers, "FUTURES_SIMULATED_QTY_STEP_MISMATCH", Math.abs(units - Math.round(units)) > 1e-9);
    }
  }
  return blockers;
}

function blocked(blockers, marketAdapterIdentity = null) {
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    status: "BLOCKED",
    blockers: [...new Set(blockers)],
    sampleExecutionReady: false,
    marketAdapterIdentity: marketAdapterIdentity ? clone(marketAdapterIdentity) : null,
    executionPolicy: clone(CANONICAL_PAPER_EXECUTION_POLICY),
    orderPolicy: clone(CANONICAL_PAPER_SIMULATED_ORDER_POLICY),
    execution: null,
    order: null,
    quote: null,
    executionContext: null,
    ...safetyEnvelope(),
  });
}

export function resolveCanonicalPaperSimulationAuthority({
  candidate,
  nowMs = Date.now(),
  maxEvidenceAgeMs = DEFAULT_MAX_EVIDENCE_AGE_MS,
} = {}) {
  if (!positive(nowMs) || !positive(maxEvidenceAgeMs)) {
    return blocked(["CANONICAL_SIMULATION_CLOCK_INVALID"]);
  }

  const blockers = identityBlockers(candidate, nowMs);
  const market = candidate?.signal?.market;
  const profile = FOUR_MARKET_EXECUTION_PROFILES[market];
  const marketAdapterIdentity = profile?.marketAdapter ?? null;
  const risk = candidate?.riskEvidence;
  const dataEvidence = candidate?.execution?.dataEvidence;
  const costPolicy = candidate?.execution?.costPolicy;
  const strategyIdentity = candidate?.signal?.strategyIdentity;

  blockers.push(...riskBlockers(risk, nowMs, maxEvidenceAgeMs));
  add(blockers, "CANONICAL_EXECUTION_DATA_REQUIRED", !dataEvidence || dataEvidence.publicOnly !== true || dataEvidence.dataQuality !== "READY");
  add(blockers, "CANONICAL_EXECUTION_DATA_TIMESTAMP_REQUIRED", !positive(dataEvidence?.asOfMs));
  if (positive(dataEvidence?.asOfMs)) {
    add(blockers, "CANONICAL_EXECUTION_DATA_FROM_FUTURE", dataEvidence.asOfMs > nowMs);
    if (positive(dataEvidence?.maxAgeMs)) {
      add(blockers, "CANONICAL_EXECUTION_DATA_STALE", nowMs - dataEvidence.asOfMs > Math.min(dataEvidence.maxAgeMs, maxEvidenceAgeMs));
    } else {
      add(blockers, "CANONICAL_EXECUTION_DATA_MAX_AGE_REQUIRED");
    }
  }
  add(blockers, "CANONICAL_EXECUTION_COST_POLICY_REQUIRED", !costPolicy || !nonEmpty(costPolicy.version));
  if (nonEmpty(costPolicy?.version) && nonEmpty(strategyIdentity?.costPolicyVersion)) {
    add(blockers, "CANONICAL_EXECUTION_COST_POLICY_MISMATCH", costPolicy.version !== strategyIdentity.costPolicyVersion);
  }
  blockers.push(...quoteBlockers(dataEvidence, nowMs, maxEvidenceAgeMs));
  blockers.push(...quantityBlockers(market, risk?.recommendedQuantity, dataEvidence));

  if (blockers.length > 0 || !marketAdapterIdentity) return blocked(blockers, marketAdapterIdentity);

  const execution = deepFreeze({
    ...clone(candidate.execution),
    marketAdapterIdentity: clone(marketAdapterIdentity),
    executionPolicy: clone(CANONICAL_PAPER_EXECUTION_POLICY),
    strategyIdentity: clone(strategyIdentity),
  });
  const order = deepFreeze({
    type: CANONICAL_PAPER_SIMULATED_ORDER_POLICY.type,
    direction: candidate.signal.direction,
    quantity: risk.recommendedQuantity,
  });
  const quote = deepFreeze(clone(dataEvidence.quoteEvidence));

  let executionContext;
  try {
    executionContext = buildFourMarketExecutionContext({
      market,
      stage: "PAPER",
      style: candidate.signal.style,
      timeframe: candidate.signal.timeframe,
      horizon: candidate.signal.horizon,
      direction: candidate.signal.direction,
      executionPurpose: "ENTRY",
      marketAdapterIdentity,
      strategyIdentity,
      costPolicy,
      executionPolicy: CANONICAL_PAPER_EXECUTION_POLICY,
      dataEvidence,
      evaluatedAtMs: nowMs,
    });
  } catch (error) {
    return blocked([`CANONICAL_EXECUTION_CONTEXT_INVALID:${error?.message ?? "UNKNOWN"}`], marketAdapterIdentity);
  }

  if (executionContext.status !== "READY") {
    return blocked(executionContext.blockers?.length
      ? executionContext.blockers.map((code) => `EXECUTION_KERNEL:${code}`)
      : ["CANONICAL_EXECUTION_CONTEXT_NOT_READY"], marketAdapterIdentity);
  }

  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    status: "READY",
    blockers: [],
    sampleExecutionReady: true,
    marketAdapterIdentity: clone(marketAdapterIdentity),
    executionPolicy: clone(CANONICAL_PAPER_EXECUTION_POLICY),
    orderPolicy: clone(CANONICAL_PAPER_SIMULATED_ORDER_POLICY),
    execution,
    order,
    quote,
    executionContext,
    ...safetyEnvelope(),
  });
}
