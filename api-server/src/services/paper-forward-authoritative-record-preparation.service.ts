import { buildPublicForwardLiquidityRuntimeCostEvidence } from '../../../market-intelligence-sidecar/src/public-forward-liquidity-runtime-cost-evidence.mjs';
import {
  buildAuthoritativePaperPartialFillCostEvidence,
  type PartialFillCalibrationArtifact,
  type PartialFillCalibrationContext,
} from './authoritative-paper-partial-fill-cost-evidence.service';
import {
  createAuthoritativePaperGenericRiskPolicyProducer,
  type AuthoritativePaperGenericRiskPolicyRecordV1,
} from './authoritative-paper-generic-risk-policy-producer.service';
import type { PercentCostEvidence } from './scanner-profit-cost-evidence-adapter.service';

export const PAPER_FORWARD_AUTHORITATIVE_RECORD_PREPARATION_VERSION =
  'paper-forward-authoritative-record-preparation-v1' as const;

type Scope = Readonly<{
  targetSha: string;
  market: 'CRYPTO_FUTURES';
  symbol: string;
  strategyScope: string;
  side: 'LONG' | 'SHORT';
  costPolicyId: string;
}>;

type RiskValidationResult = Readonly<{
  status: 'PRESENT' | 'BLOCKED_DATA';
  blockers?: readonly string[];
  executionAuthority?: string;
  privateApiAllowed?: boolean;
  liveTrading?: boolean;
  realOrderAllowed?: boolean;
  financialMutationAllowed?: boolean;
}>;

type Dependencies = Readonly<{
  validateRiskPolicy(input: Readonly<{
    record: unknown;
    request: Readonly<{
      market: 'CRYPTO_FUTURES';
      symbol: string;
      strategyScope: string;
      researchCodeSha: string;
    }>;
    nowMs: number;
  }>): Promise<RiskValidationResult>;
  buildLiquidityEvidence(input: unknown): unknown;
  buildPartialFillEvidence(input: Readonly<{
    artifact?: PartialFillCalibrationArtifact | null;
    expected: PartialFillCalibrationContext;
  }>): unknown;
}>;

export type PaperForwardAuthoritativeRecordPreparationInput = Scope & Readonly<{
  riskPolicyRecord: AuthoritativePaperGenericRiskPolicyRecordV1 | unknown;
  liquidityRuntimeInput: unknown;
  partialFillArtifact: PartialFillCalibrationArtifact | null;
  partialFillExpected: PartialFillCalibrationContext;
  nowMs?: number;
}>;

export type PaperForwardSupplementalCostRecord = Readonly<{
  schemaVersion: 'paper-forward-supplemental-cost-record-v1';
  costPolicyId: string;
  observedAtMs: number;
  liquidityImpact: PercentCostEvidence;
  partialFillImpact: PercentCostEvidence;
  evidenceBindings: Readonly<{
    liquidityImpactArtifactDigest: string | null;
    partialFillArtifactDigest: string | null;
  }>;
  unknownCostIsZero: false;
  economicCreditCreated: false;
  profitabilityCredit: 0;
  executionAuthority: 'NONE';
  privateTradingApiAllowed: false;
  liveTrading: false;
  realOrderEnabled: false;
}>;

export type PaperForwardAuthoritativeRecordPreparationResult = Readonly<{
  schemaVersion: typeof PAPER_FORWARD_AUTHORITATIVE_RECORD_PREPARATION_VERSION;
  status: 'PREPARED' | 'BLOCKED_DATA';
  blockers: readonly string[];
  riskPolicyRecord: AuthoritativePaperGenericRiskPolicyRecordV1 | null;
  supplementalCostRecord: PaperForwardSupplementalCostRecord | null;
  economicCreditCreated: false;
  profitabilityCredit: 0;
  executionAuthority: 'NONE';
  privateTradingApiAllowed: false;
  liveTrading: false;
  realOrderEnabled: false;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function normalizeSymbol(value: unknown): string | null {
  if (!nonEmpty(value)) return null;
  const symbol = value.trim().toUpperCase().replace(/[^A-Z0-9]/gu, '');
  return /^[A-Z0-9]{2,20}USDT$/u.test(symbol) ? symbol : null;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function safetyEnvelope() {
  return Object.freeze({
    economicCreditCreated: false as const,
    profitabilityCredit: 0 as const,
    executionAuthority: 'NONE' as const,
    privateTradingApiAllowed: false as const,
    liveTrading: false as const,
    realOrderEnabled: false as const,
  });
}

function blocked(blockers: readonly string[]): PaperForwardAuthoritativeRecordPreparationResult {
  return Object.freeze({
    schemaVersion: PAPER_FORWARD_AUTHORITATIVE_RECORD_PREPARATION_VERSION,
    status: 'BLOCKED_DATA',
    blockers: Object.freeze([...new Set(blockers)]),
    riskPolicyRecord: null,
    supplementalCostRecord: null,
    ...safetyEnvelope(),
  });
}

function percentEvidence(value: unknown, code: string): PercentCostEvidence | null {
  const item = record(value);
  if (!item
    || typeof item.valuePercent !== 'number'
    || !Number.isFinite(item.valuePercent)
    || item.valuePercent < 0
    || !nonEmpty(item.quality)
    || !['OBSERVED', 'DOCUMENTED', 'ESTIMATED', 'NOT_APPLICABLE'].includes(item.quality)
    || !nonEmpty(item.source)
    || !positive(item.observedAtMs)
    || (item.quality === 'NOT_APPLICABLE' && item.valuePercent !== 0)) {
    return null;
  }
  void code;
  return Object.freeze({
    valuePercent: item.valuePercent,
    quality: item.quality as PercentCostEvidence['quality'],
    source: item.source.trim(),
    observedAtMs: item.observedAtMs,
  });
}

function liquidityExpectedScope(input: unknown) {
  const root = record(input);
  const firewall = record(root?.liquidityImpactFirewallInput);
  return record(firewall?.expected);
}

function exactScopeBlockers(
  input: PaperForwardAuthoritativeRecordPreparationInput,
): string[] {
  const blockers: string[] = [];
  const symbol = normalizeSymbol(input.symbol);
  if (!exactSha(input.targetSha)) blockers.push('AUTHORITATIVE_RECORD_TARGET_SHA_INVALID');
  if (input.market !== 'CRYPTO_FUTURES') blockers.push('AUTHORITATIVE_RECORD_MARKET_INVALID');
  if (!symbol) blockers.push('AUTHORITATIVE_RECORD_SYMBOL_INVALID');
  if (!nonEmpty(input.strategyScope)) blockers.push('AUTHORITATIVE_RECORD_STRATEGY_SCOPE_REQUIRED');
  if (input.side !== 'LONG' && input.side !== 'SHORT') blockers.push('AUTHORITATIVE_RECORD_SIDE_INVALID');
  if (!nonEmpty(input.costPolicyId)) blockers.push('AUTHORITATIVE_RECORD_COST_POLICY_ID_REQUIRED');

  const liquidityScope = liquidityExpectedScope(input.liquidityRuntimeInput);
  if (!liquidityScope
    || liquidityScope.market !== input.market
    || normalizeSymbol(liquidityScope.symbol) !== symbol
    || liquidityScope.side !== input.side) {
    blockers.push('LIQUIDITY_RUNTIME_SCOPE_MISMATCH');
  }

  const partial = input.partialFillExpected as Partial<PartialFillCalibrationContext>;
  if (partial.market !== input.market
    || normalizeSymbol(partial.symbol) !== symbol
    || partial.side !== input.side) {
    blockers.push('PARTIAL_FILL_RUNTIME_SCOPE_MISMATCH');
  }
  return blockers;
}

const DEFAULT_DEPENDENCIES: Dependencies = Object.freeze({
  async validateRiskPolicy({ record: canonicalRecord, request, nowMs }) {
    const producer = createAuthoritativePaperGenericRiskPolicyProducer({
      readCanonicalRecord: async () => canonicalRecord,
      now: () => nowMs,
    });
    return producer(request);
  },
  buildLiquidityEvidence(input) {
    return buildPublicForwardLiquidityRuntimeCostEvidence(input as Record<string, unknown>);
  },
  buildPartialFillEvidence(input) {
    return buildAuthoritativePaperPartialFillCostEvidence(input);
  },
});

export async function preparePaperForwardAuthoritativeRecords(
  input: PaperForwardAuthoritativeRecordPreparationInput,
  dependencies: Dependencies = DEFAULT_DEPENDENCIES,
): Promise<PaperForwardAuthoritativeRecordPreparationResult> {
  const blockers = exactScopeBlockers(input);
  const nowMs = positive(input.nowMs) ? input.nowMs : Date.now();
  const symbol = normalizeSymbol(input.symbol);
  if (!positive(nowMs)) blockers.push('AUTHORITATIVE_RECORD_CLOCK_INVALID');
  if (blockers.length > 0 || !symbol) return blocked(blockers);

  const risk = await dependencies.validateRiskPolicy({
    record: input.riskPolicyRecord,
    request: Object.freeze({
      market: 'CRYPTO_FUTURES',
      symbol,
      strategyScope: input.strategyScope.trim(),
      researchCodeSha: input.targetSha,
    }),
    nowMs,
  });
  if (risk.status !== 'PRESENT') {
    blockers.push(...(risk.blockers ?? ['RISK_POLICY_CANONICAL_RECORD_BLOCKED']));
  }
  if (risk.executionAuthority !== 'NONE'
    || risk.privateApiAllowed !== false
    || risk.liveTrading !== false
    || risk.realOrderAllowed !== false
    || risk.financialMutationAllowed !== false) {
    blockers.push('RISK_POLICY_SAFETY_ENVELOPE_INVALID');
  }

  const liquidityInput = record(input.liquidityRuntimeInput);
  const liquidityResult = record(dependencies.buildLiquidityEvidence({
    ...(liquidityInput ?? {}),
    nowMs,
  }));
  if (!liquidityResult
    || liquidityResult.status !== 'PRESENT'
    || liquidityResult.liquidityImpactStatus !== 'PRESENT'
    || liquidityResult.executionAuthority !== 'NONE'
    || liquidityResult.privateApiUsed !== false
    || liquidityResult.liveTrading !== false
    || liquidityResult.orderSubmitted !== false
    || liquidityResult.unknownCostIsZero !== false
    || liquidityResult.runtimeCostCredit !== 0
    || liquidityResult.evidenceComplete !== 0
    || liquidityResult.fullCostReady !== false
    || liquidityResult.profitabilityProven !== false) {
    blockers.push('LIQUIDITY_RUNTIME_EVIDENCE_NOT_PRESENT');
  }
  const liquidityImpact = percentEvidence(
    liquidityResult?.evidence,
    'LIQUIDITY_RUNTIME_PERCENT_EVIDENCE_INVALID',
  );
  if (!liquidityImpact) blockers.push('LIQUIDITY_RUNTIME_PERCENT_EVIDENCE_INVALID');

  const partialExpected = Object.freeze({
    ...input.partialFillExpected,
    market: 'CRYPTO_FUTURES' as const,
    symbol,
    side: input.side,
    nowMs,
  }) as PartialFillCalibrationContext;
  const partialResult = record(dependencies.buildPartialFillEvidence({
    artifact: input.partialFillArtifact,
    expected: partialExpected,
  }));
  if (!partialResult
    || partialResult.status !== 'PRESENT'
    || partialResult.executionAuthority !== 'NONE'
    || partialResult.privateApiUsed !== false
    || partialResult.liveTrading !== false
    || partialResult.realFillObserved !== false
    || partialResult.publicDepthIsRealFillProof !== false
    || partialResult.unknownCostIsZero !== false) {
    blockers.push('PARTIAL_FILL_RUNTIME_EVIDENCE_NOT_PRESENT');
  }
  const partialFillImpact = percentEvidence(
    partialResult?.evidence,
    'PARTIAL_FILL_PERCENT_EVIDENCE_INVALID',
  );
  if (!partialFillImpact) blockers.push('PARTIAL_FILL_PERCENT_EVIDENCE_INVALID');

  const riskRecord = record(input.riskPolicyRecord);
  if (!riskRecord
    || riskRecord.schemaVersion !== 'authoritative-paper-generic-risk-policy-record-v1'
    || riskRecord.researchCodeSha !== input.targetSha) {
    blockers.push('RISK_POLICY_RECORD_TARGET_BINDING_INVALID');
  }

  if (blockers.length > 0 || !liquidityImpact || !partialFillImpact || !riskRecord) {
    return blocked(blockers);
  }

  const observedAtMs = Math.min(liquidityImpact.observedAtMs, partialFillImpact.observedAtMs);
  if (!positive(observedAtMs) || observedAtMs > nowMs) {
    return blocked(['SUPPLEMENTAL_COST_OBSERVED_AT_INVALID']);
  }

  const supplementalCostRecord: PaperForwardSupplementalCostRecord = Object.freeze({
    schemaVersion: 'paper-forward-supplemental-cost-record-v1',
    costPolicyId: input.costPolicyId.trim(),
    observedAtMs,
    liquidityImpact,
    partialFillImpact,
    evidenceBindings: Object.freeze({
      liquidityImpactArtifactDigest: digest(liquidityResult?.liquidityImpactArtifactDigest)
        ? String(liquidityResult?.liquidityImpactArtifactDigest).toLowerCase()
        : null,
      partialFillArtifactDigest: digest(partialResult?.artifactDigest)
        ? String(partialResult?.artifactDigest).toLowerCase()
        : null,
    }),
    unknownCostIsZero: false,
    ...safetyEnvelope(),
  });

  return Object.freeze({
    schemaVersion: PAPER_FORWARD_AUTHORITATIVE_RECORD_PREPARATION_VERSION,
    status: 'PREPARED',
    blockers: Object.freeze([]),
    riskPolicyRecord: Object.freeze(clone(input.riskPolicyRecord)) as AuthoritativePaperGenericRiskPolicyRecordV1,
    supplementalCostRecord,
    ...safetyEnvelope(),
  });
}

export const PAPER_FORWARD_AUTHORITATIVE_RECORD_PREPARATION_SAFETY = Object.freeze({
  schemaVersion: PAPER_FORWARD_AUTHORITATIVE_RECORD_PREPARATION_VERSION,
  riskPolicyDefaultsAllowed: false,
  riskPercentInvented: false,
  leverageInvented: false,
  marginModeInvented: false,
  liquidityImpactInvented: false,
  partialFillImpactInvented: false,
  missingCostConvertedToZero: false,
  replayBackfillSyntheticCredit: 0,
  economicCreditCreated: false,
  profitabilityCredit: 0,
  scheduleActivationAuthority: false,
  serverMutationAuthority: false,
  executionAuthority: 'NONE',
  privateTradingApiAllowed: false,
  liveTrading: false,
  realOrderEnabled: false,
});
