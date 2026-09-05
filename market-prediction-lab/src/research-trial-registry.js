import { createHash } from "node:crypto";

export const TRIAL_REGISTRY_SCHEMA_VERSION = 2;
export const FORWARD_ONLY_STAGES = Object.freeze(new Set(["final_holdout", "shadow", "paper"]));
const ALLOWED_STAGES = Object.freeze(new Set([
  "development",
  "validation",
  "oos",
  "walk_forward",
  "final_holdout",
  "shadow",
  "paper",
]));

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function researchDigest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function immutableString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} is required`);
  return value;
}

function finiteSeries(values, name) {
  if (!Array.isArray(values) || values.length < 2 || values.some((value) => !Number.isFinite(value))) {
    throw new TypeError(`${name} must contain at least two finite observations`);
  }
  return Object.freeze([...values]);
}

export function buildStrategyIdentity(identity) {
  const normalized = Object.freeze({
    strategyId: immutableString(identity?.strategyId, "strategyId"),
    strategyVersion: immutableString(identity?.strategyVersion, "strategyVersion"),
    researchCodeSha: immutableString(identity?.researchCodeSha, "researchCodeSha"),
    datasetSnapshotHash: immutableString(identity?.datasetSnapshotHash, "datasetSnapshotHash"),
    market: immutableString(identity?.market, "market"),
    timeframe: immutableString(identity?.timeframe, "timeframe"),
    direction: immutableString(identity?.direction, "direction"),
  });
  return Object.freeze({ ...normalized, familyFingerprint: researchDigest(normalized) });
}

export function buildSelectedStrategyFingerprint(registry, trial) {
  if (!registry || registry.schemaVersion !== TRIAL_REGISTRY_SCHEMA_VERSION) throw new TypeError("valid trial registry is required");
  if (!trial || typeof trial !== "object") throw new TypeError("selected trial is required");
  return researchDigest({
    familyFingerprint: registry.strategyIdentity.familyFingerprint,
    candidateId: immutableString(trial.candidateId, "candidateId"),
    parameterHash: immutableString(trial.parameterHash, "parameterHash"),
  });
}

export function createResearchTrialRegistry({ experimentId, identity }) {
  const strategyIdentity = buildStrategyIdentity(identity);
  return Object.freeze({
    schemaVersion: TRIAL_REGISTRY_SCHEMA_VERSION,
    experimentId: immutableString(experimentId, "experimentId"),
    strategyIdentity,
    trials: Object.freeze([]),
    registryDigest: researchDigest({ experimentId, strategyIdentity, trials: [] }),
    safety: Object.freeze({
      forwardEvidenceCanSelectCandidate: false,
      historicalBackfillAllowed: false,
      liveAuthority: false,
      orderAuthority: false,
    }),
  });
}

export function appendResearchTrial(registry, trial) {
  if (!registry || registry.schemaVersion !== TRIAL_REGISTRY_SCHEMA_VERSION) throw new TypeError("valid trial registry is required");
  const trialId = immutableString(trial?.trialId, "trialId");
  if (registry.trials.some((row) => row.trialId === trialId)) throw new Error(`duplicate trialId: ${trialId}`);
  const stage = immutableString(trial?.stage, "stage");
  if (!ALLOWED_STAGES.has(stage)) throw new RangeError(`unsupported research stage: ${stage}`);
  const selectionEligible = trial.selectionEligible === true;
  if (selectionEligible && FORWARD_ONLY_STAGES.has(stage)) {
    throw new Error(`${stage} evidence cannot be used for candidate selection`);
  }
  const candidateId = immutableString(trial?.candidateId, "candidateId");
  const parameterHash = immutableString(trial?.parameterHash, "trial.parameterHash");
  const returnSeries = finiteSeries(trial.returnSeries, "returnSeries");
  const recorded = Object.freeze({
    trialId,
    candidateId,
    stage,
    selectionEligible,
    parameterHash,
    startedAt: Number.isInteger(trial?.startedAt) ? trial.startedAt : null,
    completedAt: Number.isInteger(trial?.completedAt) ? trial.completedAt : null,
    returnSeries,
    metrics: Object.freeze({ ...(trial.metrics ?? {}) }),
    trialDigest: researchDigest({
      trialId,
      candidateId,
      stage,
      selectionEligible,
      parameterHash,
      returnSeries,
      metrics: trial.metrics ?? {},
    }),
  });
  const trials = Object.freeze([...registry.trials, recorded]);
  return Object.freeze({
    ...registry,
    trials,
    registryDigest: researchDigest({ experimentId: registry.experimentId, strategyIdentity: registry.strategyIdentity, trials }),
  });
}

export function selectionTrials(registry) {
  if (!registry || registry.schemaVersion !== TRIAL_REGISTRY_SCHEMA_VERSION) throw new TypeError("valid trial registry is required");
  const rows = registry.trials.filter((trial) => trial.selectionEligible);
  if (rows.some((trial) => FORWARD_ONLY_STAGES.has(trial.stage))) throw new Error("forward evidence contamination detected");
  return Object.freeze(rows);
}

export function summarizeTrialRegistry(registry) {
  const selectable = selectionTrials(registry);
  return Object.freeze({
    experimentId: registry.experimentId,
    strategyFamilyFingerprint: registry.strategyIdentity.familyFingerprint,
    totalTrials: registry.trials.length,
    selectionTrials: selectable.length,
    stages: Object.freeze(Object.fromEntries([...ALLOWED_STAGES].map((stage) => [
      stage,
      registry.trials.filter((trial) => trial.stage === stage).length,
    ]))),
    registryDigest: registry.registryDigest,
    selectionContamination: false,
  });
}
