import { adoptExistingAuthoritativePaperRuntimeStageEvidenceV1 } from "./authoritative-paper-runtime-stage-evidence-caller-v1.js";

export const PAPER_FORWARD_STAGE_EVIDENCE_ADOPTION_VERSION =
  "paper-forward-stage-evidence-adoption-v1";

const MEANINGFUL_SEARCH_SOURCE_VERSION = "meaningful-search-scheduled-paper-provider-v1";

function freeze(value) {
  return Object.freeze(value);
}

function safeCandidateEnvelope(value) {
  return value?.executionAuthority === "NONE"
    && value?.simulatedOnly === true
    && value?.liveOrderAllowed === false
    && value?.privateTradingApiAllowed === false
    && value?.orderSubmitted === false
    && value?.exchangeRequestSent === false
    && value?.productionMutationAllowed === false;
}

function cloneRows(value) {
  return freeze(value.map((row) => freeze(structuredClone(row))));
}

function authoritativeRuntimeViewFromScheduledEvidence(evidence) {
  const source = evidence?.paperCandidateSource;
  const candidates = evidence?.candidates;
  const exits = evidence?.exits;
  const measurements = source?.stageMeasurements;

  if (evidence?.status !== "READY"
    || source?.schemaVersion !== MEANINGFUL_SEARCH_SOURCE_VERSION
    || source?.status !== "PAPER_CANDIDATES_READY"
    || !Array.isArray(candidates)
    || !Array.isArray(exits)
    || !Array.isArray(measurements)
    || candidates.some((candidate) => !safeCandidateEnvelope(candidate))) {
    return null;
  }

  return freeze({
    status: source.status,
    paperBridge: freeze({
      candidates: cloneRows(candidates),
      exitSignals: cloneRows(exits),
    }),
    stageMeasurements: cloneRows(measurements),
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

export function adoptPaperForwardStageEvidenceV1({
  scheduledEvidence,
  recurringCycleResult,
} = {}) {
  const paperRuntimeResult = authoritativeRuntimeViewFromScheduledEvidence(scheduledEvidence);
  if (paperRuntimeResult === null) return null;

  return adoptExistingAuthoritativePaperRuntimeStageEvidenceV1({
    paperRuntimeResult,
    recurringCycleResult,
    runtimeIdentityMode: "SCHEDULE_PROCESS",
  });
}
