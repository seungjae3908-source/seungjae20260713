import { createHash } from "node:crypto";
import {
  buildFourMarketExecutionContext,
  simulateFourMarketFill,
} from "./four-market-execution-v2.js";
import { buildPaperEvidenceProvenance } from "./four-market-paper-sampler-v1.js";
import { validatePumpProspectiveStateV1 } from "./crypto-pump-reversal-prospective-state-v1.js";

export const PUMP_CANONICAL_SAMPLE_VERSION =
  "crypto-pump-reversal-canonical-paper-sample-v1";

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hash(value) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function positive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function immutableSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function readySizedRecord(state, recordId) {
  validatePumpProspectiveStateV1(state);
  const record = state.records.find((row) => row.recordId === recordId);
  if (!record) throw new Error("PUMP_CANONICAL_RECORD_NOT_FOUND");
  if (record.status !== "OPEN" && record.status !== "EXIT_TRIGGERED") {
    throw new Error("PUMP_CANONICAL_OPEN_OR_EXIT_RECORD_REQUIRED");
  }
  if (record.riskSizingStatus !== "READY") {
    throw new Error("PUMP_CANONICAL_RISK_SIZING_REQUIRED");
  }
  const sizing = record.riskSizing?.result;
  const execution = sizing?.prospectiveEntryExecution;
  if (sizing?.status !== "READY"
    || !positive(sizing?.finalQuantity)
    || !positive(sizing?.finalNotional)
    || execution?.schemaVersion !== "crypto-pump-reversal-prospective-entry-execution-v1"
    || execution.actualExchangeFillClaim !== false
    || !positive(execution.quantity)
    || execution.quantity !== sizing.finalQuantity
    || execution.timeframe !== "1h"
    || execution.horizon !== 72
    || execution.style !== "SWING"
    || execution.marketAdapterIdentity?.id !== "crypto-futures-bitget-execution"
    || execution.marketAdapterIdentity?.version !== "v2"
    || execution.executionPolicy?.sameBarPolicy !== "STOP_FIRST"
    || execution.executionPolicy?.fillModel !== "DEPTH_PARTICIPATION"
    || execution.executionPolicy?.allowPartialFill !== false
    || !positive(execution.executionPolicy?.maxParticipationRate)
    || !nonEmpty(execution.costPolicy?.version)
    || execution.fundingChargedAtEntry !== false) {
    throw new Error("PUMP_CANONICAL_ENTRY_EXECUTION_SNAPSHOT_INVALID");
  }
  return { record, sizing, execution };
}

function strategyIdentity(state, record) {
  const candidate = state.policy.candidate;
  if (!immutableSha(candidate?.researchCodeSha)
    || candidate.strategyId !== record.signal.strategyId
    || candidate.strategyVersion !== record.signal.strategyVersion
    || candidate.parameterHash !== record.signal.parameterHash
    || candidate.market !== "CRYPTO_FUTURES"
    || candidate.direction !== "SHORT") {
    throw new Error("PUMP_CANONICAL_STRATEGY_IDENTITY_MISMATCH");
  }
  return Object.freeze({
    candidateId: candidate.candidateId,
    strategyFamily: candidate.strategyFamily,
    strategyId: candidate.strategyId,
    strategyVersion: candidate.strategyVersion,
    parameterHash: candidate.parameterHash,
    parameterDigest: candidate.parameterHash,
    researchCodeSha: candidate.researchCodeSha,
    accountMode: "PAPER",
  });
}

export function buildPumpCanonicalOpenSampleV1({
  state,
  recordId,
} = {}) {
  const { record, sizing, execution } = readySizedRecord(state, recordId);
  const identity = strategyIdentity(state, record);
  const evaluatedAtMs = execution.evaluatedAtMs;
  if (!Number.isSafeInteger(evaluatedAtMs)
    || evaluatedAtMs < record.position.entryTimestampMs
    || evaluatedAtMs - record.position.entryTimestampMs > 30_000) {
    throw new Error("PUMP_CANONICAL_ENTRY_EXECUTION_TIME_INVALID");
  }

  const context = buildFourMarketExecutionContext({
    market: "CRYPTO_FUTURES",
    stage: "PAPER",
    style: execution.style,
    timeframe: execution.timeframe,
    horizon: execution.horizon,
    direction: "SHORT",
    executionPurpose: "ENTRY",
    marketAdapterIdentity: execution.marketAdapterIdentity,
    strategyIdentity: identity,
    costPolicy: execution.costPolicy,
    executionPolicy: execution.executionPolicy,
    dataEvidence: execution.dataEvidence,
    evaluatedAtMs,
  });
  if (context.status !== "READY") {
    throw new Error(`PUMP_CANONICAL_EXECUTION_CONTEXT_BLOCKED:${context.blockers.join(",")}`);
  }

  const fill = simulateFourMarketFill({
    context,
    order: Object.freeze({
      type: "MARKET",
      quantity: execution.quantity,
      direction: "SHORT",
    }),
    quote: execution.quote,
    depth: execution.depth,
  });
  if (fill.status !== "FILLED"
    || !positive(fill.fillPrice)
    || !positive(fill.filledQuantity)
    || !positive(fill.notional)
    || fill.filledQuantity !== execution.quantity
    || fill.orderSubmitted !== false
    || fill.exchangeRequestSent !== false
    || fill.privateTradingRequestSent !== false
    || fill.liveExecution !== false) {
    throw new Error("PUMP_CANONICAL_ENTRY_FILL_NOT_READY");
  }

  const signal = Object.freeze({
    signalId: record.signal.signalId,
    market: "CRYPTO_FUTURES",
    symbol: record.signal.symbol,
    style: execution.style,
    timeframe: execution.timeframe,
    horizon: execution.horizon,
    direction: "SHORT",
    signalDirection: "SHORT",
    strategyIdentity: identity,
  });
  const entryEvidenceProvenance = buildPaperEvidenceProvenance({
    dataEvidence: execution.dataEvidence,
    signal,
  });
  const sampleIdentity = Object.freeze({
    signalId: signal.signalId,
    market: signal.market,
    symbol: signal.symbol,
    style: signal.style,
    timeframe: signal.timeframe,
    horizon: signal.horizon,
    signalDirection: signal.signalDirection,
    executionDirection: "SHORT",
    candidateId: identity.candidateId,
    strategyFamily: identity.strategyFamily,
    strategyId: identity.strategyId,
    strategyVersion: identity.strategyVersion,
    parameterHash: identity.parameterHash,
    parameterDigest: identity.parameterDigest,
    researchCodeSha: identity.researchCodeSha,
    accountMode: identity.accountMode,
    evaluatedAtMs,
  });
  const paperSampleId = hash({
    version: PUMP_CANONICAL_SAMPLE_VERSION,
    recordId: record.recordId,
    identity: sampleIdentity,
    parityFingerprint: context.parityFingerprint,
    fill,
    riskSizingEvidenceDigest: record.riskSizing.evidenceDigest,
  });

  return deepFreeze({
    schemaVersion: 1,
    pumpSchemaVersion: PUMP_CANONICAL_SAMPLE_VERSION,
    paperSampleId,
    recordId: record.recordId,
    identity: sampleIdentity,
    decision: "RESEARCH_ONLY",
    profitGate: Object.freeze({
      decision: "RESEARCH_ONLY",
      eligible: false,
      reasons: Object.freeze([
        "PUMP_PROSPECTIVE_OBSERVED_CALIBRATION_REQUIRED",
        "CANONICAL_PROFIT_ADMISSION_NOT_YET_ALLOWED",
      ]),
      executionAuthority: "NONE",
    }),
    profitEvidence: Object.freeze({
      status: "RESEARCH_ONLY",
      expectedNetEdge: null,
      expectedNetReturn: null,
      riskRewardRatio: null,
      sampleSize: 0,
      costPolicyId: execution.costPolicy.version,
      executionAuthority: "NONE",
    }),
    executionContextStatus: "READY",
    parityFingerprint: context.parityFingerprint,
    entryEvidenceProvenance,
    fill: Object.freeze({ ...fill }),
    riskSizingEvidenceDigest: record.riskSizing.evidenceDigest,
    settlementExecutionPolicy: Object.freeze({
      marketAdapterIdentity: execution.marketAdapterIdentity,
      entryExecutionPolicy: execution.executionPolicy,
      costPolicyVersion: execution.costPolicy.version,
      sameBarPolicy: "STOP_FIRST",
      fundingChargedAtEntry: false,
    }),
    blockers: Object.freeze([]),
    simulatedOnly: true,
    canonicalProfitAdmissionEligible: false,
    profitabilityClaimAllowed: false,
    profitabilityCredit: 0,
    economicSampleCredit: 0,
    executionAuthority: "NONE",
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
  });
}

export function buildPumpCanonicalSettlementRequestV1({
  state,
  recordId,
} = {}) {
  const { record, sizing } = readySizedRecord(state, recordId);
  if (record.status !== "EXIT_TRIGGERED" || !record.exitTrigger) {
    throw new Error("PUMP_CANONICAL_EXIT_TRIGGER_REQUIRED");
  }
  const sample = buildPumpCanonicalOpenSampleV1({ state, recordId });
  if (sample.riskSizingEvidenceDigest !== record.riskSizing.evidenceDigest) {
    throw new Error("PUMP_CANONICAL_SETTLEMENT_RISK_LINEAGE_MISMATCH");
  }
  const requestCore = Object.freeze({
    schemaVersion: "crypto-pump-reversal-canonical-settlement-request-v1",
    recordId: record.recordId,
    candidateId: record.observation.candidateId,
    signalId: record.signal.signalId,
    strategyId: state.policy.candidate.strategyId,
    strategyVersion: state.policy.candidate.strategyVersion,
    parameterHash: state.policy.candidate.parameterHash,
    researchCodeSha: state.policy.candidate.researchCodeSha,
    market: "CRYPTO_FUTURES",
    symbol: record.observation.symbol,
    direction: "SHORT",
    paperSampleId: sample.paperSampleId,
    sample,
    quantity: sizing.finalQuantity,
    entryTimestampMs: record.position.entryTimestampMs,
    entryReferencePrice: record.position.entryPrice,
    entryFillPrice: sample.fill.fillPrice,
    entryNotional: sample.fill.notional,
    stopPrice: record.position.stopPrice,
    timeExitAtMs: record.position.timeExitAtMs,
    exitTrigger: record.exitTrigger,
    costPolicyVersion: sample.profitEvidence.costPolicyId,
    riskSizingEvidenceDigest: record.riskSizing.evidenceDigest,
    requiredFullCostComponents: Object.freeze([
      ...state.policy.fullCostPolicy.requiredComponents,
    ]),
    settlementBeforeFullCostAllowed: false,
    missingCostAsZeroAllowed: false,
    profitabilityClaimAllowed: false,
    executionAuthority: "NONE",
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
  return deepFreeze({
    ...requestCore,
    settlementRequestId: hash(requestCore),
  });
}
