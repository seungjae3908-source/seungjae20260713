import { createHash } from 'node:crypto';

import {
  buildFailureResearchRestartV1,
} from '../../market-prediction-lab/src/autonomous-alpha-factory-phase3-v1.js';

export const RESEARCH_FAILURE_MEMORY_CONTRACT_V1 = 'research-failure-memory/v1';

const SHA40 = /^[0-9a-f]{40}$/i;
const HASH64 = /^[0-9a-f]{64}$/i;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function exactSha(value) {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!SHA40.test(sha)) throw new TypeError('researchSha must be exact SHA');
  return sha;
}

function memoryCore(memory) {
  return {
    schemaVersion: 1,
    contract: RESEARCH_FAILURE_MEMORY_CONTRACT_V1,
    createdByResearchSha: memory.createdByResearchSha,
    observations: memory.observations,
    safety: memory.safety,
  };
}

function normalizeFailureObservation(observation) {
  const restart = buildFailureResearchRestartV1(observation);
  if (observation.executionAuthority !== 'NONE'
    || observation.sameStrategyMutationAllowed !== false
    || observation.sameParameterMutationAllowed !== false
    || observation.newHypothesisRequired !== true
    || observation.newFormulaCandidateRequired !== true
    || observation.newStrategyIdentityRequired !== true
    || observation.tournamentRestartRequired !== true
    || observation.priorEvidenceInheritanceAllowed !== false
    || restart.sameStrategyMutationAllowed !== false
    || restart.priorPerformanceInheritanceAllowed !== false
    || restart.priorSampleCreditInheritanceAllowed !== false
    || restart.executionAuthority !== 'NONE') {
    throw new Error('RESEARCH_FAILURE_AUTHORITY_OR_RESTART_CONTRACT_INVALID');
  }
  if (!HASH64.test(observation.strategyIdentityDigest ?? '')
    || !HASH64.test(observation.failureObservationDigest ?? '')
    || !HASH64.test(observation.evidenceDigest ?? '')) {
    throw new Error('RESEARCH_FAILURE_DIGEST_INVALID');
  }
  return deepFreeze({
    failureObservation: deepFreeze({ ...observation, failureCodes: Object.freeze([...observation.failureCodes]) }),
    restart,
  });
}

export function createResearchFailureMemoryV1({ researchSha } = {}) {
  const core = {
    schemaVersion: 1,
    contract: RESEARCH_FAILURE_MEMORY_CONTRACT_V1,
    createdByResearchSha: exactSha(researchSha),
    observations: Object.freeze([]),
    safety: deepFreeze({
      evidenceOnly: true,
      automaticSameStrategyRetryAllowed: false,
      automaticParameterMutationAllowed: false,
      priorPerformanceInheritanceAllowed: false,
      priorSampleCreditInheritanceAllowed: false,
      liveTrading: false,
      autoTrading: false,
      realOrder: false,
      privateTradingApi: false,
      executionAuthority: 'NONE',
    }),
  };
  return deepFreeze({ ...core, memoryDigest: digest(core) });
}

export function assertResearchFailureMemoryV1(memory) {
  if (!memory || memory.contract !== RESEARCH_FAILURE_MEMORY_CONTRACT_V1
    || memory.schemaVersion !== 1
    || !SHA40.test(memory.createdByResearchSha ?? '')
    || !Array.isArray(memory.observations)
    || !HASH64.test(memory.memoryDigest ?? '')) {
    throw new TypeError('valid Research Failure Memory is required');
  }
  if (memory.safety?.evidenceOnly !== true
    || memory.safety?.automaticSameStrategyRetryAllowed !== false
    || memory.safety?.automaticParameterMutationAllowed !== false
    || memory.safety?.priorPerformanceInheritanceAllowed !== false
    || memory.safety?.priorSampleCreditInheritanceAllowed !== false
    || memory.safety?.liveTrading !== false
    || memory.safety?.autoTrading !== false
    || memory.safety?.realOrder !== false
    || memory.safety?.privateTradingApi !== false
    || memory.safety?.executionAuthority !== 'NONE') {
    throw new Error('RESEARCH_FAILURE_MEMORY_SAFETY_INVALID');
  }

  const seen = new Set();
  for (const entry of memory.observations) {
    if (!entry || typeof entry !== 'object' || !entry.failureObservation || !entry.restart) {
      throw new Error('RESEARCH_FAILURE_MEMORY_ENTRY_INVALID');
    }
    const normalized = normalizeFailureObservation(entry.failureObservation);
    if (digest(normalized.restart) !== digest(entry.restart)) {
      throw new Error('RESEARCH_FAILURE_RESTART_MISMATCH');
    }
    const id = entry.failureObservation.failureObservationDigest;
    if (seen.has(id)) throw new Error('RESEARCH_FAILURE_MEMORY_DUPLICATE');
    seen.add(id);
  }
  if (digest(memoryCore(memory)) !== memory.memoryDigest) {
    throw new Error('RESEARCH_FAILURE_MEMORY_DIGEST_MISMATCH');
  }
  return memory;
}

export function appendResearchFailureObservationV1(memory, observation) {
  assertResearchFailureMemoryV1(memory);
  const normalized = normalizeFailureObservation(observation);
  const id = normalized.failureObservation.failureObservationDigest;
  const existing = memory.observations.find((entry) => entry.failureObservation.failureObservationDigest === id);
  if (existing) return memory;

  const observations = Object.freeze([...memory.observations, normalized]);
  const core = {
    ...memoryCore(memory),
    observations,
  };
  return deepFreeze({ ...core, memoryDigest: digest(core) });
}

export function buildResearchFailureDecisionV1(memory, { strategyIdentityDigest } = {}) {
  assertResearchFailureMemoryV1(memory);
  const identity = String(strategyIdentityDigest ?? '').toLowerCase();
  if (!HASH64.test(identity)) throw new TypeError('strategyIdentityDigest must be SHA-256 hex');
  const matches = memory.observations.filter((entry) => entry.failureObservation.strategyIdentityDigest === identity);
  if (matches.length === 0) {
    return deepFreeze({
      status: 'NO_KNOWN_FAILURE',
      strategyIdentityDigest: identity,
      failureCount: 0,
      automaticSameStrategyRetryAllowed: true,
      newHypothesisRequired: false,
      newFormulaCandidateRequired: false,
      newStrategyIdentityRequired: false,
      tournamentRestartRequired: false,
      priorPerformanceInheritanceAllowed: false,
      priorSampleCreditInheritanceAllowed: false,
      executionAuthority: 'NONE',
    });
  }
  return deepFreeze({
    status: 'AUTOMATIC_SAME_IDENTITY_RETRY_BLOCKED',
    strategyIdentityDigest: identity,
    failureCount: matches.length,
    latestFailureDigest: matches.at(-1).failureObservation.failureObservationDigest,
    latestStage: matches.at(-1).failureObservation.stage,
    latestStatus: matches.at(-1).failureObservation.status,
    automaticSameStrategyRetryAllowed: false,
    newHypothesisRequired: true,
    newFormulaCandidateRequired: true,
    newStrategyIdentityRequired: true,
    tournamentRestartRequired: true,
    priorPerformanceInheritanceAllowed: false,
    priorSampleCreditInheritanceAllowed: false,
    executionAuthority: 'NONE',
  });
}

export function summarizeResearchFailureMemoryV1(memory) {
  assertResearchFailureMemoryV1(memory);
  const byStage = {};
  const byStatus = {};
  const strategies = new Set();
  let latestObservedAt = null;
  for (const entry of memory.observations) {
    const row = entry.failureObservation;
    strategies.add(row.strategyIdentityDigest);
    byStage[row.stage] = (byStage[row.stage] ?? 0) + 1;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    if (latestObservedAt == null || Date.parse(row.observedAt) > Date.parse(latestObservedAt)) latestObservedAt = row.observedAt;
  }
  return deepFreeze({
    schemaVersion: 1,
    contract: 'research-failure-memory-summary/v1',
    observationCount: memory.observations.length,
    strategyIdentityCount: strategies.size,
    byStage: Object.freeze(Object.fromEntries(Object.entries(byStage).sort())),
    byStatus: Object.freeze(Object.fromEntries(Object.entries(byStatus).sort())),
    latestObservedAt,
    economicMetricsIncluded: false,
    performanceCreditCreated: false,
    sampleCreditCreated: false,
    executionAuthority: 'NONE',
  });
}
