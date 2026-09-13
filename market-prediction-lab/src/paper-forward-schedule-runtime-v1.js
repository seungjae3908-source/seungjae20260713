import {
  PAPER_FORWARD_SCHEDULE_ACTIVATION_CONTRACT,
  PAPER_FORWARD_SCHEDULE_CADENCE,
  __paperForwardScheduleTestables,
  readPaperForwardScheduleSnapshot,
  runPaperForwardScheduledInvocation as runBasePaperForwardScheduledInvocation,
} from "./paper-forward-schedule-runtime-base-v1.js";
import { adoptExistingAuthoritativePaperRuntimeStageEvidenceV1 } from "./authoritative-paper-runtime-stage-evidence-caller-v1.js";

export {
  PAPER_FORWARD_SCHEDULE_ACTIVATION_CONTRACT,
  PAPER_FORWARD_SCHEDULE_CADENCE,
  __paperForwardScheduleTestables,
  readPaperForwardScheduleSnapshot,
};

export const AUTHORITATIVE_PAPER_SCHEDULE_STAGE_ADOPTION_VERSION =
  "authoritative-paper-schedule-stage-adoption-v1";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeRuntimeInputFromEvidence(evidence) {
  const source = evidence?.paperCandidateSource;
  if (!Array.isArray(source?.stageMeasurements)) return null;
  return Object.freeze({
    schemaVersion: "authoritative-paper-schedule-runtime-stage-input-v1",
    executionAuthority: "NONE",
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
    profitabilityClaimAllowed: false,
    stageMeasurements: source.stageMeasurements,
    paperBridge: Object.freeze({
      candidates: Array.isArray(evidence?.candidates) ? evidence.candidates : Object.freeze([]),
    }),
  });
}

function blockedConnection(blocker) {
  return Object.freeze({
    schemaVersion: AUTHORITATIVE_PAPER_SCHEDULE_STAGE_ADOPTION_VERSION,
    status: "BLOCKED",
    blocker,
    sampleCredit: 0,
    executionRealismCredit: 0,
    profitabilityCredit: 0,
    fullCostReady: false,
    profitabilityProven: false,
    executionAuthority: "NONE",
    runtimeActivationAllowed: false,
    scheduleActivationAllowed: false,
    dispatchAllowed: false,
  });
}

function wrapProvider(provider, capture) {
  if (!provider || typeof provider.collectPublicEvidence !== "function") return provider;
  return Object.freeze({
    async collectPublicEvidence(input) {
      const evidence = await provider.collectPublicEvidence(input);
      if (input?.market === "CRYPTO_FUTURES") capture(evidence);
      return evidence;
    },
  });
}

function withAdoptionEvidence(result, adoption) {
  const connection = adoption?.stageEvidenceConnection ?? null;
  const reconciled = connection?.status === "RECONCILED";
  const stageMeasurements = reconciled && Array.isArray(adoption?.stageMeasurements)
    ? adoption.stageMeasurements
    : null;
  const summary = isRecord(result?.summary)
    ? Object.freeze({
      ...result.summary,
      authoritativeRuntimeStageEvidenceConnection: connection,
      authoritativeRuntimeStageMeasurements: stageMeasurements,
    })
    : result?.summary;
  return Object.freeze({
    ...result,
    summary,
    authoritativeRuntimeStageEvidenceConnection: connection,
    authoritativeRuntimeStageMeasurements: stageMeasurements,
  });
}

export async function runPaperForwardScheduledInvocationWithAuthoritativeStageEvidenceV1({
  input = {},
  runBase = runBasePaperForwardScheduledInvocation,
} = {}) {
  if (!isRecord(input)) throw new TypeError("Paper Forward schedule input must be an object");
  if (typeof runBase !== "function") throw new TypeError("Paper Forward base schedule runtime must be a function");

  const provider = input.publicEvidenceProvider;
  if (provider == null) return runBase(input);
  if (typeof provider.collectPublicEvidence !== "function") {
    throw new TypeError("Paper Forward public evidence provider is invalid");
  }

  let futuresEvidenceObserved = false;
  const captured = [];
  const wrappedProvider = wrapProvider(provider, (evidence) => {
    futuresEvidenceObserved = true;
    const runtimeInput = safeRuntimeInputFromEvidence(evidence);
    if (runtimeInput != null) captured.push(runtimeInput);
  });
  const result = await runBase({ ...input, publicEvidenceProvider: wrappedProvider });

  let adoption;
  if (!futuresEvidenceObserved) {
    adoption = Object.freeze({
      stageEvidenceConnection: blockedConnection("PAPER_SCHEDULE_CRYPTO_FUTURES_EVIDENCE_NOT_OBSERVED"),
    });
  } else if (captured.length === 0) {
    adoption = Object.freeze({
      stageEvidenceConnection: blockedConnection("PAPER_SCHEDULE_AUTHORITATIVE_STAGE_EVIDENCE_MISSING"),
    });
  } else if (captured.length !== 1) {
    adoption = Object.freeze({
      stageEvidenceConnection: blockedConnection("PAPER_SCHEDULE_AUTHORITATIVE_STAGE_EVIDENCE_AMBIGUOUS"),
    });
  } else {
    adoption = adoptExistingAuthoritativePaperRuntimeStageEvidenceV1({
      paperRuntimeResult: captured[0],
      recurringCycleResult: Object.freeze({
        state: result?.state,
        summary: result?.summary,
      }),
    });
  }

  return withAdoptionEvidence(result, adoption);
}

export async function runPaperForwardScheduledInvocation(input = {}) {
  return runPaperForwardScheduledInvocationWithAuthoritativeStageEvidenceV1({
    input,
    runBase: runBasePaperForwardScheduledInvocation,
  });
}
