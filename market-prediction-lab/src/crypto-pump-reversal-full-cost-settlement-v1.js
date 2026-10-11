import { createHash } from "node:crypto";
import {
  adaptNaturalPaperSettlementFullCost,
} from "./natural-paper-position-settlement-lifecycle-v1.js";
import {
  createNaturalPaperTriggerBoundSettlementCostProducer,
} from "./natural-paper-trigger-bound-settlement-cost-producer-v1.js";
import { settleFourMarketPaperSample } from "./four-market-paper-settlement-v1.js";

export const PUMP_PROSPECTIVE_FULL_COST_SETTLEMENT_VERSION =
  "crypto-pump-reversal-full-cost-settlement-v1";

const MINUTE_MS = 60_000;
const EXIT_EVIDENCE_CAPTURE_WINDOW_MS = 30_000;

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
function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function positive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function safeTime(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function safety() {
  return Object.freeze({
    profitabilityClaimAllowed: false,
    profitabilityCredit: 0,
    canonicalProfitAdmissionEligible: false,
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
    executionAuthority: "NONE",
  });
}
function blocked(blockers) {
  return deepFreeze({
    schemaVersion: PUMP_PROSPECTIVE_FULL_COST_SETTLEMENT_VERSION,
    status: "BLOCKED_DATA",
    blockers: Object.freeze([...new Set(blockers.filter(nonEmpty))]),
    economicSampleCredit: 0,
    ...safety(),
  });
}

export function buildPumpCanonicalSettlementBridgeV1({
  record,
  observedAtMs,
} = {}) {
  if (record?.status !== "EXIT_TRIGGERED"
    || record?.riskSizingStatus !== "READY"
    || record?.prospectiveExecutionSampleStatus !== "READY"
    || !record?.riskSizing?.result
    || !record?.prospectiveExecutionSample
    || !record?.position
    || !record?.exitTrigger) {
    throw new Error("PUMP_FULL_COST_SIZED_EXIT_REQUIRED");
  }
  const triggerAtMs = record.exitTrigger.triggerTimestampMs;
  const triggerBar = record.exitTrigger.bar;
  const barCloseMs = triggerAtMs + MINUTE_MS;
  if (!safeTime(triggerAtMs)
    || !triggerBar
    || triggerBar.timestampMs !== triggerAtMs
    || !positive(triggerBar.open)
    || !positive(triggerBar.high)
    || !positive(triggerBar.low)
    || !positive(triggerBar.close)
    || triggerBar.high < triggerBar.low) {
    throw new Error("PUMP_FULL_COST_EXIT_BAR_REQUIRED");
  }
  if (!safeTime(observedAtMs)
    || observedAtMs < barCloseMs
    || observedAtMs - barCloseMs > EXIT_EVIDENCE_CAPTURE_WINDOW_MS) {
    throw new Error("PUMP_FULL_COST_EXIT_EVIDENCE_CAPTURE_WINDOW_EXPIRED");
  }

  const sample = record.prospectiveExecutionSample;
  const sizing = record.riskSizing.result;
  const entryExecution = sizing.prospectiveEntryExecution;
  if (sample?.status !== "OPEN"
    || sample?.identity?.candidateId !== record.observation.candidateId
    || sample?.identity?.parameterHash !== record.observation.parameterHash
    || sample?.identity?.parameterDigest !== record.observation.parameterHash
    || sample?.identity?.researchCodeSha !== record.observation.researchCodeSha
    || sample?.identity?.executionDirection !== "SHORT"
    || !positive(sample?.fill?.fillPrice)
    || !positive(sample?.fill?.filledQuantity)
    || !positive(sample?.fill?.notional)
    || entryExecution?.costPolicy?.version !== sample?.profitEvidence?.costPolicyId
    || !entryExecution?.marketAdapterIdentity
    || !entryExecution?.executionPolicy
    || !entryExecution?.dataEvidence) {
    throw new Error("PUMP_FULL_COST_ENTRY_SAMPLE_INVALID");
  }

  const strategyIdentity = Object.freeze({
    candidateId: record.observation.candidateId,
    strategyFamily: "EVENT_SPECIALIST",
    strategyId: record.signal.strategyId,
    strategyVersion: record.observation.strategyVersion,
    parameterHash: record.observation.parameterHash,
    parameterDigest: record.observation.parameterHash,
    researchCodeSha: record.observation.researchCodeSha.toLowerCase(),
    accountMode: "PAPER",
  });
  const immutableContractDigest = sha256({
    recordId: record.recordId,
    paperSampleId: sample.paperSampleId,
    entryParityFingerprint: sample.parityFingerprint,
    riskSizingEvidenceDigest: record.riskSizing.evidenceDigest,
    costPolicyVersion: entryExecution.costPolicy.version,
  });
  const canonicalTriggerPayload = Object.freeze({
    positionId: record.position.positionId,
    paperSampleId: sample.paperSampleId,
    candidateId: record.observation.candidateId,
    strategyId: record.signal.strategyId,
    strategyIdentity,
    researchCodeSha: record.observation.researchCodeSha.toLowerCase(),
    costPolicyVersion: entryExecution.costPolicy.version,
    positionLifecycleDigest: immutableContractDigest,
    triggerObservationId: record.exitTrigger.exitTriggerId,
    triggeredAtMs: triggerAtMs,
    bar: Object.freeze({
      open: triggerBar.open,
      high: triggerBar.high,
      low: triggerBar.low,
      close: triggerBar.close,
    }),
    source: "CRYPTO_PUMP_REVERSAL_PROSPECTIVE_EXIT_V1",
  });
  const canonicalTrigger = deepFreeze({
    ...canonicalTriggerPayload,
    exitTriggerId: sha256(canonicalTriggerPayload),
  });
  const position = deepFreeze({
    positionId: record.position.positionId,
    paperSampleId: sample.paperSampleId,
    signalId: record.signal.signalId,
    market: "CRYPTO_FUTURES",
    symbol: record.signal.symbol,
    direction: "SHORT",
    candidateId: record.observation.candidateId,
    strategyFamily: "EVENT_SPECIALIST",
    strategyId: record.signal.strategyId,
    strategyVersion: record.observation.strategyVersion,
    parameterHash: record.observation.parameterHash,
    parameterDigest: record.observation.parameterHash,
    researchCodeSha: record.observation.researchCodeSha.toLowerCase(),
    costPolicyVersion: entryExecution.costPolicy.version,
    accountMode: "PAPER",
    entryTimestampMs: sample.identity.evaluatedAtMs,
    entryFillPrice: sample.fill.fillPrice,
    quantity: sample.fill.filledQuantity,
    sample,
    settlementExecutionPolicy: Object.freeze({
      marketAdapterIdentity: entryExecution.marketAdapterIdentity,
      executionPolicy: entryExecution.executionPolicy,
      entryDataEvidence: entryExecution.dataEvidence,
    }),
    lifecycle: Object.freeze({
      immutableContractDigest,
      pendingExit: canonicalTrigger,
      sampleEligibility: Object.freeze({
        provenanceClass: "NATURAL_FORWARD",
      }),
    }),
  });
  const observationCore = Object.freeze({
    positionId: position.positionId,
    paperSampleId: position.paperSampleId,
    market: position.market,
    symbol: position.symbol,
    direction: position.direction,
    strategyId: position.strategyId,
    strategyVersion: position.strategyVersion,
    parameterHash: position.parameterHash,
    researchCodeSha: position.researchCodeSha,
    costPolicyVersion: position.costPolicyVersion,
    observedAtMs,
    maxAgeMs: EXIT_EVIDENCE_CAPTURE_WINDOW_MS,
    publicOnly: true,
    source: "CRYPTO_PUMP_REVERSAL_PROSPECTIVE_FULL_COST_V1",
    provenance: "GENUINE_FUTURE_PROSPECTIVE_PUMP_EXIT",
    bar: Object.freeze({
      timestampMs: triggerAtMs,
      open: triggerBar.open,
      high: triggerBar.high,
      low: triggerBar.low,
      close: triggerBar.close,
    }),
    naturalEvidence: Object.freeze({
      provenanceClass: "NATURAL_FORWARD",
      synthetic: false,
      replay: false,
      testOnly: false,
      backfill: false,
      historical: false,
      duplicate: false,
    }),
  });
  const observation = deepFreeze({
    ...observationCore,
    observationId: sha256(observationCore),
  });
  return deepFreeze({
    position,
    observation,
    canonicalTrigger,
    pumpExitTriggerId: record.exitTrigger.exitTriggerId,
    barCloseMs,
    captureDeadlineMs: barCloseMs + EXIT_EVIDENCE_CAPTURE_WINDOW_MS,
  });
}

export function createPumpProspectiveFullCostSettlementOwnerV1({
  collectAuthoritativeEvidence,
  clock = Date.now,
  producerFactory = createNaturalPaperTriggerBoundSettlementCostProducer,
  adaptFullCost = adaptNaturalPaperSettlementFullCost,
  settleSample = settleFourMarketPaperSample,
} = {}) {
  if (typeof collectAuthoritativeEvidence !== "function") {
    throw new TypeError("Pump authoritative Full Cost collector is required");
  }
  if (typeof clock !== "function"
    || typeof producerFactory !== "function"
    || typeof adaptFullCost !== "function"
    || typeof settleSample !== "function") {
    throw new TypeError("Pump Full Cost dependencies must be functions");
  }
  const produce = producerFactory({ collectAuthoritativeEvidence, clock });
  if (typeof produce !== "function") throw new TypeError("Pump trigger-bound Full Cost producer is required");

  return async function settlePumpProspectiveFullCost({
    record,
    observedAtMs,
  } = {}) {
    let bridge;
    try {
      bridge = buildPumpCanonicalSettlementBridgeV1({ record, observedAtMs });
    } catch (error) {
      return blocked([String(error?.message ?? "PUMP_FULL_COST_BRIDGE_FAILED")]);
    }

    let produced;
    try {
      produced = await produce({
        position: bridge.position,
        observation: bridge.observation,
        evaluatedAtMs: observedAtMs,
      });
    } catch {
      return blocked(["PUMP_FULL_COST_TRIGGER_BOUND_PRODUCER_FAILED"]);
    }
    if (produced?.status !== "PRESENT"
      || produced?.fullCostReady !== true
      || !produced?.observation
      || !safeTime(produced?.evaluatedAtMs)) {
      return blocked(produced?.blockers ?? ["PUMP_FULL_COST_TRIGGER_BOUND_EVIDENCE_MISSING"]);
    }

    const fullCost = adaptFullCost({
      position: bridge.position,
      observation: produced.observation,
      trigger: bridge.canonicalTrigger,
      evaluatedAtMs: produced.evaluatedAtMs,
    });
    if (fullCost?.status !== "PRESENT" || fullCost?.fullCostReady !== true) {
      return blocked(fullCost?.blockers ?? ["PUMP_FULL_COST_8_OF_8_REQUIRED"]);
    }

    const settlementInput = produced.observation.settlementInput;
    let settled;
    try {
      settled = settleSample({
        sample: record.prospectiveExecutionSample,
        exitTriggerId: settlementInput.exitTriggerId,
        exitExecutionId: settlementInput.exitExecutionId,
        exitExecution: settlementInput.exitExecution,
        exitOrderType: settlementInput.exitOrderType ?? "MARKET",
        exitLimitPrice: settlementInput.exitLimitPrice ?? null,
        exitStopPrice: settlementInput.exitStopPrice ?? null,
        exitBar: settlementInput.exitBar,
        exitQuote: settlementInput.exitQuote,
        exitDepth: settlementInput.exitDepth,
        pathBars: settlementInput.pathBars ?? [],
        fundingEvidence: settlementInput.fundingEvidence,
        evaluatedAtMs: produced.evaluatedAtMs,
      });
    } catch {
      return blocked(["PUMP_FULL_COST_CANONICAL_SETTLEMENT_FAILED"]);
    }
    if (settled?.status !== "SETTLED"
      || settled?.paperSampleId !== record.prospectiveExecutionSample.paperSampleId
      || !Number.isFinite(settled?.netPnl)
      || !Number.isFinite(settled?.netReturnPercent)
      || !Number.isFinite(settled?.grossPnl)
      || !Number.isFinite(settled?.grossReturnPercent)
      || settled?.costPolicyVersion !== bridge.position.costPolicyVersion) {
      return blocked(["PUMP_FULL_COST_CANONICAL_SETTLEMENT_INVALID"]);
    }

    const fullCostEvidence = produced.observation.settlementCostEvidence;
    const core = {
      schemaVersion: PUMP_PROSPECTIVE_FULL_COST_SETTLEMENT_VERSION,
      status: "SETTLED",
      recordId: record.recordId,
      signalId: record.signal.signalId,
      candidateId: record.observation.candidateId,
      symbol: record.signal.symbol,
      direction: "SHORT",
      exitTriggerId: bridge.pumpExitTriggerId,
      canonicalExitTriggerId: bridge.canonicalTrigger.exitTriggerId,
      exitExecutionId: settled.exitExecutionId,
      paperSampleId: settled.paperSampleId,
      riskSizingEvidenceDigest: record.riskSizing.evidenceDigest,
      settledAtMs: settled.settledAtMs,
      holdingMs: settled.holdingMs,
      quantity: settled.quantity,
      entryFillPrice: settled.entryFillPrice,
      exitFillPrice: settled.exitFillPrice,
      grossPnl: settled.grossPnl,
      grossReturnPercent: settled.grossReturnPercent,
      netPnl: settled.netPnl,
      netReturnPercent: settled.netReturnPercent,
      totalExplicitCost: settled.totalExplicitCost,
      entryCost: settled.entryCost,
      exitCost: settled.exitCost,
      fundingCost: settled.fundingCost,
      costPolicyVersion: settled.costPolicyVersion,
      fullCostEvidence,
      canonicalFullCostAdapterEvidence: fullCost,
      canonicalSettlement: settled,
      economicSampleCredit: 1,
      ...safety(),
    };
    return deepFreeze({
      ...core,
      settlementId: sha256(core),
      blockers: Object.freeze([]),
    });
  };
}

export const PUMP_PROSPECTIVE_FULL_COST_SETTLEMENT_SAFETY = Object.freeze({
  schemaVersion: PUMP_PROSPECTIVE_FULL_COST_SETTLEMENT_VERSION,
  canonicalTriggerBoundProducerRequired: true,
  canonicalEightComponentFullCostRequired: true,
  canonicalFourMarketSettlementRequired: true,
  exitEvidenceCaptureAfterClosedMinuteMs: EXIT_EVIDENCE_CAPTURE_WINDOW_MS,
  missingCostConvertedToZero: false,
  delayedExitRepricingAllowed: false,
  economicSampleCreditAfterSettlement: 1,
  profitabilityCreditAfterSettlement: 0,
  profitabilityClaimAllowed: false,
  executionAuthority: "NONE",
  liveOrderAllowed: false,
  privateTradingApiAllowed: false,
});
