import { createHash } from 'node:crypto';
import type { ScannerCanonicalPaperCandidate } from './scanner-canonical-paper-identity.service.js';
import type { SignalSnapshot } from './signal-performance-learning.service.js';
import type { RiskEngineInput, RiskEngineResult } from './trading-risk-engine.service.js';
import {
  buildScannerTradingCostPolicy,
  type ScannerCostEvidenceProvenance,
  type SupplementalExecutionCostEvidence,
} from './scanner-profit-cost-evidence-adapter.service.js';
import {
  validatePaperReadiness,
  type PaperReadinessEvidence,
} from './trade-paper-market-contract.service.js';

export const SCANNER_PAPER_ADMISSION_BUNDLE_VERSION = 'scanner-paper-admission-evidence-bundle-v1' as const;
export const SCANNER_PAPER_ADMISSION_EXECUTION_AUTHORITY = 'NONE' as const;

export type CanonicalPaperExecutionCostPolicy = Readonly<{
  version: string;
  commissionRate: number;
  taxRate: number;
  spreadRate: number;
  slippageRate: number;
  fundingRate: number;
  latencyRate: number;
  liquidityImpactRate: number;
  partialFillImpactRate: number;
  source: 'SCANNER_COST_EVIDENCE_PERCENT_DIV_100';
  unitConversion: 'PERCENT_DIV_100';
}>;

export type CanonicalPaperRiskEvidence = Readonly<{
  status: 'APPROVED';
  source: 'TRADING_RISK_ENGINE';
  evaluatedAtMs: number;
  simulatedOnly: true;
  allowed: true;
  blockCodes: readonly string[];
  recommendedQuantity: number;
  actualRiskPercent: number | null;
  riskReward1: number | null;
  riskReward2: number | null;
  executionAuthority: 'NONE';
}>;

export type CanonicalPaperAdmissionEvidenceBundle = Readonly<{
  schemaVersion: typeof SCANNER_PAPER_ADMISSION_BUNDLE_VERSION;
  paperCandidate: ScannerCanonicalPaperCandidate;
  learningSnapshot: SignalSnapshot;
  riskEvidence: CanonicalPaperRiskEvidence;
  executionEvidence: Readonly<{
    dataEvidence: Readonly<Record<string, unknown>>;
    costPolicy: CanonicalPaperExecutionCostPolicy;
    costProvenance: ScannerCostEvidenceProvenance;
  }>;
  evidenceDigest: string;
  executionAuthority: 'NONE';
  simulatedOnly: true;
  liveOrderAllowed: false;
  privateTradingApiAllowed: false;
  orderSubmitted: false;
  exchangeRequestSent: false;
  productionMutationAllowed: false;
}>;

export type CanonicalPaperAdmissionEvidenceResult = Readonly<{
  status: 'READY' | 'BLOCKED';
  bundle: CanonicalPaperAdmissionEvidenceBundle | null;
  blockers: readonly string[];
  executionAuthority: 'NONE';
  simulatedOnly: true;
  liveOrderAllowed: false;
  privateTradingApiAllowed: false;
  orderSubmitted: false;
  exchangeRequestSent: false;
  productionMutationAllowed: false;
}>;

type JsonRecord = Record<string, unknown>;

const DEFAULT_MAX_EVIDENCE_AGE_MS = 30_000;
const MARKET_PROVIDER = Object.freeze({
  KR_STOCK: 'toss',
  US_STOCK: 'toss',
  CRYPTO_SPOT: 'upbit',
  CRYPTO_FUTURES: 'bitget',
} as const);
const RISK_MARKET = Object.freeze({
  KR_STOCK: 'stock',
  US_STOCK: 'stock',
  CRYPTO_SPOT: 'crypto-spot',
  CRYPTO_FUTURES: 'crypto-futures',
} as const);
const LEARNING_HORIZON = Object.freeze({
  SCALPING: 'SCALP',
  SWING: 'SWING',
  MID_LONG: 'POSITION',
} as const);

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}
function nonNegative(value: unknown): value is number {
  return finite(value) && value >= 0;
}
function add(blockers: string[], blocker: string, condition = true) {
  if (condition && !blockers.includes(blocker)) blockers.push(blocker);
}
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as JsonRecord;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
function digest(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}
function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
function clone<T>(value: T): T {
  return structuredClone(value);
}
function safetyEnvelope() {
  return Object.freeze({
    executionAuthority: SCANNER_PAPER_ADMISSION_EXECUTION_AUTHORITY,
    simulatedOnly: true as const,
    liveOrderAllowed: false as const,
    privateTradingApiAllowed: false as const,
    orderSubmitted: false as const,
    exchangeRequestSent: false as const,
    productionMutationAllowed: false as const,
  });
}
function blocked(blockers: string[]): CanonicalPaperAdmissionEvidenceResult {
  return Object.freeze({
    status: 'BLOCKED', bundle: null, blockers: Object.freeze([...new Set(blockers)]), ...safetyEnvelope(),
  });
}
function parseIso(value: unknown): number | null {
  if (!nonEmpty(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function expectedRiskSide(direction: ScannerCanonicalPaperCandidate['signal']['direction']): RiskEngineInput['side'] | null {
  if (direction === 'BUY' || direction === 'LONG') return 'long';
  if (direction === 'SHORT') return 'short';
  return null;
}

function validateCandidate(candidate: ScannerCanonicalPaperCandidate, blockers: string[]) {
  const signal = candidate?.signal;
  if (!signal || !nonEmpty(signal.signalId) || !nonEmpty(signal.symbol)) add(blockers, 'CANONICAL_PAPER_IDENTITY_REQUIRED');
  if (!signal?.strategyIdentity || !nonEmpty(signal.strategyIdentity.costPolicyVersion)) add(blockers, 'CANONICAL_COST_POLICY_VERSION_REQUIRED');
  if (candidate?.executionAuthority !== 'NONE'
    || candidate?.liveOrderAllowed !== false
    || candidate?.privateTradingApiAllowed !== false
    || candidate?.orderSubmitted !== false
    || candidate?.exchangeRequestSent !== false) add(blockers, 'CANONICAL_PAPER_SAFETY_ENVELOPE_INVALID');
  if (signal?.direction === 'SELL') add(blockers, 'PAPER_ENTRY_DIRECTION_UNSUPPORTED');
}

function validateLearning(candidate: ScannerCanonicalPaperCandidate, learning: SignalSnapshot, blockers: string[]) {
  const signal = candidate.signal;
  if (learning?.immutable !== true || learning?.executionAuthority !== 'NONE') add(blockers, 'LEARNING_SNAPSHOT_NOT_IMMUTABLE');
  if (learning?.signalId !== signal.signalId) add(blockers, 'LEARNING_SIGNAL_ID_MISMATCH');
  if (learning?.market !== signal.market) add(blockers, 'LEARNING_MARKET_MISMATCH');
  if (learning?.symbol !== signal.symbol) add(blockers, 'LEARNING_SYMBOL_MISMATCH');
  if (learning?.strategyProfileVersion !== signal.strategyIdentity.strategyVersion) add(blockers, 'LEARNING_STRATEGY_VERSION_MISMATCH');
  if (learning?.direction !== signal.direction) add(blockers, 'LEARNING_DIRECTION_MISMATCH');
  if (learning?.strategyHorizon !== LEARNING_HORIZON[signal.style]) add(blockers, 'LEARNING_HORIZON_MISMATCH');
  if (!Array.isArray(learning?.timeframes) || !learning.timeframes.includes(signal.timeframe)) add(blockers, 'LEARNING_TIMEFRAME_MISMATCH');
  const timestampMs = parseIso(learning?.timestamp);
  if (timestampMs !== signal.timestampMs) add(blockers, 'LEARNING_TIMESTAMP_MISMATCH');
  const dataTimestampMs = parseIso(learning?.dataTimestamp);
  if (dataTimestampMs == null || (timestampMs != null && dataTimestampMs > timestampMs)) add(blockers, 'LEARNING_DATA_TIMESTAMP_INVALID');
  if (!Array.isArray(learning?.dataProvenance)
    || learning.dataProvenance.length === 0
    || learning.dataProvenance.some((source) => !nonEmpty(source))) add(blockers, 'LEARNING_DATA_PROVENANCE_REQUIRED');
}

function validateRisk(
  candidate: ScannerCanonicalPaperCandidate,
  riskInput: RiskEngineInput,
  riskResult: RiskEngineResult,
  nowMs: number,
  maxEvidenceAgeMs: number,
  blockers: string[],
): CanonicalPaperRiskEvidence | null {
  const expectedSide = expectedRiskSide(candidate.signal.direction);
  if (!expectedSide) add(blockers, 'PAPER_ENTRY_DIRECTION_UNSUPPORTED');
  if (riskInput?.market !== RISK_MARKET[candidate.signal.market]) add(blockers, 'RISK_MARKET_MISMATCH');
  if (riskInput?.symbol !== candidate.signal.symbol) add(blockers, 'RISK_SYMBOL_MISMATCH');
  if (expectedSide && riskInput?.side !== expectedSide) add(blockers, 'RISK_SIDE_MISMATCH');
  if (riskInput?.dataStatus !== 'live') add(blockers, 'RISK_DATA_NOT_LIVE');
  if (candidate.signal.market === 'CRYPTO_FUTURES' && riskInput?.contractRulesStatus !== 'live') add(blockers, 'RISK_CONTRACT_RULES_NOT_LIVE');
  if (riskResult?.allowed !== true || !Array.isArray(riskResult?.blockCodes) || riskResult.blockCodes.length !== 0) add(blockers, 'RISK_ENGINE_NOT_APPROVED');
  const evaluatedAtMs = parseIso(riskResult?.calculatedAt);
  if (evaluatedAtMs == null) add(blockers, 'RISK_TIMESTAMP_INVALID');
  else if (evaluatedAtMs > nowMs) add(blockers, 'RISK_EVIDENCE_FROM_FUTURE');
  else if (nowMs - evaluatedAtMs > maxEvidenceAgeMs) add(blockers, 'RISK_EVIDENCE_STALE');
  if (!positive(riskResult?.recommendedQuantity)) add(blockers, 'RISK_RECOMMENDED_QUANTITY_REQUIRED');
  if (!finite(riskResult?.actualRiskPercent) && riskResult?.actualRiskPercent != null) add(blockers, 'RISK_PERCENT_INVALID');
  if (finite(riskResult?.actualRiskPercent) && positive(riskInput?.riskPercent)
    && riskResult.actualRiskPercent > riskInput.riskPercent + 1e-9) add(blockers, 'RISK_PERCENT_EXCEEDS_REQUEST');
  if (blockers.length > 0 || evaluatedAtMs == null || !positive(riskResult.recommendedQuantity)) return null;
  return Object.freeze({
    status: 'APPROVED', source: 'TRADING_RISK_ENGINE', evaluatedAtMs, simulatedOnly: true, allowed: true,
    blockCodes: Object.freeze([]), recommendedQuantity: riskResult.recommendedQuantity,
    actualRiskPercent: riskResult.actualRiskPercent, riskReward1: riskResult.riskReward1, riskReward2: riskResult.riskReward2,
    executionAuthority: 'NONE',
  });
}

function validQuoteEvidence(value: unknown, nowMs: number): boolean {
  if (!isRecord(value) || value.available !== true || !positive(value.bid) || !positive(value.ask) || value.bid > value.ask) return false;
  if (!finite(value.asOfMs) || !positive(value.maxAgeMs)) return false;
  return value.asOfMs <= nowMs && nowMs - value.asOfMs <= value.maxAgeMs;
}
function normalizedQuoteEvidence(value: unknown) {
  if (!isRecord(value)) return undefined;
  return Object.freeze({
    available: value.available === true,
    bid: finite(value.bid) ? value.bid : null,
    ask: finite(value.ask) ? value.ask : null,
    last: finite(value.last) ? value.last : null,
    asOfMs: finite(value.asOfMs) ? value.asOfMs : null,
    maxAgeMs: finite(value.maxAgeMs) ? value.maxAgeMs : null,
  });
}

function normalizeExecutionEvidence(
  candidate: ScannerCanonicalPaperCandidate,
  paper: PaperReadinessEvidence,
  raw: unknown,
  nowMs: number,
  blockers: string[],
): Readonly<Record<string, unknown>> | null {
  if (!isRecord(raw)) { add(blockers, 'EXECUTION_DATA_EVIDENCE_REQUIRED'); return null; }
  const market = candidate.signal.market;
  const expectedProvider = MARKET_PROVIDER[market];
  if (raw.provider !== expectedProvider || paper.provider !== expectedProvider) add(blockers, 'EXECUTION_PROVIDER_MISMATCH');
  if (raw.publicOnly !== true || raw.dataQuality !== 'READY') add(blockers, 'EXECUTION_PUBLIC_READY_EVIDENCE_REQUIRED');
  if (!nonEmpty(raw.provenance) || raw.provenance !== paper.providerProvenance) add(blockers, 'EXECUTION_PROVENANCE_MISMATCH');
  if (!finite(raw.asOfMs) || raw.asOfMs !== paper.observedAtMs) add(blockers, 'EXECUTION_TIMESTAMP_MISMATCH');
  if (!positive(raw.maxAgeMs) || (finite(raw.asOfMs) && (raw.asOfMs > nowMs || nowMs - raw.asOfMs > raw.maxAgeMs))) add(blockers, 'EXECUTION_EVIDENCE_STALE_OR_FUTURE');
  if (!positive(raw.tickSize) || raw.tickSize !== paper.tickSize) add(blockers, 'EXECUTION_TICK_SIZE_MISMATCH');
  if (raw.privateApiUsed === true || raw.privateTradingApiAllowed === true || raw.liveOrderAllowed === true
    || raw.orderSubmitted === true || raw.exchangeRequestSent === true) add(blockers, 'EXECUTION_SAFETY_VIOLATION');
  const realtimeBarReady = raw.barProxyRealtimeAllowed === true;
  const quoteReady = validQuoteEvidence(raw.quoteEvidence, nowMs);
  if (!realtimeBarReady && !quoteReady) add(blockers, 'EXECUTION_FILL_FIDELITY_EVIDENCE_REQUIRED');

  const common: JsonRecord = {
    provider: expectedProvider, provenance: paper.providerProvenance, publicOnly: true, dataQuality: 'READY',
    asOfMs: paper.observedAtMs, maxAgeMs: raw.maxAgeMs, tickSize: paper.tickSize, barProxyRealtimeAllowed: realtimeBarReady,
  };
  const quote = normalizedQuoteEvidence(raw.quoteEvidence);
  if (quote) common.quoteEvidence = quote;

  if (market === 'KR_STOCK' || market === 'US_STOCK') {
    const stock = paper as Extract<PaperReadinessEvidence, { market: 'KR_STOCK' | 'US_STOCK' }>;
    const session = isRecord(raw.session) ? raw.session : null;
    if (raw.taxPolicyKnown !== true || raw.taxPolicyVersion !== stock.taxPolicyVersion) add(blockers, 'EXECUTION_TAX_POLICY_MISMATCH');
    if (!session || session.version !== stock.sessionCalendarVersion || session.status !== stock.marketStatus) add(blockers, 'EXECUTION_SESSION_MISMATCH');
    if (market === 'KR_STOCK') {
      if (typeof raw.volatilityInterruptionKnown !== 'boolean') add(blockers, 'EXECUTION_KR_VOLATILITY_INTERRUPTION_REQUIRED');
      if (candidate.signal.style === 'SCALPING' && raw.volatilityInterruptionKnown === true && raw.volatilityInterruptionActive === true) add(blockers, 'EXECUTION_KR_VOLATILITY_INTERRUPTION_ACTIVE');
    }
    if (market === 'US_STOCK') {
      const kind = session?.kind;
      if (kind !== 'REGULAR' && kind !== 'PREMARKET' && kind !== 'AFTER_HOURS') add(blockers, 'EXECUTION_US_SESSION_KIND_REQUIRED');
      if ((kind === 'PREMARKET' || kind === 'AFTER_HOURS') && raw.extendedHoursEvidenceReady !== true) add(blockers, 'EXECUTION_US_EXTENDED_HOURS_EVIDENCE_REQUIRED');
    }
    common.taxPolicyKnown = true;
    common.taxPolicyVersion = stock.taxPolicyVersion;
    common.session = Object.freeze({ version: stock.sessionCalendarVersion, status: stock.marketStatus, ...(nonEmpty(session?.kind) ? { kind: session.kind } : {}) });
    if (market === 'KR_STOCK') {
      common.volatilityInterruptionKnown = raw.volatilityInterruptionKnown;
      common.volatilityInterruptionActive = raw.volatilityInterruptionActive === true;
    }
    if (market === 'US_STOCK' && raw.extendedHoursEvidenceReady != null) common.extendedHoursEvidenceReady = raw.extendedHoursEvidenceReady === true;
  } else if (market === 'CRYPTO_SPOT') {
    const spot = paper as Extract<PaperReadinessEvidence, { market: 'CRYPTO_SPOT' }>;
    if (raw.marketStatus !== 'TRADABLE') add(blockers, 'EXECUTION_SPOT_MARKET_NOT_TRADABLE');
    if (!positive(raw.minOrderNotional) || raw.minOrderNotional !== spot.minimumOrderNotional) add(blockers, 'EXECUTION_MIN_ORDER_NOTIONAL_MISMATCH');
    common.marketStatus = 'TRADABLE';
    common.minOrderNotional = spot.minimumOrderNotional;
  } else {
    const futures = paper as Extract<PaperReadinessEvidence, { market: 'CRYPTO_FUTURES' }>;
    if (raw.contractStatus !== 'TRADABLE') add(blockers, 'EXECUTION_FUTURES_CONTRACT_NOT_TRADABLE');
    if (raw.minQty !== futures.minimumOrderQuantity) add(blockers, 'EXECUTION_MIN_QTY_MISMATCH');
    if (raw.qtyStep !== futures.quantityStep) add(blockers, 'EXECUTION_QTY_STEP_MISMATCH');
    if (raw.quantityPrecision !== futures.quantityPrecision) add(blockers, 'EXECUTION_QTY_PRECISION_MISMATCH');
    if (raw.markPrice !== futures.markPrice) add(blockers, 'EXECUTION_MARK_PRICE_MISMATCH');
    if (raw.fundingRate !== futures.fundingRate) add(blockers, 'EXECUTION_FUNDING_RATE_MISMATCH');
    if (raw.leverage !== futures.leverage) add(blockers, 'EXECUTION_LEVERAGE_MISMATCH');
    if (raw.marginMode !== futures.marginMode.toUpperCase()) add(blockers, 'EXECUTION_MARGIN_MODE_MISMATCH');
    if (raw.liquidationDistancePct !== futures.liquidationDistancePercent) add(blockers, 'EXECUTION_LIQUIDATION_DISTANCE_MISMATCH');
    if (!positive(raw.indexPrice)) add(blockers, 'EXECUTION_INDEX_PRICE_REQUIRED');
    if (!nonNegative(raw.openInterest)) add(blockers, 'EXECUTION_OPEN_INTEREST_REQUIRED');
    if (!positive(raw.maxLeverage) || futures.leverage > raw.maxLeverage) add(blockers, 'EXECUTION_MAX_LEVERAGE_REQUIRED');
    Object.assign(common, {
      contractStatus: 'TRADABLE', minQty: futures.minimumOrderQuantity, qtyStep: futures.quantityStep,
      quantityPrecision: futures.quantityPrecision, markPrice: futures.markPrice, indexPrice: raw.indexPrice,
      fundingRate: futures.fundingRate, openInterest: raw.openInterest, leverage: futures.leverage,
      maxLeverage: raw.maxLeverage, marginMode: futures.marginMode.toUpperCase(),
      liquidationDistancePct: futures.liquidationDistancePercent,
    });
  }
  return deepFreeze(common);
}

function executionCostPolicy(provenance: ScannerCostEvidenceProvenance): CanonicalPaperExecutionCostPolicy {
  const c = provenance.components;
  const rate = (valuePercent: number) => valuePercent / 100;
  return Object.freeze({
    version: provenance.policyId,
    commissionRate: rate(c.commission.valuePercent), taxRate: rate(c.tax.valuePercent),
    spreadRate: rate(c.spread.valuePercent), slippageRate: rate(c.slippage.valuePercent),
    fundingRate: rate(c.funding.valuePercent), latencyRate: rate(c.latency.valuePercent),
    liquidityImpactRate: rate(c.liquidityImpact.valuePercent), partialFillImpactRate: rate(c.partialFillImpact.valuePercent),
    source: 'SCANNER_COST_EVIDENCE_PERCENT_DIV_100', unitConversion: 'PERCENT_DIV_100',
  });
}

export function buildScannerCanonicalPaperAdmissionEvidence(input: {
  paperCandidate: ScannerCanonicalPaperCandidate;
  learningSnapshot: SignalSnapshot;
  riskInput: RiskEngineInput;
  riskResult: RiskEngineResult;
  paperEvidence: PaperReadinessEvidence;
  supplementalCostEvidence: SupplementalExecutionCostEvidence;
  executionDataEvidence: unknown;
  nowMs?: number;
  maxEvidenceAgeMs?: number;
}): CanonicalPaperAdmissionEvidenceResult {
  const nowMs = input.nowMs ?? Date.now();
  const maxEvidenceAgeMs = input.maxEvidenceAgeMs ?? DEFAULT_MAX_EVIDENCE_AGE_MS;
  const blockers: string[] = [];
  if (!positive(nowMs) || !positive(maxEvidenceAgeMs)) return blocked(['ADMISSION_EVIDENCE_CLOCK_INVALID']);

  validateCandidate(input.paperCandidate, blockers);
  validateLearning(input.paperCandidate, input.learningSnapshot, blockers);
  const signal = input.paperCandidate.signal;
  if (input.paperEvidence?.market !== signal.market) add(blockers, 'PAPER_READINESS_MARKET_MISMATCH');
  if (input.paperEvidence?.direction !== signal.direction) add(blockers, 'PAPER_READINESS_DIRECTION_MISMATCH');
  const canonicalCostPolicyVersion = signal.strategyIdentity.costPolicyVersion;
  if (input.paperEvidence?.costPolicyVersion !== canonicalCostPolicyVersion) add(blockers, 'PAPER_COST_POLICY_VERSION_MISMATCH');
  if (input.supplementalCostEvidence?.costPolicyId !== canonicalCostPolicyVersion) add(blockers, 'SUPPLEMENTAL_COST_POLICY_VERSION_MISMATCH');

  const readiness = validatePaperReadiness(input.paperEvidence, nowMs, maxEvidenceAgeMs);
  if (!readiness.ready) add(blockers, 'PAPER_READINESS_BLOCKED');
  const cost = buildScannerTradingCostPolicy({
    paperEvidence: input.paperEvidence, supplemental: input.supplementalCostEvidence, nowMs, maxEvidenceAgeMs,
  });
  if (cost.status !== 'READY' || !cost.policy || !cost.provenance) add(blockers, 'SCANNER_COST_EVIDENCE_NOT_READY');
  if (cost.provenance && (cost.provenance.policyId !== canonicalCostPolicyVersion
    || cost.provenance.paperCostPolicyVersion !== canonicalCostPolicyVersion)) add(blockers, 'COST_PROVENANCE_POLICY_VERSION_MISMATCH');

  const riskEvidence = validateRisk(input.paperCandidate, input.riskInput, input.riskResult, nowMs, maxEvidenceAgeMs, blockers);
  const executionDataEvidence = normalizeExecutionEvidence(input.paperCandidate, input.paperEvidence, input.executionDataEvidence, nowMs, blockers);
  if (blockers.length > 0 || !riskEvidence || !executionDataEvidence || !cost.provenance) return blocked(blockers);

  const bundleWithoutDigest = {
    schemaVersion: SCANNER_PAPER_ADMISSION_BUNDLE_VERSION,
    paperCandidate: clone(input.paperCandidate), learningSnapshot: clone(input.learningSnapshot), riskEvidence,
    executionEvidence: {
      dataEvidence: executionDataEvidence, costPolicy: executionCostPolicy(cost.provenance), costProvenance: clone(cost.provenance),
    },
    ...safetyEnvelope(),
  };
  const bundle = deepFreeze({ ...bundleWithoutDigest, evidenceDigest: digest(bundleWithoutDigest) }) as CanonicalPaperAdmissionEvidenceBundle;
  return Object.freeze({ status: 'READY', bundle, blockers: Object.freeze([]), ...safetyEnvelope() });
}
