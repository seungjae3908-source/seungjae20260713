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

const OWNED_MARKET = "CRYPTO_FUTURES";
const BUNDLE_SCHEMA = "scanner-paper-admission-evidence-bundle-v1";
const TRUTHY = new Set(["1", "true", "yes", "on", "enabled"]);

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

function blockedRuntime(market, status, blockers = [status]) {
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
  });
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
