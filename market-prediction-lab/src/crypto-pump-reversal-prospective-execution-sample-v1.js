import { createHash } from "node:crypto";
import {
  buildFourMarketExecutionContext,
  simulateFourMarketFill,
} from "./four-market-execution-v2.js";
import { buildPaperEvidenceProvenance } from "./four-market-paper-sampler-v1.js";

export const PUMP_PROSPECTIVE_EXECUTION_SAMPLE_VERSION =
  "crypto-pump-reversal-prospective-execution-sample-v1";

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
function positive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function exactSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
function safety() {
  return {
    prospectiveExecutionSampleOnly: true,
    canonicalProfitAdmissionEligible: false,
    profitabilityCredit: 0,
    profitabilityClaimAllowed: false,
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
    executionAuthority: "NONE",
  };
}

export function buildPumpProspectiveExecutionSampleV1({
  record,
  sizingResult,
} = {}) {
  if (record?.status !== "OPEN"
    || record?.signal?.strategyId !== "CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1"
    || record?.signal?.direction !== "SHORT"
    || record?.signal?.market !== "CRYPTO_FUTURES"
    || !nonEmpty(record?.observation?.candidateId)
    || !nonEmpty(record?.observation?.strategyVersion)
    || !nonEmpty(record?.observation?.parameterHash)
    || !exactSha(record?.observation?.researchCodeSha)) {
    throw new Error("PUMP_PROSPECTIVE_EXECUTION_RECORD_INVALID");
  }
  if (sizingResult?.status !== "READY"
    || sizingResult?.version !== "pump-reversal-paper-risk-sizing-v1"
    || sizingResult?.canonicalProfitAdmissionEligible !== false
    || sizingResult?.profitabilityClaimAllowed !== false
    || sizingResult?.executionAuthority !== "NONE"
    || sizingResult?.liveOrderAllowed !== false
    || sizingResult?.privateTradingApiAllowed !== false
    || !positive(sizingResult?.finalQuantity)
    || !positive(sizingResult?.finalNotional)) {
    throw new Error("PUMP_PROSPECTIVE_EXECUTION_SIZING_INVALID");
  }
  const snapshot = sizingResult.prospectiveEntryExecution;
  if (!snapshot
    || snapshot.schemaVersion !== "crypto-pump-reversal-prospective-entry-execution-v1"
    || snapshot.style !== "SWING"
    || snapshot.timeframe !== "1h"
    || snapshot.horizon !== 72
    || snapshot.quantity !== sizingResult.finalQuantity
    || snapshot.fundingChargedAtEntry !== false
    || snapshot.actualExchangeFillClaim !== false
    || snapshot.executionPolicy?.fillModel !== "DEPTH_PARTICIPATION"
    || snapshot.executionPolicy?.allowPartialFill !== false
    || snapshot.executionPolicy?.sameBarPolicy !== "STOP_FIRST"
    || !nonEmpty(snapshot.costPolicy?.version)) {
    throw new Error("PUMP_PROSPECTIVE_ENTRY_EXECUTION_SNAPSHOT_INVALID");
  }

  const strategyIdentity = Object.freeze({
    candidateId: record.observation.candidateId,
    strategyFamily: "EVENT_SPECIALIST",
    strategyId: record.signal.strategyId,
    strategyVersion: record.observation.strategyVersion,
    parameterHash: record.observation.parameterHash,
    parameterDigest: record.observation.parameterHash,
    researchCodeSha: record.observation.researchCodeSha,
    accountMode: "PAPER",
  });
  const identity = Object.freeze({
    signalId: record.signal.signalId,
    market: "CRYPTO_FUTURES",
    symbol: record.signal.symbol,
    style: "SWING",
    timeframe: "1h",
    horizon: 72,
    signalDirection: "SHORT",
    executionDirection: "SHORT",
    ...strategyIdentity,
    evaluatedAtMs: snapshot.evaluatedAtMs,
  });

  const context = buildFourMarketExecutionContext({
    market: "CRYPTO_FUTURES",
    stage: "PAPER",
    executionPurpose: "ENTRY",
    style: "SWING",
    timeframe: "1h",
    horizon: 72,
    direction: "SHORT",
    marketAdapterIdentity: snapshot.marketAdapterIdentity,
    strategyIdentity,
    costPolicy: snapshot.costPolicy,
    executionPolicy: snapshot.executionPolicy,
    dataEvidence: snapshot.dataEvidence,
    evaluatedAtMs: snapshot.evaluatedAtMs,
  });
  if (context.status !== "READY") {
    throw new Error(`PUMP_PROSPECTIVE_ENTRY_CONTEXT_BLOCKED:${context.blockers.join(",")}`);
  }

  const fill = simulateFourMarketFill({
    context,
    order: Object.freeze({
      type: "MARKET",
      quantity: snapshot.quantity,
      direction: "SHORT",
    }),
    quote: snapshot.quote,
    depth: snapshot.depth,
  });
  if (fill.status !== "FILLED"
    || fill.filledQuantity !== snapshot.quantity
    || fill.orderSubmitted !== false
    || fill.exchangeRequestSent !== false) {
    throw new Error("PUMP_PROSPECTIVE_ENTRY_FULL_SIMULATED_FILL_REQUIRED");
  }

  const signalForProvenance = Object.freeze({
    signalId: record.signal.signalId,
    market: "CRYPTO_FUTURES",
    symbol: record.signal.symbol,
    style: "SWING",
    timeframe: "1h",
    horizon: 72,
    direction: "SHORT",
    strategyIdentity,
  });
  const entryEvidenceProvenance = buildPaperEvidenceProvenance({
    dataEvidence: snapshot.dataEvidence,
    signal: signalForProvenance,
  });
  const paperSampleId = sha256({
    schemaVersion: PUMP_PROSPECTIVE_EXECUTION_SAMPLE_VERSION,
    recordId: record.recordId,
    identity,
    parityFingerprint: context.parityFingerprint,
    costPolicyId: snapshot.costPolicy.version,
    quantity: snapshot.quantity,
    dataAsOfMs: snapshot.dataEvidence.asOfMs,
  });

  return deepFreeze({
    schemaVersion: 1,
    prospectiveExecutionSchemaVersion: PUMP_PROSPECTIVE_EXECUTION_SAMPLE_VERSION,
    paperSampleId,
    recordId: record.recordId,
    sampleClass: "GENUINE_FUTURE_PROSPECTIVE_EXECUTION_ONLY",
    status: "OPEN",
    identity,
    profitGate: Object.freeze({
      decision: "NOT_PROFIT_ADMITTED",
      eligible: false,
      reasons: Object.freeze(["OBSERVED_CALIBRATION_REQUIRED_BEFORE_CANONICAL_PROFIT_ADMISSION"]),
      executionAuthority: "NONE",
    }),
    profitEvidence: Object.freeze({
      status: "PROSPECTIVE_EXECUTION_ONLY",
      expectedNetEdge: null,
      expectedNetReturn: null,
      riskRewardRatio: null,
      sampleSize: 0,
      costPolicyId: snapshot.costPolicy.version,
      executionAuthority: "NONE",
    }),
    executionContextStatus: context.status,
    parityFingerprint: context.parityFingerprint,
    entryEvidenceProvenance,
    fill: deepFreeze({ ...fill }),
    blockers: Object.freeze([]),
    projectedFundingRiskRate: snapshot.projectedFundingRiskRate,
    fundingChargedAtEntry: false,
    ...safety(),
  });
}

export const PUMP_PROSPECTIVE_EXECUTION_SAMPLE_SAFETY = Object.freeze({
  schemaVersion: PUMP_PROSPECTIVE_EXECUTION_SAMPLE_VERSION,
  profitGateBypassAllowed: false,
  fabricatedExpectedEdgeAllowed: false,
  fabricatedSampleSizeAllowed: false,
  canonicalProfitAdmissionEligible: false,
  profitabilityCredit: 0,
  profitabilityClaimAllowed: false,
  simulatedOnly: true,
  actualExchangeFillClaim: false,
  executionAuthority: "NONE",
  liveOrderAllowed: false,
  privateTradingApiAllowed: false,
});
