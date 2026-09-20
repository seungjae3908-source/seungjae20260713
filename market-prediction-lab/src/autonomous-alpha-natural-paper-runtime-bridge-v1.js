import crypto from "node:crypto";

import {
  buildAutonomousAlphaArchitectureReadinessV1,
} from "./autonomous-alpha-certification-v1.js";

export const AUTONOMOUS_ALPHA_NATURAL_PAPER_RUNTIME_BRIDGE_V1 =
  "autonomous-alpha-natural-paper-runtime-bridge-v1";

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sha40(value) {
  const normalized = text(value)?.toLowerCase() ?? null;
  return normalized && /^[0-9a-f]{40}$/u.test(normalized) ? normalized : null;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  );
}

function digest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function safety() {
  return {
    paperOnly: true,
    observerOnly: true,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    privateRequestCount: 0,
    realOrderCount: 0,
    financialMutationAllowed: false,
    executionAuthority: "NONE",
    automaticPromotionAllowed: false,
    automaticChampionSwapAllowed: false,
  };
}

function validPaperSnapshot(snapshot) {
  return snapshot?.schemaVersion === "paper-forward-schedule-snapshot-v1"
    && snapshot?.scheduleActive === true
    && snapshot?.liveTrading === false
    && snapshot?.orderAuthority === false
    && snapshot?.privateRequestCount === 0
    && snapshot?.financialMutationCount === 0
    && (snapshot?.memberAutoTradingHandoff == null
      || snapshot.memberAutoTradingHandoff.executionAuthority === "NONE");
}

function validHandoffEnvelope(handoff, researchCodeSha) {
  return handoff?.schemaVersion === "autonomous-alpha-runtime-handoff-v1"
    && handoff?.sourceSha === researchCodeSha
    && handoff?.executionAuthority === "NONE"
    && handoff?.liveTrading === false
    && handoff?.autoTrading === false
    && handoff?.realOrderEnabled === false
    && handoff?.privateTradingApiAllowed === false
    && handoff?.worldKnowledge
    && handoff?.alphaGenome
    && handoff?.redTeam
    && handoff?.forecast
    && handoff?.counterfactual
    && handoff?.digitalTwin
    && handoff?.championChallenger
    && handoff?.certification;
}

export function buildAutonomousAlphaNaturalPaperObservationV1({
  paperSnapshot,
  alphaHandoff = null,
  researchCodeSha,
  observedAtMs = Date.now(),
} = {}) {
  const blockers = [];
  const sourceSha = sha40(researchCodeSha);
  if (!sourceSha) blockers.push("ALPHA_OBSERVER_RESEARCH_SHA_INVALID");
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs <= 0) {
    blockers.push("ALPHA_OBSERVER_TIME_INVALID");
  }
  if (!validPaperSnapshot(paperSnapshot)) {
    blockers.push("ALPHA_OBSERVER_PAPER_SNAPSHOT_INVALID");
  }

  if (blockers.length > 0) {
    return deepFreeze({
      schemaVersion: AUTONOMOUS_ALPHA_NATURAL_PAPER_RUNTIME_BRIDGE_V1,
      artifactType: "AUTONOMOUS_ALPHA_NATURAL_PAPER_OBSERVATION",
      status: "BLOCKED_DATA",
      blockers: [...new Set(blockers)].sort(),
      researchCodeSha: sourceSha,
      alphaHandoffPresent: alphaHandoff != null,
      architectureReadiness: null,
      naturalPaper: null,
      profitabilityProven: false,
      ...safety(),
    });
  }

  const naturalPaper = {
    scheduleActive: true,
    stateCycleCount: Number.isInteger(paperSnapshot.stateCycleCount)
      ? paperSnapshot.stateCycleCount : 0,
    positionCount: Number.isInteger(paperSnapshot.positionCount)
      ? paperSnapshot.positionCount : 0,
    settlementCount: Number.isInteger(paperSnapshot.settlementCount)
      ? paperSnapshot.settlementCount : 0,
    lastInvocationStatus: paperSnapshot.lastInvocation?.status ?? null,
    memberAutoTradingHandoffStatus:
      paperSnapshot.memberAutoTradingHandoff?.status ?? null,
    privateRequestCount: 0,
    financialMutationCount: 0,
    liveTrading: false,
    orderAuthority: false,
  };

  if (alphaHandoff == null) {
    const core = {
      researchCodeSha: sourceSha,
      observedAtMs,
      naturalPaper,
      alphaHandoffPresent: false,
    };
    return deepFreeze({
      schemaVersion: AUTONOMOUS_ALPHA_NATURAL_PAPER_RUNTIME_BRIDGE_V1,
      artifactType: "AUTONOMOUS_ALPHA_NATURAL_PAPER_OBSERVATION",
      status: "WAITING_FOR_ALPHA_HANDOFF",
      blockers: ["ALPHA_HANDOFF_MISSING"],
      researchCodeSha: sourceSha,
      observedAtMs,
      alphaHandoffPresent: false,
      architectureReadiness: null,
      naturalPaper,
      observationDigest: digest(core),
      profitabilityProven: false,
      nextAction: "CONTINUE_PAPER_ONLY_AND_WAIT_FOR_VALID_ALPHA_HANDOFF",
      ...safety(),
    });
  }

  if (!validHandoffEnvelope(alphaHandoff, sourceSha)) {
    return deepFreeze({
      schemaVersion: AUTONOMOUS_ALPHA_NATURAL_PAPER_RUNTIME_BRIDGE_V1,
      artifactType: "AUTONOMOUS_ALPHA_NATURAL_PAPER_OBSERVATION",
      status: "BLOCKED_DATA",
      blockers: ["ALPHA_HANDOFF_INVALID_OR_UNSAFE"],
      researchCodeSha: sourceSha,
      observedAtMs,
      alphaHandoffPresent: true,
      architectureReadiness: null,
      naturalPaper,
      profitabilityProven: false,
      ...safety(),
    });
  }

  const architectureReadiness = buildAutonomousAlphaArchitectureReadinessV1({
    worldKnowledge: alphaHandoff.worldKnowledge,
    alphaGenome: alphaHandoff.alphaGenome,
    redTeam: alphaHandoff.redTeam,
    forecast: alphaHandoff.forecast,
    counterfactual: alphaHandoff.counterfactual,
    digitalTwin: alphaHandoff.digitalTwin,
    championChallenger: alphaHandoff.championChallenger,
    certification: alphaHandoff.certification,
  });

  const ready = architectureReadiness.architectureReady === true
    && architectureReadiness.executionAuthority === "NONE"
    && architectureReadiness.liveTradingAllowed === false
    && architectureReadiness.autoTradingAllowed === false
    && architectureReadiness.realOrderAllowed === false;

  const core = {
    researchCodeSha: sourceSha,
    observedAtMs,
    naturalPaper,
    alphaHandoffDigest: text(alphaHandoff.handoffDigest),
    readinessDigest: architectureReadiness.readinessDigest ?? null,
  };

  return deepFreeze({
    schemaVersion: AUTONOMOUS_ALPHA_NATURAL_PAPER_RUNTIME_BRIDGE_V1,
    artifactType: "AUTONOMOUS_ALPHA_NATURAL_PAPER_OBSERVATION",
    status: ready
      ? "ALPHA_OBSERVING_NATURAL_PAPER"
      : "ALPHA_HANDOFF_REJECTED_BY_LINEAGE_FIREWALL",
    blockers: ready ? [] : architectureReadiness.blockers,
    researchCodeSha: sourceSha,
    observedAtMs,
    alphaHandoffPresent: true,
    alphaHandoffDigest: text(alphaHandoff.handoffDigest),
    architectureReadiness,
    naturalPaper,
    observationDigest: digest(core),
    profitabilityProven: ready && architectureReadiness.profitabilityProven === true,
    nextAction: ready
      ? "CONTINUE_GENUINE_NATURAL_PAPER_EVIDENCE"
      : "REPAIR_ALPHA_LINEAGE_BEFORE_PROMOTION",
    ...safety(),
  });
}
