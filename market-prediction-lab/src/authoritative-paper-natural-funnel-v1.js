import { createHash } from "node:crypto";
import { createAuthoritativePaperRuntimeFromSourceWiring } from "./authoritative-paper-runtime-factory-v1.js";

export const AUTHORITATIVE_PAPER_NATURAL_FUNNEL_CONTRACT = Object.freeze({
  version: "authoritative-paper-natural-funnel-v1",
  stages: Object.freeze([
    "UNIVERSE",
    "SCANNER_EVALUATED",
    "CANDIDATE",
    "EVIDENCE_COMPLETE",
    "ADMISSION_PASS",
    "RISK_PASS",
    "COST_PASS",
    "ACCOUNT_READY",
    "PAPER_ENTRY",
    "POSITION",
    "SETTLEMENT",
    "OUTCOME",
  ]),
  measuredStatuses: Object.freeze(["MEASURED", "PARTIAL", "UNKNOWN"]),
  firstZeroRequiresMeasuredPrefix: true,
  unknownIsZero: false,
  replayCountsAsNatural: false,
  syntheticCountsAsNatural: false,
  historicalCountsAsNatural: false,
  executionAuthority: "NONE",
  scheduleActivationAuthority: false,
});

export const CANONICAL_NATURAL_PAPER_STAGE_ORDER = Object.freeze([
  "SIGNAL_CANDIDATE",
  "QUALITY_PASSED",
  "RISK_PASSED",
  "ENTRY_ELIGIBLE",
  "ENTRY",
  "POSITION",
  "EXIT_ELIGIBLE",
  "SETTLEMENT",
]);

export const CANONICAL_NATURAL_PAPER_STAGE_FIELDS = Object.freeze({
  SIGNAL_CANDIDATE: "signalCandidate",
  QUALITY_PASSED: "qualityPassed",
  RISK_PASSED: "riskPassed",
  ENTRY_ELIGIBLE: "entryEligible",
  ENTRY: "entry",
  POSITION: "position",
  EXIT_ELIGIBLE: "exitEligible",
  SETTLEMENT: "settlement",
});

const SOURCE_INCOMPLETE_BLOCKERS = new Set([
  "P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_MISSING",
  "P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_FAILED",
]);
const PRE_EVIDENCE_UNKNOWN_BLOCKERS = new Set([
  "P0_C9_MARKET_NOT_OWNED",
  "P0_C9_EVIDENCE_CLOCK_INVALID",
]);
const EXACT_SOURCE_REASON = /^(P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_(?:MISSING|FAILED)):([A-Za-z][A-Za-z0-9]*)$/u;

function freeze(value) {
  return Object.freeze(value);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function immutableSha(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return /^[0-9a-f]{40}$/u.test(normalized) ? normalized : null;
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stageMeasurement(stage, {
  status = "UNKNOWN",
  count = null,
  blocker = null,
  provenance = null,
  measuredAtMs = null,
} = {}) {
  const normalizedStatus = ["MEASURED", "PARTIAL"].includes(status) ? status : "UNKNOWN";
  return freeze({
    stage,
    status: normalizedStatus,
    count: normalizedStatus !== "UNKNOWN" && nonNegativeInteger(count) ? count : null,
    blocker: nonEmpty(blocker) ? blocker : null,
    provenance: nonEmpty(provenance) ? provenance : null,
    measuredAtMs: Number.isFinite(measuredAtMs) && measuredAtMs > 0 ? measuredAtMs : null,
  });
}

function directStageMeasurement(stage, {
  status = "UNKNOWN",
  count = null,
  blocker = null,
  provenance = null,
  observedAt = null,
  observationIds = [],
} = {}) {
  const measured = status === "MEASURED" && nonNegativeInteger(count);
  return freeze({
    stage,
    field: CANONICAL_NATURAL_PAPER_STAGE_FIELDS[stage],
    status: measured ? "MEASURED" : "UNKNOWN",
    count: measured ? count : null,
    blocker: measured ? null : (nonEmpty(blocker) ? blocker : `UNMEASURED_${stage}`),
    provenance: measured && nonEmpty(provenance) ? provenance : null,
    observedAt: Number.isFinite(observedAt) && observedAt > 0 ? observedAt : null,
    observationIds: freeze(measured ? [...observationIds] : []),
    naturalCredit: 0,
    replayCredit: 0,
    duplicateCredit: 0,
  });
}

function cardObservationId(card) {
  const values = [card?.signalId, card?.id, card?.paperCandidate?.signal?.signalId, card?.signal?.signalId];
  const value = values.find(nonEmpty);
  return nonEmpty(value) ? value.trim() : null;
}

function uniqueComplete(ids, expectedCount) {
  return ids.length === expectedCount && new Set(ids).size === ids.length;
}

function firstMeasuredZero(measurements) {
  for (const measurement of measurements) {
    if (measurement.status !== "MEASURED") {
      return freeze({
        stage: "UNKNOWN",
        reason: measurement.blocker ?? `UNMEASURED_${measurement.stage}`,
      });
    }
    if (measurement.count === 0) {
      return freeze({ stage: measurement.stage, reason: "MEASURED_ZERO" });
    }
  }
  return freeze({ stage: "UNKNOWN", reason: "NO_MEASURED_ZERO" });
}

function evidenceCompleteness(produced) {
  if (!isRecord(produced)) return "UNKNOWN";
  if (produced.status === "READY") return "PASS";
  if (produced.status !== "BLOCKED" || !Array.isArray(produced.blockers)) return "UNKNOWN";
  if (produced.blockers.some((code) => PRE_EVIDENCE_UNKNOWN_BLOCKERS.has(code))) return "UNKNOWN";
  if (produced.blockers.some((code) => SOURCE_INCOMPLETE_BLOCKERS.has(code))) return "BLOCKED";
  return "PASS";
}

function newCounters() {
  return {
    scanBatchCalls: 0,
    universeCount: null,
    universeKnown: true,
    scannerEvaluatedCount: 0,
    scannerEvaluatedKnown: true,
    scannerCandidateCount: 0,
    candidateKnown: true,
    producerAttemptCount: 0,
    evidenceClassifiedCount: 0,
    evidenceCompleteCount: 0,
    producerReadyCount: 0,
    directEvidenceBlockerSets: [],
    candidateObservationIds: [],
    qualityObservationIds: [],
    riskObservationIds: [],
    qualityPassedObservationIds: [],
    riskPassedObservationIds: [],
    qualityObservedCount: 0,
    qualityPassedCount: 0,
    riskObservedCount: 0,
    riskPassedCount: 0,
    directReasonObservations: [],
  };
}

function wrapSourceWiring(sourceWiring, counters) {
  const wrapped = { ...sourceWiring };
  if (typeof sourceWiring.scanBatchForMarket === "function") {
    wrapped.scanBatchForMarket = async (context) => {
      const scanBatch = await sourceWiring.scanBatchForMarket(context);
      if (typeof scanBatch !== "function") return scanBatch;
      return async (...args) => {
        const response = await scanBatch(...args);
        counters.scanBatchCalls += 1;
        if (!isRecord(response) || !Array.isArray(response.cards)) {
          counters.candidateKnown = false;
          counters.universeKnown = false;
          counters.scannerEvaluatedKnown = false;
          return response;
        }
        counters.scannerCandidateCount += response.cards.length;
        for (const card of response.cards) {
          const id = cardObservationId(card);
          if (id) counters.candidateObservationIds.push(id);
        }
        const totalCount = response?.universe?.totalCount;
        if (nonNegativeInteger(totalCount)) {
          counters.universeCount = counters.universeCount == null
            ? totalCount
            : Math.max(counters.universeCount, totalCount);
        } else {
          counters.universeKnown = false;
        }
        const completedCount = response?.execution?.completedCount;
        if (nonNegativeInteger(completedCount)) {
          counters.scannerEvaluatedCount += completedCount;
        } else {
          counters.scannerEvaluatedKnown = false;
        }
        return response;
      };
    };
  }

  if (typeof sourceWiring.createPaperAdmissionEvidenceProducer === "function") {
    wrapped.createPaperAdmissionEvidenceProducer = (sources) => {
      const producer = sourceWiring.createPaperAdmissionEvidenceProducer(sources);
      if (typeof producer !== "function") return producer;
      return async (context) => {
        counters.producerAttemptCount += 1;
        const produced = await producer(context);
        const completeness = evidenceCompleteness(produced);
        if (completeness !== "UNKNOWN") counters.evidenceClassifiedCount += 1;
        if (completeness === "PASS") counters.evidenceCompleteCount += 1;
        if (produced?.status === "READY") counters.producerReadyCount += 1;
        const gates = produced?.gateObservability;
        if (gates?.qualityGate?.status === "MEASURED") {
          counters.qualityObservedCount += 1;
          if (gates.qualityGate.passed === true) {
            counters.qualityPassedCount += 1;
            if (nonEmpty(gates.qualityGate.observationId)) counters.qualityPassedObservationIds.push(gates.qualityGate.observationId);
          }
          if (nonEmpty(gates.qualityGate.observationId)) counters.qualityObservationIds.push(gates.qualityGate.observationId);
        }
        if (gates?.riskGate?.status === "MEASURED") {
          counters.riskObservedCount += 1;
          if (gates.riskGate.passed === true && gates.riskGate.evaluated === true) {
            counters.riskPassedCount += 1;
            if (nonEmpty(gates.riskGate.observationId)) counters.riskPassedObservationIds.push(gates.riskGate.observationId);
          }
          if (nonEmpty(gates.riskGate.observationId)) counters.riskObservationIds.push(gates.riskGate.observationId);
        }
        if (Array.isArray(gates?.reasonObservations)) {
          counters.directReasonObservations.push(...gates.reasonObservations.map((row) => freeze(structuredClone(row))));
        }
        if (completeness === "BLOCKED") {
          const blockers = Array.isArray(produced?.blockers)
            ? [...new Set(produced.blockers.filter(nonEmpty))]
            : [];
          counters.directEvidenceBlockerSets.push(freeze(blockers));
        }
        return produced;
      };
    };
  }
  return freeze(wrapped);
}

function naturalFunnelMeasurements({ result, counters, measuredAtMs }) {
  const scanObserved = counters.scanBatchCalls > 0;
  const universeMeasured = scanObserved && counters.universeKnown && nonNegativeInteger(counters.universeCount);
  const evaluatedMeasured = scanObserved && counters.scannerEvaluatedKnown;
  const candidateMeasured = scanObserved && counters.candidateKnown;
  const evidenceMeasured = candidateMeasured && (
    counters.scannerCandidateCount === 0
    || (
      counters.producerAttemptCount === counters.scannerCandidateCount
      && counters.evidenceClassifiedCount === counters.producerAttemptCount
    )
  );
  const allEvidenceCompleteReachedProducerReady = evidenceMeasured
    && counters.evidenceCompleteCount === counters.producerReadyCount
    && counters.producerReadyCount === counters.producerAttemptCount;
  const admissionCount = nonNegativeInteger(result?.admissionBridgeReadyCandidates)
    ? result.admissionBridgeReadyCandidates
    : null;
  const downstreamMeasured = allEvidenceCompleteReachedProducerReady && admissionCount != null;

  return freeze([
    stageMeasurement("UNIVERSE", {
      status: universeMeasured ? "MEASURED" : scanObserved ? "PARTIAL" : "UNKNOWN",
      count: universeMeasured ? counters.universeCount : null,
      blocker: universeMeasured ? null : "SCANNER_UNIVERSE_COUNT_NOT_MEASURED",
      provenance: universeMeasured ? "ScannerResponse.universe.totalCount" : null,
      measuredAtMs,
    }),
    stageMeasurement("SCANNER_EVALUATED", {
      status: evaluatedMeasured ? "MEASURED" : scanObserved ? "PARTIAL" : "UNKNOWN",
      count: evaluatedMeasured ? counters.scannerEvaluatedCount : null,
      blocker: evaluatedMeasured ? null : "SCANNER_EXECUTION_COMPLETED_COUNT_NOT_MEASURED",
      provenance: evaluatedMeasured ? "ScannerResponse.execution.completedCount" : null,
      measuredAtMs,
    }),
    stageMeasurement("CANDIDATE", {
      status: candidateMeasured ? "MEASURED" : "UNKNOWN",
      count: candidateMeasured ? counters.scannerCandidateCount : null,
      blocker: candidateMeasured ? null : "SCANNER_CANDIDATE_COUNT_NOT_MEASURED",
      provenance: candidateMeasured ? "ScannerResponse.cards.length" : null,
      measuredAtMs,
    }),
    stageMeasurement("EVIDENCE_COMPLETE", {
      status: evidenceMeasured ? "MEASURED" : counters.producerAttemptCount > 0 ? "PARTIAL" : "UNKNOWN",
      count: evidenceMeasured ? counters.evidenceCompleteCount : null,
      blocker: evidenceMeasured ? null : "AUTHORITATIVE_EVIDENCE_COMPLETENESS_NOT_FULLY_MEASURED",
      provenance: evidenceMeasured ? "authoritative Paper admission producer source-completeness classification" : null,
      measuredAtMs,
    }),
    stageMeasurement("ADMISSION_PASS", {
      status: downstreamMeasured ? "MEASURED" : "UNKNOWN",
      count: downstreamMeasured ? admissionCount : null,
      blocker: downstreamMeasured ? null : "ADMISSION_STAGE_DEPENDS_ON_UNRESOLVED_EVIDENCE_OR_PRODUCER_BLOCK",
      provenance: downstreamMeasured ? "canonical-meaningful-search-paper-runtime-v1.admissionBridgeReadyCandidates" : null,
      measuredAtMs,
    }),
    stageMeasurement("RISK_PASS", {
      status: downstreamMeasured ? "MEASURED" : "UNKNOWN",
      count: downstreamMeasured ? counters.producerReadyCount : null,
      blocker: downstreamMeasured ? null : "RISK_STAGE_NOT_INDEPENDENTLY_MEASURED",
      provenance: downstreamMeasured ? "READY authoritative producer includes approved Trading Risk Engine result" : null,
      measuredAtMs,
    }),
    stageMeasurement("COST_PASS", {
      status: downstreamMeasured ? "MEASURED" : "UNKNOWN",
      count: downstreamMeasured ? counters.producerReadyCount : null,
      blocker: downstreamMeasured ? null : "COST_STAGE_NOT_INDEPENDENTLY_MEASURED",
      provenance: downstreamMeasured ? "READY authoritative producer includes complete canonical cost evidence and risk-cost parity" : null,
      measuredAtMs,
    }),
    stageMeasurement("ACCOUNT_READY", {
      status: downstreamMeasured ? "MEASURED" : "UNKNOWN",
      count: downstreamMeasured ? counters.producerReadyCount : null,
      blocker: downstreamMeasured ? null : "ACCOUNT_STAGE_NOT_INDEPENDENTLY_MEASURED",
      provenance: downstreamMeasured ? "READY authoritative producer includes validated PaperTradingState/equity" : null,
      measuredAtMs,
    }),
    stageMeasurement("PAPER_ENTRY", { blocker: "PAPER_ENTRY_REQUIRES_RECURRING_LOOP_STATE" }),
    stageMeasurement("POSITION", { blocker: "POSITION_REQUIRES_RECURRING_LOOP_STATE" }),
    stageMeasurement("SETTLEMENT", { blocker: "SETTLEMENT_REQUIRES_RECURRING_LOOP_STATE" }),
    stageMeasurement("OUTCOME", { blocker: "OUTCOME_REQUIRES_RECURRING_LOOP_STATE" }),
  ]);
}

function naturalEvidenceIdentity({ input, result, measurements }) {
  const cycleId = input?.cycle?.cycleId ?? result?.cycleId ?? null;
  if (!nonEmpty(cycleId)) return null;
  const runtimeSha = immutableSha(input?.cycle?.identity?.researchCodeSha)
    ?? immutableSha(input?.signal?.strategyIdentity?.researchCodeSha)
    ?? null;
  return sha256({
    schemaVersion: AUTHORITATIVE_PAPER_NATURAL_FUNNEL_CONTRACT.version,
    cycleId,
    market: input?.market ?? result?.market ?? null,
    runtimeSha,
    measurements: measurements.map(({ stage, status, count, blocker, provenance }) => ({
      stage, status, count, blocker, provenance,
    })),
  });
}

function canonicalNaturalStageEvidence({
  input,
  counters,
  measuredAtMs,
  runtimeSha,
  datasetIdentity,
}) {
  const candidateMeasured = counters.scanBatchCalls > 0
    && counters.candidateKnown
    && uniqueComplete(counters.candidateObservationIds, counters.scannerCandidateCount);
  const producerCoverage = candidateMeasured
    && counters.producerAttemptCount === counters.scannerCandidateCount;
  const qualityMeasured = producerCoverage
    && counters.qualityObservedCount === counters.producerAttemptCount
    && uniqueComplete(counters.qualityObservationIds, counters.qualityObservedCount);
  const riskMeasured = producerCoverage
    && counters.riskObservedCount === counters.producerAttemptCount
    && uniqueComplete(counters.riskObservationIds, counters.riskObservedCount);
  const cycleId = nonEmpty(input?.cycle?.cycleId) ? input.cycle.cycleId : null;
  const identity = freeze({
    cycleId,
    strategySha: runtimeSha,
    runtimeSha,
    datasetIdentity: nonEmpty(datasetIdentity) ? datasetIdentity : null,
  });
  const stages = [
    directStageMeasurement("SIGNAL_CANDIDATE", {
      status: candidateMeasured ? "MEASURED" : "UNKNOWN",
      count: candidateMeasured ? counters.scannerCandidateCount : null,
      blocker: "SIGNAL_CANDIDATE_DIRECT_PROVENANCE_INCOMPLETE",
      provenance: "authoritative-paper-natural-funnel-v1 wrapped ScannerResponse.cards",
      observedAt: measuredAtMs,
      observationIds: counters.candidateObservationIds,
    }),
    directStageMeasurement("QUALITY_PASSED", {
      status: qualityMeasured ? "MEASURED" : "UNKNOWN",
      count: qualityMeasured ? counters.qualityPassedCount : null,
      blocker: "QUALITY_GATE_DIRECT_PROVENANCE_INCOMPLETE",
      provenance: "scanner-crypto-futures-paper-admission-evidence-producer-v1 gateObservability.qualityGate",
      observedAt: measuredAtMs,
      observationIds: counters.qualityPassedObservationIds,
    }),
    directStageMeasurement("RISK_PASSED", {
      status: riskMeasured ? "MEASURED" : "UNKNOWN",
      count: riskMeasured ? counters.riskPassedCount : null,
      blocker: "RISK_GATE_DIRECT_PROVENANCE_INCOMPLETE",
      provenance: "scanner-crypto-futures-paper-admission-evidence-producer-v1 gateObservability.riskGate",
      observedAt: measuredAtMs,
      observationIds: counters.riskPassedObservationIds,
    }),
    directStageMeasurement("ENTRY_ELIGIBLE", { blocker: "RECURRING_LOOP_ENTRY_ELIGIBILITY_REQUIRED" }),
    directStageMeasurement("ENTRY", { blocker: "RECURRING_LOOP_ENTRY_REQUIRED" }),
    directStageMeasurement("POSITION", { blocker: "RECURRING_LOOP_POSITION_REQUIRED" }),
    directStageMeasurement("EXIT_ELIGIBLE", { blocker: "OPEN_POSITION_EXIT_ELIGIBILITY_REQUIRED" }),
    directStageMeasurement("SETTLEMENT", { blocker: "RECURRING_LOOP_SETTLEMENT_REQUIRED" }),
  ];
  const reasonRows = counters.directReasonObservations.map((row) => freeze({
    ...structuredClone(row),
    identity: freeze({ ...identity, observationId: row?.identity?.observationId ?? null }),
    naturalCredit: 0,
    replayCredit: 0,
    duplicateCredit: 0,
  }));
  if (candidateMeasured && counters.scannerCandidateCount === 0) {
    reasonRows.push(freeze({
      sourceStage: "SIGNAL_CANDIDATE",
      sourceCode: "NO_SIGNAL_CANDIDATE",
      sourceReason: "NO_SIGNAL_CANDIDATE",
      canonicalReason: "NO_SIGNAL",
      lossless: true,
      provenance: "authoritative-paper-natural-funnel-v1 wrapped ScannerResponse.cards",
      observedAt: measuredAtMs,
      identity,
      naturalCredit: 0,
      replayCredit: 0,
      duplicateCredit: 0,
    }));
  }
  return freeze({
    schemaVersion: "canonical-natural-paper-stage-evidence-v1",
    stageOrder: CANONICAL_NATURAL_PAPER_STAGE_ORDER,
    identity,
    stageCounts: freeze(Object.fromEntries(stages.map((stage) => [stage.field, stage]))),
    reasonObservations: freeze(reasonRows),
    naturalCredit: 0,
    replayCredit: 0,
    duplicateCredit: 0,
    unknownIsZero: false,
  });
}

function normalizeSourceKey(value) {
  return String(value).replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toUpperCase();
}

function exactSourceSetReason(counters, genericReason) {
  const grouped = new Map();
  for (const row of counters.directReasonObservations) {
    if (row?.sourceStage !== "EVIDENCE_SOURCE" || row?.lossless !== true || !nonEmpty(row?.sourceCode)) continue;
    const match = EXACT_SOURCE_REASON.exec(row.sourceCode.trim());
    const observationId = row?.identity?.observationId;
    if (!match || !nonEmpty(observationId) || match[1] !== genericReason) return null;
    const code = `${match[1]}_${normalizeSourceKey(match[2])}`;
    const values = grouped.get(observationId) ?? [];
    values.push(code);
    grouped.set(observationId, values);
  }
  if (grouped.size !== counters.producerAttemptCount || grouped.size === 0) return null;
  const signatures = [...grouped.values()].map((values) => [...new Set(values)].sort().join("_AND_"));
  if (new Set(signatures).size !== 1) return null;
  return freeze({
    reasonCode: signatures[0],
    sourceCodes: freeze([...new Set(counters.directReasonObservations
      .map((row) => nonEmpty(row?.sourceCode) ? row.sourceCode.trim() : null)
      .filter(Boolean))].sort()),
  });
}

function authoritativeFirstZeroReasonEvidenceByStage({
  firstZero,
  counters,
  runtimeSha,
  datasetIdentity,
}) {
  if (firstZero?.stage !== "EVIDENCE_COMPLETE") return freeze({});
  if (!runtimeSha || !nonEmpty(datasetIdentity) || counters.producerAttemptCount <= 0) return freeze({});
  if (counters.directEvidenceBlockerSets.length !== counters.producerAttemptCount) return freeze({});

  const reasons = [];
  for (const blockers of counters.directEvidenceBlockerSets) {
    if (blockers.length !== 1 || !SOURCE_INCOMPLETE_BLOCKERS.has(blockers[0])) return freeze({});
    reasons.push(blockers[0]);
  }
  if (new Set(reasons).size !== 1) return freeze({});

  const genericReason = reasons[0];
  const exact = exactSourceSetReason(counters, genericReason);
  const reasonCode = exact?.reasonCode ?? genericReason;
  return freeze({
    EVIDENCE_COMPLETE: freeze({
      authoritative: true,
      freshness: "FRESH",
      reasonCode,
      sourceCodes: exact?.sourceCodes ?? freeze([]),
      strategySha: runtimeSha,
      runtimeSha,
      datasetIdentity,
      synthetic: false,
      testFixture: false,
      historical: false,
      replay: false,
      duplicateReplay: false,
      manualExpiry: false,
      futureTimeCompression: false,
      clockAdvanced: false,
    }),
  });
}

export function createNaturalFunnelObservedPaperRuntimeFromSourceWiring({
  sourceWiring = {},
  baseRuntimeFactory = createAuthoritativePaperRuntimeFromSourceWiring,
  now = () => Date.now(),
  ...runtimeOptions
} = {}) {
  if (!isRecord(sourceWiring)) throw new TypeError("authoritative Paper sourceWiring must be an object");
  if (typeof baseRuntimeFactory !== "function") throw new TypeError("base authoritative Paper runtime factory is required");
  if (typeof now !== "function") throw new TypeError("natural funnel observation clock is required");

  return async function naturalFunnelObservedPaperRuntime(input = {}) {
    const counters = newCounters();
    const wrappedSourceWiring = wrapSourceWiring(sourceWiring, counters);
    const baseRuntime = baseRuntimeFactory({
      sourceWiring: wrappedSourceWiring,
      now,
      ...runtimeOptions,
    });
    const result = await baseRuntime(input);
    const measuredAtMs = now();
    const measurements = naturalFunnelMeasurements({ result, counters, measuredAtMs });
    const firstZero = firstMeasuredZero(measurements);
    const evidenceIdentity = naturalEvidenceIdentity({ input, result, measurements });
    const runtimeSha = immutableSha(input?.cycle?.identity?.researchCodeSha)
      ?? immutableSha(input?.signal?.strategyIdentity?.researchCodeSha)
      ?? null;
    const reasonEvidenceByStage = authoritativeFirstZeroReasonEvidenceByStage({
      firstZero,
      counters,
      runtimeSha,
      datasetIdentity: evidenceIdentity,
    });
    const directEvidence = canonicalNaturalStageEvidence({
      input,
      counters,
      measuredAtMs,
      runtimeSha,
      datasetIdentity: evidenceIdentity,
    });
    return freeze({
      ...result,
      naturalFunnelContract: AUTHORITATIVE_PAPER_NATURAL_FUNNEL_CONTRACT,
      naturalFunnelMeasurements: measurements,
      naturalFirstZeroStage: firstZero.stage,
      naturalFirstZeroReason: firstZero.reason,
      naturalEvidenceIdentity: evidenceIdentity,
      naturalRuntimeSha: runtimeSha,
      authoritativeFirstZeroReasonEvidenceByStage: reasonEvidenceByStage,
      canonicalNaturalStageEvidence: directEvidence,
      universeCount: measurements[0].count,
      scannerEvaluatedCount: measurements[1].count,
      evidenceCompleteCount: measurements[3].count,
      admissionPassCount: measurements[4].count,
      riskPassCount: measurements[5].count,
      costPassCount: measurements[6].count,
      accountReadyCount: measurements[7].count,
      executionAuthority: "NONE",
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
      orderSubmitted: false,
      exchangeRequestSent: false,
      productionMutationAllowed: false,
    });
  };
}
