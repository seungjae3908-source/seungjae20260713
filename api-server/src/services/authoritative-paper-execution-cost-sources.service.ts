import { normalizeBitgetFuturesSymbol } from './bitget-futures-public-evidence.service';
import type { BitgetFuturesPublicEvidence } from './bitget-futures-public-evidence.service';
import type {
  AuthoritativePaperRiskPolicyEvidence,
} from './authoritative-paper-callback-owners.service';
import type { PaperSimulatedExecutionEvidenceInput } from './paper-simulated-execution-evidence.service';
import type {
  ScannerCryptoFuturesPaperExecutionObservation,
} from './scanner-crypto-futures-paper-admission-composer.service';
import type { ScannerCanonicalPaperCandidate } from './scanner-canonical-paper-identity.service';
import type {
  CostEvidenceQuality,
  PercentCostEvidence,
} from './scanner-profit-cost-evidence-adapter.service';
import type {
  AuthoritativePaperRiskPolicyEvidenceV1,
} from './authoritative-paper-risk-sizing-source.service';

export const AUTHORITATIVE_PAPER_EXECUTION_COST_SOURCES_VERSION =
  'authoritative-paper-execution-cost-sources-v1' as const;

export const AUTHORITATIVE_PAPER_EXECUTION_SIZING_EVIDENCE_VERSION =
  'authoritative-paper-execution-sizing-evidence-v1' as const;

export const AUTHORITATIVE_PAPER_FUNDING_HORIZON_COST_VERSION =
  'authoritative-paper-funding-horizon-cost-v1' as const;

const BITGET_BASE_URL = 'https://api.bitget.com';
const PUBLIC_L2_MAXIMUM_AGE_MS = 30_000;
const PUBLIC_L2_LIMIT = '50';
const COST_EVIDENCE_QUALITIES = new Set<CostEvidenceQuality>([
  'OBSERVED',
  'DOCUMENTED',
  'ESTIMATED',
  'NOT_APPLICABLE',
]);

type DepthLevel = readonly [number | string, number | string];

type ExecutionSourceContext = Readonly<{
  card: unknown;
  market: 'CRYPTO_FUTURES';
  signal?: unknown;
}>;

type FetchPublicJson = (
  url: URL,
  input: Readonly<{ provider: string; signal?: AbortSignal }>,
) => Promise<unknown>;

export type AuthoritativePaperExecutionSizingEvidence = Readonly<{
  schemaVersion: typeof AUTHORITATIVE_PAPER_EXECUTION_SIZING_EVIDENCE_VERSION;
  signalId: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  targetQuantity: number;
  riskPolicy: AuthoritativePaperRiskPolicyEvidence;
  source: string;
  observedAtMs: number;
  maximumAgeMs: number;
}>;

export type AuthoritativePaperExecutionObservationInput = Readonly<{
  executionEvidenceInput: PaperSimulatedExecutionEvidenceInput;
  riskPolicy: AuthoritativePaperRiskPolicyEvidence;
  nowMs: number;
}>;

export type SupplementalCostSourceState = 'PRESENT' | 'REFERENCE_ONLY' | 'UNAVAILABLE';

export type SupplementalCostSourceComponent = Readonly<{
  state: SupplementalCostSourceState;
  value: number | null;
  unit: 'PERCENT' | 'MILLISECONDS' | 'QUANTITY' | 'RATIO';
  quality: CostEvidenceQuality | 'OBSERVED_DURATION_ONLY' | 'OBSERVED_PUBLIC_DEPTH' | null;
  source: string | null;
  observedAtMs: number | null;
  countsAsExecutionCost: boolean;
  unavailableIsZero: false;
}>;

type PartialSupplementalCostInput = Readonly<{
  costPolicyId?: string | null;
  observedAtMs?: number | null;
  latency?: PercentCostEvidence | null;
  liquidityImpact?: PercentCostEvidence | null;
  partialFillImpact?: PercentCostEvidence | null;
  funding?: PercentCostEvidence | null;
  nowMs?: number;
  maximumAgeMs?: number;
}>;

export type ResolvedSupplementalCostInput = Readonly<{
  costPolicyId: string;
  observedAtMs: number;
  latency: PercentCostEvidence;
  liquidityImpact: PercentCostEvidence;
  partialFillImpact: PercentCostEvidence;
  funding: PercentCostEvidence;
  nowMs: number;
  maximumAgeMs: number;
}>;

export type AuthoritativeSupplementalCostSourceAudit = Readonly<{
  schemaVersion: typeof AUTHORITATIVE_PAPER_EXECUTION_COST_SOURCES_VERSION;
  status: 'PRESENT' | 'MISSING';
  fullCostReady: boolean;
  components: Readonly<Record<
    'fees' | 'spread' | 'slippage' | 'latency' | 'liquidityImpact' | 'partialFillImpact' | 'funding',
    SupplementalCostSourceComponent
  >>;
  supplementalCostInput: ResolvedSupplementalCostInput | null;
  blockers: readonly string[];
  unknownIsZero: false;
  unavailableCostConvertedToZero: false;
}>;

export type AuthoritativePaperFundingHorizonComponentClass =
  | 'KNOWN_COMPONENT'
  | 'PROJECTED_COMPONENT'
  | 'UNKNOWN_COMPONENT';

export type AuthoritativePaperFundingHorizonComponent = Readonly<{
  componentClass: AuthoritativePaperFundingHorizonComponentClass;
  settlementCount: number;
  firstFundingTimestampMs: number | null;
  lastFundingTimestampMs: number | null;
  fundingRateDecimal: number | null;
  signedCostPercent: number | null;
  executionCostPercent: number | null;
  creditPercent: number | null;
  signedCostAmount: number | null;
  executionCostAmount: number | null;
  creditAmount: number | null;
  realized: false;
  source: string;
}>;

export type AuthoritativePaperFundingPercentCostEvidence = PercentCostEvidence & Readonly<{
  evidenceId: string;
  evidenceClass: 'KNOWN_COMPONENT' | 'PROJECTED_COMPONENT';
  modelId: typeof AUTHORITATIVE_PAPER_FUNDING_HORIZON_COST_VERSION;
  modelVersion: typeof AUTHORITATIVE_PAPER_FUNDING_HORIZON_COST_VERSION;
  provenance: readonly string[];
  maximumAgeMs: number;
  scheduledSettlementCount: 0 | 1;
  signedCostPercent: number;
  creditPercent: number;
  projectedIsRealized: false;
}>;

export type AuthoritativePaperFundingHorizonCostResult = Readonly<{
  schemaVersion: typeof AUTHORITATIVE_PAPER_FUNDING_HORIZON_COST_VERSION;
  status: 'PRESENT' | 'REFERENCE_ONLY' | 'BLOCKED_DATA';
  blockers: readonly string[];
  evidenceId: string | null;
  market: 'CRYPTO_FUTURES' | null;
  symbol: string | null;
  direction: 'LONG' | 'SHORT' | null;
  signalId: string | null;
  strategyId: string | null;
  researchCodeSha: string | null;
  riskPolicyId: string | null;
  riskPolicyVersion: string | null;
  costPolicyId: string | null;
  entryTimestampMs: number | null;
  exitTimestampMs: number | null;
  holdingHorizonMs: number | null;
  positionNotional: number | null;
  fundingRateDecimal: number | null;
  fundingIntervalHours: number | null;
  nextFundingTimestampMs: number | null;
  observedAtMs: number | null;
  maximumAgeMs: number | null;
  ageMs: number | null;
  freshness: 'FRESH' | null;
  source: string | null;
  provenance: readonly string[];
  scheduledSettlementCount: number | null;
  knownComponentCount: number;
  projectedComponentCount: number;
  unknownComponentCount: number;
  components: readonly AuthoritativePaperFundingHorizonComponent[];
  fundingCostEvidence: AuthoritativePaperFundingPercentCostEvidence | null;
  realizedFundingCostPercent: null;
  reconciliation: Readonly<{
    evidenceId: string;
    signalId: string;
    strategyId: string;
    researchCodeSha: string;
    riskPolicyId: string;
    costPolicyId: string;
    entryTimestampMs: number;
    exitTimestampMs: number;
    fundingTimestamps: readonly number[];
    laterUnknownSettlementCount: number;
  }> | null;
  unknownIsZero: false;
  currentRateReplicatedAcrossFutureIntervals: false;
  projectedIsRealized: false;
  executionAuthority: 'NONE';
  privateApiAllowed: false;
  liveTrading: false;
  realOrderCount: 0;
}>;

export type AuthoritativePaperFundingHorizonCostInput = Readonly<{
  candidate: ScannerCanonicalPaperCandidate | unknown;
  riskPolicy: AuthoritativePaperRiskPolicyEvidenceV1 | unknown;
  publicEvidence: BitgetFuturesPublicEvidence | unknown;
  researchCodeSha: string;
  costPolicyId: string;
  entryTimestampMs: number;
  expectedExitTimestampMs: number;
  positionNotional: number;
  nowMs?: number;
  maximumAgeMs?: number;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteScalar(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function nonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function fresh(observedAtMs: number, maximumAgeMs: number, nowMs: number): boolean {
  return positive(observedAtMs) && positive(maximumAgeMs)
    && observedAtMs <= nowMs && nowMs - observedAtMs <= maximumAgeMs;
}

function abortSignal(value: unknown): AbortSignal | undefined {
  return value instanceof AbortSignal ? value : undefined;
}

function freeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
}

function exactSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function nonEmptyStrings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmpty);
}

function normalizedFundingSymbol(value: unknown): string | null {
  if (!nonEmpty(value)) return null;
  try {
    return normalizeBitgetFuturesSymbol(value);
  } catch {
    return null;
  }
}

function blockedFundingHorizonResult(
  blockers: readonly string[],
  partial: Partial<AuthoritativePaperFundingHorizonCostResult> = {},
): AuthoritativePaperFundingHorizonCostResult {
  return freeze({
    schemaVersion: AUTHORITATIVE_PAPER_FUNDING_HORIZON_COST_VERSION,
    status: 'BLOCKED_DATA',
    blockers: [...new Set(blockers)],
    evidenceId: null,
    market: null,
    symbol: null,
    direction: null,
    signalId: null,
    strategyId: null,
    researchCodeSha: null,
    riskPolicyId: null,
    riskPolicyVersion: null,
    costPolicyId: null,
    entryTimestampMs: null,
    exitTimestampMs: null,
    holdingHorizonMs: null,
    positionNotional: null,
    fundingRateDecimal: null,
    fundingIntervalHours: null,
    nextFundingTimestampMs: null,
    observedAtMs: null,
    maximumAgeMs: null,
    ageMs: null,
    freshness: null,
    source: null,
    provenance: [],
    scheduledSettlementCount: null,
    knownComponentCount: 0,
    projectedComponentCount: 0,
    unknownComponentCount: 0,
    components: [],
    fundingCostEvidence: null,
    realizedFundingCostPercent: null,
    reconciliation: null,
    unknownIsZero: false,
    currentRateReplicatedAcrossFutureIntervals: false,
    projectedIsRealized: false,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    realOrderCount: 0,
    ...partial,
  }) as AuthoritativePaperFundingHorizonCostResult;
}

/**
 * Converts one fresh public funding snapshot into a candidate-bound Paper cost.
 * The published current rate is used for the exchange's next funding timestamp
 * only. Later timestamps retain an unknown rate and therefore fail closed.
 */
export function buildAuthoritativePaperFundingHoldingHorizonCost(
  input: AuthoritativePaperFundingHorizonCostInput,
): AuthoritativePaperFundingHorizonCostResult {
  const nowMs = positive(input?.nowMs) ? input.nowMs : Date.now();
  const maximumAgeMs = positive(input?.maximumAgeMs)
    ? input.maximumAgeMs
    : PUBLIC_L2_MAXIMUM_AGE_MS;
  const candidate = record(input?.candidate);
  const signal = record(candidate?.signal);
  const strategyIdentity = record(signal?.strategyIdentity);
  const riskPolicy = record(input?.riskPolicy);
  const publicEvidence = record(input?.publicEvidence);
  const blockers: string[] = [];

  const market = signal?.market === 'CRYPTO_FUTURES' ? 'CRYPTO_FUTURES' as const : null;
  const symbol = normalizedFundingSymbol(signal?.symbol);
  const direction = signal?.direction === 'LONG' || signal?.direction === 'SHORT'
    ? signal.direction
    : null;
  const signalId = nonEmpty(signal?.signalId) ? signal.signalId.trim() : null;
  const strategyId = nonEmpty(strategyIdentity?.strategyId) ? strategyIdentity.strategyId.trim() : null;
  const candidateResearchSha = exactSha(strategyIdentity?.researchCodeSha)
    ? strategyIdentity.researchCodeSha
    : null;
  const candidateCostPolicyId = nonEmpty(strategyIdentity?.costPolicyVersion)
    ? strategyIdentity.costPolicyVersion.trim()
    : null;
  const riskPolicyId = nonEmpty(riskPolicy?.policyId) ? riskPolicy.policyId.trim() : null;
  const riskPolicyVersion = nonEmpty(riskPolicy?.policyVersion) ? riskPolicy.policyVersion.trim() : null;
  const riskPolicySource = nonEmpty(riskPolicy?.source) ? riskPolicy.source.trim() : null;
  const riskPolicyProvenance = nonEmptyStrings(riskPolicy?.provenance)
    ? Object.freeze(riskPolicy.provenance.map((value) => value.trim()))
    : null;
  const costPolicyId = nonEmpty(input?.costPolicyId) ? input.costPolicyId.trim() : null;
  const researchCodeSha = exactSha(input?.researchCodeSha) ? input.researchCodeSha : null;
  const entryTimestampMs = finiteNumber(input?.entryTimestampMs);
  const exitTimestampMs = finiteNumber(input?.expectedExitTimestampMs);
  const positionNotional = finiteNumber(input?.positionNotional);

  if (!positive(nowMs) || !positive(maximumAgeMs)) blockers.push('FUNDING_COST_CLOCK_INVALID');
  if (!candidate || !signal || !strategyIdentity || !signalId || !strategyId) {
    blockers.push('CANONICAL_FUNDING_CANDIDATE_IDENTITY_REQUIRED');
  }
  if (!market) blockers.push('NON_FUNDING_MARKET');
  if (!symbol) blockers.push('CANONICAL_FUNDING_SYMBOL_REQUIRED');
  if (!direction) blockers.push('CANONICAL_FUNDING_DIRECTION_REQUIRED');
  if (candidate?.executionAuthority !== 'NONE'
    || candidate?.liveOrderAllowed !== false
    || candidate?.privateTradingApiAllowed !== false
    || candidate?.orderSubmitted !== false
    || candidate?.exchangeRequestSent !== false) {
    blockers.push('CANONICAL_FUNDING_CANDIDATE_SAFETY_INVALID');
  }
  if (!researchCodeSha || !candidateResearchSha || researchCodeSha !== candidateResearchSha) {
    blockers.push('FUNDING_RESEARCH_SHA_MISMATCH');
  }
  if (!costPolicyId || !candidateCostPolicyId || costPolicyId !== candidateCostPolicyId) {
    blockers.push('FUNDING_COST_POLICY_ID_MISMATCH');
  }
  const signalTimestampMs = finiteNumber(signal?.timestampMs);
  const signalTtlMs = finiteNumber(signal?.ttlMs);
  const candidateExitTimestampMs = finiteNumber(signal?.expiresAtMs);
  if (!positive(signalTimestampMs) || !positive(signalTtlMs) || !positive(candidateExitTimestampMs)
    || candidateExitTimestampMs - signalTimestampMs !== signalTtlMs) {
    blockers.push('FUNDING_HOLDING_HORIZON_MISSING_OR_INVALID');
  }
  if (!positive(entryTimestampMs) || !positive(exitTimestampMs) || exitTimestampMs <= entryTimestampMs) {
    blockers.push('FUNDING_HOLDING_INTERVAL_MISSING_OR_INVALID');
  }
  if (positive(signalTimestampMs) && positive(entryTimestampMs) && entryTimestampMs < signalTimestampMs) {
    blockers.push('FUNDING_ENTRY_PRECEDES_CANDIDATE');
  }
  if (positive(candidateExitTimestampMs) && exitTimestampMs !== candidateExitTimestampMs) {
    blockers.push('FUNDING_EXIT_HORIZON_NOT_CANONICAL');
  }
  if (!positive(positionNotional)) blockers.push('FUNDING_POSITION_NOTIONAL_REQUIRED');

  if (!riskPolicy || riskPolicy.schemaVersion !== 'authoritative-paper-generic-risk-policy-evidence-v1') {
    blockers.push('FUNDING_RISK_POLICY_IDENTITY_REQUIRED');
  }
  if (!riskPolicyId || !riskPolicyVersion || !riskPolicySource || !riskPolicyProvenance) {
    blockers.push('FUNDING_RISK_POLICY_PROVENANCE_REQUIRED');
  }
  if (!fresh(Number(riskPolicy?.observedAtMs), Number(riskPolicy?.maximumAgeMs), nowMs)) {
    blockers.push('FUNDING_RISK_POLICY_STALE_OR_INVALID');
  }
  if (!researchCodeSha || riskPolicy?.researchCodeSha !== researchCodeSha) {
    blockers.push('FUNDING_RISK_POLICY_RESEARCH_SHA_MISMATCH');
  }
  if (!Array.isArray(riskPolicy?.marketScopes) || !riskPolicy.marketScopes.includes('CRYPTO_FUTURES')) {
    blockers.push('FUNDING_RISK_POLICY_MARKET_SCOPE_MISMATCH');
  }
  if (!strategyId || !Array.isArray(riskPolicy?.strategyScopes)
    || !riskPolicy.strategyScopes.includes(strategyId)) {
    blockers.push('FUNDING_RISK_POLICY_STRATEGY_SCOPE_MISMATCH');
  }
  const riskSymbolScopes = riskPolicy?.symbolScopes;
  if (symbol && riskSymbolScopes !== '*' && (!Array.isArray(riskSymbolScopes)
    || !riskSymbolScopes.map(normalizedFundingSymbol).includes(symbol))) {
    blockers.push('FUNDING_RISK_POLICY_SYMBOL_SCOPE_MISMATCH');
  }

  if (!publicEvidence || publicEvidence.provider !== 'bitget'
    || publicEvidence.productType !== 'USDT-FUTURES'
    || publicEvidence.dataQuality !== 'ready') {
    blockers.push('AUTHORITATIVE_PUBLIC_FUNDING_SOURCE_REQUIRED');
  }
  const publicSymbol = normalizedFundingSymbol(publicEvidence?.symbol);
  if (!symbol || !publicSymbol || publicSymbol !== symbol) blockers.push('FUNDING_PUBLIC_SYMBOL_MISMATCH');
  const fundingRateDecimal = finiteNumber(publicEvidence?.fundingRate);
  const fundingIntervalHours = finiteNumber(publicEvidence?.fundingIntervalHours);
  const nextFundingTimestampMs = finiteNumber(publicEvidence?.nextFundingUpdateMs);
  const observedAtMs = finiteNumber(publicEvidence?.observedAtMs);
  if (fundingRateDecimal == null) blockers.push('FUNDING_RATE_MISSING');
  if (!positive(fundingIntervalHours)) blockers.push('FUNDING_INTERVAL_MISSING_OR_INVALID');
  if (!positive(nextFundingTimestampMs)) blockers.push('FUNDING_NEXT_TIMESTAMP_MISSING_OR_INVALID');
  if (!positive(observedAtMs) || !fresh(observedAtMs, maximumAgeMs, nowMs)) {
    blockers.push('FUNDING_SOURCE_STALE_OR_INVALID');
  }
  if (positive(observedAtMs) && positive(entryTimestampMs) && entryTimestampMs < observedAtMs) {
    blockers.push('FUNDING_ENTRY_PRECEDES_SNAPSHOT');
  }
  if (positive(observedAtMs) && positive(nextFundingTimestampMs)
    && nextFundingTimestampMs < observedAtMs) {
    blockers.push('FUNDING_NEXT_TIMESTAMP_PRECEDES_SNAPSHOT');
  }
  if (positive(entryTimestampMs) && positive(nextFundingTimestampMs)
    && nextFundingTimestampMs < entryTimestampMs) {
    blockers.push('FUNDING_NEXT_TIMESTAMP_PRECEDES_ENTRY');
  }

  const partial = {
    market,
    symbol,
    direction,
    signalId,
    strategyId,
    researchCodeSha,
    riskPolicyId,
    riskPolicyVersion,
    costPolicyId,
    entryTimestampMs,
    exitTimestampMs,
    holdingHorizonMs: positive(entryTimestampMs) && positive(exitTimestampMs)
      ? exitTimestampMs - entryTimestampMs
      : null,
    positionNotional: positive(positionNotional) ? positionNotional : null,
    fundingRateDecimal,
    fundingIntervalHours: positive(fundingIntervalHours) ? fundingIntervalHours : null,
    nextFundingTimestampMs: positive(nextFundingTimestampMs) ? nextFundingTimestampMs : null,
    observedAtMs: positive(observedAtMs) ? observedAtMs : null,
    maximumAgeMs,
    ageMs: positive(observedAtMs) && nowMs >= observedAtMs ? nowMs - observedAtMs : null,
    freshness: positive(observedAtMs) && fresh(observedAtMs, maximumAgeMs, nowMs)
      ? 'FRESH' as const
      : null,
  } as const;
  if (blockers.length > 0 || !market || !symbol || !direction || !signalId || !strategyId
    || !researchCodeSha || !riskPolicyId || !riskPolicyVersion || !riskPolicySource
    || !riskPolicyProvenance || !costPolicyId
    || !positive(entryTimestampMs) || !positive(exitTimestampMs) || !positive(positionNotional)
    || fundingRateDecimal == null || !positive(fundingIntervalHours)
    || !positive(nextFundingTimestampMs) || !positive(observedAtMs)) {
    return blockedFundingHorizonResult(blockers, partial);
  }

  const intervalMs = fundingIntervalHours * 60 * 60_000;
  const scheduledSettlementCount = nextFundingTimestampMs > exitTimestampMs
    ? 0
    : 1 + Math.floor((exitTimestampMs - nextFundingTimestampMs) / intervalMs);
  if (!Number.isSafeInteger(scheduledSettlementCount) || scheduledSettlementCount < 0
    || scheduledSettlementCount > 1_000) {
    return blockedFundingHorizonResult(['FUNDING_SETTLEMENT_COUNT_INVALID'], partial);
  }
  const fundingTimestamps = Object.freeze(Array.from(
    { length: scheduledSettlementCount },
    (_, index) => nextFundingTimestampMs + index * intervalMs,
  ));
  const ratePercent = fundingRateDecimal * 100;
  const signedCostPercent = scheduledSettlementCount === 0
    ? 0
    : direction === 'LONG' ? ratePercent : -ratePercent;
  const executionCostPercent = Math.max(0, signedCostPercent);
  const creditPercent = Math.max(0, -signedCostPercent);
  const signedCostAmount = positionNotional * signedCostPercent / 100;
  const executionCostAmount = positionNotional * executionCostPercent / 100;
  const creditAmount = positionNotional * creditPercent / 100;
  const source = 'BITGET_PUBLIC_V2_CURRENT_FUNDING_RATE_HOLDING_HORIZON_V1';
  const provenance = Object.freeze([
    'BITGET_PUBLIC_API_V2_MIX_MARKET_CURRENT_FUND_RATE',
    'BITGET_PUBLIC_CURRENT_FUNDING_RATE_SNAPSHOT',
    'BITGET_PUBLIC_CURRENT_FUNDING_RATE_INTERVAL',
    'BITGET_PUBLIC_CURRENT_FUNDING_NEXT_UPDATE',
    'CANONICAL_CANDIDATE_EXIT_HORIZON',
    `STRATEGY:${strategyId}`,
    `RISK_POLICY:${riskPolicyId}:${riskPolicyVersion}`,
    `COST_POLICY:${costPolicyId}`,
    riskPolicySource,
    ...riskPolicyProvenance,
  ]);
  const evidenceId = [
    AUTHORITATIVE_PAPER_FUNDING_HORIZON_COST_VERSION,
    signalId,
    strategyId,
    symbol,
    direction,
    entryTimestampMs,
    exitTimestampMs,
    nextFundingTimestampMs,
    positionNotional,
    researchCodeSha,
    riskPolicyId,
    costPolicyId,
  ].join(':');
  const laterUnknownSettlementCount = Math.max(0, scheduledSettlementCount - 1);
  const components: AuthoritativePaperFundingHorizonComponent[] = [];
  if (scheduledSettlementCount === 0) {
    components.push({
      componentClass: 'KNOWN_COMPONENT',
      settlementCount: 0,
      firstFundingTimestampMs: null,
      lastFundingTimestampMs: null,
      fundingRateDecimal: 0,
      signedCostPercent: 0,
      executionCostPercent: 0,
      creditPercent: 0,
      signedCostAmount: 0,
      executionCostAmount: 0,
      creditAmount: 0,
      realized: false,
      source: 'NO_FUNDING_SETTLEMENT_WITHIN_CANONICAL_HOLDING_HORIZON',
    });
  } else {
    components.push({
      componentClass: 'PROJECTED_COMPONENT',
      settlementCount: 1,
      firstFundingTimestampMs: nextFundingTimestampMs,
      lastFundingTimestampMs: nextFundingTimestampMs,
      fundingRateDecimal,
      signedCostPercent,
      executionCostPercent,
      creditPercent,
      signedCostAmount,
      executionCostAmount,
      creditAmount,
      realized: false,
      source: 'BITGET_PUBLIC_V2_CURRENT_RATE_FOR_NEXT_FUNDING_TIMESTAMP_ONLY',
    });
  }
  if (laterUnknownSettlementCount > 0) {
    components.push({
      componentClass: 'UNKNOWN_COMPONENT',
      settlementCount: laterUnknownSettlementCount,
      firstFundingTimestampMs: fundingTimestamps[1] ?? null,
      lastFundingTimestampMs: fundingTimestamps.at(-1) ?? null,
      fundingRateDecimal: null,
      signedCostPercent: null,
      executionCostPercent: null,
      creditPercent: null,
      signedCostAmount: null,
      executionCostAmount: null,
      creditAmount: null,
      realized: false,
      source: 'FUTURE_FUNDING_RATE_NOT_YET_OBSERVED',
    });
  }

  const present = laterUnknownSettlementCount === 0;
  const fundingCostEvidence: AuthoritativePaperFundingPercentCostEvidence | null = present
    ? freeze({
      valuePercent: executionCostPercent,
      quality: 'ESTIMATED' as const,
      source,
      observedAtMs,
      evidenceId,
      evidenceClass: scheduledSettlementCount === 0
        ? 'KNOWN_COMPONENT' as const
        : 'PROJECTED_COMPONENT' as const,
      modelId: AUTHORITATIVE_PAPER_FUNDING_HORIZON_COST_VERSION,
      modelVersion: AUTHORITATIVE_PAPER_FUNDING_HORIZON_COST_VERSION,
      provenance,
      maximumAgeMs,
      scheduledSettlementCount: scheduledSettlementCount as 0 | 1,
      signedCostPercent,
      creditPercent,
      projectedIsRealized: false as const,
    }) as AuthoritativePaperFundingPercentCostEvidence
    : null;
  const referenceBlockers = present
    ? []
    : ['FUTURE_FUNDING_RATE_UNKNOWN_FOR_LATER_BOUNDARIES'];
  return freeze({
    schemaVersion: AUTHORITATIVE_PAPER_FUNDING_HORIZON_COST_VERSION,
    status: present ? 'PRESENT' as const : 'REFERENCE_ONLY' as const,
    blockers: referenceBlockers,
    evidenceId,
    ...partial,
    source,
    provenance,
    scheduledSettlementCount,
    knownComponentCount: scheduledSettlementCount === 0 ? 1 : 0,
    projectedComponentCount: scheduledSettlementCount > 0 ? 1 : 0,
    unknownComponentCount: laterUnknownSettlementCount,
    components: Object.freeze(components.map((component) => freeze(component))),
    fundingCostEvidence,
    realizedFundingCostPercent: null,
    reconciliation: freeze({
      evidenceId,
      signalId,
      strategyId,
      researchCodeSha,
      riskPolicyId,
      costPolicyId,
      entryTimestampMs,
      exitTimestampMs,
      fundingTimestamps,
      laterUnknownSettlementCount,
    }),
    unknownIsZero: false,
    currentRateReplicatedAcrossFutureIntervals: false,
    projectedIsRealized: false,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    realOrderCount: 0,
  }) as AuthoritativePaperFundingHorizonCostResult;
}

function scannerExecutionIdentity(context: ExecutionSourceContext): Readonly<{
  signalId: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
}> | null {
  const card = record(context?.card);
  if (!card || context?.market !== 'CRYPTO_FUTURES') return null;
  const signalId = nonEmpty(card.signalId) ? card.signalId.trim() : null;
  const direction = card.action === 'LONG' || card.action === 'SHORT' ? card.action : null;
  if (!signalId || !nonEmpty(card.symbol) || !direction) return null;
  try {
    return freeze({ signalId, symbol: normalizeBitgetFuturesSymbol(card.symbol), direction });
  } catch {
    return null;
  }
}

function validDepthLevel(value: unknown): value is DepthLevel {
  if (!Array.isArray(value) || value.length < 2) return false;
  const price = finiteScalar(value[0]);
  const size = finiteScalar(value[1]);
  return positive(price) && positive(size);
}

function normalizedLevels(value: unknown): readonly DepthLevel[] {
  return Array.isArray(value)
    ? Object.freeze(value.filter(validDepthLevel).map((level) => Object.freeze([level[0], level[1]] as const)))
    : Object.freeze([]);
}

function bitgetPublicL2Url(symbol: string): URL {
  const url = new URL('/api/v3/market/orderbook', BITGET_BASE_URL);
  url.search = new URLSearchParams({
    category: 'USDT-FUTURES',
    symbol: normalizeBitgetFuturesSymbol(symbol),
    limit: PUBLIC_L2_LIMIT,
  }).toString();
  return url;
}

function validatedSizingSnapshot(
  sizing: AuthoritativePaperExecutionSizingEvidence,
  identity: NonNullable<ReturnType<typeof scannerExecutionIdentity>>,
  nowMs: number,
): AuthoritativePaperExecutionSizingEvidence | null {
  const policy = sizing?.riskPolicy;
  const valid = sizing?.schemaVersion === AUTHORITATIVE_PAPER_EXECUTION_SIZING_EVIDENCE_VERSION
    && sizing.signalId === identity.signalId
    && sizing.symbol === identity.symbol
    && sizing.direction === identity.direction
    && positive(sizing.targetQuantity)
    && nonEmpty(sizing.source)
    && fresh(sizing.observedAtMs, sizing.maximumAgeMs, nowMs)
    && policy?.schemaVersion === 'authoritative-paper-risk-policy-evidence-v1'
    && positive(policy.leverage)
    && positive(policy.riskPercent)
    && policy.riskPercent <= 1
    && (policy.marginMode === 'isolated' || policy.marginMode === 'cross')
    && nonEmpty(policy.source)
    && fresh(policy.observedAtMs, policy.maximumAgeMs, nowMs);
  if (!valid) return null;
  return freeze({
    schemaVersion: sizing.schemaVersion,
    signalId: sizing.signalId,
    symbol: sizing.symbol,
    direction: sizing.direction,
    targetQuantity: sizing.targetQuantity,
    riskPolicy: {
      schemaVersion: policy.schemaVersion,
      leverage: policy.leverage,
      riskPercent: policy.riskPercent,
      marginMode: policy.marginMode,
      source: policy.source.trim(),
      observedAtMs: policy.observedAtMs,
      maximumAgeMs: policy.maximumAgeMs,
    },
    source: sizing.source.trim(),
    observedAtMs: sizing.observedAtMs,
    maximumAgeMs: sizing.maximumAgeMs,
  });
}

export async function collectAuthoritativePaperExecutionObservationInput(input: Readonly<{
  context: ExecutionSourceContext;
  sizingEvidence: AuthoritativePaperExecutionSizingEvidence;
  fetchPublicJson: FetchPublicJson;
  now?: () => number;
}>): Promise<AuthoritativePaperExecutionObservationInput | null> {
  if (typeof input?.fetchPublicJson !== 'function') throw new TypeError('PUBLIC_L2_FETCH_REQUIRED');
  const now = input.now ?? Date.now;
  if (typeof now !== 'function') throw new TypeError('PUBLIC_L2_CLOCK_REQUIRED');
  const identity = scannerExecutionIdentity(input.context);
  const requestStartedAtMs = now();
  if (!identity || !positive(requestStartedAtMs)) return null;
  const sizing = validatedSizingSnapshot(input.sizingEvidence, identity, requestStartedAtMs);
  if (!sizing) return null;

  const payload = record(await input.fetchPublicJson(bitgetPublicL2Url(identity.symbol), {
    provider: 'bitget',
    signal: abortSignal(input.context.signal),
  }));
  const requestCompletedAtMs = now();
  if (!positive(requestCompletedAtMs) || requestCompletedAtMs < requestStartedAtMs) return null;
  if (!payload || payload.code !== '00000') return null;
  const data = record(payload.data);
  const observedAtMs = finiteScalar(data?.ts);
  const bids = normalizedLevels(data?.b);
  const asks = normalizedLevels(data?.a);
  if (!observedAtMs || observedAtMs > requestCompletedAtMs
    || requestCompletedAtMs - observedAtMs > PUBLIC_L2_MAXIMUM_AGE_MS
    || bids.length === 0 || asks.length === 0) return null;

  return freeze({
    executionEvidenceInput: {
      source: 'BITGET_PUBLIC_UTA_V3_ORDERBOOK',
      market: 'CRYPTO_FUTURES',
      symbol: identity.symbol,
      direction: identity.direction,
      targetQuantity: sizing.targetQuantity,
      bids,
      asks,
      observedAtMs,
      requestStartedAtMs,
      requestCompletedAtMs,
      maximumAgeMs: PUBLIC_L2_MAXIMUM_AGE_MS,
      provenance: Object.freeze(['SIMULATED', 'public-L2', 'bitget-public-uta-v3-orderbook']),
      calibratedFillModel: null,
    },
    riskPolicy: sizing.riskPolicy,
    nowMs: requestCompletedAtMs,
  });
}

function unavailable(
  unit: SupplementalCostSourceComponent['unit'] = 'PERCENT',
): SupplementalCostSourceComponent {
  return freeze({
    state: 'UNAVAILABLE',
    value: null,
    unit,
    quality: null,
    source: null,
    observedAtMs: null,
    countsAsExecutionCost: false,
    unavailableIsZero: false,
  });
}

function componentFromPercentEvidence(
  value: PercentCostEvidence | null | undefined,
  nowMs: number,
  maximumAgeMs: number,
): SupplementalCostSourceComponent | null {
  if (!value || !nonNegative(value.valuePercent) || !nonEmpty(value.source)
    || !COST_EVIDENCE_QUALITIES.has(value.quality)
    || !fresh(value.observedAtMs, maximumAgeMs, nowMs)
    || value.quality === 'NOT_APPLICABLE') return null;
  return freeze({
    state: 'PRESENT',
    value: value.valuePercent,
    unit: 'PERCENT',
    quality: value.quality,
    source: value.source.trim(),
    observedAtMs: value.observedAtMs,
    countsAsExecutionCost: true,
    unavailableIsZero: false,
  });
}

function publicPercent(
  value: number | null,
  quality: CostEvidenceQuality,
  source: string,
  observedAtMs: number | null,
  nowMs: number,
  maximumAgeMs: number,
): SupplementalCostSourceComponent {
  return value != null && value >= 0 && observedAtMs != null
    && fresh(observedAtMs, maximumAgeMs, nowMs)
    ? freeze({
      state: 'PRESENT',
      value,
      unit: 'PERCENT' as const,
      quality,
      source,
      observedAtMs,
      countsAsExecutionCost: true,
      unavailableIsZero: false as const,
    })
    : unavailable();
}

function referenceOnly(
  value: number | null,
  unit: SupplementalCostSourceComponent['unit'],
  quality: SupplementalCostSourceComponent['quality'],
  source: string | null,
  observedAtMs: number | null,
  nowMs: number,
  maximumAgeMs: number,
): SupplementalCostSourceComponent {
  return (value == null || Number.isFinite(value)) && source && observedAtMs != null
    && fresh(observedAtMs, maximumAgeMs, nowMs)
    ? freeze({
      state: 'REFERENCE_ONLY' as const,
      value,
      unit,
      quality,
      source,
      observedAtMs,
      countsAsExecutionCost: false as const,
      unavailableIsZero: false as const,
    })
    : unavailable(unit);
}

function spreadPercent(publicEvidence: BitgetFuturesPublicEvidence | null | undefined): number | null {
  const bid = publicEvidence?.bidPrice;
  const ask = publicEvidence?.askPrice;
  if (!positive(bid) || !positive(ask) || ask < bid) return null;
  const midpoint = (bid + ask) / 2;
  return midpoint > 0 ? (ask - bid) / midpoint * 100 : null;
}

function observationRecord(
  observation: ScannerCryptoFuturesPaperExecutionObservation | null | undefined,
): Record<string, unknown> | null {
  return record(observation);
}

function resolvedSupplementalCostInput(
  input: PartialSupplementalCostInput | null | undefined,
  nowMs: number,
  maximumAgeMs: number,
): ResolvedSupplementalCostInput | null {
  if (!input || !nonEmpty(input.costPolicyId) || !positive(input.observedAtMs)
    || !fresh(input.observedAtMs, maximumAgeMs, nowMs)) return null;
  const latency = componentFromPercentEvidence(input.latency, nowMs, maximumAgeMs);
  const liquidityImpact = componentFromPercentEvidence(input.liquidityImpact, nowMs, maximumAgeMs);
  const partialFillImpact = componentFromPercentEvidence(input.partialFillImpact, nowMs, maximumAgeMs);
  const funding = componentFromPercentEvidence(input.funding, nowMs, maximumAgeMs);
  if (!latency || !liquidityImpact || !partialFillImpact || !funding) return null;
  return freeze({
    costPolicyId: input.costPolicyId.trim(),
    observedAtMs: input.observedAtMs,
    latency: input.latency as PercentCostEvidence,
    liquidityImpact: input.liquidityImpact as PercentCostEvidence,
    partialFillImpact: input.partialFillImpact as PercentCostEvidence,
    funding: input.funding as PercentCostEvidence,
    nowMs,
    maximumAgeMs,
  });
}

export function auditAuthoritativeSupplementalCostSources(input: Readonly<{
  publicEvidence?: BitgetFuturesPublicEvidence | null;
  executionObservation?: ScannerCryptoFuturesPaperExecutionObservation | null;
  supplemental?: PartialSupplementalCostInput | null;
  nowMs?: number;
  maximumAgeMs?: number;
}> = {}): AuthoritativeSupplementalCostSourceAudit {
  const nowMs = positive(input.nowMs) ? input.nowMs : Date.now();
  const maximumAgeMs = positive(input.maximumAgeMs) ? input.maximumAgeMs : PUBLIC_L2_MAXIMUM_AGE_MS;
  const publicEvidence = input.publicEvidence;
  const execution = observationRecord(input.executionObservation);
  const slippage = record(execution?.slippage);
  const latency = record(execution?.latency);
  const liquidity = record(execution?.liquidity);
  const partialFill = record(execution?.partialFill);
  const supplemental = input.supplemental;
  const resolved = resolvedSupplementalCostInput(supplemental, nowMs, maximumAgeMs);

  const latencyCost = componentFromPercentEvidence(supplemental?.latency, nowMs, maximumAgeMs);
  const liquidityImpactCost = componentFromPercentEvidence(supplemental?.liquidityImpact, nowMs, maximumAgeMs);
  const partialFillImpactCost = componentFromPercentEvidence(supplemental?.partialFillImpact, nowMs, maximumAgeMs);
  const fundingCost = supplemental?.funding?.quality === 'NOT_APPLICABLE'
    ? null
    : componentFromPercentEvidence(supplemental?.funding, nowMs, maximumAgeMs);
  const blockers: string[] = [];
  if (!supplemental || !nonEmpty(supplemental.costPolicyId)) {
    blockers.push('SUPPLEMENTAL_COST_POLICY_EVIDENCE_UNAVAILABLE');
  }
  if (!supplemental || !positive(supplemental.observedAtMs)
    || !fresh(supplemental.observedAtMs, maximumAgeMs, nowMs)) {
    blockers.push('SUPPLEMENTAL_COST_OBSERVATION_UNAVAILABLE');
  }
  if (!latencyCost) blockers.push('LATENCY_COST_EVIDENCE_UNAVAILABLE');
  if (!liquidityImpactCost) blockers.push('LIQUIDITY_IMPACT_COST_EVIDENCE_UNAVAILABLE');
  if (!partialFillImpactCost) blockers.push('PARTIAL_FILL_COST_EVIDENCE_UNAVAILABLE');
  if (!fundingCost) blockers.push('FUNDING_EXECUTION_COST_EVIDENCE_UNAVAILABLE');

  const observedAtMs = positive(publicEvidence?.observedAtMs) ? publicEvidence.observedAtMs : null;
  const slippagePercent = finiteNumber(slippage?.valuePercent);
  const slippageAtMs = finiteNumber(slippage?.observedAtMs);
  const slippageQuality = slippage?.quality !== 'NOT_APPLICABLE'
    && COST_EVIDENCE_QUALITIES.has(slippage?.quality as CostEvidenceQuality)
    ? slippage?.quality as CostEvidenceQuality
    : null;
  const observedRoundTripMs = finiteNumber(latency?.observedRoundTripMs);
  const latencyAtMs = finiteNumber(latency?.observedAtMs);
  const visibleLiquidity = finiteNumber(liquidity?.value);
  const liquidityAtMs = finiteNumber(liquidity?.observedAtMs);
  const partialFillAtMs = finiteNumber(partialFill?.observedAtMs);
  const fundingRate = finiteNumber(publicEvidence?.fundingRate);
  const takerFeeRate = finiteNumber(publicEvidence?.takerFeeRate);
  const fundingRatePercent = fundingRate == null ? null : fundingRate * 100;

  const components = freeze({
      fees: publicPercent(
        takerFeeRate == null ? null : takerFeeRate * 100,
        'DOCUMENTED',
        'BITGET_PUBLIC_CONTRACT_TAKER_FEE_RATE',
        observedAtMs,
        nowMs,
        maximumAgeMs,
      ),
      spread: publicPercent(
        spreadPercent(publicEvidence),
        'OBSERVED',
        'BITGET_PUBLIC_BEST_BID_ASK',
        positive(publicEvidence?.tickerTimestampMs) ? publicEvidence.tickerTimestampMs : null,
        nowMs,
        maximumAgeMs,
      ),
      slippage: slippagePercent != null && slippagePercent >= 0
        && slippageQuality != null
        && nonEmpty(slippage?.source) && slippageAtMs != null
        && fresh(slippageAtMs, maximumAgeMs, nowMs)
        ? freeze({
          state: 'PRESENT' as const,
          value: slippagePercent,
          unit: 'PERCENT' as const,
          quality: slippageQuality,
          source: String(slippage.source),
          observedAtMs: slippageAtMs,
          countsAsExecutionCost: true as const,
          unavailableIsZero: false as const,
        })
        : unavailable(),
      latency: latencyCost ?? referenceOnly(
        observedRoundTripMs,
        'MILLISECONDS',
        'OBSERVED_DURATION_ONLY',
        nonEmpty(latency?.source) ? latency.source : null,
        latencyAtMs,
        nowMs,
        maximumAgeMs,
      ),
      liquidityImpact: liquidityImpactCost ?? referenceOnly(
        visibleLiquidity,
        'QUANTITY',
        'OBSERVED_PUBLIC_DEPTH',
        nonEmpty(liquidity?.source) ? liquidity.source : null,
        liquidityAtMs,
        nowMs,
        maximumAgeMs,
      ),
      partialFillImpact: partialFillImpactCost ?? referenceOnly(
        null,
        'RATIO',
        'OBSERVED_PUBLIC_DEPTH',
        nonEmpty(partialFill?.source) ? partialFill.source : null,
        partialFillAtMs,
        nowMs,
        maximumAgeMs,
      ),
      funding: fundingCost ?? referenceOnly(
        fundingRatePercent,
        'PERCENT',
        'OBSERVED',
        fundingRatePercent == null ? null : 'BITGET_PUBLIC_CURRENT_FUNDING_RATE_SNAPSHOT',
        observedAtMs,
        nowMs,
        maximumAgeMs,
      ),
  });
  if (components.fees.state !== 'PRESENT') blockers.push('FEE_COST_EVIDENCE_UNAVAILABLE');
  if (components.spread.state !== 'PRESENT') blockers.push('SPREAD_COST_EVIDENCE_UNAVAILABLE');
  if (components.slippage.state !== 'PRESENT') blockers.push('SLIPPAGE_COST_EVIDENCE_UNAVAILABLE');
  const fullCostReady = resolved != null
    && Object.values(components).every((component) => (
      component.state === 'PRESENT' && component.countsAsExecutionCost
    ));

  return freeze({
    schemaVersion: AUTHORITATIVE_PAPER_EXECUTION_COST_SOURCES_VERSION,
    status: fullCostReady ? 'PRESENT' : 'MISSING',
    fullCostReady,
    components,
    supplementalCostInput: resolved,
    blockers: Object.freeze(blockers),
    unknownIsZero: false,
    unavailableCostConvertedToZero: false,
  });
}

export const AUTHORITATIVE_PAPER_EXECUTION_COST_SOURCES_SAFETY = Object.freeze({
  schemaVersion: AUTHORITATIVE_PAPER_EXECUTION_COST_SOURCES_VERSION,
  executionMode: 'SIMULATED_EXECUTION_ONLY',
  executionAuthority: 'NONE',
  publicL2Only: true,
  publicDepthIsFillProof: false,
  realFillObserved: false,
  realFillClaimAllowed: false,
  liveSubmittedExecutionSampleCredit: 0,
  unavailableCostConvertedToZero: false,
  privateApiAllowed: false,
  liveTrading: false,
  orderSubmissionAllowed: false,
  financialMutationAllowed: false,
});
