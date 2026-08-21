import { runCanonicalMeaningfulSearchPaperMarketWithAdmissionBundles } from "./canonical-paper-admission-bundle-injection-runtime-v1.js";
import { createCanonicalPaperForwardEvidenceProvider } from "./paper-forward-evidence-runtime-v1.js";

export const AUTHORITATIVE_PAPER_RUNTIME_FACTORY_CONTRACT = Object.freeze({
  version: "authoritative-paper-runtime-factory-v1",
  ownedMarkets: Object.freeze(["CRYPTO_FUTURES"]),
  bundleSchemaVersion: "scanner-paper-admission-evidence-bundle-v1",
  executionAuthority: "NONE",
  simulatedOnly: true,
  liveOrderAllowed: false,
  privateTradingApiAllowed: false,
  orderSubmitted: false,
  exchangeRequestSent: false,
  productionMutationAllowed: false,
  scheduleActivationAuthority: false,
  profitabilityClaimAllowed: false,
});

export const AUTHORITATIVE_PAPER_SOURCE_WIRING_CONTRACT = Object.freeze({
  version: "authoritative-paper-source-wiring-v1",
  requiredCallbacks: Object.freeze([
    "createPaperAdmissionEvidenceProducer",
    "scanBatchForMarket",
    "paperCandidateForCard",
    "learningSnapshotForCard",
    "paperStateForCard",
    "contractRulesForCard",
    "publicEvidenceForCard",
    "executionObservationForCard",
    "supplementalCostEvidenceForCard",
  ]),
  firstZeroStageWhenBlocked: "UNKNOWN",
  unknownIsZero: false,
  executionAuthority: "NONE",
  scheduleActivationAuthority: false,
});

export const AUTHORITATIVE_PAPER_STAGE_MEASUREMENT_CONTRACT = Object.freeze({
  version: "authoritative-paper-stage-measurements-v1",
  stages: Object.freeze([
    "Scanner Candidate",
    "Profit Gate",
    "Identity",
    "Paper Admission",
    "Entry",
    "Position",
    "Exit",
    "Settlement",
  ]),
  measuredStatuses: Object.freeze(["MEASURED", "PARTIAL", "UNKNOWN"]),
  firstZeroRequiresMeasuredPrefix: true,
  unknownIsZero: false,
});

const OWNED_MARKET = "CRYPTO_FUTURES";
const BUNDLE_SCHEMA = "scanner-paper-admission-evidence-bundle-v1";
const TRUTHY = new Set(["1", "true", "yes", "on", "enabled"]);
const SOURCE_BLOCKERS = Object.freeze({
  createPaperAdmissionEvidenceProducer: "AUTHORITATIVE_ADMISSION_PRODUCER_FACTORY_SOURCE_UNAVAILABLE",
  scanBatchForMarket: "AUTHORITATIVE_SCANNER_BATCH_SOURCE_UNAVAILABLE",
  paperCandidateForCard: "AUTHORITATIVE_PAPER_CANDIDATE_SOURCE_UNAVAILABLE",
  learningSnapshotForCard: "AUTHORITATIVE_LEARNING_SNAPSHOT_SOURCE_UNAVAILABLE",
  paperStateForCard: "AUTHORITATIVE_PAPER_STATE_SOURCE_UNAVAILABLE",
  contractRulesForCard: "AUTHORITATIVE_CONTRACT_RULES_SOURCE_UNAVAILABLE",
  publicEvidenceForCard: "AUTHORITATIVE_PUBLIC_EVIDENCE_SOURCE_UNAVAILABLE",
  executionObservationForCard: "AUTHORITATIVE_EXECUTION_OBSERVATION_SOURCE_UNAVAILABLE",
  supplementalCostEvidenceForCard: "AUTHORITATIVE_SUPPLEMENTAL_COST_SOURCE_UNAVAILABLE",
});

function freeze(value) {
  return Object.freeze(value);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function truthy(value) {
  return TRUTHY.has(String(value ?? "").trim().toLowerCase());
}

function blockedDataSourceContract(value, callback) {
  const contract = value?.authoritativeBlockedData;
  return isRecord(contract)
    && contract.schemaVersion === "authoritative-paper-blocked-data-source-contract-v1"
    && contract.callback === callback
    && contract.status === "BLOCKED_DATA"
    && contract.ownerStatus === "OWNER_MISSING"
    && nonEmpty(contract.blocker)
    && nonEmpty(contract.provenance)
    && contract.unknownIsZero === false
    ? contract
    : null;
}

function stageMeasurement(stage, {
  status = "UNKNOWN",
  count = null,
  blocker = null,
  provenance = null,
  measuredAtMs = null,
} = {}) {
  const measurable = status === "MEASURED" || status === "PARTIAL";
  return freeze({
    stage,
    status: measurable ? status : "UNKNOWN",
    count: measurable && Number.isInteger(count) && count >= 0 ? count : null,
    blocker: nonEmpty(blocker) ? blocker : null,
    provenance: nonEmpty(provenance) ? provenance : null,
    measuredAtMs: Number.isFinite(measuredAtMs) && measuredAtMs > 0 ? measuredAtMs : null,
  });
}

function unknownStageMeasurements(blocker = null) {
  return freeze(AUTHORITATIVE_PAPER_STAGE_MEASUREMENT_CONTRACT.stages.map((stage) => stageMeasurement(stage, {
    blocker,
  })));
}

function firstMeasuredZero(stageMeasurements, fallbackReason = "EARLIER_STAGE_NOT_MEASURED") {
  for (const measurement of stageMeasurements) {
    if (measurement.status !== "MEASURED") {
      return freeze({ stage: "UNKNOWN", reason: measurement.blocker ?? fallbackReason });
    }
    if (measurement.count === 0) {
      return freeze({ stage: measurement.stage, reason: "MEASURED_ZERO" });
    }
  }
  return freeze({ stage: "UNKNOWN", reason: "NO_MEASURED_ZERO" });
}

function stageCount(stageMeasurements, stage) {
  return stageMeasurements.find((row) => row.stage === stage)?.count ?? null;
}

function safeEnvelope(value) {
  return value?.executionAuthority === "NONE"
    && value?.simulatedOnly === true
    && value?.liveOrderAllowed === false
    && value?.privateTradingApiAllowed === false
    && value?.orderSubmitted === false
    && value?.exchangeRequestSent === false
    && value?.productionMutationAllowed === false;
}

function emptyPaperBridge() {
  return freeze({
    candidates: freeze([]),
    exitSignals: freeze([]),
    blocked: null,
    noTrade: null,
    eligible: null,
    exits: null,
    executionAuthority: "NONE",
    liveTrading: false,
    realOrder: false,
    privateApi: false,
  });
}

function blockedRuntime(
  market,
  status,
  blockers = [status],
  sourceWiringAudit = null,
  stageMeasurements = null,
) {
  const unique = [...new Set((Array.isArray(blockers) ? blockers : [status]).filter(nonEmpty))];
  const stages = Array.isArray(stageMeasurements)
    ? freeze(stageMeasurements)
    : Array.isArray(sourceWiringAudit?.stageMeasurements)
      ? sourceWiringAudit.stageMeasurements
      : unknownStageMeasurements(unique[0] ?? status);
  const firstZero = firstMeasuredZero(stages, sourceWiringAudit?.firstZeroReason ?? status);
  return freeze({
    schemaVersion: "authoritative-paper-runtime-fail-closed-v1",
    market: market ?? null,
    status,
    search: freeze({ outcome: "SEARCH_FAILURE", validNoTrade: false, searchFailure: true }),
    admissionBlockers: freeze(unique),
    simulationBlockers: freeze([]),
    evaluatedPaperCandidates: null,
    capturedProfitGateCandidates: null,
    admissionBridgeReadyCandidates: null,
    admissionBlockedCandidates: null,
    simulationReadyCandidates: null,
    simulationBlockedCandidates: null,
    bridgeEligibleCandidates: null,
    bridgeExitSignals: null,
    bridgeBlockedCandidates: null,
    paperBridge: emptyPaperBridge(),
    authoritativePaperRuntimeFactory: AUTHORITATIVE_PAPER_RUNTIME_FACTORY_CONTRACT,
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
    profitabilityClaimAllowed: false,
    ...(sourceWiringAudit == null ? {} : { sourceWiringAudit }),
    stageMeasurements: stages,
    firstZeroStage: firstZero.stage,
    firstZeroReason: firstZero.reason,
    scannerCandidateCount: stageCount(stages, "Scanner Candidate"),
    canonicalPaperCandidateCount: stageCount(stages, "Identity"),
    entryCount: stageCount(stages, "Entry"),
    settlementCount: stageCount(stages, "Settlement"),
  });
}

export function auditAuthoritativePaperSourceWiring(sourceWiring = {}) {
  if (!isRecord(sourceWiring)) throw new TypeError("authoritative Paper sourceWiring must be an object");
  const requiredCallbacks = AUTHORITATIVE_PAPER_SOURCE_WIRING_CONTRACT.requiredCallbacks;
  const readyCallbacks = requiredCallbacks.filter((name) => typeof sourceWiring[name] === "function");
  const missingCallbacks = requiredCallbacks.filter((name) => typeof sourceWiring[name] !== "function");
  const missingCallbackBlockers = missingCallbacks.map((name) => SOURCE_BLOCKERS[name]);
  const blockedDataContracts = readyCallbacks
    .map((name) => blockedDataSourceContract(sourceWiring[name], name))
    .filter(Boolean);
  const ownerMissingCallbacks = blockedDataContracts.map((contract) => contract.callback);
  const dataBlockers = [...new Set(blockedDataContracts.map((contract) => contract.blocker))];
  const blockers = [...missingCallbackBlockers, ...dataBlockers];
  const status = missingCallbacks.length > 0
    ? "BLOCKED_DATA"
    : dataBlockers.length > 0
      ? "CALLBACKS_CONNECTED_BLOCKED_DATA"
      : "CALLABLES_READY";
  const firstZeroReason = missingCallbacks.length > 0
    ? "AUTHORITATIVE_CALLBACK_SOURCE_UNAVAILABLE"
    : dataBlockers.length > 0
      ? "AUTHORITATIVE_EVIDENCE_DATA_UNAVAILABLE"
      : null;
  return freeze({
    schemaVersion: "authoritative-paper-source-wiring-audit-v1",
    status,
    requiredCallbacks,
    readyCallbacks: freeze(readyCallbacks),
    missingCallbacks: freeze(missingCallbacks),
    ownerMissingCallbacks: freeze(ownerMissingCallbacks),
    blockedDataContracts: freeze(blockedDataContracts),
    dataBlockers: freeze(dataBlockers),
    blockers: freeze(blockers),
    firstZeroStage: "UNKNOWN",
    firstZeroReason,
    stageMeasurements: unknownStageMeasurements(firstZeroReason),
    scannerCandidateCount: null,
    canonicalPaperCandidateCount: null,
    entryCount: null,
    settlementCount: null,
    unknownIsZero: false,
    executionAuthority: "NONE",
    scheduleActivationAuthority: false,
  });
}

function failClosedSourceWiringRuntime(status, blockers, sourceWiringAudit) {
  return async function failClosedAuthoritativePaperRuntime({ market } = {}) {
    if (market !== OWNED_MARKET) {
      return blockedRuntime(market, "AUTHORITATIVE_ADMISSION_MARKET_NOT_OWNED");
    }
    return blockedRuntime(market, status, blockers, sourceWiringAudit);
  };
}

function paperAdmissionEvidenceProducer(sourceWiring) {
  return sourceWiring.createPaperAdmissionEvidenceProducer({
    paperCandidateSource: sourceWiring.paperCandidateForCard,
    learningSnapshotSource: sourceWiring.learningSnapshotForCard,
    paperStateSource: sourceWiring.paperStateForCard,
    contractRulesSource: sourceWiring.contractRulesForCard,
    publicEvidenceSource: sourceWiring.publicEvidenceForCard,
    executionObservationSource: sourceWiring.executionObservationForCard,
    supplementalCostEvidenceSource: sourceWiring.supplementalCostEvidenceForCard,
  });
}

export function createAuthoritativePaperRuntimeFromSourceWiring({
  sourceWiring = {},
  ...runtimeOptions
} = {}) {
  const sourceWiringAudit = auditAuthoritativePaperSourceWiring(sourceWiring);
  if (sourceWiringAudit.missingCallbacks.length > 0) {
    return failClosedSourceWiringRuntime(
      "AUTHORITATIVE_RECURRING_SOURCE_WIRING_BLOCKED",
      sourceWiringAudit.blockers,
      sourceWiringAudit,
    );
  }

  let producer;
  try {
    producer = paperAdmissionEvidenceProducer(sourceWiring);
  } catch {
    return failClosedSourceWiringRuntime(
      "AUTHORITATIVE_ADMISSION_PRODUCER_CONSTRUCTION_FAILED",
      ["AUTHORITATIVE_ADMISSION_PRODUCER_CONSTRUCTION_FAILED"],
      sourceWiringAudit,
    );
  }
  if (typeof producer !== "function") {
    return failClosedSourceWiringRuntime(
      "AUTHORITATIVE_ADMISSION_PRODUCER_INVALID",
      ["AUTHORITATIVE_ADMISSION_PRODUCER_INVALID"],
      sourceWiringAudit,
    );
  }

  const runtime = createAuthoritativePaperRuntimeForMarket({
    ...runtimeOptions,
    scanBatchForMarket: sourceWiring.scanBatchForMarket,
    paperAdmissionEvidenceForCard: producer,
    authoritativeSourceDataBlockers: sourceWiringAudit.dataBlockers,
  });
  return async function auditedAuthoritativePaperRuntime(input = {}) {
    const result = await runtime(input);
    return freeze({ ...result, sourceWiringAudit });
  };
}

function producerBlockError(blockers) {
  const normalized = [...new Set((Array.isArray(blockers) ? blockers : []).filter(nonEmpty))];
  const error = new Error("AUTHORITATIVE_ADMISSION_EVIDENCE_BLOCKED");
  error.code = "AUTHORITATIVE_ADMISSION_EVIDENCE_BLOCKED";
  error.authoritativeAdmissionBlockers = normalized.length > 0
    ? normalized
    : ["AUTHORITATIVE_ADMISSION_EVIDENCE_BLOCKED"];
  return error;
}

function validProducerResult(value) {
  return isRecord(value)
    && value.status === "READY"
    && isRecord(value.bundle)
    && value.bundle.schemaVersion === BUNDLE_SCHEMA
    && safeEnvelope(value)
    && safeEnvelope(value.bundle);
}

function validRuntimeResult(value, market) {
  return isRecord(value)
    && value.market === market
    && nonEmpty(value.status)
    && isRecord(value.search)
    && isRecord(value.paperBridge)
    && Array.isArray(value.paperBridge.candidates)
    && Array.isArray(value.paperBridge.exitSignals)
    && safeEnvelope(value);
}

function runtimeOptionsForInvocation({ profitInputForCard, maximumBatches, onProgress, now }) {
  return {
    ...(typeof profitInputForCard === "function" ? { profitInputForCard } : {}),
    ...(Number.isInteger(maximumBatches) ? { maximumBatches } : {}),
    ...(typeof onProgress === "function" ? { onProgress } : {}),
    ...(typeof now === "function" ? { now } : {}),
  };
}

function safeMeasurementTime(now) {
  try {
    const value = now();
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function runtimeStageMeasurements({
  completed,
  runtime = null,
  scanBatchCalls,
  scannerCandidateCount,
  producerReadyCount,
  blocker = null,
  measuredAtMs = null,
}) {
  const scannerMeasured = completed && scanBatchCalls > 0;
  const scannerPartial = !completed && scanBatchCalls > 0;
  const profitGateCount = Number.isInteger(runtime?.capturedProfitGateCandidates)
    ? runtime.capturedProfitGateCandidates
    : null;
  const identityMeasured = scannerMeasured
    && producerReadyCount === scannerCandidateCount
    && profitGateCount != null;
  const admissionCount = Number.isInteger(runtime?.admissionBridgeReadyCandidates)
    ? runtime.admissionBridgeReadyCandidates
    : null;
  const exitCount = Number.isInteger(runtime?.bridgeExitSignals)
    ? runtime.bridgeExitSignals
    : null;
  return freeze([
    stageMeasurement("Scanner Candidate", {
      status: scannerMeasured ? "MEASURED" : scannerPartial ? "PARTIAL" : "UNKNOWN",
      count: scannerCandidateCount,
      blocker: completed ? null : blocker,
      provenance: scanBatchCalls > 0 ? "CryptoSignalScannerService scanBatch response.cards" : null,
      measuredAtMs,
    }),
    stageMeasurement("Profit Gate", {
      status: completed && profitGateCount != null ? "MEASURED" : "UNKNOWN",
      count: profitGateCount,
      blocker: completed ? null : blocker,
      provenance: completed && profitGateCount != null
        ? "canonical-meaningful-search-paper-runtime-v1.capturedProfitGateCandidates"
        : null,
      measuredAtMs,
    }),
    stageMeasurement("Identity", {
      status: identityMeasured ? "MEASURED" : "UNKNOWN",
      count: identityMeasured ? profitGateCount : null,
      blocker: completed ? null : blocker,
      provenance: identityMeasured
        ? "#546 validated bundle injection for every scanned card + measured Profit Gate subset"
        : null,
      measuredAtMs,
    }),
    stageMeasurement("Paper Admission", {
      status: completed && admissionCount != null ? "MEASURED" : "UNKNOWN",
      count: admissionCount,
      blocker: completed ? null : blocker,
      provenance: completed && admissionCount != null
        ? "canonical-meaningful-search-paper-runtime-v1.admissionBridgeReadyCandidates"
        : null,
      measuredAtMs,
    }),
    stageMeasurement("Entry", {
      blocker: "RECURRING_PAPER_ENTRY_NOT_MEASURED_BY_ADMISSION_RUNTIME",
    }),
    stageMeasurement("Position", {
      blocker: "RECURRING_PAPER_POSITION_NOT_MEASURED_BY_ADMISSION_RUNTIME",
    }),
    stageMeasurement("Exit", {
      status: completed && exitCount != null ? "MEASURED" : "UNKNOWN",
      count: exitCount,
      blocker: completed ? null : blocker,
      provenance: completed && exitCount != null
        ? "canonical-meaningful-search-paper-runtime-v1.bridgeExitSignals"
        : null,
      measuredAtMs,
    }),
    stageMeasurement("Settlement", {
      blocker: "RECURRING_PAPER_SETTLEMENT_NOT_MEASURED_BY_ADMISSION_RUNTIME",
    }),
  ]);
}

export function createAuthoritativePaperRuntimeForMarket({
  scanBatchForMarket,
  paperAdmissionEvidenceForCard,
  profitInputForCard,
  maximumBatches,
  onProgress,
  now = () => Date.now(),
  authoritativeSourceDataBlockers = [],
  runRuntimeWithAdmissionBundles = runCanonicalMeaningfulSearchPaperMarketWithAdmissionBundles,
} = {}) {
  if (typeof scanBatchForMarket !== "function") throw new TypeError("authoritative scanBatchForMarket is required");
  if (typeof paperAdmissionEvidenceForCard !== "function") {
    throw new TypeError("authoritative paperAdmissionEvidenceForCard is required");
  }
  if (typeof now !== "function") throw new TypeError("authoritative Paper runtime clock is required");
  if (!Array.isArray(authoritativeSourceDataBlockers)
    || authoritativeSourceDataBlockers.some((value) => !nonEmpty(value))) {
    throw new TypeError("authoritative source data blockers must be an array of non-empty strings");
  }
  const sourceDataBlockers = freeze([...new Set(authoritativeSourceDataBlockers)]);
  if (typeof runRuntimeWithAdmissionBundles !== "function") {
    throw new TypeError("canonical admission-bundle runtime is required");
  }
  if (maximumBatches != null && (!Number.isInteger(maximumBatches) || maximumBatches < 1)) {
    throw new TypeError("positive integer maximumBatches is required when provided");
  }

  return async function authoritativePaperRuntimeForMarket({ market, cycle, signal } = {}) {
    if (market !== OWNED_MARKET) {
      return blockedRuntime(market, "AUTHORITATIVE_ADMISSION_MARKET_NOT_OWNED");
    }

    let scanBatch;
    try {
      scanBatch = await scanBatchForMarket({ market, cycle, signal });
    } catch {
      return blockedRuntime(market, "AUTHORITATIVE_SCANNER_RUNTIME_FAILED");
    }
    if (typeof scanBatch !== "function") {
      return blockedRuntime(market, "AUTHORITATIVE_SCANNER_RUNTIME_UNAVAILABLE");
    }

    let scanBatchCalls = 0;
    let scannerCandidateCount = 0;
    let producerReadyCount = 0;
    const trackedScanBatch = async (...args) => {
      const response = await scanBatch(...args);
      if (!isRecord(response) || !Array.isArray(response.cards)) {
        throw new Error("AUTHORITATIVE_SCANNER_RESPONSE_INVALID");
      }
      scanBatchCalls += 1;
      scannerCandidateCount += response.cards.length;
      return response;
    };

    const paperAdmissionBundleForCard = async (card, selectedMarket) => {
      let produced;
      try {
        produced = await paperAdmissionEvidenceForCard({
          card,
          market: selectedMarket,
          cycle,
          signal,
        });
      } catch {
        throw producerBlockError([
          ...sourceDataBlockers,
          "P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_FAILED",
        ]);
      }
      if (!validProducerResult(produced)) {
        throw producerBlockError([
          ...sourceDataBlockers,
          ...(Array.isArray(produced?.blockers) ? produced.blockers : []),
        ]);
      }
      producerReadyCount += 1;
      return produced.bundle;
    };

    try {
      const runtime = await runRuntimeWithAdmissionBundles({
        market,
        scanBatch: trackedScanBatch,
        paperAdmissionBundleForCard,
        ...runtimeOptionsForInvocation({ profitInputForCard, maximumBatches, onProgress, now }),
      });
      if (!validRuntimeResult(runtime, market)) {
        return blockedRuntime(market, "AUTHORITATIVE_PAPER_RUNTIME_CONTRACT_INVALID");
      }
      const measuredAtMs = safeMeasurementTime(now);
      if (measuredAtMs == null) {
        return blockedRuntime(market, "AUTHORITATIVE_STAGE_MEASUREMENT_CLOCK_INVALID");
      }
      const stageMeasurements = runtimeStageMeasurements({
        completed: true,
        runtime,
        scanBatchCalls,
        scannerCandidateCount,
        producerReadyCount,
        measuredAtMs,
      });
      const firstZero = firstMeasuredZero(stageMeasurements);
      return freeze({
        ...runtime,
        authoritativePaperRuntimeFactory: AUTHORITATIVE_PAPER_RUNTIME_FACTORY_CONTRACT,
        stageMeasurements,
        firstZeroStage: firstZero.stage,
        firstZeroReason: firstZero.reason,
        scannerCandidateCount: stageCount(stageMeasurements, "Scanner Candidate"),
        canonicalPaperCandidateCount: stageCount(stageMeasurements, "Identity"),
        entryCount: null,
        settlementCount: null,
      });
    } catch (error) {
      const tagged = error?.code === "AUTHORITATIVE_ADMISSION_EVIDENCE_BLOCKED";
      const admissionBlockers = tagged
        ? error.authoritativeAdmissionBlockers
        : ["AUTHORITATIVE_PAPER_RUNTIME_FAILED"];
      const measuredAtMs = safeMeasurementTime(now);
      const stageMeasurements = runtimeStageMeasurements({
        completed: false,
        scanBatchCalls,
        scannerCandidateCount,
        producerReadyCount,
        blocker: admissionBlockers[0] ?? "AUTHORITATIVE_PAPER_RUNTIME_FAILED",
        measuredAtMs,
      });
      return blockedRuntime(
        market,
        tagged ? "AUTHORITATIVE_ADMISSION_EVIDENCE_BLOCKED" : "AUTHORITATIVE_PAPER_RUNTIME_FAILED",
        admissionBlockers,
        null,
        stageMeasurements,
      );
    }
  };
}

export function createAuthoritativePaperForwardEvidenceProvider({
  paperRuntimeForMarket,
  env = process.env,
  providerFactory = createCanonicalPaperForwardEvidenceProvider,
  ...providerOptions
} = {}) {
  if (typeof paperRuntimeForMarket !== "function") {
    throw new TypeError("authoritative paperRuntimeForMarket is required");
  }
  if (!truthy(env?.RESEARCH_PRODUCTION)) {
    throw new Error("AUTHORITATIVE_PAPER_RUNTIME_RESEARCH_PRODUCTION_REQUIRED");
  }
  if (typeof providerFactory !== "function") throw new TypeError("canonical Paper provider factory is required");
  return providerFactory({
    ...providerOptions,
    env,
    paperRuntimeForMarket,
  });
}

export function createAuthoritativePaperForwardDependencies({
  runtimeOptions,
  providerOptions = {},
  runtimeFactory = createAuthoritativePaperRuntimeForMarket,
  evidenceProviderFactory = createAuthoritativePaperForwardEvidenceProvider,
} = {}) {
  if (!isRecord(runtimeOptions)) throw new TypeError("authoritative Paper runtimeOptions are required");
  if (!isRecord(providerOptions)) throw new TypeError("authoritative Paper providerOptions must be an object");
  if (typeof runtimeFactory !== "function" || typeof evidenceProviderFactory !== "function") {
    throw new TypeError("authoritative Paper factories are required");
  }
  const paperRuntimeForMarket = runtimeFactory(runtimeOptions);
  const publicEvidenceProvider = evidenceProviderFactory({
    ...providerOptions,
    paperRuntimeForMarket,
  });
  return freeze({
    paperRuntimeForMarket,
    publicEvidenceProvider,
    contract: AUTHORITATIVE_PAPER_RUNTIME_FACTORY_CONTRACT,
  });
}

export function createAuthoritativePaperForwardDependenciesFromSourceWiring({
  sourceWiring = {},
  runtimeOptions = {},
  providerOptions = {},
  runtimeFactory = createAuthoritativePaperRuntimeFromSourceWiring,
  evidenceProviderFactory = createAuthoritativePaperForwardEvidenceProvider,
} = {}) {
  if (!isRecord(sourceWiring)) throw new TypeError("authoritative Paper sourceWiring must be an object");
  if (!isRecord(runtimeOptions)) throw new TypeError("authoritative Paper runtimeOptions must be an object");
  if (!isRecord(providerOptions)) throw new TypeError("authoritative Paper providerOptions must be an object");
  if (typeof runtimeFactory !== "function" || typeof evidenceProviderFactory !== "function") {
    throw new TypeError("authoritative Paper source-wiring factories are required");
  }
  const sourceWiringAudit = auditAuthoritativePaperSourceWiring(sourceWiring);
  const paperRuntimeForMarket = runtimeFactory({ sourceWiring, ...runtimeOptions });
  const publicEvidenceProvider = evidenceProviderFactory({
    ...providerOptions,
    paperRuntimeForMarket,
  });
  return freeze({
    paperRuntimeForMarket,
    publicEvidenceProvider,
    sourceWiringAudit,
    contract: AUTHORITATIVE_PAPER_RUNTIME_FACTORY_CONTRACT,
  });
}
