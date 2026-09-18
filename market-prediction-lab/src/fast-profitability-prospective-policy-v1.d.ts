export const FAST_PROFITABILITY_PROSPECTIVE_POLICY_V1: 'fast-profitability-prospective-policy-v1';
export const FAST_PROFITABILITY_MINIMUM_FUTURE_BUFFER_MS: number;
export const FAST_PROFITABILITY_VALIDATION_MINIMUM_INDEPENDENT_N: 30;
export const FAST_PROFITABILITY_SEALED_OOS_MINIMUM_INDEPENDENT_N: 30;
export const FAST_PROFITABILITY_FULL_COST_COMPONENTS: readonly [
  'commission',
  'tax',
  'spread',
  'slippage',
  'funding',
  'latency',
  'liquidityImpact',
  'partialFillImpact',
];

export type FastProfitabilityProspectivePolicyV1 = Readonly<Record<string, any>> & Readonly<{
  schemaVersion: 'fast-profitability-prospective-policy-v1';
  status: 'FROZEN_INACTIVE';
  policyFrozenAtMs: number;
  eligibleAfterMs: number;
  minimumFutureBufferMs: number;
  candidate: Readonly<{
    candidateId: string;
    strategyId: string;
    strategyVersion: string;
    parameterHash: string;
    researchCodeSha: string;
    market: string;
    symbol: string;
    timeframe: string;
    horizon: number;
    side: string;
    riskPolicyRef: string;
    costPolicyRef: string;
    exitPolicyRef: string;
  }>;
  candidateDigest: string;
  policyDigest: string;
  validationPolicy: Readonly<{
    minimumEffectiveIndependentN: number;
    requiredOutcomeClasses: readonly string[];
    durableReadbackRequired: boolean;
    sameCandidateRequired: boolean;
  }>;
  sealedOosPolicy: Readonly<{
    minimumEffectiveIndependentN: number;
    outcomeQuarantineRequired: boolean;
    revealRequiresValidationReceipt: boolean;
  }>;
}>;

export type FastProfitabilityAllocationV1 = Readonly<{
  split: 'VALIDATION' | 'SEALED_OOS';
  bucket: number;
  allocationDigest: string;
  policyDigest: string;
  candidateDigest: string;
  publicEventIdentity: string;
  sourceFrameIdentity: string;
  dependencyComponentId: string;
  observedAtMs: number;
  outcomeConsulted: false;
  reassignmentAllowed: false;
  profitabilityCredit: 0;
}>;

export function fastProfitabilityCanonicalJson(value: unknown): string;
export function fastProfitabilitySha256(value: unknown): string;

export function buildFastProfitabilityProspectivePolicyV1(input?: {
  candidate?: Record<string, unknown>;
  policyFrozenAtMs?: number;
  eligibleAfterMs?: number;
}): FastProfitabilityProspectivePolicyV1;

export function verifyFastProfitabilityProspectivePolicyV1(
  policy: unknown,
): Readonly<{ valid: boolean; blockers: readonly string[] }>;

export function allocateFastProfitabilitySplit(
  policy: unknown,
  observation: {
    publicEventIdentity: string;
    sourceFrameIdentity: string;
    dependencyComponentId: string;
    independenceStatus: 'PROVEN';
    dependencyComponentCredit: 1;
    observedAtMs: number;
  },
): FastProfitabilityAllocationV1;

export function admitFastProfitabilityIndependentObservation(
  policy: unknown,
  observation: Record<string, unknown>,
): Readonly<Record<string, unknown>>;

export function evaluateFastProfitabilityReadiness(
  policy: unknown,
  state?: Record<string, unknown>,
): Readonly<Record<string, any>> & Readonly<{
  status: 'BLOCKED' | 'COLLECTING' | 'SEALED_OOS_REVEAL_READY';
  validationReady: boolean;
  sealedOosMinimumReached?: boolean;
  sealedOosRevealAllowed: boolean;
  profitabilityCredit?: 0;
  profitabilityClaimAllowed: false;
  championPromotionAllowed?: false;
}>;
