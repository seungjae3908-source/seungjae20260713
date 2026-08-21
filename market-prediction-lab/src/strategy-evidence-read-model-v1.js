import {
  verifyGlobalStrategyResearchRecord,
  verifyStrategyEvidenceTierLedger,
} from "./global-alpha-literature-registry-v1.js";
import { researchDigest } from "./research-trial-registry.js";

export const STRATEGY_EVIDENCE_READ_MODEL_SCHEMA_VERSION = 1;

const COUNT_KINDS = Object.freeze({
  externalPaperN: Object.freeze(["EXTERNAL_REPORTED_EVIDENCE"]),
  externalStudyCount: Object.freeze(["EXTERNAL_REPORTED_EVIDENCE", "EXTERNAL_META_ANALYSIS"]),
  externalDatasetN: Object.freeze(["EXTERNAL_RAW_DATA_REFERENCE"]),
  ourReplicationN: Object.freeze(["OUR_REPLICATION", "OUR_REPLICATION_ON_EXTERNAL_DATA"]),
  ourOosN: Object.freeze(["OUR_OOS"]),
  ourWalkForwardN: Object.freeze(["OUR_WALK_FORWARD"]),
  ourHoldoutN: Object.freeze(["OUR_FINAL_HOLDOUT"]),
  ourShadowN: Object.freeze(["OUR_NATURAL_SHADOW"]),
  ourPaperN: Object.freeze(["OUR_NATURAL_PAPER"]),
  ourSettledN: Object.freeze(["OUR_SETTLEMENT"]),
});

const STAGES = Object.freeze({
  replication: Object.freeze(["OUR_REPLICATION", "OUR_REPLICATION_ON_EXTERNAL_DATA"]),
  oos: Object.freeze(["OUR_OOS"]),
  walkForward: Object.freeze(["OUR_WALK_FORWARD"]),
  finalHoldout: Object.freeze(["OUR_FINAL_HOLDOUT"]),
  shadow: Object.freeze(["OUR_NATURAL_SHADOW"]),
  paper: Object.freeze(["OUR_NATURAL_PAPER"]),
  settlement: Object.freeze(["OUR_SETTLEMENT"]),
});

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function optionalStatus(value) {
  return value == null ? "NOT_COLLECTED" : requiredString(value, "advisory status").toUpperCase();
}

function readModelSafety() {
  return Object.freeze({
    readOnly: true,
    externalEvidenceCanBecomeOurEvidence: false,
    externalSampleCanBecomePaperSample: false,
    historicalEvidenceCanBecomeNaturalForward: false,
    scannerGatesBypassed: false,
    noTradePreserved: true,
    profitabilityAuthority: false,
    promotionAuthority: false,
    championAuthority: false,
    scannerAuthority: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    transferEnabled: false,
    withdrawalEnabled: false,
    executionAuthority: "NONE",
    actualOrders: 0,
    actualCancels: 0,
    actualAmends: 0,
    actualTransfers: 0,
    actualWithdrawals: 0,
  });
}

function presentCount(ledger, field, kinds) {
  const matching = ledger.entries.filter((entry) => kinds.includes(entry.evidenceKind));
  const recomputedValue = field === "externalStudyCount"
    ? matching.length
    : matching.reduce((sum, entry) => sum + entry.sampleCount, 0);
  return Object.freeze({
    status: matching.length ? "RECORDED" : "NOT_COLLECTED",
    value: matching.length ? recomputedValue : null,
    sourceEntryCount: matching.length,
  });
}

function stageReadModel(ledger, kinds) {
  const entries = ledger.entries.filter((entry) => kinds.includes(entry.evidenceKind));
  if (!entries.length) {
    return Object.freeze({ status: "NOT_COLLECTED", sampleN: null, resultStatuses: Object.freeze([]), failureReasons: Object.freeze([]), evidenceIds: Object.freeze([]) });
  }
  return Object.freeze({
    status: "RECORDED",
    sampleN: entries.reduce((sum, entry) => sum + entry.sampleCount, 0),
    resultStatuses: Object.freeze([...new Set(entries.map((entry) => entry.resultStatus))].sort()),
    failureReasons: Object.freeze([...new Set(entries.map((entry) => entry.failureReason).filter(Boolean))].sort()),
    evidenceIds: Object.freeze(entries.map((entry) => entry.evidenceId).sort()),
  });
}

function externalSourceReadModel(record) {
  const source = record.sourceMetadata;
  return Object.freeze({
    researchSourceId: record.researchSourceId,
    strategyFamilyId: record.strategyDna.strategyFamilyId,
    paperVariantId: record.strategyDna.paperVariantId,
    title: source.title,
    authors: source.authors,
    publication: source.publication,
    publicationDate: source.publicationDate,
    doi: source.doi,
    canonicalUrl: source.canonicalUrl,
    sourceType: source.sourceType,
    market: source.market,
    assetClass: source.assetClass,
    samplePeriod: source.samplePeriod,
    reportedSampleN: source.sampleN,
    reportedMetrics: source.reportedMetrics,
    costAssumptions: source.transactionCostAssumptions,
    limitations: source.statedLimitations,
    datasetReference: source.datasetReference,
    sourceFingerprint: source.sourceFingerprint,
    licenseStatus: source.licenseStatus,
    provenanceStatus: source.provenanceStatus,
    evidenceTier: "E1",
    ourVerificationStatus: "NOT_INFERRED_FROM_LITERATURE",
  });
}

function settledMetric(ledger, metricName) {
  const settled = ledger.entries.filter((entry) => entry.evidenceKind === "OUR_SETTLEMENT");
  if (!settled.length) return Object.freeze({ status: "NOT_COLLECTED", value: null, evidenceId: null });
  const withMetric = settled.filter((entry) => entry.deterministicMetrics && Object.hasOwn(entry.deterministicMetrics, metricName));
  if (!withMetric.length) return Object.freeze({ status: "MISSING", value: null, evidenceId: null });
  const latest = withMetric.at(-1);
  const value = latest.deterministicMetrics[metricName];
  if (typeof value !== "number" || !Number.isFinite(value)) return Object.freeze({ status: "N_A", value: null, evidenceId: latest.evidenceId });
  return Object.freeze({ status: "RECORDED", value, evidenceId: latest.evidenceId });
}

function advisoryReadModel(advisory = {}) {
  if (!advisory || typeof advisory !== "object" || Array.isArray(advisory)) throw new TypeError("advisory must be an object");
  return Object.freeze({
    metaAnalysisStatus: optionalStatus(advisory.metaAnalysisStatus),
    replicationStatus: optionalStatus(advisory.replicationStatus),
    statisticalStatus: optionalStatus(advisory.statisticalStatus),
    economicRealityStatus: optionalStatus(advisory.economicRealityStatus),
    strategyHealth: optionalStatus(advisory.strategyHealth),
    championStatus: optionalStatus(advisory.championStatus),
  });
}

function readModelCore({ strategyIdentity, ledgerDigest, externalSources, counts, stages, advisory, canonicalSettledMetrics }) {
  return Object.freeze({ strategyIdentity, ledgerDigest, externalSources, counts, stages, advisory, canonicalSettledMetrics });
}

export function buildStrategyEvidenceReadModel({ ledger, researchRecords = [], advisory = {} } = {}) {
  if (!verifyStrategyEvidenceTierLedger(ledger)) throw new Error("STRATEGY_EVIDENCE_TIER_LEDGER_INVALID");
  if (!Array.isArray(researchRecords)) throw new TypeError("researchRecords must be an array");
  if (researchRecords.some((record) => !verifyGlobalStrategyResearchRecord(record))) throw new Error("GLOBAL_STRATEGY_RESEARCH_RECORD_INVALID");
  const identity = ledger.strategyIdentity;
  for (const record of researchRecords) {
    if (record.strategyDna.strategyFamilyId !== identity.strategyFamilyId) throw new Error("STRATEGY_FAMILY_ID_MISMATCH");
    if (record.sourceMetadata.market !== identity.market) throw new Error("CROSS_MARKET_EVIDENCE_REQUIRES_TRANSFER_ASSESSMENT");
  }
  const counts = Object.freeze(Object.fromEntries(Object.entries(COUNT_KINDS).map(([field, kinds]) => [field, presentCount(ledger, field, kinds)])));
  const stages = Object.freeze(Object.fromEntries(Object.entries(STAGES).map(([stage, kinds]) => [stage, stageReadModel(ledger, kinds)])));
  const externalSources = Object.freeze(researchRecords.map(externalSourceReadModel).sort((left, right) => left.researchSourceId.localeCompare(right.researchSourceId)));
  const core = readModelCore({
    strategyIdentity: identity,
    ledgerDigest: ledger.ledgerDigest,
    externalSources,
    counts,
    stages,
    advisory: advisoryReadModel(advisory),
    canonicalSettledMetrics: Object.freeze({
      profitFactor: settledMetric(ledger, "profitFactor"),
      expectedValue: settledMetric(ledger, "expectedValue"),
      maximumDrawdown: settledMetric(ledger, "maximumDrawdown"),
      netReturn: settledMetric(ledger, "netReturn"),
      winRate: settledMetric(ledger, "winRate"),
    }),
  });
  return Object.freeze({
    schemaVersion: STRATEGY_EVIDENCE_READ_MODEL_SCHEMA_VERSION,
    ...core,
    readModelDigest: researchDigest(core),
    whatOtherResearchFound: Object.freeze({
      sourceCount: externalSources.length,
      sources: externalSources,
      externalPaperN: counts.externalPaperN,
      externalDatasetN: counts.externalDatasetN,
    }),
    whatOurSystemVerified: Object.freeze({
      stages,
      settledMetrics: core.canonicalSettledMetrics,
    }),
    externalAndOurSamplesCombined: false,
    profitabilityProven: false,
    eligibleForScannerResearchConsideration: false,
    scannerEligibilityReason: "AUTHORITATIVE_SCANNER_OWNER_AND_ALL_EXISTING_GATES_REQUIRED",
    safety: readModelSafety(),
  });
}

export function verifyStrategyEvidenceReadModel(readModel) {
  if (!readModel || readModel.schemaVersion !== STRATEGY_EVIDENCE_READ_MODEL_SCHEMA_VERSION) return false;
  const core = readModelCore({
    strategyIdentity: readModel.strategyIdentity,
    ledgerDigest: readModel.ledgerDigest,
    externalSources: readModel.externalSources,
    counts: readModel.counts,
    stages: readModel.stages,
    advisory: readModel.advisory,
    canonicalSettledMetrics: readModel.canonicalSettledMetrics,
  });
  return readModel.readModelDigest === researchDigest(core)
    && readModel.externalAndOurSamplesCombined === false
    && readModel.eligibleForScannerResearchConsideration === false
    && readModel.safety?.noTradePreserved === true
    && readModel.safety?.executionAuthority === "NONE";
}

export function buildScannerStrategyEvidenceAdvisory(readModel) {
  if (!verifyStrategyEvidenceReadModel(readModel)) throw new Error("STRATEGY_EVIDENCE_READ_MODEL_INVALID");
  return Object.freeze({
    strategyId: readModel.strategyIdentity.strategyId,
    strategyFamilyId: readModel.strategyIdentity.strategyFamilyId,
    strategyVersion: readModel.strategyIdentity.strategyVersion,
    parameterHash: readModel.strategyIdentity.parameterHash,
    researchCodeSha: readModel.strategyIdentity.researchCodeSha,
    market: readModel.strategyIdentity.market,
    direction: readModel.strategyIdentity.direction,
    timeframe: readModel.strategyIdentity.timeframe,
    costPolicyVersion: readModel.strategyIdentity.costPolicyVersion,
    externalEvidenceStatus: readModel.externalSources.length ? "RECORDED_E1" : "NOT_COLLECTED",
    replicationStatus: readModel.stages.replication.status,
    statisticalStatus: readModel.advisory.statisticalStatus,
    oosStatus: readModel.stages.oos.status,
    walkForwardStatus: readModel.stages.walkForward.status,
    holdoutStatus: readModel.stages.finalHoldout.status,
    shadowStatus: readModel.stages.shadow.status,
    paperStatus: readModel.stages.paper.status,
    settledN: readModel.counts.ourSettledN,
    strategyHealth: readModel.advisory.strategyHealth,
    eligibleForScannerResearchConsideration: false,
    noTradePreserved: true,
    existingDataHealthQuantProfitRiskGatesRequired: true,
    scannerAuthority: false,
    safety: readModelSafety(),
  });
}

function transferSafety() {
  return Object.freeze({
    researchOnly: true,
    targetMarketQualified: false,
    scannerEligible: false,
    promotionEligible: false,
    liveTrading: false,
    executionAuthority: "NONE",
  });
}

export function createCrossMarketTransferAssessment({ sourceIdentity, targetIdentity, transferEvidence = null } = {}) {
  const originalMarket = requiredString(sourceIdentity?.market, "sourceIdentity.market");
  const targetMarket = requiredString(targetIdentity?.market, "targetIdentity.market");
  const sourceStrategyFamilyId = requiredString(sourceIdentity?.strategyFamilyId, "sourceIdentity.strategyFamilyId");
  const targetStrategyFamilyId = requiredString(targetIdentity?.strategyFamilyId, "targetIdentity.strategyFamilyId");
  if (sourceStrategyFamilyId !== targetStrategyFamilyId) throw new Error("STRATEGY_FAMILY_ID_MISMATCH");
  if (originalMarket === targetMarket) {
    return Object.freeze({ originalMarket, targetMarket, transferStatus: "NOT_REQUIRED_SAME_MARKET", transferEvidence: null, safety: transferSafety() });
  }
  if (transferEvidence == null) {
    return Object.freeze({ originalMarket, targetMarket, transferStatus: "NOT_VALIDATED", transferEvidence: null, safety: transferSafety() });
  }
  if (!transferEvidence || typeof transferEvidence !== "object" || Array.isArray(transferEvidence)) throw new TypeError("transferEvidence must be an object");
  if (transferEvidence.originalMarket !== originalMarket || transferEvidence.targetMarket !== targetMarket) throw new Error("TRANSFER_MARKET_MISMATCH");
  const researchCodeSha = requiredString(transferEvidence.researchCodeSha, "transferEvidence.researchCodeSha").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(researchCodeSha)) throw new TypeError("transferEvidence.researchCodeSha must be an exact 40-character SHA");
  const resultStatus = requiredString(transferEvidence.resultStatus, "transferEvidence.resultStatus").toUpperCase();
  if (!new Set(["REPLICATED", "NOT_REPLICATED", "BLOCKED_DATA", "INSUFFICIENT_EVIDENCE"]).has(resultStatus)) throw new RangeError("transferEvidence.resultStatus is unsupported");
  const evidence = Object.freeze({
    originalMarket,
    targetMarket,
    datasetFingerprint: requiredString(transferEvidence.datasetFingerprint, "transferEvidence.datasetFingerprint"),
    researchCodeSha,
    costPolicyVersion: requiredString(transferEvidence.costPolicyVersion, "transferEvidence.costPolicyVersion"),
    resultStatus,
  });
  return Object.freeze({
    originalMarket,
    targetMarket,
    transferStatus: "TARGET_MARKET_REPLICATION_RECORDED_REVIEW_ONLY",
    transferEvidence: Object.freeze({ ...evidence, evidenceFingerprint: researchDigest(evidence) }),
    safety: transferSafety(),
  });
}
