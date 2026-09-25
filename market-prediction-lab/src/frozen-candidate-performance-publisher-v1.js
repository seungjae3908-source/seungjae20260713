import { mkdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { verifyPhase4FrozenChallengerV1 } from "./phase4-frozen-challenger-core-v1.js";
import {
  blockedFrozenCandidatePerformanceV1,
  readFrozenCandidatePerformanceV1,
} from "./frozen-candidate-performance-reader-v1.js";

export const FROZEN_CANDIDATE_PERFORMANCE_SOURCE_VERSION =
  "phase4-existing-owner-candidate-performance-source-v1";
export const FROZEN_CANDIDATE_PERFORMANCE_PUBLISHER_VERSION =
  "frozen-candidate-performance-publisher-v1";
export const FROZEN_CANDIDATE_PERFORMANCE_RELATIVE_PATH =
  "status/candidate-performance.json";

const OWNER_CONTRACT = "phase4-existing-owner-runtime-caller-v1";
const SHA40 = /^[0-9a-f]{40}$/iu;
const DIGEST64 = /^[0-9a-f]{64}$/iu;
const FORBIDDEN_PROVENANCE = /(?:^|[^a-z])(fixture|fake|example|tests?)(?:[^a-z]|$)/iu;
const FORBIDDEN_EVIDENCE_KEY = /(?:secret|token|password|credential|private.?key|api.?key)/iu;
const ABSOLUTE_PATH = /^(?:[a-z]:[\\/]|\/)/iu;

function record(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function unsafeOwnerEvidence(value, key = "") {
  if (value == null) return false;
  if (FORBIDDEN_EVIDENCE_KEY.test(key)) return true;
  if (typeof value === "string") {
    return (/path/iu.test(key) && ABSOLUTE_PATH.test(value))
      || (/(?:provenance|sourceOwner)/iu.test(key) && FORBIDDEN_PROVENANCE.test(value));
  }
  if (Array.isArray(value)) return value.some((item) => unsafeOwnerEvidence(item, key));
  return record(value)
    ? Object.entries(value).some(([childKey, child]) => unsafeOwnerEvidence(child, childKey))
    : false;
}

function provenance() {
  return deepFreeze({
    evidenceClass: "PRODUCTION_AUTHORITATIVE",
    sourceOwner: OWNER_CONTRACT,
    fixture: false,
    synthetic: false,
    replay: false,
    backfill: false,
    manual: false,
  });
}

function safetyValid(value) {
  return value?.runtimeActivationAllowed === false
    && value?.schedulerActivationAllowed === false
    && value?.dispatchAllowed === false
    && value?.economicCreditCreated === false
    && value?.sampleCredit === 0
    && value?.executionRealismCredit === 0
    && value?.profitabilityCredit === 0
    && value?.FULL_COST_READY === false
    && value?.NET_ALPHA_PROVEN === false
    && value?.PROFITABILITY_PROVEN === false
    && value?.executionAuthority === "NONE"
    && value?.LIVE_TRADING === false
    && value?.AUTO_TRADING === false
    && value?.REAL_ORDER_ENABLED === false
    && value?.PRIVATE_TRADING_API_ALLOWED === false
    && value?.realOrderCount === 0;
}

function validateOwnerResult(value) {
  const owner = record(value);
  if (!owner
    || owner.contract !== OWNER_CONTRACT
    || owner.status !== "PHASE4_EXISTING_OWNER_RUNTIME_CALLER_READY_NON_ACTIVATING"
    || owner.testOnly === true
    || owner.ownerPreflightOnly !== true
    || unsafeOwnerEvidence(owner)
    || !safetyValid(owner)) {
    throw new Error("PHASE4_EXISTING_OWNER_PERFORMANCE_SOURCE_INVALID");
  }
  const challenger = record(owner.phase4Result?.challenger);
  if (verifyPhase4FrozenChallengerV1(challenger)?.valid !== true) {
    throw new Error("PHASE4_EXISTING_OWNER_FROZEN_CANDIDATE_INVALID");
  }
  const binding = record(owner.routed?.binding?.candidateStrategyIdentity);
  const paperCandidate = record(owner.consumer?.paper?.candidate);
  if (!binding || !paperCandidate) {
    throw new Error("PHASE4_EXISTING_OWNER_PAPER_BINDING_MISSING");
  }
  return { owner, challenger, binding, paperCandidate };
}

function valueAt(candidate, key) {
  const paperIdentity = record(candidate?.paperIdentity);
  const signal = record(candidate?.signal);
  const strategyIdentity = record(signal?.strategyIdentity);
  if (key === "provider") {
    return paperIdentity?.provider
      ?? candidate?.execution?.dataEvidence?.provider
      ?? candidate?.entryEvidenceProvenance?.provider
      ?? null;
  }
  if (key === "sidePolicy") return paperIdentity?.direction ?? signal?.signalDirection ?? signal?.direction ?? null;
  return paperIdentity?.[key] ?? signal?.[key] ?? strategyIdentity?.[key] ?? null;
}

function assertEqual(actual, expected, field) {
  const left = field === "researchCodeSha" ? actual?.toLowerCase?.() : actual;
  const right = field === "researchCodeSha" ? expected?.toLowerCase?.() : expected;
  if (!nonEmpty(String(left ?? "")) || left !== right) {
    throw new Error(`CANDIDATE_PERFORMANCE_OWNER_${field}_MISMATCH`);
  }
}

function frozenCandidateFromOwner(ownerParts, stageIdentity) {
  const identity = record(stageIdentity);
  if (!identity) throw new Error("CANDIDATE_PERFORMANCE_STAGE_IDENTITY_MISSING");
  const { challenger, binding, paperCandidate } = ownerParts;
  for (const field of ["candidateId", "strategyFamily", "strategyVersion", "accountMode"]) {
    assertEqual(identity[field], challenger[field], field);
    assertEqual(identity[field], binding[field], field);
  }
  assertEqual(identity.parameterHash, challenger.parameterDigest, "parameterHash");
  assertEqual(identity.parameterDigest, challenger.parameterDigest, "parameterDigest");
  assertEqual(identity.parameterHash, binding.parameterHash, "parameterHash");
  assertEqual(identity.parameterDigest, binding.parameterDigest, "parameterDigest");
  for (const field of ["strategyId", "researchCodeSha", "costPolicyVersion", "executionPolicyVersion"]) {
    assertEqual(identity[field], binding[field], field);
  }
  for (const field of ["market", "symbol", "timeframe", "sidePolicy"]) {
    assertEqual(identity[field], challenger[field], field);
    assertEqual(identity[field], valueAt(paperCandidate, field), field);
  }
  assertEqual(identity.provider, valueAt(paperCandidate, "provider"), "provider");
  if (!SHA40.test(identity.researchCodeSha) || !DIGEST64.test(identity.parameterHash)
    || identity.parameterHash !== identity.parameterDigest) {
    throw new Error("CANDIDATE_PERFORMANCE_OWNER_IDENTITY_INVALID");
  }
  return deepFreeze({
    identity: structuredClone(identity),
    freezeTimestamp: challenger.freezeTimestamp,
    freezeTimestampMs: challenger.freezeTimestampMs,
    prospectiveOnly: true,
    retroactiveCreditAllowed: false,
    provenance: provenance(),
  });
}

export function createFrozenCandidatePerformanceSourceV1({
  existingOwnerRuntimeResult,
  candidateMatchEvidence = null,
  fullCostEvidence = null,
  effectiveIndependentMarketN = null,
} = {}) {
  const ownerParts = validateOwnerResult(existingOwnerRuntimeResult);
  return deepFreeze({
    schemaVersion: FROZEN_CANDIDATE_PERFORMANCE_SOURCE_VERSION,
    sourceOwner: OWNER_CONTRACT,
    ownerResult: existingOwnerRuntimeResult,
    candidateMatchEvidence: candidateMatchEvidence == null ? null : structuredClone(candidateMatchEvidence),
    fullCostEvidence: fullCostEvidence == null ? null : structuredClone(fullCostEvidence),
    effectiveIndependentMarketN: Number.isInteger(effectiveIndependentMarketN)
      && effectiveIndependentMarketN >= 0
      ? effectiveIndependentMarketN
      : null,
    candidateId: ownerParts.challenger.candidateId,
    provenance: provenance(),
  });
}

function validateSource(value) {
  const source = record(value);
  if (!source
    || source.schemaVersion !== FROZEN_CANDIDATE_PERFORMANCE_SOURCE_VERSION
    || source.sourceOwner !== OWNER_CONTRACT
    || source.provenance?.evidenceClass !== "PRODUCTION_AUTHORITATIVE"
    || source.provenance?.fixture !== false
    || source.provenance?.synthetic !== false
    || source.provenance?.replay !== false
    || source.provenance?.backfill !== false
    || source.provenance?.manual !== false
    || FORBIDDEN_PROVENANCE.test(String(source.provenance?.sourceOwner ?? ""))) {
    throw new Error("PHASE4_EXISTING_OWNER_PERFORMANCE_SOURCE_INVALID");
  }
  const ownerParts = validateOwnerResult(source.ownerResult);
  if (source.candidateId !== ownerParts.challenger.candidateId) {
    throw new Error("PHASE4_EXISTING_OWNER_PERFORMANCE_SOURCE_CANDIDATE_MISMATCH");
  }
  return { source, ownerParts };
}

async function atomicPublish(rootDirectory, artifact) {
  if (!nonEmpty(rootDirectory) || !isAbsolute(rootDirectory)) {
    throw new TypeError("candidate performance rootDirectory must be absolute");
  }
  const root = resolve(rootDirectory);
  const directory = join(root, "status");
  const target = join(directory, "candidate-performance.json");
  const expected = join(root, ...FROZEN_CANDIDATE_PERFORMANCE_RELATIVE_PATH.split("/"));
  if (target !== expected) throw new Error("CANDIDATE_PERFORMANCE_TARGET_PATH_INVALID");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

export async function publishFrozenCandidatePerformanceV1({
  rootDirectory,
  source = null,
  reconciledStageEvidence = null,
  recurringState = null,
} = {}) {
  let artifact;
  if (source == null) {
    artifact = blockedFrozenCandidatePerformanceV1(
      "PHASE4_EXISTING_OWNER_PERFORMANCE_SOURCE_MISSING",
    );
  } else {
    try {
      const validated = validateSource(source);
      const frozenCandidate = frozenCandidateFromOwner(
        validated.ownerParts,
        reconciledStageEvidence?.candidateIdentity,
      );
      artifact = readFrozenCandidatePerformanceV1({
        frozenCandidate,
        reconciledStageEvidence,
        recurringState,
        candidateMatchEvidence: validated.source.candidateMatchEvidence,
        effectiveIndependentMarketN: validated.source.effectiveIndependentMarketN,
        fullCostEvidence: validated.source.fullCostEvidence,
      });
    } catch (error) {
      artifact = blockedFrozenCandidatePerformanceV1(
        nonEmpty(error?.message) ? error.message : "CANDIDATE_PERFORMANCE_PUBLICATION_BLOCKED",
      );
    }
  }
  await atomicPublish(rootDirectory, artifact);
  return deepFreeze({
    schemaVersion: FROZEN_CANDIDATE_PERFORMANCE_PUBLISHER_VERSION,
    status: "PUBLISHED",
    evidenceStatus: artifact.status,
    artifactRelativePath: FROZEN_CANDIDATE_PERFORMANCE_RELATIVE_PATH,
    FIRST_ZERO: artifact.FIRST_ZERO,
    candidateId: artifact.candidateId,
    identity14Verified: artifact.identity14Verified === true,
    executionAuthority: "NONE",
  });
}
