import { PredictionInputError } from "./contracts.js";
import { buildUsQualityDaytradeLiveEvidenceBundle } from "./us-quality-daytrade-live-evidence-v1.js";
import { admitUsQualityDaytradeEvidence } from "./us-quality-daytrade-evidence-admission-v1.js";

export const QUALITY_DAYTRADE_PUBLIC_COLLECTOR_ADAPTER_VERSION = "us-quality-daytrade-public-collector-adapter-v1";

const VALID_WORKFLOW_FAMILIES = new Set(["RESEARCH_PRODUCTION", "GITHUB_ACTIONS"]);
const EXECUTABLE_QUOTE_SEMANTICS = "EXECUTABLE_BID_ASK";

function freeze(value) {
  return Object.freeze(value);
}

function safeBlocked(reason, ledger, details = {}) {
  return freeze({
    contractVersion: QUALITY_DAYTRADE_PUBLIC_COLLECTOR_ADAPTER_VERSION,
    status: "BLOCKED_DATA",
    reason,
    sampleCountDelta: 0,
    canonicalSampleAccepted: false,
    duplicateCountingAllowed: false,
    selectionEligible: false,
    executionAuthority: "NONE",
    liveTradingAllowed: false,
    privateApiAllowed: false,
    orderAuthority: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    ledger,
    ...details,
  });
}

function normalizeWorkflowFamily(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (!VALID_WORKFLOW_FAMILIES.has(normalized)) {
    throw new PredictionInputError("workflowFamily must be RESEARCH_PRODUCTION or GITHUB_ACTIONS");
  }
  return normalized;
}

function validateCollectorProof(raw, quoteEvidence) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "PUBLIC_COLLECTOR_PROOF_REQUIRED";
  if (raw.publicReadOnly !== true) return "PUBLIC_COLLECTOR_READ_ONLY_REQUIRED";
  if (raw.privateApiUsed !== false) return "PUBLIC_COLLECTOR_PRIVATE_API_STATE_INVALID";
  if (raw.liveTradingAllowed !== false) return "PUBLIC_COLLECTOR_LIVE_TRADING_STATE_INVALID";
  if (raw.orderAuthority !== false) return "PUBLIC_COLLECTOR_ORDER_AUTHORITY_STATE_INVALID";
  if (String(raw.quoteSemantics ?? "").trim().toUpperCase() !== EXECUTABLE_QUOTE_SEMANTICS) {
    return "PUBLIC_COLLECTOR_EXECUTABLE_QUOTE_CONTRACT_REQUIRED";
  }
  if (raw.syntheticBidAsk === true || raw.referencePriceUsedAsBidAsk === true) {
    return "PUBLIC_COLLECTOR_SYNTHETIC_BID_ASK_FORBIDDEN";
  }
  const sourceId = String(raw.sourceId ?? "").trim();
  if (!sourceId) return "PUBLIC_COLLECTOR_SOURCE_REQUIRED";

  // The collector proof must identify the concrete quote producer separately
  // from the collector/adapter itself. This prevents a trusted collector label
  // from being paired with executable-looking fields from another source.
  const executableQuoteSourceId = String(raw.executableQuoteSourceId ?? "").trim();
  if (!executableQuoteSourceId) return "PUBLIC_COLLECTOR_EXECUTABLE_QUOTE_SOURCE_REQUIRED";
  const quoteSourceId = String(quoteEvidence?.sourceId ?? quoteEvidence?.source ?? "").trim();
  if (!quoteSourceId || quoteSourceId !== executableQuoteSourceId) {
    return "PUBLIC_COLLECTOR_EXECUTABLE_QUOTE_SOURCE_MISMATCH";
  }
  if (quoteEvidence?.syntheticBidAsk === true || quoteEvidence?.referencePriceUsedAsBidAsk === true) {
    return "PUBLIC_COLLECTOR_QUOTE_PROVENANCE_FORBIDDEN";
  }
  return null;
}

/**
 * Research-only bridge from a public U.S.-stock intraday collector into the
 * canonical live-evidence + global-evidence-admission chain.
 *
 * The adapter deliberately refuses to infer bid/ask from last/close/reference
 * prices. Historical/chart collectors (for example yahoo-public-chart) can be
 * useful for candles but cannot satisfy the executable quote contract by
 * themselves.
 */
export function admitUsQualityDaytradePublicCollectorObservation(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PredictionInputError("public collector observation input must be an object");
  }

  const workflowFamily = normalizeWorkflowFamily(raw.workflowFamily);
  const collectorBlocker = validateCollectorProof(raw.collectorProof, raw.quoteEvidence);
  if (collectorBlocker) {
    return safeBlocked(collectorBlocker, raw.ledger, { workflowFamily });
  }

  const bundle = buildUsQualityDaytradeLiveEvidenceBundle({
    asOfMs: raw.asOfMs,
    dataPolicy: raw.dataPolicy,
    quoteEvidence: raw.quoteEvidence,
    candleEvidence: raw.candleEvidence,
    relativeVolumeEvidence: raw.relativeVolumeEvidence,
  });

  if (bundle.status !== "READY") {
    return safeBlocked(bundle.reason ?? "SOURCE_BACKED_LIVE_EVIDENCE_REQUIRED", raw.ledger, {
      workflowFamily,
      liveEvidenceStatus: bundle.status,
      liveEvidenceReason: bundle.reason ?? null,
    });
  }

  const admitted = admitUsQualityDaytradeEvidence({
    ledger: raw.ledger,
    strategyIdentity: raw.strategyIdentity,
    symbol: raw.symbol,
    bundle,
    workflowFamily,
    artifactLineageDigest: raw.artifactLineageDigest,
  });

  return freeze({
    ...admitted,
    contractVersion: QUALITY_DAYTRADE_PUBLIC_COLLECTOR_ADAPTER_VERSION,
    workflowFamily,
    collector: freeze({
      sourceId: String(raw.collectorProof.sourceId).trim(),
      executableQuoteSourceId: String(raw.collectorProof.executableQuoteSourceId).trim(),
      quoteSemantics: EXECUTABLE_QUOTE_SEMANTICS,
      publicReadOnly: true,
      privateApiUsed: false,
      syntheticBidAsk: false,
      referencePriceUsedAsBidAsk: false,
    }),
    duplicateCountingAllowed: false,
    selectionEligible: false,
    executionAuthority: "NONE",
    liveTradingAllowed: false,
    privateApiAllowed: false,
    orderAuthority: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
}
