import { resolveCanonicalPaperAdmissionBridgeCandidate } from "./canonical-paper-admission-bridge-v1.js";
import { runCanonicalMeaningfulSearchPaperMarket } from "./canonical-meaningful-search-paper-runtime-v1.js";

const DEFAULT_MAX_EVIDENCE_AGE_MS = 30_000;

export const AUTHORITATIVE_NATURAL_PAPER_ADMISSION_CONTRACT = Object.freeze({
  version: "authoritative-natural-paper-admission-producer-v1",
  bundleSchemaVersion: "scanner-paper-admission-evidence-bundle-v1",
  publicEvidenceOnly: true,
  requiresCrossRuntimeVerification: true,
  requiresTradingRiskEngineEvidence: true,
  requiresFreshExecutionEvidence: true,
  requiresFreshTopOfBookForEntry: true,
  executionAuthority: "NONE",
  simulatedOnly: true,
  liveOrderAllowed: false,
  privateTradingApiAllowed: false,
  orderSubmitted: false,
  exchangeRequestSent: false,
  productionMutationAllowed: false,
  profitabilityClaimAllowed: false,
});

function freeze(value) { return Object.freeze(value); }
function finitePositive(value) { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function isRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function safetyEnvelope() {
  return AUTHORITATIVE_NATURAL_PAPER_ADMISSION_CONTRACT;
}

function blocked(blockers, errorCode = null) {
  return freeze({
    status: "BLOCKED",
    bundle: null,
    evidenceDigest: null,
    blockers: freeze([...new Set(blockers.filter(nonEmpty))]),
    errorCode: nonEmpty(errorCode) ? errorCode.slice(0, 160) : null,
    ...safetyEnvelope(),
  });
}

function ready(bundle, evidenceDigest) {
  return freeze({
    status: "READY",
    bundle: deepFreeze(structuredClone(bundle)),
    evidenceDigest,
    blockers: freeze([]),
    errorCode: null,
    ...safetyEnvelope(),
  });
}

function safeErrorCode(error) {
  return String(error?.code ?? error?.message ?? "AUTHORITATIVE_ADMISSION_SOURCE_FAILED")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_:-]/gu, "_")
    .slice(0, 160);
}

export function createAuthoritativeNaturalPaperAdmissionProducer({
  bundleForCard,
  now = Date.now,
  maxEvidenceAgeMs = DEFAULT_MAX_EVIDENCE_AGE_MS,
} = {}) {
  if (typeof bundleForCard !== "function") throw new TypeError("bundleForCard is required");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (!finitePositive(maxEvidenceAgeMs)) throw new TypeError("positive maxEvidenceAgeMs is required");

  return freeze({
    contract: AUTHORITATIVE_NATURAL_PAPER_ADMISSION_CONTRACT,
    async produce(card, selectedMarket, context = {}) {
      const nowMs = now();
      if (!finitePositive(nowMs)) return blocked(["AUTHORITATIVE_ADMISSION_CLOCK_INVALID"]);
      try {
        const bundle = await bundleForCard(card, selectedMarket, context);
        if (!isRecord(bundle)) return blocked(["AUTHORITATIVE_ADMISSION_BUNDLE_MISSING"]);
        const resolved = resolveCanonicalPaperAdmissionBridgeCandidate({
          bundle,
          nowMs,
          maxEvidenceAgeMs,
        });
        if (resolved.status !== "BRIDGE_READY" || !resolved.candidate) {
          return blocked(resolved.blockers.length
            ? resolved.blockers
            : ["AUTHORITATIVE_ADMISSION_BUNDLE_BLOCKED"]);
        }
        if (resolved.candidate.signal?.market !== selectedMarket) {
          return blocked(["AUTHORITATIVE_ADMISSION_MARKET_MISMATCH"]);
        }
        if (resolved.candidate.riskEvidence?.source !== "TRADING_RISK_ENGINE") {
          return blocked(["AUTHORITATIVE_TRADING_RISK_ENGINE_EVIDENCE_REQUIRED"]);
        }
        return ready(bundle, resolved.evidenceDigest);
      } catch (error) {
        return blocked(["AUTHORITATIVE_ADMISSION_SOURCE_FAILED"], safeErrorCode(error));
      }
    },
  });
}

export function createFailClosedNaturalPaperAdmissionProducer({
  reason = "AUTHORITATIVE_ADMISSION_PRODUCER_UNAVAILABLE",
} = {}) {
  if (!nonEmpty(reason)) throw new TypeError("fail-closed reason is required");
  return freeze({
    contract: AUTHORITATIVE_NATURAL_PAPER_ADMISSION_CONTRACT,
    async produce() {
      return blocked([reason]);
    },
  });
}

function stripEntryAuthority(value, blocker) {
  if (!isRecord(value)) return value;
  const copy = structuredClone(value);
  if (isRecord(copy.execution)) {
    delete copy.execution.executionPolicy;
    delete copy.execution.marketAdapterIdentity;
  }
  delete copy.order;
  delete copy.quote;
  delete copy.fill;
  copy.sampleExecutionReady = false;
  copy.sampleExecutionBlockers = [blocker];
  copy.executionAuthority = "NONE";
  copy.simulatedOnly = true;
  copy.liveOrderAllowed = false;
  copy.privateTradingApiAllowed = false;
  copy.orderSubmitted = false;
  copy.exchangeRequestSent = false;
  copy.productionMutationAllowed = false;
  return copy;
}

function applyProductionResult(card, result) {
  if (result?.status === "READY" && isRecord(result.bundle)) {
    return freeze({
      ...card,
      paperAdmissionEvidenceBundle: result.bundle,
      canonicalAdmissionProducer: freeze({
        version: AUTHORITATIVE_NATURAL_PAPER_ADMISSION_CONTRACT.version,
        status: "READY",
        evidenceDigest: result.evidenceDigest,
        blockers: freeze([]),
      }),
    });
  }

  const blockers = Array.isArray(result?.blockers) && result.blockers.length
    ? result.blockers
    : ["AUTHORITATIVE_ADMISSION_BUNDLE_REQUIRED"];
  const blocker = blockers[0];
  const blockedCard = stripEntryAuthority(card, blocker);
  if (isRecord(blockedCard?.paperCandidate)) {
    blockedCard.paperCandidate = stripEntryAuthority(blockedCard.paperCandidate, blocker);
  }
  delete blockedCard.paperAdmissionEvidenceBundle;
  blockedCard.canonicalAdmissionProducer = freeze({
    version: AUTHORITATIVE_NATURAL_PAPER_ADMISSION_CONTRACT.version,
    status: "BLOCKED",
    evidenceDigest: null,
    blockers: freeze([...new Set(blockers)]),
  });
  return freeze(blockedCard);
}

function signalKey(card, market) {
  return `${market}:${String(card?.signalId ?? card?.signal?.signalId ?? "NO_SIGNAL_ID")}`;
}

async function attachAdmissionToScannerResponse(response, market, producer, context) {
  if (!isRecord(response)) throw new TypeError("scanner response is required");
  const cache = new Map();
  const enrich = async (card) => {
    const key = signalKey(card, market);
    let result = cache.get(key);
    if (!result) {
      result = await producer.produce(card, market, context);
      cache.set(key, result);
    }
    return applyProductionResult(card, result);
  };

  const cards = [];
  for (const card of Array.isArray(response.cards) ? response.cards : []) cards.push(await enrich(card));
  let audit = response.audit;
  if (isRecord(response.audit) && Array.isArray(response.audit.internalCards)) {
    const internalCards = [];
    for (const card of response.audit.internalCards) internalCards.push(await enrich(card));
    audit = freeze({ ...response.audit, internalCards: freeze(internalCards) });
  }
  return freeze({ ...response, cards: freeze(cards), ...(audit ? { audit } : {}) });
}

export function createCanonicalNaturalPaperRuntimeForMarket({
  scanBatchForMarket,
  profitInputForCard,
  admissionProducer,
  now = Date.now,
  maximumBatches = 1_000,
} = {}) {
  if (typeof scanBatchForMarket !== "function") throw new TypeError("scanBatchForMarket is required");
  if (typeof profitInputForCard !== "function") throw new TypeError("profitInputForCard is required");
  if (!admissionProducer || typeof admissionProducer.produce !== "function") throw new TypeError("admissionProducer is required");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (!Number.isInteger(maximumBatches) || maximumBatches < 1) throw new TypeError("positive maximumBatches is required");

  return async function canonicalNaturalPaperRuntimeForMarket({ market, cycle, signal } = {}) {
    return runCanonicalMeaningfulSearchPaperMarket({
      market,
      maximumBatches,
      now,
      scanBatch: async ({ market: selectedMarket, cursor }) => {
        const response = await scanBatchForMarket({ market: selectedMarket, cursor, cycle, signal });
        return attachAdmissionToScannerResponse(response, selectedMarket, admissionProducer, { cycle, signal });
      },
      profitInputForCard: (card, selectedMarket) => profitInputForCard(card, selectedMarket, { cycle, signal }),
    });
  };
}

export function createFailClosedCanonicalPaperRuntimeForMarket({
  reason = "AUTHORITATIVE_ADMISSION_PRODUCER_UNAVAILABLE",
} = {}) {
  if (!nonEmpty(reason)) throw new TypeError("fail-closed reason is required");
  return async function failClosedCanonicalPaperRuntimeForMarket({ market } = {}) {
    return freeze({
      schemaVersion: "canonical-natural-paper-runtime-fail-closed-v1",
      market,
      status: "VALID_NO_TRADE",
      search: freeze({ outcome: "VALID_NO_TRADE", validNoTrade: true, searchFailure: false }),
      admissionBlockers: freeze([reason]),
      simulationBlockers: freeze([]),
      paperBridge: freeze({
        candidates: freeze([]),
        exitSignals: freeze([]),
        blocked: 0,
        noTrade: 1,
        eligible: 0,
        exits: 0,
        executionAuthority: "NONE",
        liveTrading: false,
        realOrder: false,
        privateApi: false,
      }),
      executionAuthority: "NONE",
      simulatedOnly: true,
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
      orderSubmitted: false,
      exchangeRequestSent: false,
      productionMutationAllowed: false,
      profitabilityClaimAllowed: false,
    });
  };
}
