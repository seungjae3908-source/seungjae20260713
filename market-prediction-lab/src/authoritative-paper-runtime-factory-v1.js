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
    blocked: 1,
    noTrade: 0,
    eligible: 0,
    exits: 0,
    executionAuthority: "NONE",
    liveTrading: false,
    realOrder: false,
    privateApi: false,
  });
}

function blockedRuntime(market, status, blockers = [status], sourceWiringAudit = null) {
  const unique = [...new Set((Array.isArray(blockers) ? blockers : [status]).filter(nonEmpty))];
  return freeze({
    schemaVersion: "authoritative-paper-runtime-fail-closed-v1",
    market: market ?? null,
    status,
    search: freeze({ outcome: "SEARCH_FAILURE", validNoTrade: false, searchFailure: true }),
    admissionBlockers: freeze(unique),
    simulationBlockers: freeze([]),
    evaluatedPaperCandidates: 0,
    capturedProfitGateCandidates: 0,
    admissionBridgeReadyCandidates: 0,
    admissionBlockedCandidates: 1,
    simulationReadyCandidates: 0,
    simulationBlockedCandidates: 0,
    bridgeEligibleCandidates: 0,
    bridgeExitSignals: 0,
    bridgeBlockedCandidates: 1,
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
    ...(sourceWiringAudit == null ? {} : {
      sourceWiringAudit,
      firstZeroStage: "UNKNOWN",
      firstZeroReason: status === "AUTHORITATIVE_RECURRING_SOURCE_WIRING_BLOCKED"
        ? "AUTHORITATIVE_CALLBACK_SOURCE_UNAVAILABLE"
        : status,
      scannerCandidateCount: null,
      canonicalPaperCandidateCount: null,
      entryCount: null,
      settlementCount: null,
    }),
  });
}

export function auditAuthoritativePaperSourceWiring(sourceWiring = {}) {
  if (!isRecord(sourceWiring)) throw new TypeError("authoritative Paper sourceWiring must be an object");
  const requiredCallbacks = AUTHORITATIVE_PAPER_SOURCE_WIRING_CONTRACT.requiredCallbacks;
  const readyCallbacks = requiredCallbacks.filter((name) => typeof sourceWiring[name] === "function");
  const missingCallbacks = requiredCallbacks.filter((name) => typeof sourceWiring[name] !== "function");
  const blockers = missingCallbacks.map((name) => SOURCE_BLOCKERS[name]);
  return freeze({
    schemaVersion: "authoritative-paper-source-wiring-audit-v1",
    status: blockers.length === 0 ? "CALLABLES_READY" : "BLOCKED_DATA",
    requiredCallbacks,
    readyCallbacks: freeze(readyCallbacks),
    missingCallbacks: freeze(missingCallbacks),
    blockers: freeze(blockers),
    firstZeroStage: "UNKNOWN",
    firstZeroReason: blockers.length === 0 ? null : "AUTHORITATIVE_CALLBACK_SOURCE_UNAVAILABLE",
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
  if (sourceWiringAudit.status !== "CALLABLES_READY") {
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

export function createAuthoritativePaperRuntimeForMarket({
  scanBatchForMarket,
  paperAdmissionEvidenceForCard,
  profitInputForCard,
  maximumBatches,
  onProgress,
  now = () => Date.now(),
  runRuntimeWithAdmissionBundles = runCanonicalMeaningfulSearchPaperMarketWithAdmissionBundles,
} = {}) {
  if (typeof scanBatchForMarket !== "function") throw new TypeError("authoritative scanBatchForMarket is required");
  if (typeof paperAdmissionEvidenceForCard !== "function") {
    throw new TypeError("authoritative paperAdmissionEvidenceForCard is required");
  }
  if (typeof now !== "function") throw new TypeError("authoritative Paper runtime clock is required");
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
        throw producerBlockError(["P0_C9_AUTHORITATIVE_EVIDENCE_SOURCE_FAILED"]);
      }
      if (!validProducerResult(produced)) {
        throw producerBlockError(produced?.blockers);
      }
      return produced.bundle;
    };

    try {
      const runtime = await runRuntimeWithAdmissionBundles({
        market,
        scanBatch,
        paperAdmissionBundleForCard,
        ...runtimeOptionsForInvocation({ profitInputForCard, maximumBatches, onProgress, now }),
      });
      if (!validRuntimeResult(runtime, market)) {
        return blockedRuntime(market, "AUTHORITATIVE_PAPER_RUNTIME_CONTRACT_INVALID");
      }
      return freeze({
        ...runtime,
        authoritativePaperRuntimeFactory: AUTHORITATIVE_PAPER_RUNTIME_FACTORY_CONTRACT,
      });
    } catch (error) {
      const tagged = error?.code === "AUTHORITATIVE_ADMISSION_EVIDENCE_BLOCKED";
      return blockedRuntime(
        market,
        tagged ? "AUTHORITATIVE_ADMISSION_EVIDENCE_BLOCKED" : "AUTHORITATIVE_PAPER_RUNTIME_FAILED",
        tagged ? error.authoritativeAdmissionBlockers : ["AUTHORITATIVE_PAPER_RUNTIME_FAILED"],
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
