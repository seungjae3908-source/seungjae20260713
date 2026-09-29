import { selectBitgetPositionTier } from '../../../market-prediction-lab/src/bitget-position-tier-v1.js';
import type { BitgetFuturesPublicEvidence } from './bitget-futures-public-evidence.service';
import {
  buildPaperSimulatedExecutionEvidence,
  type PaperSimulatedExecutionEvidenceInput,
} from './paper-simulated-execution-evidence.service';
import {
  validateImmutablePaperTradingStateSnapshot,
  type PaperTradingStateSnapshot,
} from './paper-trading-state-snapshot.service';
import type { PaperContractRules, PaperTradingState } from './paper-trading.types';
import type { ScannerCryptoFuturesPaperExecutionObservation } from './scanner-crypto-futures-paper-admission-composer.service';
import type {
  CostEvidenceQuality,
  PercentCostEvidence,
  SupplementalExecutionCostEvidence,
} from './scanner-profit-cost-evidence-adapter.service';

export const AUTHORITATIVE_PAPER_CALLBACK_OWNERS_VERSION =
  'authoritative-paper-callback-owners-v1' as const;

const QUALITIES = new Set<CostEvidenceQuality>(['OBSERVED', 'DOCUMENTED', 'ESTIMATED', 'NOT_APPLICABLE']);

export type AuthoritativePaperRiskPolicyEvidence = Readonly<{
  schemaVersion: 'authoritative-paper-risk-policy-evidence-v1';
  leverage: number;
  riskPercent: number;
  marginMode: 'isolated' | 'cross';
  source: string;
  observedAtMs: number;
  maximumAgeMs: number;
}>;

export type SizedContractRulesEvidence = Readonly<{
  schemaVersion: 'sized-bitget-paper-contract-rules-v1';
  contractRules: PaperContractRules;
  riskPolicy: AuthoritativePaperRiskPolicyEvidence;
  sizedNotional: number;
  selectedTier: Readonly<Record<string, unknown>>;
  provenance: readonly string[];
  executionAuthority: 'NONE';
  privateApiAllowed: false;
  liveTrading: false;
  financialMutationAllowed: false;
}>;

type SupplementalCostInputs = Readonly<{
  costPolicyId: string;
  observedAtMs: number;
  latency: PercentCostEvidence;
  liquidityImpact: PercentCostEvidence;
  partialFillImpact: PercentCostEvidence;
  funding: PercentCostEvidence;
  nowMs?: number;
  maximumAgeMs?: number;
}>;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function nonNegative(value: unknown): value is number {
  return finite(value) && value >= 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function fresh(observedAtMs: number, maximumAgeMs: number, nowMs: number): boolean {
  return positive(observedAtMs) && positive(maximumAgeMs)
    && observedAtMs <= nowMs && nowMs - observedAtMs <= maximumAgeMs;
}

function freeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
}

function riskPolicy(value: AuthoritativePaperRiskPolicyEvidence, nowMs: number): AuthoritativePaperRiskPolicyEvidence {
  if (value?.schemaVersion !== 'authoritative-paper-risk-policy-evidence-v1'
    || !positive(value.leverage)
    || !positive(value.riskPercent)
    || value.riskPercent > 1
    || (value.marginMode !== 'isolated' && value.marginMode !== 'cross')
    || !nonEmpty(value.source)
    || !fresh(value.observedAtMs, value.maximumAgeMs, nowMs)) {
    throw new Error('AUTHORITATIVE_PAPER_RISK_POLICY_EVIDENCE_INVALID');
  }
  return freeze({ ...value, source: value.source.trim() }) as AuthoritativePaperRiskPolicyEvidence;
}

export function paperStateFromAuthoritativeSnapshot(
  snapshot: PaperTradingStateSnapshot | unknown,
  nowMs = Date.now(),
): Readonly<PaperTradingState> {
  return validateImmutablePaperTradingStateSnapshot(snapshot, nowMs).state;
}

export function buildAuthoritativeSizedContractRules(input: Readonly<{
  publicEvidence: BitgetFuturesPublicEvidence;
  positionTiers: readonly unknown[];
  sizedNotional: number;
  quantityPrecision: number;
  riskPolicy: AuthoritativePaperRiskPolicyEvidence;
  observedAtMs: number;
  nowMs?: number;
  maximumAgeMs?: number;
}>): SizedContractRulesEvidence {
  const nowMs = input.nowMs ?? Date.now();
  const maximumAgeMs = input.maximumAgeMs ?? 30_000;
  const evidence = input.publicEvidence;
  if (evidence?.provider !== 'bitget' || evidence.dataQuality !== 'ready'
    || !positive(input.sizedNotional)
    || !fresh(input.observedAtMs, maximumAgeMs, nowMs)
    || !positive(evidence.sizeMultiplier)
    || !Number.isInteger(input.quantityPrecision) || input.quantityPrecision < 0
    || !positive(evidence.minTradeNum)
    || !positive(evidence.minTradeUsdt)
    || !positive(evidence.maxLeverage)) {
    throw new Error('AUTHORITATIVE_SIZED_CONTRACT_INPUT_INVALID');
  }
  const policy = riskPolicy(input.riskPolicy, nowMs);
  if (policy.leverage > evidence.maxLeverage) throw new Error('AUTHORITATIVE_RISK_POLICY_LEVERAGE_EXCEEDS_CONTRACT');
  const selectedTier = selectBitgetPositionTier(input.positionTiers, input.sizedNotional);
  const contractRules: PaperContractRules = freeze({
    symbol: evidence.symbol,
    quantityStep: evidence.sizeMultiplier,
    quantityPrecision: input.quantityPrecision,
    minimumQuantity: evidence.minTradeNum,
    minimumNotional: evidence.minTradeUsdt,
    maximumLeverage: evidence.maxLeverage,
    maintenanceMarginRate: selectedTier.maintenanceMarginRate,
    status: 'live',
    updatedAt: new Date(input.observedAtMs).toISOString(),
    warnings: [],
  }) as PaperContractRules;
  return freeze({
    schemaVersion: 'sized-bitget-paper-contract-rules-v1',
    contractRules,
    riskPolicy: policy,
    sizedNotional: input.sizedNotional,
    selectedTier,
    provenance: [
      'bitget-public-v2-contracts',
      'bitget-public-v2-query-position-lever',
      policy.source,
    ],
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
  }) as SizedContractRulesEvidence;
}

export function buildAuthoritativePaperExecutionObservation(input: Readonly<{
  executionEvidenceInput: PaperSimulatedExecutionEvidenceInput;
  riskPolicy: AuthoritativePaperRiskPolicyEvidence;
  nowMs?: number;
}>): ScannerCryptoFuturesPaperExecutionObservation {
  const nowMs = input.nowMs ?? Date.now();
  const policy = riskPolicy(input.riskPolicy, nowMs);
  const evidence = buildPaperSimulatedExecutionEvidence({
    ...input.executionEvidenceInput,
    nowMs,
  }) as Readonly<Record<string, unknown>>;
  const observed = evidence.observed as Readonly<Record<string, unknown>> | undefined;
  const latency = observed?.latencyEvidence as Readonly<Record<string, unknown>> | undefined;
  const estimated = evidence.estimated as Readonly<Record<string, unknown>> | undefined;
  const slippage = estimated?.slippageEstimate as Readonly<Record<string, unknown>> | undefined;
  const liquidity = estimated?.liquidityEvidence as Readonly<Record<string, unknown>> | undefined;
  const paperSimulation = evidence.paperSimulation as Readonly<Record<string, unknown>> | undefined;
  const liveGradeFillReadiness = evidence.liveGradeFillReadiness as Readonly<Record<string, unknown>> | undefined;
  if (paperSimulation?.status !== 'READY'
    || paperSimulation?.evidenceClass !== 'SIMULATED'
    || paperSimulation?.marketDataClass !== 'public-L2'
    || paperSimulation?.realFillClaim !== false
    || paperSimulation?.publicDepthIsFillProof !== false
    || slippage?.quality !== 'ESTIMATED'
    || !nonNegative(slippage.percent)
    || !positive(liquidity?.visibleExecutableQuantity)
    || !positive(liquidity?.visibleCoverageRatio)
    || Number(liquidity.visibleCoverageRatio) < 1) {
    throw new Error('AUTHORITATIVE_EXECUTION_OBSERVATION_DATA_UNAVAILABLE');
  }
  const observedAtMs = input.executionEvidenceInput.observedAtMs;
  const provenance = Array.isArray(evidence.provenance)
    ? evidence.provenance.filter(nonEmpty)
    : [];
  if (!provenance.includes('SIMULATED') || !provenance.includes('public-L2')) {
    throw new Error('AUTHORITATIVE_EXECUTION_OBSERVATION_PROVENANCE_INVALID');
  }
  return freeze({
    providerProvenance: provenance.join('+'),
    slippage: {
      valuePercent: Number(slippage.percent),
      quality: 'ESTIMATED',
      source: String(slippage.model ?? 'VISIBLE_L2_BOOK_WALK_ONLY'),
      observedAtMs,
    },
    liquidity: {
      value: Number(liquidity.visibleExecutableQuantity),
      source: 'BITGET_PUBLIC_VISIBLE_L2_EXECUTABLE_QUANTITY',
      observedAtMs,
    },
    partialFill: {
      model: 'ORDER_BOOK',
      source: 'SIMULATED/public-L2:VISIBLE_L2_BOOK_WALK_ONLY',
      observedAtMs,
    },
    latency: {
      observedRoundTripMs: nonNegative(latency?.observedRoundTripMs)
        ? Number(latency.observedRoundTripMs)
        : null,
      costValuePercent: null,
      source: 'BITGET_PUBLIC_L2_REQUEST_TIMING',
      observedAtMs,
    },
    executionProvenance: {
      evidenceClass: 'SIMULATED',
      marketDataClass: 'public-L2',
      executionMode: 'SIMULATED_EXECUTION_ONLY',
      realFillObserved: false,
      realFillClaim: false,
      publicDepthIsFillProof: false,
      liveSubmittedExecutionSampleCredit: 0,
      liveFillCalibrationStatus: liveGradeFillReadiness?.status === 'READY'
        || liveGradeFillReadiness?.status === 'VETO'
        ? liveGradeFillReadiness.status
        : 'BLOCKED_DATA',
    },
    leverage: policy.leverage,
    riskPercent: policy.riskPercent,
    marginMode: policy.marginMode,
  }) as ScannerCryptoFuturesPaperExecutionObservation;
}

function validatedComponent(
  value: PercentCostEvidence,
  nowMs: number,
  maximumAgeMs: number,
  code: string,
): PercentCostEvidence {
  if (!value || !nonNegative(value.valuePercent) || !QUALITIES.has(value.quality)
    || !nonEmpty(value.source) || !fresh(value.observedAtMs, maximumAgeMs, nowMs)
    || (value.quality === 'NOT_APPLICABLE' && value.valuePercent !== 0)) {
    throw new Error(code);
  }
  return freeze({ ...value, source: value.source.trim() }) as PercentCostEvidence;
}

export function buildAuthoritativeSupplementalCostEvidence(
  input: SupplementalCostInputs,
): SupplementalExecutionCostEvidence {
  const nowMs = input.nowMs ?? Date.now();
  const maximumAgeMs = input.maximumAgeMs ?? 30_000;
  if (!nonEmpty(input.costPolicyId) || !fresh(input.observedAtMs, maximumAgeMs, nowMs)) {
    throw new Error('AUTHORITATIVE_COST_POLICY_EVIDENCE_INVALID');
  }
  return freeze({
    costPolicyId: input.costPolicyId.trim(),
    observedAtMs: input.observedAtMs,
    latency: validatedComponent(input.latency, nowMs, maximumAgeMs, 'AUTHORITATIVE_LATENCY_COST_EVIDENCE_REQUIRED'),
    liquidityImpact: validatedComponent(input.liquidityImpact, nowMs, maximumAgeMs, 'AUTHORITATIVE_LIQUIDITY_COST_EVIDENCE_REQUIRED'),
    partialFillImpact: validatedComponent(input.partialFillImpact, nowMs, maximumAgeMs, 'AUTHORITATIVE_PARTIAL_FILL_COST_EVIDENCE_REQUIRED'),
    funding: validatedComponent(input.funding, nowMs, maximumAgeMs, 'AUTHORITATIVE_FUNDING_COST_EVIDENCE_REQUIRED'),
  }) as SupplementalExecutionCostEvidence;
}

export const AUTHORITATIVE_PAPER_CALLBACK_OWNERS_SAFETY = Object.freeze({
  schemaVersion: AUTHORITATIVE_PAPER_CALLBACK_OWNERS_VERSION,
  owners: Object.freeze([
    'paperStateForCard',
    'contractRulesForCard',
    'executionObservationForCard',
    'supplementalCostEvidenceForCard',
  ]),
  ownerMissingCount: 0,
  dataReadiness: 'RUNTIME_VALIDATED_BLOCKED_DATA',
  recurringLedgerDerivationAllowed: false,
  scalarMaintenanceMarginDefaultAllowed: false,
  uncalibratedFillClaimAllowed: false,
  paperPublicL2SimulationAllowed: true,
  liveFillCalibrationRequiredForPaperObservation: false,
  liveFillCalibrationRequiredForRealFillClaim: true,
  supplementalFullCostEvidenceRequiredForAdmission: true,
  unknownCostIsZero: false,
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  liveTrading: false,
  scheduleActivationAuthority: false,
  financialMutationAllowed: false,
});
