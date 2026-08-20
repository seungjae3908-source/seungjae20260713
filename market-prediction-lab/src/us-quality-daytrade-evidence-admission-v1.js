import { PredictionInputError } from "./contracts.js";
import {
  createGlobalEvidenceLedger,
  recordGlobalEvidence,
} from "./global-evidence-dedup-ledger-v1.js";
import { researchDigest } from "./research-trial-registry.js";
import { buildUsQualityDaytradeObservationIdentity } from "./us-quality-daytrade-live-evidence-v1.js";

export const QUALITY_DAYTRADE_EVIDENCE_ADMISSION_VERSION = "us-quality-daytrade-evidence-admission-v1";

function freeze(value) {
  return Object.freeze(value);
}

function requiredString(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new PredictionInputError(`${name} is required`);
  return normalized;
}

function blocked(reason) {
  return freeze({
    contractVersion: QUALITY_DAYTRADE_EVIDENCE_ADMISSION_VERSION,
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
  });
}

export function createUsQualityDaytradeEvidenceLedger() {
  return createGlobalEvidenceLedger({ ledgerId: "US_QUALITY_DAYTRADE_GLOBAL_EVIDENCE_V1" });
}

export function admitUsQualityDaytradeEvidence({
  ledger,
  strategyIdentity,
  symbol,
  bundle,
  workflowFamily,
  artifactLineageDigest,
  horizon = "SESSION_END",
  outcomeKind = "PRE_ENTRY_OBSERVATION",
} = {}) {
  if (!bundle || bundle.status !== "READY" || !bundle.provenance?.observationDigest) {
    return blocked("READY_SOURCE_BACKED_LIVE_EVIDENCE_REQUIRED");
  }

  const observationIdentity = buildUsQualityDaytradeObservationIdentity({
    strategyIdentity,
    bundle,
    symbol,
  });
  const strategyIdentityDigest = researchDigest(observationIdentity.strategyIdentity);
  const sourceDatasetId = [
    "US_QUALITY_DAYTRADE",
    bundle.session,
    requiredString(bundle.provenance.quoteSourceId, "quoteSourceId"),
    requiredString(bundle.provenance.candleSourceId, "candleSourceId"),
    requiredString(bundle.provenance.relativeVolumeSourceId, "relativeVolumeSourceId"),
  ].join(":");

  const payload = freeze({
    localEvidenceId: observationIdentity.evidenceId,
    observationDigest: bundle.provenance.observationDigest,
    session: bundle.session,
    quote: freeze({ bid: bundle.quote.bid, ask: bundle.quote.ask, timestampMs: bundle.quote.timestampMs }),
    lastCompleteCandleTimestampMs: bundle.candleEvidence.lastCompleteCandleTimestampMs,
    relativeVolume: bundle.relativeVolume,
    relativeVolumeObservedAtMs: bundle.relativeVolumeObservedAtMs,
  });

  const admission = recordGlobalEvidence(ledger, {
    producerFamily: "US_QUALITY_DAYTRADE",
    strategyIdentityDigest,
    researchCodeSha: observationIdentity.strategyIdentity.researchCodeSha,
    market: "US_STOCK",
    symbol: observationIdentity.symbol,
    timeframe: `${bundle.candleEvidence.timeframeMs}ms`,
    side: "LONG",
    observationTimestamp: bundle.quote.timestampMs,
    horizon: requiredString(horizon, "horizon"),
    sourceDatasetId,
    provenanceDigest: bundle.provenance.observationDigest,
    outcomeKind: requiredString(outcomeKind, "outcomeKind"),
    workflowFamily: requiredString(workflowFamily, "workflowFamily"),
    artifactLineageDigest: requiredString(artifactLineageDigest, "artifactLineageDigest"),
    payload,
  });

  return freeze({
    contractVersion: QUALITY_DAYTRADE_EVIDENCE_ADMISSION_VERSION,
    status: admission.status,
    reason: admission.status,
    evidenceId: admission.evidenceId,
    localEvidenceId: observationIdentity.evidenceId,
    sampleCountDelta: admission.sampleCountDelta,
    canonicalSampleAccepted: admission.sampleCountDelta === 1,
    duplicateCountingAllowed: false,
    selectionEligible: false,
    executionAuthority: "NONE",
    liveTradingAllowed: false,
    privateApiAllowed: false,
    orderAuthority: false,
    conflict: admission.conflict,
    ledger: admission.ledger,
  });
}
