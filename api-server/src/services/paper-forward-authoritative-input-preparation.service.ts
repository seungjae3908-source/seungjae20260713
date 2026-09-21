import {
  createAuthoritativePaperGenericRiskPolicyProducer,
  type AuthoritativePaperGenericRiskPolicyRecordV1,
  type AuthoritativePaperGenericRiskPolicyRequest,
} from './authoritative-paper-generic-risk-policy-producer.service';
import {
  buildAuthoritativePaperPartialFillCostEvidence,
  type PartialFillCalibrationArtifact,
  type PartialFillCalibrationContext,
} from './authoritative-paper-partial-fill-cost-evidence.service';
import type { PercentCostEvidence } from './scanner-profit-cost-evidence-adapter.service';
export const PAPER_FORWARD_AUTHORITATIVE_INPUT_PREPARATION_VERSION =
  'paper-forward-authoritative-input-preparation-v1' as const;

type LiquidityRuntimeInput = Readonly<{
  calibrationArtifactInput?: unknown;
  producerOutput?: unknown;
  liquidityImpactFirewallInput?: unknown;
  bridge?: unknown;
}>;

export type PaperForwardAuthoritativeInputPreparationInput = Readonly<{
  researchCodeSha: string;
  riskPolicyRecord: unknown;
  riskPolicyRequest: AuthoritativePaperGenericRiskPolicyRequest;
  costPolicyId: string;
  liquidity: LiquidityRuntimeInput;
  partialFill: Readonly<{
    artifact?: PartialFillCalibrationArtifact | null;
    expected: PartialFillCalibrationContext;
  }>;
  nowMs: number;
  maximumAgeMs: number;
}>;

export type PreparedPaperForwardSupplementalCostInput = Readonly<{
  costPolicyId: string;
  observedAtMs: number;
  liquidityImpact: PercentCostEvidence;
  partialFillImpact: PercentCostEvidence;
  maximumAgeMs: number;
}>;

export type PaperForwardAuthoritativeInputPreparationResult = Readonly<{
  schemaVersion: typeof PAPER_FORWARD_AUTHORITATIVE_INPUT_PREPARATION_VERSION;
  status: 'READY' | 'BLOCKED_DATA';
  blockers: readonly string[];
  riskPolicyRecord: AuthoritativePaperGenericRiskPolicyRecordV1 | null;
  supplementalCostInput: PreparedPaperForwardSupplementalCostInput | null;
  evidenceClasses: Readonly<{
    riskPolicy: 'CANONICAL_EXPLICIT_RECORD' | 'MISSING';
    liquidityImpact: 'GENUINE_RUNTIME_CALIBRATION' | 'MISSING';
    partialFillImpact: 'GENUINE_PUBLIC_FORWARD_CALIBRATION' | 'MISSING';
    latency: 'RUNTIME_MEASURED_LATER';
    funding: 'CANDIDATE_BOUND_RUNTIME_LATER';
  }>;
  economicCreditCreated: false;
  profitabilityCredit: 0;
  executionAuthority: 'NONE';
  liveTrading: false;
  autoTrading: false;
  realOrderEnabled: false;
  privateTradingApiAllowed: false;
}>;

type Dependencies = Readonly<{
  createRiskProducer: typeof createAuthoritativePaperGenericRiskPolicyProducer;
  buildLiquidity(input: Record<string, unknown>): Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>;
  buildPartialFill: typeof buildAuthoritativePaperPartialFillCostEvidence;
}>;

const DEFAULT_DEPENDENCIES: Dependencies = Object.freeze({
  createRiskProducer: createAuthoritativePaperGenericRiskPolicyProducer,
  buildLiquidity: async () => Object.freeze({
    status: 'BLOCKED_DATA',
    liquidityImpactStatus: 'BLOCKED_DATA',
    evidence: null,
    blockers: Object.freeze(['CANONICAL_LIQUIDITY_RUNTIME_BUILDER_NOT_BOUND']),
  }),
  buildPartialFill: buildAuthoritativePaperPartialFillCostEvidence,
});

const SHA40 = /^[0-9a-f]{40}$/u;
const NATURAL_RUNTIME_MAXIMUM_AGE_MS = 30_000;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function exactSha(value: unknown): value is string {
  return typeof value === 'string' && SHA40.test(value);
}

function symbol(value: unknown): string | null {
  if (!nonEmpty(value)) return null;
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]/gu, '');
  return normalized.length > 0 ? normalized : null;
}

function blockersFrom(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(nonEmpty).map((item) => item.trim()) : [];
}

function evidence(value: unknown): PercentCostEvidence | null {
  const row = record(value);
  if (!row
    || typeof row.valuePercent !== 'number'
    || !Number.isFinite(row.valuePercent)
    || row.valuePercent < 0
    || !['OBSERVED', 'DOCUMENTED', 'ESTIMATED', 'NOT_APPLICABLE'].includes(String(row.quality ?? ''))
    || !nonEmpty(row.source)
    || !positive(row.observedAtMs)) {
    return null;
  }
  if (row.quality === 'NOT_APPLICABLE' && row.valuePercent !== 0) return null;
  return Object.freeze({
    valuePercent: row.valuePercent,
    quality: row.quality as PercentCostEvidence['quality'],
    source: row.source.trim(),
    observedAtMs: row.observedAtMs,
  });
}

function blocked(blockers: readonly string[]): PaperForwardAuthoritativeInputPreparationResult {
  return Object.freeze({
    schemaVersion: PAPER_FORWARD_AUTHORITATIVE_INPUT_PREPARATION_VERSION,
    status: 'BLOCKED_DATA',
    blockers: Object.freeze([...new Set(blockers)]),
    riskPolicyRecord: null,
    supplementalCostInput: null,
    evidenceClasses: Object.freeze({
      riskPolicy: 'MISSING',
      liquidityImpact: 'MISSING',
      partialFillImpact: 'MISSING',
      latency: 'RUNTIME_MEASURED_LATER',
      funding: 'CANDIDATE_BOUND_RUNTIME_LATER',
    }),
    economicCreditCreated: false,
    profitabilityCredit: 0,
    executionAuthority: 'NONE',
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
  });
}

export async function preparePaperForwardAuthoritativeInputs(
  input: PaperForwardAuthoritativeInputPreparationInput,
  overrides: Partial<Dependencies> = {},
): Promise<PaperForwardAuthoritativeInputPreparationResult> {
  const dependencies = Object.freeze({ ...DEFAULT_DEPENDENCIES, ...overrides }) as Dependencies;
  const blockers: string[] = [];
  const normalizedSha = String(input?.researchCodeSha ?? '').trim().toLowerCase();
  const riskRequest = input?.riskPolicyRequest;
  const riskRecord = record(input?.riskPolicyRecord);
  const nowMs = input?.nowMs;
  const maximumAgeMs = input?.maximumAgeMs;

  if (!exactSha(normalizedSha)) blockers.push('PREPARATION_EXACT_RESEARCH_SHA_REQUIRED');
  if (!positive(nowMs) || !positive(maximumAgeMs)) blockers.push('PREPARATION_CLOCK_OR_MAXIMUM_AGE_INVALID');
  else if (maximumAgeMs > NATURAL_RUNTIME_MAXIMUM_AGE_MS) blockers.push('PREPARATION_MAXIMUM_AGE_EXCEEDS_NATURAL_RUNTIME');
  if (!nonEmpty(input?.costPolicyId)) blockers.push('PREPARATION_COST_POLICY_ID_REQUIRED');
  if (!riskRecord) blockers.push('PREPARATION_RISK_POLICY_RECORD_REQUIRED');
  if (riskRequest?.market !== 'CRYPTO_FUTURES') blockers.push('PREPARATION_CRYPTO_FUTURES_ONLY');
  if (!riskRequest || String(riskRequest.researchCodeSha ?? '').toLowerCase() !== normalizedSha) {
    blockers.push('PREPARATION_RISK_POLICY_RESEARCH_SHA_MISMATCH');
  }

  const expectedPartial = input?.partialFill?.expected;
  if (expectedPartial?.market !== 'CRYPTO_FUTURES'
    || symbol(expectedPartial?.symbol) !== symbol(riskRequest?.symbol)) {
    blockers.push('PREPARATION_PARTIAL_FILL_SCOPE_MISMATCH');
  }

  const firewall = record(input?.liquidity?.liquidityImpactFirewallInput);
  const liquidityExpected = record(firewall?.expected);
  if (liquidityExpected) {
    if (String(liquidityExpected.market ?? '') !== 'CRYPTO_FUTURES'
      || symbol(liquidityExpected.symbol) !== symbol(riskRequest?.symbol)
      || String(liquidityExpected.side ?? '') !== String(expectedPartial?.side ?? '')) {
      blockers.push('PREPARATION_LIQUIDITY_SCOPE_MISMATCH');
    }
  }

  if (blockers.length > 0) return blocked(blockers);

  const riskProducer = dependencies.createRiskProducer({
    readCanonicalRecord: async () => riskRecord,
    now: () => nowMs,
  });
  const riskResult = await riskProducer(Object.freeze({
    ...riskRequest,
    researchCodeSha: normalizedSha,
  }));
  if (riskResult.status !== 'PRESENT' || !riskResult.policyEvidence) {
    blockers.push(...blockersFrom(riskResult.blockers).map((code) => `RISK:${code}`));
    if (!blockers.some((code) => code.startsWith('RISK:'))) {
      blockers.push('RISK:CANONICAL_RECORD_NOT_PRESENT');
    }
  }

  const liquidityResult = await dependencies.buildLiquidity({
    ...(record(input.liquidity) ?? {}),
    nowMs,
  });
  const liquidityEvidence = liquidityResult.status === 'PRESENT'
    && liquidityResult.liquidityImpactStatus === 'PRESENT'
    ? evidence(liquidityResult.evidence)
    : null;
  if (!liquidityEvidence) {
    blockers.push(...blockersFrom(liquidityResult.blockers).map((code) => `LIQUIDITY:${code}`));
    if (!blockers.some((code) => code.startsWith('LIQUIDITY:'))) {
      blockers.push('LIQUIDITY:GENUINE_RUNTIME_COST_EVIDENCE_NOT_PRESENT');
    }
  }

  const partialResult = dependencies.buildPartialFill({
    artifact: input.partialFill.artifact ?? null,
    expected: Object.freeze({
      ...input.partialFill.expected,
      nowMs,
      maximumAgeMs,
    }),
  });
  const partialFillEvidence = partialResult.status === 'PRESENT'
    ? evidence(partialResult.evidence)
    : null;
  if (!partialFillEvidence) {
    blockers.push(...blockersFrom(partialResult.blockers).map((code) => `PARTIAL_FILL:${code}`));
    if (!blockers.some((code) => code.startsWith('PARTIAL_FILL:'))) {
      blockers.push('PARTIAL_FILL:GENUINE_CALIBRATION_EVIDENCE_NOT_PRESENT');
    }
  }

  if (liquidityEvidence && nowMs - liquidityEvidence.observedAtMs > maximumAgeMs) {
    blockers.push('LIQUIDITY:EVIDENCE_STALE_AT_PREPARATION');
  }
  if (partialFillEvidence && nowMs - partialFillEvidence.observedAtMs > maximumAgeMs) {
    blockers.push('PARTIAL_FILL:EVIDENCE_STALE_AT_PREPARATION');
  }

  if (blockers.length > 0 || !liquidityEvidence || !partialFillEvidence) return blocked(blockers);

  const observedAtMs = Math.min(liquidityEvidence.observedAtMs, partialFillEvidence.observedAtMs);
  const canonicalRiskRecord = Object.freeze(structuredClone(riskRecord)) as AuthoritativePaperGenericRiskPolicyRecordV1;
  const supplementalCostInput = Object.freeze({
    costPolicyId: input.costPolicyId.trim(),
    observedAtMs,
    liquidityImpact: liquidityEvidence,
    partialFillImpact: partialFillEvidence,
    maximumAgeMs,
  });

  return Object.freeze({
    schemaVersion: PAPER_FORWARD_AUTHORITATIVE_INPUT_PREPARATION_VERSION,
    status: 'READY',
    blockers: Object.freeze([]),
    riskPolicyRecord: canonicalRiskRecord,
    supplementalCostInput,
    evidenceClasses: Object.freeze({
      riskPolicy: 'CANONICAL_EXPLICIT_RECORD',
      liquidityImpact: 'GENUINE_RUNTIME_CALIBRATION',
      partialFillImpact: 'GENUINE_PUBLIC_FORWARD_CALIBRATION',
      latency: 'RUNTIME_MEASURED_LATER',
      funding: 'CANDIDATE_BOUND_RUNTIME_LATER',
    }),
    economicCreditCreated: false,
    profitabilityCredit: 0,
    executionAuthority: 'NONE',
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
  });
}

export const PAPER_FORWARD_AUTHORITATIVE_INPUT_PREPARATION_SAFETY = Object.freeze({
  riskPolicyValuesInvented: false,
  liquidityImpactInvented: false,
  canonicalLiquidityRuntimeBuilderMustBeExplicitlyBound: true,
  naturalRuntimeMaximumAgeMs: NATURAL_RUNTIME_MAXIMUM_AGE_MS,
  partialFillImpactInvented: false,
  latencyPreparedAheadOfRuntime: false,
  fundingPreparedAheadOfCandidate: false,
  replayBackfillSyntheticManualEconomicCredit: 0,
  scheduleActivationAuthority: false,
  deploymentAuthority: false,
  executionAuthority: 'NONE',
  liveTrading: false,
  autoTrading: false,
  realOrderEnabled: false,
  privateTradingApiAllowed: false,
});
