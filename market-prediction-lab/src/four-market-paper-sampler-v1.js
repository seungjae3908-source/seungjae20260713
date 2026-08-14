import { createHash } from "node:crypto";
import {
  buildFourMarketExecutionContext,
  simulateFourMarketFill,
} from "./four-market-execution-v2.js";

const SUPPORTED_MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);
const STOCK_OR_SPOT_DIRECTIONS = new Set(["BUY", "SELL_EXIT"]);
const FUTURES_DIRECTIONS = new Set(["LONG", "SHORT"]);

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function immutableSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/iu.test(value);
}

function validDecision(decision) {
  return decision === "ELIGIBLE" || decision === "NO_TRADE";
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function validateSignalIdentity(signal) {
  if (!nonEmpty(signal?.signalId)) throw new TypeError("signalId is required");
  if (!SUPPORTED_MARKETS.has(signal?.market)) throw new TypeError("supported market is required");
  if (!nonEmpty(signal?.style)) throw new TypeError("style is required");
  if (!nonEmpty(signal?.timeframe)) throw new TypeError("timeframe is required");
  if (!Number.isInteger(signal?.horizon) || signal.horizon <= 0) throw new TypeError("positive horizon is required");
  if (!nonEmpty(signal?.strategyIdentity?.strategyId)) throw new TypeError("strategyId is required");
  if (!nonEmpty(signal?.strategyIdentity?.strategyVersion)) throw new TypeError("strategyVersion is required");
  if (!nonEmpty(signal?.strategyIdentity?.parameterHash)) throw new TypeError("parameterHash is required");
  if (!immutableSha(signal?.strategyIdentity?.researchCodeSha)) throw new TypeError("immutable researchCodeSha is required");

  const directionSet = signal.market === "CRYPTO_FUTURES" ? FUTURES_DIRECTIONS : STOCK_OR_SPOT_DIRECTIONS;
  if (!directionSet.has(signal.direction)) throw new TypeError("direction is not supported for market");
}

function validateGate(gate) {
  if (!validDecision(gate?.decision)) throw new TypeError("valid Profit-First decision is required");
  if (typeof gate?.eligible !== "boolean") throw new TypeError("eligible boolean is required");
  if (!Array.isArray(gate?.reasons)) throw new TypeError("gate reasons are required");
  if (gate?.executionAuthority !== "NONE") throw new Error("PAPER_GATE_EXECUTION_AUTHORITY_FORBIDDEN");
  if (gate.decision === "ELIGIBLE" && gate.eligible !== true) throw new Error("PAPER_GATE_ELIGIBILITY_MISMATCH");
  if (gate.decision === "NO_TRADE" && gate.eligible !== false) throw new Error("PAPER_GATE_ELIGIBILITY_MISMATCH");
  if (gate.decision === "ELIGIBLE" && gate.reasons.length > 0) throw new Error("PAPER_ELIGIBLE_GATE_REASONS_FORBIDDEN");
}

function validateEvidence(evidence, signal, gate) {
  if (!evidence || typeof evidence !== "object") throw new TypeError("profit evidence is required");
  if (evidence.executionAuthority !== "NONE") throw new Error("PAPER_EVIDENCE_EXECUTION_AUTHORITY_FORBIDDEN");
  if (gate.decision === "ELIGIBLE") {
    if (evidence.status !== "READY") throw new Error("PAPER_ELIGIBLE_EVIDENCE_NOT_READY");
    if (!finite(evidence.expectedNetEdge) || evidence.expectedNetEdge <= 0) throw new Error("PAPER_ELIGIBLE_NET_EDGE_NON_POSITIVE");
    if (!finite(evidence.expectedNetReturn) || evidence.expectedNetReturn <= 0) throw new Error("PAPER_ELIGIBLE_EXPECTED_RETURN_NON_POSITIVE");
    if (!finite(evidence.riskRewardRatio) || evidence.riskRewardRatio < 1) throw new Error("PAPER_ELIGIBLE_RISK_REWARD_INSUFFICIENT");
    if (!Number.isInteger(evidence.sampleSize) || evidence.sampleSize <= 0) throw new Error("PAPER_ELIGIBLE_SAMPLE_EVIDENCE_REQUIRED");
    if (!nonEmpty(evidence.costPolicyId)) throw new Error("PAPER_ELIGIBLE_COST_POLICY_REQUIRED");
  }
  if (nonEmpty(evidence.market) && evidence.market !== signal.market) throw new Error("PAPER_EVIDENCE_MARKET_MISMATCH");
}

function safetyEnvelope() {
  return Object.freeze({
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
    profitabilityClaimAllowed: false,
  });
}

function buildBaseSnapshot(signal, gate, evidence, evaluatedAtMs) {
  const identity = Object.freeze({
    signalId: signal.signalId,
    market: signal.market,
    style: signal.style,
    timeframe: signal.timeframe,
    horizon: signal.horizon,
    direction: signal.direction,
    strategyId: signal.strategyIdentity.strategyId,
    strategyVersion: signal.strategyIdentity.strategyVersion,
    parameterHash: signal.strategyIdentity.parameterHash,
    researchCodeSha: signal.strategyIdentity.researchCodeSha.toLowerCase(),
    evaluatedAtMs,
  });
  return Object.freeze({
    schemaVersion: 1,
    identity,
    profitGate: Object.freeze({
      decision: gate.decision,
      eligible: gate.eligible,
      reasons: Object.freeze([...gate.reasons]),
      executionAuthority: "NONE",
    }),
    profitEvidence: Object.freeze({
      status: evidence.status ?? null,
      expectedNetEdge: evidence.expectedNetEdge ?? null,
      expectedNetReturn: evidence.expectedNetReturn ?? null,
      riskRewardRatio: evidence.riskRewardRatio ?? null,
      sampleSize: evidence.sampleSize ?? 0,
      costPolicyId: evidence.costPolicyId ?? null,
      executionAuthority: "NONE",
    }),
  });
}

export function buildFourMarketPaperSample({
  signal,
  profitGate,
  profitEvidence,
  execution,
  order = null,
  bar = null,
  quote = null,
  depth = null,
  evaluatedAtMs,
} = {}) {
  if (!finite(evaluatedAtMs)) throw new TypeError("evaluatedAtMs is required");
  validateSignalIdentity(signal);
  validateGate(profitGate);
  validateEvidence(profitEvidence, signal, profitGate);

  const base = buildBaseSnapshot(signal, profitGate, profitEvidence, evaluatedAtMs);

  if (profitGate.decision === "NO_TRADE") {
    const sampleId = hash({ ...base.identity, decision: "NO_TRADE", reasons: profitGate.reasons });
    return Object.freeze({
      ...base,
      paperSampleId: sampleId,
      status: "NO_TRADE",
      executionContextStatus: "NOT_REQUESTED",
      fill: null,
      blockers: Object.freeze([...profitGate.reasons]),
      ...safetyEnvelope(),
    });
  }

  if (!execution || typeof execution !== "object") throw new TypeError("execution input is required for ELIGIBLE signal");
  if (!order || typeof order !== "object") throw new TypeError("simulated order is required for ELIGIBLE signal");
  if (order.direction !== signal.direction) throw new Error("PAPER_SIGNAL_ORDER_DIRECTION_MISMATCH");

  const context = buildFourMarketExecutionContext({
    ...execution,
    market: signal.market,
    stage: "PAPER",
    style: signal.style,
    timeframe: signal.timeframe,
    horizon: signal.horizon,
    direction: signal.direction,
    strategyIdentity: signal.strategyIdentity,
    evaluatedAtMs,
  });

  const sampleId = hash({
    ...base.identity,
    decision: "ELIGIBLE",
    parityFingerprint: context.parityFingerprint,
    dataAsOfMs: execution?.dataEvidence?.asOfMs ?? null,
    orderType: order.type ?? null,
    quantity: order.quantity ?? null,
  });

  if (context.status !== "READY") {
    return Object.freeze({
      ...base,
      paperSampleId: sampleId,
      status: "BLOCKED",
      executionContextStatus: context.status,
      parityFingerprint: context.parityFingerprint,
      fill: null,
      blockers: Object.freeze([...context.blockers]),
      ...safetyEnvelope(),
    });
  }

  const fill = simulateFourMarketFill({ context, order, bar, quote, depth });
  if (fill.status !== "FILLED" && fill.status !== "PARTIALLY_FILLED") {
    return Object.freeze({
      ...base,
      paperSampleId: sampleId,
      status: fill.status === "PENDING" ? "PENDING" : "BLOCKED",
      executionContextStatus: context.status,
      parityFingerprint: context.parityFingerprint,
      fill: Object.freeze({ ...fill }),
      blockers: Object.freeze(fill.reason ? [fill.reason] : []),
      ...safetyEnvelope(),
    });
  }

  return Object.freeze({
    ...base,
    paperSampleId: sampleId,
    status: "OPEN",
    executionContextStatus: context.status,
    parityFingerprint: context.parityFingerprint,
    fill: Object.freeze({ ...fill }),
    blockers: Object.freeze([]),
    ...safetyEnvelope(),
  });
}

export function dedupeFourMarketPaperSamples(samples = []) {
  if (!Array.isArray(samples)) throw new TypeError("samples array is required");
  const byId = new Map();
  for (const sample of samples) {
    if (!sample || !nonEmpty(sample.paperSampleId)) throw new TypeError("valid paperSampleId is required");
    const serialized = stableSerialize(sample);
    const existing = byId.get(sample.paperSampleId);
    if (existing && existing.serialized !== serialized) throw new Error("PAPER_SAMPLE_ID_CONFLICT");
    if (!existing) byId.set(sample.paperSampleId, { sample, serialized });
  }
  return Object.freeze([...byId.values()].map(({ sample }) => sample));
}
