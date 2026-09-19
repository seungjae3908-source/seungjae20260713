import { createHash } from 'node:crypto';

import {
  runResearchDualFreeAiReview,
  type ResearchAiInvoker,
  type ResearchDualFreeAiResult,
} from './research-dual-free-ai.service';

export const RESEARCH_FACTORY_DUAL_AI_GATE_CONTRACT_V1 = 'research-factory-dual-ai-gate/v1';

type UnknownRecord = Record<string, unknown>;

export type ResearchFactoryAiGateStatus =
  | 'READY'
  | 'BLOCKED_FACTORY_INVALID'
  | 'BLOCKED_POLICY'
  | 'BLOCKED_DATA'
  | 'BLOCKED_RUNTIME';

export type ResearchFactoryDualAiGate = {
  schemaVersion: 1;
  contract: typeof RESEARCH_FACTORY_DUAL_AI_GATE_CONTRACT_V1;
  status: ResearchFactoryAiGateStatus;
  reason: string;
  promptVersion: 'research-factory-dual-ai-v1';
  evidenceDigest: string;
  evidenceSummary: string;
  providerPlan: ReadonlyArray<Readonly<{ provider: 'gemini' | 'groq'; role: 'PROPOSER' | 'CRITIC' }>>;
  providerCallsAllowed: 0 | 2;
  authority: Readonly<{
    researchProposalOnly: true;
    paidFallback: false;
    numericPerformanceAuthority: false;
    candidateSelectionAuthority: false;
    championPromotionAuthority: false;
    orderAllowed: false;
    executionAuthority: 'NONE';
  }>;
  gateDigest: string;
};

const FACTORY_CONTRACT = 'research-factory-runtime-status/v1';
const FACTORY_STATUSES = new Set([
  'BLOCKED_POLICY_MISSING',
  'BLOCKED_POLICY_INVALID',
  'BLOCKED_NO_READY_PROFILES',
  'BLOCKED_RUNTIME_BINDINGS',
  'READY_NON_ACTIVATING',
]);
const HASH64 = /^[0-9a-f]{64}$/i;
const SHA40 = /^[0-9a-f]{40}$/i;
const SAFE_CODE = /^[A-Za-z0-9._:-]{1,180}$/;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const row = record(value);
  if (!row) return value;
  return Object.fromEntries(Object.keys(row).sort().map((key) => [key, canonical(row[key])]));
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function safeCode(value: unknown): string | null {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : null;
}

function qualitativeLevel(ready: number | null, blocked: number | null): 'unknown' | 'none_ready' | 'partially_ready' | 'all_ready' {
  if (ready == null || blocked == null) return 'unknown';
  if (ready === 0) return 'none_ready';
  if (blocked === 0) return 'all_ready';
  return 'partially_ready';
}

function validateFailureSummary(value: unknown): UnknownRecord | null {
  if (value == null) return null;
  const row = record(value);
  if (!row
    || row.contract !== 'research-failure-memory-summary/v1'
    || nonNegativeInteger(row.observationCount) == null
    || nonNegativeInteger(row.strategyIdentityCount) == null
    || record(row.byStage) == null
    || record(row.byStatus) == null
    || row.economicMetricsIncluded !== false
    || row.performanceCreditCreated !== false
    || row.sampleCreditCreated !== false
    || row.executionAuthority !== 'NONE') return null;
  return row;
}

function validateFactoryStatus(value: unknown): {
  row: UnknownRecord;
  status: string;
  firstZero: string;
  policyPresent: boolean;
  policyValid: boolean;
  policyDigest: string | null;
  controlPlaneDigest: string | null;
  readyMarketCount: number | null;
  blockedMarketCount: number | null;
  readyProfileCount: number | null;
  blockedProfileCount: number | null;
} | null {
  const row = record(value);
  if (!row || row.contract !== FACTORY_CONTRACT || row.schemaVersion !== 1) return null;
  const status = typeof row.status === 'string' && FACTORY_STATUSES.has(row.status) ? row.status : null;
  const firstZero = safeCode(row.firstZero);
  const researchSha = typeof row.researchSha === 'string' && SHA40.test(row.researchSha) ? row.researchSha.toLowerCase() : null;
  const policy = record(row.policy);
  const dataFactory = record(row.dataFactory);
  const adaptive = record(row.canonicalAdaptive);
  const safety = record(row.safety);
  if (!status || !firstZero || !researchSha || !policy || !dataFactory || !adaptive || !safety) return null;
  if (safety.runtimeExecutionAttempted !== false
    || safety.runtimeActivationAllowed !== false
    || safety.scheduleMutationAllowed !== false
    || safety.deploymentAllowed !== false
    || safety.databaseMutationAllowed !== false
    || safety.secretMutationAllowed !== false
    || safety.liveTrading !== false
    || safety.autoTrading !== false
    || safety.privateTradingApi !== false
    || safety.realOrder !== false
    || safety.profitabilityClaim !== false
    || safety.executionAuthority !== 'NONE') return null;

  const policyPresent = typeof policy.present === 'boolean' ? policy.present : null;
  const policyValid = typeof policy.valid === 'boolean' ? policy.valid : null;
  const policyDigest = policy.policyDigest == null ? null : String(policy.policyDigest).toLowerCase();
  const controlPlaneDigest = row.controlPlaneDigest == null ? null : String(row.controlPlaneDigest).toLowerCase();
  if (policyPresent == null || policyValid == null
    || (policyDigest != null && !HASH64.test(policyDigest))
    || (controlPlaneDigest != null && !HASH64.test(controlPlaneDigest))
    || (!policyPresent && (policyValid || policyDigest != null))) return null;

  return {
    row,
    status,
    firstZero,
    policyPresent,
    policyValid,
    policyDigest,
    controlPlaneDigest,
    readyMarketCount: dataFactory.readyMarketCount == null ? null : nonNegativeInteger(dataFactory.readyMarketCount),
    blockedMarketCount: dataFactory.blockedMarketCount == null ? null : nonNegativeInteger(dataFactory.blockedMarketCount),
    readyProfileCount: adaptive.readyProfileCount == null ? null : nonNegativeInteger(adaptive.readyProfileCount),
    blockedProfileCount: adaptive.blockedProfileCount == null ? null : nonNegativeInteger(adaptive.blockedProfileCount),
  };
}

function authority() {
  return Object.freeze({
    researchProposalOnly: true as const,
    paidFallback: false as const,
    numericPerformanceAuthority: false as const,
    candidateSelectionAuthority: false as const,
    championPromotionAuthority: false as const,
    orderAllowed: false as const,
    executionAuthority: 'NONE' as const,
  });
}

function gateStatus(factoryStatus: string): { status: ResearchFactoryAiGateStatus; reason: string; providerCallsAllowed: 0 | 2 } {
  switch (factoryStatus) {
    case 'READY_NON_ACTIVATING':
      return { status: 'READY', reason: 'CANONICAL_FACTORY_READY_FOR_QUALITATIVE_RESEARCH', providerCallsAllowed: 2 };
    case 'BLOCKED_POLICY_MISSING':
    case 'BLOCKED_POLICY_INVALID':
      return { status: 'BLOCKED_POLICY', reason: factoryStatus, providerCallsAllowed: 0 };
    case 'BLOCKED_NO_READY_PROFILES':
      return { status: 'BLOCKED_DATA', reason: factoryStatus, providerCallsAllowed: 0 };
    default:
      return { status: 'BLOCKED_RUNTIME', reason: factoryStatus, providerCallsAllowed: 0 };
  }
}

export function buildResearchFactoryDualAiGateV1({
  factoryStatus,
  failureSummary = null,
}: {
  factoryStatus: unknown;
  failureSummary?: unknown;
}): ResearchFactoryDualAiGate {
  const factory = validateFactoryStatus(factoryStatus);
  const failures = validateFailureSummary(failureSummary);
  if (!factory) {
    const core: Omit<ResearchFactoryDualAiGate, 'gateDigest'> = {
      schemaVersion: 1,
      contract: RESEARCH_FACTORY_DUAL_AI_GATE_CONTRACT_V1,
      status: 'BLOCKED_FACTORY_INVALID' as const,
      reason: 'FACTORY_STATUS_INVALID',
      promptVersion: 'research-factory-dual-ai-v1' as const,
      evidenceDigest: sha256({ factory: 'invalid', failureMemory: failures ? 'present' : 'absent' }),
      evidenceSummary: 'Factory control-plane evidence is invalid. No AI research review may run.',
      providerPlan: Object.freeze([]) as ReadonlyArray<Readonly<{ provider: 'gemini' | 'groq'; role: 'PROPOSER' | 'CRITIC' }>>,
      providerCallsAllowed: 0 as const,
      authority: authority(),
    };
    return Object.freeze({ ...core, gateDigest: sha256(core) });
  }

  const gate = gateStatus(factory.status);
  const marketReadiness = qualitativeLevel(factory.readyMarketCount, factory.blockedMarketCount);
  const profileReadiness = qualitativeLevel(factory.readyProfileCount, factory.blockedProfileCount);
  const failureMemory = failures && Number(failures.observationCount) > 0 ? 'known_failure_memory_present' : 'no_known_failure_memory';

  const evidenceCore = {
    factoryStatus: factory.status,
    firstZero: factory.firstZero,
    policyPresent: factory.policyPresent,
    policyValid: factory.policyValid,
    policyDigest: factory.policyDigest,
    controlPlaneDigest: factory.controlPlaneDigest,
    marketReadiness,
    profileReadiness,
    failureSummary: failures == null ? null : {
      observationCount: failures.observationCount,
      strategyIdentityCount: failures.strategyIdentityCount,
      byStage: failures.byStage,
      byStatus: failures.byStatus,
      latestObservedAt: failures.latestObservedAt ?? null,
    },
  };
  const evidenceDigest = sha256(evidenceCore);
  const evidenceSummary = [
    `factoryStatus=${factory.status}`,
    `firstZero=${factory.firstZero}`,
    `policy=${factory.policyValid ? 'approved' : factory.policyPresent ? 'invalid' : 'missing'}`,
    `marketReadiness=${marketReadiness}`,
    `profileReadiness=${profileReadiness}`,
    `failureMemory=${failureMemory}`,
    'Only qualitative, falsifiable research hypotheses are allowed. Numeric performance, candidate selection, promotion and trading authority remain forbidden.',
  ].join('; ');

  const providerPlan = gate.providerCallsAllowed === 2
    ? Object.freeze([
        Object.freeze({ provider: 'gemini' as const, role: 'PROPOSER' as const }),
        Object.freeze({ provider: 'groq' as const, role: 'CRITIC' as const }),
      ])
    : Object.freeze([]);

  const core: Omit<ResearchFactoryDualAiGate, 'gateDigest'> = {
    schemaVersion: 1,
    contract: RESEARCH_FACTORY_DUAL_AI_GATE_CONTRACT_V1,
    status: gate.status,
    reason: gate.reason,
    promptVersion: 'research-factory-dual-ai-v1' as const,
    evidenceDigest,
    evidenceSummary,
    providerPlan,
    providerCallsAllowed: gate.providerCallsAllowed,
    authority: authority(),
  };
  return Object.freeze({ ...core, gateDigest: sha256(core) });
}

function verifyGate(gate: ResearchFactoryDualAiGate): boolean {
  if (!gate || gate.contract !== RESEARCH_FACTORY_DUAL_AI_GATE_CONTRACT_V1
    || !HASH64.test(gate.evidenceDigest)
    || !HASH64.test(gate.gateDigest)
    || gate.authority?.researchProposalOnly !== true
    || gate.authority?.paidFallback !== false
    || gate.authority?.numericPerformanceAuthority !== false
    || gate.authority?.candidateSelectionAuthority !== false
    || gate.authority?.championPromotionAuthority !== false
    || gate.authority?.orderAllowed !== false
    || gate.authority?.executionAuthority !== 'NONE') return false;
  const core = { ...gate } as Record<string, unknown>;
  delete core.gateDigest;
  return sha256(core) === gate.gateDigest;
}

export async function runResearchFactoryDualAiAdvisoryV1({
  gate,
  invokers,
}: {
  gate: ResearchFactoryDualAiGate;
  invokers: { gemini: ResearchAiInvoker; groq: ResearchAiInvoker };
}): Promise<{
  status: 'BLOCKED' | 'READY';
  providerCallCount: 0 | 2;
  proposer: ResearchDualFreeAiResult | null;
  critic: ResearchDualFreeAiResult | null;
  authority: ReturnType<typeof authority>;
}> {
  if (!verifyGate(gate)) throw new Error('RESEARCH_FACTORY_AI_GATE_INVALID');
  if (gate.status !== 'READY') {
    return Object.freeze({
      status: 'BLOCKED' as const,
      providerCallCount: 0 as const,
      proposer: null,
      critic: null,
      authority: authority(),
    });
  }
  if (typeof invokers?.gemini !== 'function' || typeof invokers?.groq !== 'function') {
    throw new TypeError('both free-provider invokers are required');
  }

  const proposer = await runResearchDualFreeAiReview({
    provider: 'gemini',
    role: 'PROPOSER',
    promptVersion: gate.promptVersion,
    evidenceDigest: gate.evidenceDigest,
    evidenceSummary: gate.evidenceSummary,
  }, invokers.gemini);

  const proposerIdentity = proposer.hypotheses.map((row) => row.hypothesisId).join(',') || 'none';
  const criticEvidence = [
    gate.evidenceSummary,
    `proposerDisposition=${proposer.disposition}`,
    `proposerHypothesisIds=${proposerIdentity}`,
    'Critique only leakage, duplication, provenance weakness and falsifiability. Do not add numeric performance claims.',
  ].join('; ').slice(0, 800);
  const criticDigest = sha256({
    baseEvidenceDigest: gate.evidenceDigest,
    proposer: {
      disposition: proposer.disposition,
      summary: proposer.summary,
      findings: proposer.findings,
      hypotheses: proposer.hypotheses,
      risks: proposer.risks,
    },
  });

  const critic = await runResearchDualFreeAiReview({
    provider: 'groq',
    role: 'CRITIC',
    promptVersion: gate.promptVersion,
    evidenceDigest: criticDigest,
    evidenceSummary: criticEvidence,
  }, invokers.groq);

  return Object.freeze({
    status: 'READY' as const,
    providerCallCount: 2 as const,
    proposer,
    critic,
    authority: authority(),
  });
}
