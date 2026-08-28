import type { BitgetFuturesPublicEvidence } from './bitget-futures-public-evidence.service';
import {
  CONTRACT_FRESHNESS_MS,
  buildRiskInput,
  validateOrderRequest,
  validateState,
} from './paper-trading-core.service';
import type {
  PaperContractRules,
  PaperMarketData,
  PaperTradingState,
} from './paper-trading.types';
import type { ScannerCanonicalPaperCandidate } from './scanner-canonical-paper-identity.service';
import {
  buildScannerCanonicalPaperAdmissionEvidence,
  type CanonicalPaperAdmissionEvidenceResult,
} from './scanner-paper-admission-evidence-bundle.service';
import type {
  PercentCostEvidence,
  SupplementalExecutionCostEvidence,
} from './scanner-profit-cost-evidence-adapter.service';
import type { SignalSnapshot } from './signal-performance-learning.service';
import {
  calculateTradingRisk,
  type RiskEngineInput,
  type RiskEngineResult,
} from './trading-risk-engine.service';
import type { PaperReadinessEvidence } from './trade-paper-market-contract.service';

export const SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_COMPOSER_VERSION =
  'scanner-crypto-futures-paper-admission-composer-v1' as const;

const DEFAULT_MAX_EVIDENCE_AGE_MS = 30_000;

type FuturesPaperReadinessEvidence = Extract<PaperReadinessEvidence, { market: 'CRYPTO_FUTURES' }>;

type LiquidityObservation = Readonly<{
  value: number;
  source: string;
  observedAtMs: number;
}>;

type PartialFillObservation = Readonly<{
  model: 'NONE' | 'PRO_RATA' | 'ORDER_BOOK';
  source: string;
  observedAtMs: number;
}>;

type LatencyObservation = Readonly<{
  observedRoundTripMs: number | null;
  costValuePercent: null;
  source: string;
  observedAtMs: number;
}>;

type PaperExecutionProvenance = Readonly<{
  evidenceClass: 'SIMULATED';
  marketDataClass: 'public-L2';
  executionMode: 'SIMULATED_EXECUTION_ONLY';
  realFillObserved: false;
  realFillClaim: false;
  publicDepthIsFillProof: false;
  liveSubmittedExecutionSampleCredit: 0;
  liveFillCalibrationStatus: 'READY' | 'VETO' | 'BLOCKED_DATA';
}>;

export type ScannerCryptoFuturesPaperExecutionObservation = Readonly<{
  providerProvenance: string;
  slippage: PercentCostEvidence;
  liquidity: LiquidityObservation;
  partialFill: PartialFillObservation;
  latency: LatencyObservation;
  executionProvenance: PaperExecutionProvenance;
  leverage: number;
  riskPercent: number;
  marginMode: 'isolated' | 'cross';
}>;

export type ScannerCryptoFuturesPaperAdmissionComposerInput = Readonly<{
  paperCandidate: ScannerCanonicalPaperCandidate;
  learningSnapshot: SignalSnapshot;
  paperState: PaperTradingState;
  contractRules: PaperContractRules;
  publicEvidence: BitgetFuturesPublicEvidence;
  executionObservation: ScannerCryptoFuturesPaperExecutionObservation;
  supplementalCostEvidence: SupplementalExecutionCostEvidence;
  nowMs?: number;
  maxEvidenceAgeMs?: number;
}>;

export type ScannerCryptoFuturesPaperAdmissionComposition = Readonly<{
  status: 'READY' | 'BLOCKED';
  composerVersion: typeof SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_COMPOSER_VERSION;
  admissionResult: CanonicalPaperAdmissionEvidenceResult | null;
  riskInput: RiskEngineInput | null;
  riskResult: RiskEngineResult | null;
  paperEvidence: FuturesPaperReadinessEvidence | null;
  executionDataEvidence: Readonly<Record<string, unknown>> | null;
  blockers: readonly string[];
  executionAuthority: 'NONE';
  simulatedOnly: true;
  liveOrderAllowed: false;
  privateTradingApiAllowed: false;
  orderSubmitted: false;
  exchangeRequestSent: false;
  productionMutationAllowed: false;
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
function add(blockers: string[], code: string, condition = true) {
  if (condition && !blockers.includes(code)) blockers.push(code);
}
function timestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function fresh(value: number, nowMs: number, maxAgeMs: number) {
  return positive(value) && value <= nowMs && nowMs - value <= maxAgeMs;
}
function safetyEnvelope() {
  return Object.freeze({
    executionAuthority: 'NONE' as const,
    simulatedOnly: true as const,
    liveOrderAllowed: false as const,
    privateTradingApiAllowed: false as const,
    orderSubmitted: false as const,
    exchangeRequestSent: false as const,
    productionMutationAllowed: false as const,
  });
}
function blocked(
  blockers: string[],
  partial: Partial<Pick<ScannerCryptoFuturesPaperAdmissionComposition,
    'admissionResult' | 'riskInput' | 'riskResult' | 'paperEvidence' | 'executionDataEvidence'>> = {},
): ScannerCryptoFuturesPaperAdmissionComposition {
  return Object.freeze({
    status: 'BLOCKED',
    composerVersion: SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_COMPOSER_VERSION,
    admissionResult: partial.admissionResult ?? null,
    riskInput: partial.riskInput ?? null,
    riskResult: partial.riskResult ?? null,
    paperEvidence: partial.paperEvidence ?? null,
    executionDataEvidence: partial.executionDataEvidence ?? null,
    blockers: Object.freeze([...new Set(blockers)]),
    ...safetyEnvelope(),
  });
}
function spreadPercent(bid: number, ask: number): number | null {
  if (!positive(bid) || !positive(ask) || bid > ask) return null;
  const midpoint = (bid + ask) / 2;
  if (!(midpoint > 0)) return null;
  const value = (ask - bid) / midpoint * 100;
  return Number.isFinite(value) && value >= 0 ? value : null;
}
function canonicalSide(direction: ScannerCanonicalPaperCandidate['signal']['direction']): 'long' | 'short' | null {
  if (direction === 'LONG') return 'long';
  if (direction === 'SHORT') return 'short';
  return null;
}
function sameNumber(left: unknown, right: unknown) {
  return finite(left) && finite(right) && Math.abs(left - right) <= 1e-12;
}
function validateObservedCost(
  value: PercentCostEvidence,
  nowMs: number,
  maxEvidenceAgeMs: number,
  blockers: string[],
) {
  add(blockers, 'P0_C5_SLIPPAGE_EVIDENCE_INVALID', !nonNegative(value?.valuePercent));
  add(blockers, 'P0_C5_SLIPPAGE_SOURCE_REQUIRED', !nonEmpty(value?.source));
  add(blockers, 'P0_C5_SLIPPAGE_EVIDENCE_STALE_OR_FUTURE', !fresh(value?.observedAtMs, nowMs, maxEvidenceAgeMs));
}

function validSupplementalCost(
  value: PercentCostEvidence | undefined,
  nowMs: number,
  maxEvidenceAgeMs: number,
): boolean {
  return nonNegative(value?.valuePercent)
    && (value?.quality === 'OBSERVED' || value?.quality === 'ESTIMATED' || value?.quality === 'DOCUMENTED')
    && nonEmpty(value?.source)
    && fresh(value?.observedAtMs, nowMs, maxEvidenceAgeMs);
}

export function composeScannerCryptoFuturesPaperAdmission(
  input: ScannerCryptoFuturesPaperAdmissionComposerInput,
): ScannerCryptoFuturesPaperAdmissionComposition {
  const nowMs = input.nowMs ?? Date.now();
  const maxEvidenceAgeMs = input.maxEvidenceAgeMs ?? DEFAULT_MAX_EVIDENCE_AGE_MS;
  const blockers: string[] = [];
  if (!positive(nowMs) || !positive(maxEvidenceAgeMs)) return blocked(['P0_C5_EVIDENCE_CLOCK_INVALID']);

  const signal = input.paperCandidate?.signal;
  add(blockers, 'P0_C5_CRYPTO_FUTURES_CANDIDATE_REQUIRED', signal?.market !== 'CRYPTO_FUTURES');
  const side = signal ? canonicalSide(signal.direction) : null;
  add(blockers, 'P0_C5_FUTURES_DIRECTION_REQUIRED', side == null);
  add(blockers, 'P0_C5_LEARNING_SNAPSHOT_REQUIRED', !input.learningSnapshot);

  try {
    validateState(input.paperState);
  } catch {
    add(blockers, 'P0_C5_PAPER_STATE_INVALID');
  }
  add(blockers, 'P0_C5_PAPER_EQUITY_REQUIRED', !positive(input.paperState?.account?.equity));

  const publicEvidence = input.publicEvidence;
  add(blockers, 'P0_C5_BITGET_PUBLIC_EVIDENCE_REQUIRED', publicEvidence?.provider !== 'bitget' || publicEvidence?.dataQuality !== 'ready');
  add(blockers, 'P0_C5_PUBLIC_SYMBOL_MISMATCH', Boolean(signal) && publicEvidence?.symbol !== signal.symbol);
  add(blockers, 'P0_C5_PUBLIC_TICKER_STALE_OR_FUTURE', !fresh(publicEvidence?.tickerTimestampMs, nowMs, maxEvidenceAgeMs));
  add(blockers, 'P0_C5_PUBLIC_OI_STALE_OR_FUTURE', !fresh(publicEvidence?.openInterestTimestampMs, nowMs, maxEvidenceAgeMs));
  add(blockers, 'P0_C5_PUBLIC_QUOTE_INVALID', !positive(publicEvidence?.bidPrice)
    || !positive(publicEvidence?.askPrice) || publicEvidence.bidPrice > publicEvidence.askPrice);
  add(blockers, 'P0_C5_PUBLIC_TAKER_FEE_INVALID', !nonNegative(publicEvidence?.takerFeeRate));
  add(blockers, 'P0_C5_PUBLIC_CONTRACT_INVALID', !positive(publicEvidence?.priceStep)
    || !positive(publicEvidence?.minTradeNum) || !positive(publicEvidence?.sizeMultiplier)
    || !positive(publicEvidence?.minTradeUsdt) || !positive(publicEvidence?.maxLeverage));

  const rules = input.contractRules;
  const rulesAtMs = timestamp(rules?.updatedAt ?? '');
  add(blockers, 'P0_C5_PAPER_CONTRACT_RULES_REQUIRED', rules?.status !== 'live' || rules?.symbol !== signal?.symbol);
  add(blockers, 'P0_C5_PAPER_CONTRACT_RULES_STALE_OR_FUTURE', rulesAtMs == null
    || rulesAtMs > nowMs || nowMs - rulesAtMs > CONTRACT_FRESHNESS_MS);
  add(blockers, 'P0_C5_PAPER_CONTRACT_PRECISION_REQUIRED', !positive(rules?.quantityStep)
    || !Number.isInteger(rules?.quantityPrecision) || Number(rules.quantityPrecision) < 0
    || !positive(rules?.minimumQuantity) || !positive(rules?.minimumNotional)
    || !nonNegative(rules?.maintenanceMarginRate) || Number(rules.maintenanceMarginRate) >= 1
    || !positive(rules?.maximumLeverage));
  add(blockers, 'P0_C5_PUBLIC_PAPER_CONTRACT_MISMATCH', !sameNumber(rules?.quantityStep, publicEvidence?.sizeMultiplier)
    || !sameNumber(rules?.minimumQuantity, publicEvidence?.minTradeNum)
    || !sameNumber(rules?.minimumNotional, publicEvidence?.minTradeUsdt)
    || !sameNumber(rules?.maximumLeverage, publicEvidence?.maxLeverage));

  const observation = input.executionObservation;
  const providerProvenance = observation?.providerProvenance;
  add(blockers, 'P0_C5_PROVIDER_PROVENANCE_REQUIRED', !nonEmpty(providerProvenance)
    || !providerProvenance.split('+').includes('SIMULATED')
    || !providerProvenance.split('+').includes('public-L2'));
  add(blockers, 'P0_C5_SIMULATED_PUBLIC_L2_PROVENANCE_REQUIRED',
    observation?.executionProvenance?.evidenceClass !== 'SIMULATED'
    || observation?.executionProvenance?.marketDataClass !== 'public-L2'
    || observation?.executionProvenance?.executionMode !== 'SIMULATED_EXECUTION_ONLY'
    || observation?.executionProvenance?.realFillObserved !== false
    || observation?.executionProvenance?.realFillClaim !== false
    || observation?.executionProvenance?.publicDepthIsFillProof !== false
    || observation?.executionProvenance?.liveSubmittedExecutionSampleCredit !== 0);
  validateObservedCost(observation?.slippage, nowMs, maxEvidenceAgeMs, blockers);
  add(blockers, 'P0_C5_LIQUIDITY_EVIDENCE_INVALID', !positive(observation?.liquidity?.value));
  add(blockers, 'P0_C5_LIQUIDITY_SOURCE_REQUIRED', !nonEmpty(observation?.liquidity?.source));
  add(blockers, 'P0_C5_LIQUIDITY_EVIDENCE_STALE_OR_FUTURE', !fresh(observation?.liquidity?.observedAtMs, nowMs, maxEvidenceAgeMs));
  add(blockers, 'P0_C5_PARTIAL_FILL_EVIDENCE_INVALID', !['NONE', 'PRO_RATA', 'ORDER_BOOK'].includes(observation?.partialFill?.model));
  add(blockers, 'P0_C5_PARTIAL_FILL_SOURCE_REQUIRED', !nonEmpty(observation?.partialFill?.source));
  add(blockers, 'P0_C5_PARTIAL_FILL_EVIDENCE_STALE_OR_FUTURE', !fresh(observation?.partialFill?.observedAtMs, nowMs, maxEvidenceAgeMs));
  add(blockers, 'P0_C5_LEVERAGE_INVALID', !positive(observation?.leverage)
    || (positive(rules?.maximumLeverage) && observation.leverage > rules.maximumLeverage));
  add(blockers, 'P0_C5_RISK_PERCENT_INVALID', !positive(observation?.riskPercent) || observation.riskPercent > 1);
  add(blockers, 'P0_C5_MARGIN_MODE_REQUIRED', observation?.marginMode !== 'isolated' && observation?.marginMode !== 'cross');
  add(blockers, 'P0_C5_SUPPLEMENTAL_FULL_COST_EVIDENCE_REQUIRED', !input.supplementalCostEvidence);
  add(blockers, 'P0_C5_COST_POLICY_ID_MISMATCH', input.supplementalCostEvidence?.costPolicyId !== signal?.strategyIdentity?.costPolicyVersion);
  add(blockers, 'P0_C5_SUPPLEMENTAL_COST_OBSERVATION_STALE_OR_FUTURE',
    !fresh(input.supplementalCostEvidence?.observedAtMs, nowMs, maxEvidenceAgeMs));
  add(blockers, 'P0_C5_LATENCY_COST_EVIDENCE_REQUIRED',
    !validSupplementalCost(input.supplementalCostEvidence?.latency, nowMs, maxEvidenceAgeMs));
  add(blockers, 'P0_C5_LIQUIDITY_IMPACT_COST_EVIDENCE_REQUIRED',
    !validSupplementalCost(input.supplementalCostEvidence?.liquidityImpact, nowMs, maxEvidenceAgeMs));
  add(blockers, 'P0_C5_PARTIAL_FILL_COST_EVIDENCE_REQUIRED',
    !validSupplementalCost(input.supplementalCostEvidence?.partialFillImpact, nowMs, maxEvidenceAgeMs));
  add(blockers, 'P0_C5_FUNDING_COST_EVIDENCE_REQUIRED',
    !validSupplementalCost(input.supplementalCostEvidence?.funding, nowMs, maxEvidenceAgeMs));

  const entryPrice = input.learningSnapshot?.entryPrice;
  const stopLoss = input.learningSnapshot?.stopLoss;
  add(blockers, 'P0_C5_LEARNING_ENTRY_PRICE_REQUIRED', !positive(entryPrice));
  add(blockers, 'P0_C5_LEARNING_STOP_LOSS_REQUIRED', !positive(stopLoss));
  if (side === 'long' && positive(entryPrice) && positive(stopLoss)) add(blockers, 'P0_C5_LEARNING_STOP_DIRECTION_INVALID', stopLoss >= entryPrice);
  if (side === 'short' && positive(entryPrice) && positive(stopLoss)) add(blockers, 'P0_C5_LEARNING_STOP_DIRECTION_INVALID', stopLoss <= entryPrice);

  const spread = spreadPercent(publicEvidence?.bidPrice, publicEvidence?.askPrice);
  add(blockers, 'P0_C5_SPREAD_EVIDENCE_INVALID', spread == null);
  if (blockers.length > 0 || !signal || !side || !positive(entryPrice) || !positive(stopLoss)
    || spread == null || !input.supplementalCostEvidence?.funding) {
    return blocked(blockers);
  }
  const supplemental = input.supplementalCostEvidence;
  const fundingCost = supplemental.funding as PercentCostEvidence;
  const executionCostRate = (
    spread
    + observation.slippage.valuePercent
    + supplemental.latency.valuePercent
    + supplemental.liquidityImpact.valuePercent
    + supplemental.partialFillImpact.valuePercent
  ) / 100;
  const fundingCostRate = fundingCost.valuePercent / 100;

  const marketData: PaperMarketData = Object.freeze({
    symbol: signal.symbol,
    price: publicEvidence.lastPrice,
    lastPrice: publicEvidence.lastPrice,
    markPrice: publicEvidence.markPrice,
    bidPrice: publicEvidence.bidPrice,
    askPrice: publicEvidence.askPrice,
    fundingRate: publicEvidence.fundingRate,
    status: 'live',
    updatedAt: new Date(publicEvidence.tickerTimestampMs).toISOString(),
    warnings: [],
  });
  const request = validateOrderRequest({
    symbol: signal.symbol,
    side,
    orderType: 'market',
    leverage: observation.leverage,
    stopLossPrice: stopLoss,
    takeProfitPrice1: input.learningSnapshot.target1,
    takeProfitPrice2: input.learningSnapshot.target2,
    strategyName: signal.strategyIdentity.strategyId,
  });
  const suppliedRisk: RiskEngineInput = {
    market: 'crypto-futures',
    symbol: signal.symbol,
    side,
    accountBalance: input.paperState.account.equity,
    entryPrice,
    stopLossPrice: stopLoss,
    targetPrice1: input.learningSnapshot.target1,
    targetPrice2: input.learningSnapshot.target2,
    leverage: observation.leverage,
    riskPercent: observation.riskPercent,
    entryFeeRate: publicEvidence.takerFeeRate,
    exitFeeRate: publicEvidence.takerFeeRate,
    // The Risk Engine owns quantity. Its slippage slot receives the same
    // non-fee/non-funding adverse-cost vector rechecked by P0-C9 parity.
    slippageRate: executionCostRate,
    estimatedFundingRate: fundingCostRate,
    dataStatus: 'live',
  };
  const now = new Date(nowMs);
  const riskInput = buildRiskInput(
    input.paperState,
    request,
    marketData,
    rules,
    suppliedRisk,
    entryPrice,
    now,
  );
  const riskResult = calculateTradingRisk(riskInput, now);
  if (!riskResult.allowed || !positive(riskResult.recommendedQuantity)) {
    return blocked(['P0_C5_RISK_ENGINE_NOT_APPROVED', ...riskResult.blockCodes], { riskInput, riskResult });
  }

  const liquidationPrice = riskResult.estimatedLiquidationPrice;
  const liquidationDistancePercent = positive(liquidationPrice)
    ? Math.abs(entryPrice - liquidationPrice) / entryPrice * 100
    : null;
  if (!positive(liquidationDistancePercent)) {
    return blocked(['P0_C5_LIQUIDATION_DISTANCE_NOT_EVIDENCED'], { riskInput, riskResult });
  }

  const paperEvidence: FuturesPaperReadinessEvidence = Object.freeze({
    market: 'CRYPTO_FUTURES',
    provider: 'bitget',
    providerProvenance: observation.providerProvenance,
    direction: signal.direction as 'LONG' | 'SHORT',
    observedAtMs: publicEvidence.tickerTimestampMs,
    costPolicyVersion: signal.strategyIdentity.costPolicyVersion,
    feePercent: publicEvidence.takerFeeRate * 100,
    spreadPercent: spread,
    slippagePercent: observation.slippage.valuePercent,
    tickSize: publicEvidence.priceStep,
    liquidity: observation.liquidity.value,
    partialFillModel: observation.partialFill.model,
    minimumOrderQuantity: rules.minimumQuantity as number,
    quantityStep: rules.quantityStep as number,
    quantityPrecision: rules.quantityPrecision as number,
    markPrice: publicEvidence.markPrice,
    fundingRate: publicEvidence.fundingRate,
    leverage: observation.leverage,
    marginMode: observation.marginMode,
    liquidationDistancePercent,
  });

  const executionDataEvidence = Object.freeze({
    provider: 'bitget',
    provenance: observation.providerProvenance,
    publicOnly: true,
    dataQuality: 'READY',
    asOfMs: publicEvidence.tickerTimestampMs,
    maxAgeMs: maxEvidenceAgeMs,
    tickSize: publicEvidence.priceStep,
    barProxyRealtimeAllowed: false,
    quoteEvidence: Object.freeze({
      available: true,
      bid: publicEvidence.bidPrice,
      ask: publicEvidence.askPrice,
      last: publicEvidence.lastPrice,
      asOfMs: publicEvidence.tickerTimestampMs,
      maxAgeMs: maxEvidenceAgeMs,
    }),
    contractStatus: 'TRADABLE',
    minQty: rules.minimumQuantity,
    qtyStep: rules.quantityStep,
    quantityPrecision: rules.quantityPrecision,
    markPrice: publicEvidence.markPrice,
    indexPrice: publicEvidence.indexPrice,
    fundingRate: publicEvidence.fundingRate,
    openInterest: publicEvidence.openInterest,
    leverage: observation.leverage,
    maxLeverage: rules.maximumLeverage,
    marginMode: observation.marginMode.toUpperCase(),
    liquidationDistancePct: liquidationDistancePercent,
    privateApiUsed: false,
    executionProvenance: observation.executionProvenance,
    executionMode: 'SIMULATED_EXECUTION_ONLY',
    publicL2Only: true,
    realFillObserved: false,
    realFillClaim: false,
    publicDepthIsFillProof: false,
    liveSubmittedExecutionSampleCredit: 0,
    liveFillCalibrationStatus: observation.executionProvenance.liveFillCalibrationStatus,
    privateTradingApiAllowed: false,
    liveOrderAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });

  const admissionResult = buildScannerCanonicalPaperAdmissionEvidence({
    paperCandidate: input.paperCandidate,
    learningSnapshot: input.learningSnapshot,
    riskInput,
    riskResult,
    paperEvidence,
    supplementalCostEvidence: input.supplementalCostEvidence,
    executionDataEvidence,
    nowMs,
    maxEvidenceAgeMs,
  });
  if (admissionResult.status !== 'READY') {
    return blocked([...admissionResult.blockers], {
      admissionResult, riskInput, riskResult, paperEvidence, executionDataEvidence,
    });
  }

  return Object.freeze({
    status: 'READY',
    composerVersion: SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_COMPOSER_VERSION,
    admissionResult,
    riskInput,
    riskResult,
    paperEvidence,
    executionDataEvidence,
    blockers: Object.freeze([]),
    ...safetyEnvelope(),
  });
}
