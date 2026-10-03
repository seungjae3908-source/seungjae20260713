import type { BitgetFuturesPublicEvidence } from './bitget-futures-public-evidence.service';
import type { PaperContractRules } from './paper-trading.types';
import type {
  PercentCostEvidence,
  SupplementalExecutionCostEvidence,
} from './scanner-profit-cost-evidence-adapter.service';
import { buildPaperSimulatedExecutionEvidence } from './paper-simulated-execution-evidence.service';
import {
  calculateTradingRisk,
  type RiskEngineInput,
  type RiskEngineResult,
} from './trading-risk-engine.service';

export const PUMP_REVERSAL_PAPER_RISK_SIZING_VERSION =
  'pump-reversal-paper-risk-sizing-v1' as const;

const STRATEGY_ID = 'CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1';
const MAX_EVIDENCE_AGE_MS = 30_000;
const MAX_NOMINAL_ACCOUNT_PERCENT = 1;
const RISK_PERCENT = 0.25;
const LEVERAGE = 2;
const MAX_HOLD_HOURS = 72;

type DepthLevel = readonly [number | string, number | string] | Readonly<{
  price: number | string;
  size?: number | string;
  qty?: number | string;
}>;

export type PumpProspectiveOpenRecord = Readonly<{
  status: 'OPEN';
  observation: Readonly<{
    candidateId: string;
    candidateDigest: string;
    policyDigest: string;
    symbol: string;
  }>;
  signal: Readonly<{
    strategyId: string;
    market: 'CRYPTO_FUTURES';
    direction: 'SHORT';
    symbol: string;
    signalId: string;
    parameterHash: string;
  }>;
  position: Readonly<{
    positionId: string;
    entryTimestampMs: number;
    entryPrice: number;
    stopPrice: number;
    timeExitAtMs: number;
    actualExchangeFillClaim: false;
  }>;
}>;

export type PumpPaperAccountRiskSnapshot = Readonly<{
  equity: number;
  dailyRealizedPnl: number;
  weeklyRealizedPnl: number;
  consecutiveLosses: number;
  openExposure: number;
  sameDirectionExposure: number;
  observedAtMs: number;
}>;

export type PumpPublicDepthSnapshot = Readonly<{
  bids: readonly DepthLevel[];
  asks: readonly DepthLevel[];
  observedAtMs: number;
  requestStartedAtMs?: number | null;
  requestCompletedAtMs?: number | null;
  provenance: readonly string[];
}>;

export type PumpRiskSizingInput = Readonly<{
  record: PumpProspectiveOpenRecord;
  account: PumpPaperAccountRiskSnapshot;
  contractRules: PaperContractRules;
  publicEvidence: BitgetFuturesPublicEvidence;
  depth: PumpPublicDepthSnapshot;
  supplementalCostEvidence: SupplementalExecutionCostEvidence;
  nowMs?: number;
}>;

export type PumpProspectiveEntryExecutionSnapshot = Readonly<{
  schemaVersion: 'crypto-pump-reversal-prospective-entry-execution-v1';
  style: 'SWING';
  timeframe: '1h';
  horizon: 72;
  quantity: number;
  evaluatedAtMs: number;
  marketAdapterIdentity: Readonly<{ id: 'crypto-futures-bitget-execution'; version: 'v2' }>;
  costPolicy: Readonly<{
    version: string;
    commissionRate: number;
    taxRate: 0;
    spreadRate: number;
    slippageRate: number;
    fundingRate: 0;
    latencyRate: number;
    liquidityImpactRate: number;
    partialFillImpactRate: number;
  }>;
  executionPolicy: Readonly<{
    version: 'crypto-pump-reversal-prospective-entry-execution-v1';
    fillModel: 'DEPTH_PARTICIPATION';
    sameBarPolicy: 'STOP_FIRST';
    allowPartialFill: false;
    maxParticipationRate: 1;
  }>;
  dataEvidence: Readonly<Record<string, unknown>>;
  quote: Readonly<{ bid: number; ask: number; last: number; asOfMs: number; maxAgeMs: number }>;
  depth: Readonly<{ bidSize: number; askSize: number }>;
  observedSlippagePercent: number;
  visibleCoverageRatio: number;
  projectedFundingRiskRate: number;
  fundingChargedAtEntry: false;
  actualExchangeFillClaim: false;
}>;

export type PumpRiskSizingResult = Readonly<{
  status: 'READY' | 'BLOCKED';
  version: typeof PUMP_REVERSAL_PAPER_RISK_SIZING_VERSION;
  blockers: readonly string[];
  riskInput: RiskEngineInput | null;
  riskResult: RiskEngineResult | null;
  maximumProbeNotional: number | null;
  maximumProbeQuantity: number | null;
  observedSlippagePercent: number | null;
  observedSpreadPercent: number | null;
  conservativeFundingRiskRate: number | null;
  finalQuantity: number | null;
  finalNotional: number | null;
  prospectiveEntryExecution: PumpProspectiveEntryExecutionSnapshot | null;
  riskPercent: typeof RISK_PERCENT;
  leverage: typeof LEVERAGE;
  marginMode: 'isolated';
  fundingDirectionalFilterUsed: false;
  fundingCountsAsProfitabilityEvidence: false;
  simulatedOnly: true;
  canonicalProfitAdmissionEligible: false;
  profitabilityClaimAllowed: false;
  executionAuthority: 'NONE';
  liveOrderAllowed: false;
  privateTradingApiAllowed: false;
  orderSubmitted: false;
  exchangeRequestSent: false;
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
function fresh(value: unknown, nowMs: number, maxAgeMs = MAX_EVIDENCE_AGE_MS): value is number {
  return positive(value) && value <= nowMs && nowMs - value <= maxAgeMs;
}
function add(blockers: string[], code: string, condition = true) {
  if (condition && !blockers.includes(code)) blockers.push(code);
}
function safety() {
  return Object.freeze({
    fundingDirectionalFilterUsed: false as const,
    fundingCountsAsProfitabilityEvidence: false as const,
    simulatedOnly: true as const,
    canonicalProfitAdmissionEligible: false as const,
    profitabilityClaimAllowed: false as const,
    executionAuthority: 'NONE' as const,
    liveOrderAllowed: false as const,
    privateTradingApiAllowed: false as const,
    orderSubmitted: false as const,
    exchangeRequestSent: false as const,
  });
}
function result(
  blockers: string[],
  partial: Partial<Pick<PumpRiskSizingResult,
    'riskInput' | 'riskResult' | 'maximumProbeNotional' | 'maximumProbeQuantity'
    | 'observedSlippagePercent' | 'observedSpreadPercent' | 'conservativeFundingRiskRate'
    | 'finalQuantity' | 'finalNotional' | 'prospectiveEntryExecution'>> = {},
): PumpRiskSizingResult {
  return Object.freeze({
    status: blockers.length === 0 ? 'READY' : 'BLOCKED',
    version: PUMP_REVERSAL_PAPER_RISK_SIZING_VERSION,
    blockers: Object.freeze([...new Set(blockers)]),
    riskInput: partial.riskInput ?? null,
    riskResult: partial.riskResult ?? null,
    maximumProbeNotional: partial.maximumProbeNotional ?? null,
    maximumProbeQuantity: partial.maximumProbeQuantity ?? null,
    observedSlippagePercent: partial.observedSlippagePercent ?? null,
    observedSpreadPercent: partial.observedSpreadPercent ?? null,
    conservativeFundingRiskRate: partial.conservativeFundingRiskRate ?? null,
    finalQuantity: partial.finalQuantity ?? null,
    finalNotional: partial.finalNotional ?? null,
    prospectiveEntryExecution: partial.prospectiveEntryExecution ?? null,
    riskPercent: RISK_PERCENT,
    leverage: LEVERAGE,
    marginMode: 'isolated',
    ...safety(),
  });
}

function validateCostEvidence(
  evidence: PercentCostEvidence | undefined,
  nowMs: number,
  code: string,
  blockers: string[],
) {
  add(blockers, code, !evidence
    || !nonNegative(evidence.valuePercent)
    || !['OBSERVED', 'DOCUMENTED', 'ESTIMATED'].includes(evidence.quality)
    || typeof evidence.source !== 'string'
    || !evidence.source.trim()
    || !fresh(evidence.observedAtMs, nowMs));
}

function depthLevelSize(level: DepthLevel): number | null {
  const objectLevel = level as Readonly<{
    price: number | string;
    size?: number | string;
    qty?: number | string;
  }>;
  const raw = Array.isArray(level) ? level[1] : (objectLevel.size ?? objectLevel.qty);
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function visibleDepthSize(levels: readonly DepthLevel[]): number {
  return levels.reduce((sum, level) => {
    const size = depthLevelSize(level);
    return sum + (size ?? 0);
  }, 0);
}

function spreadPercent(bid: number, ask: number): number | null {
  if (!positive(bid) || !positive(ask) || bid > ask) return null;
  const midpoint = (bid + ask) / 2;
  const value = ((ask - bid) / midpoint) * 100;
  return nonNegative(value) ? value : null;
}

export function sizePumpReversalPaperRisk(
  input: PumpRiskSizingInput,
): PumpRiskSizingResult {
  const nowMs = input.nowMs ?? Date.now();
  const blockers: string[] = [];
  const record = input.record;
  const account = input.account;
  const rules = input.contractRules;
  const publicEvidence = input.publicEvidence;
  const depth = input.depth;
  const supplemental = input.supplementalCostEvidence;

  add(blockers, 'PUMP_SIZING_CLOCK_INVALID', !positive(nowMs));
  add(blockers, 'PUMP_OPEN_PROSPECTIVE_RECORD_REQUIRED',
    record?.status !== 'OPEN'
    || record?.signal?.strategyId !== STRATEGY_ID
    || record?.signal?.market !== 'CRYPTO_FUTURES'
    || record?.signal?.direction !== 'SHORT'
    || record?.signal?.symbol !== record?.observation?.symbol
    || !positive(record?.position?.entryPrice)
    || !positive(record?.position?.stopPrice)
    || record.position.stopPrice <= record.position.entryPrice
    || record.position.actualExchangeFillClaim !== false);

  add(blockers, 'PUMP_PAPER_ACCOUNT_EQUITY_REQUIRED', !positive(account?.equity));
  add(blockers, 'PUMP_PAPER_ACCOUNT_EVIDENCE_STALE', !fresh(account?.observedAtMs, nowMs));
  add(blockers, 'PUMP_PAPER_ACCOUNT_RISK_STATE_INVALID',
    !finite(account?.dailyRealizedPnl)
    || !finite(account?.weeklyRealizedPnl)
    || !Number.isInteger(account?.consecutiveLosses)
    || account.consecutiveLosses < 0
    || !nonNegative(account?.openExposure)
    || !nonNegative(account?.sameDirectionExposure));

  add(blockers, 'PUMP_CONTRACT_RULES_REQUIRED',
    rules?.status !== 'live'
    || rules?.symbol !== record?.signal?.symbol
    || !positive(rules?.quantityStep)
    || !Number.isInteger(rules?.quantityPrecision)
    || Number(rules.quantityPrecision) < 0
    || !positive(rules?.minimumQuantity)
    || !positive(rules?.minimumNotional)
    || !positive(rules?.maximumLeverage)
    || rules.maximumLeverage < LEVERAGE
    || !nonNegative(rules?.maintenanceMarginRate)
    || Number(rules.maintenanceMarginRate) >= 1);

  add(blockers, 'PUMP_BITGET_PUBLIC_EVIDENCE_REQUIRED',
    publicEvidence?.provider !== 'bitget'
    || publicEvidence?.dataQuality !== 'ready'
    || publicEvidence?.symbol !== record?.signal?.symbol
    || !fresh(publicEvidence?.tickerTimestampMs, nowMs)
    || !positive(publicEvidence?.bidPrice)
    || !positive(publicEvidence?.askPrice)
    || publicEvidence.bidPrice > publicEvidence.askPrice
    || !nonNegative(publicEvidence?.takerFeeRate)
    || !finite(publicEvidence?.fundingRate)
    || !positive(publicEvidence?.fundingIntervalHours));

  add(blockers, 'PUMP_ENTRY_REFERENCE_PRICE_DRIFT',
    positive(record?.position?.entryPrice)
    && positive(publicEvidence?.lastPrice)
    && Math.abs(publicEvidence.lastPrice - record.position.entryPrice) / record.position.entryPrice > 0.02);

  add(blockers, 'PUMP_PUBLIC_DEPTH_REQUIRED',
    !Array.isArray(depth?.bids)
    || !Array.isArray(depth?.asks)
    || depth.bids.length === 0
    || depth.asks.length === 0
    || !fresh(depth?.observedAtMs, nowMs)
    || !Array.isArray(depth?.provenance)
    || !depth.provenance.includes('public-L2'));

  add(blockers, 'PUMP_SUPPLEMENTAL_COST_POLICY_REQUIRED',
    !supplemental || typeof supplemental.costPolicyId !== 'string' || !supplemental.costPolicyId.trim());
  add(blockers, 'PUMP_SUPPLEMENTAL_COST_EVIDENCE_STALE', !fresh(supplemental?.observedAtMs, nowMs));
  validateCostEvidence(supplemental?.latency, nowMs, 'PUMP_LATENCY_COST_EVIDENCE_REQUIRED', blockers);
  validateCostEvidence(supplemental?.liquidityImpact, nowMs, 'PUMP_LIQUIDITY_IMPACT_EVIDENCE_REQUIRED', blockers);
  validateCostEvidence(supplemental?.partialFillImpact, nowMs, 'PUMP_PARTIAL_FILL_COST_EVIDENCE_REQUIRED', blockers);

  if (blockers.length > 0 || !positive(account?.equity) || !positive(record?.position?.entryPrice)) {
    return result(blockers);
  }

  const maximumProbeNotional = account.equity * (MAX_NOMINAL_ACCOUNT_PERCENT / 100);
  const maximumProbeQuantity = maximumProbeNotional / record.position.entryPrice;
  if (!(maximumProbeQuantity > 0)) return result(['PUMP_MAXIMUM_PROBE_QUANTITY_INVALID']);

  const execution = buildPaperSimulatedExecutionEvidence({
    source: 'BITGET_PUBLIC_L2_PUMP_ENTRY_SIZING',
    market: 'CRYPTO_FUTURES',
    symbol: record.signal.symbol,
    direction: 'SHORT',
    targetQuantity: maximumProbeQuantity,
    bids: depth.bids,
    asks: depth.asks,
    observedAtMs: depth.observedAtMs,
    requestStartedAtMs: depth.requestStartedAtMs ?? depth.observedAtMs,
    requestCompletedAtMs: depth.requestCompletedAtMs ?? depth.observedAtMs,
    maximumAgeMs: MAX_EVIDENCE_AGE_MS,
    provenance: ['SIMULATED', 'public-L2', ...depth.provenance],
    calibratedFillModel: null,
    nowMs,
  }) as Readonly<Record<string, any>>;

  const observedSlippagePercent = Number(execution?.estimated?.slippageEstimate?.percent);
  add(blockers, 'PUMP_PUBLIC_L2_SIMULATION_NOT_READY',
    execution?.paperSimulation?.status !== 'READY'
    || !nonNegative(observedSlippagePercent));

  const observedSpreadPercent = spreadPercent(publicEvidence.bidPrice, publicEvidence.askPrice);
  add(blockers, 'PUMP_SPREAD_EVIDENCE_INVALID', observedSpreadPercent == null);

  if (blockers.length > 0 || observedSpreadPercent == null) {
    return result(blockers, {
      maximumProbeNotional,
      maximumProbeQuantity,
      observedSlippagePercent: nonNegative(observedSlippagePercent) ? observedSlippagePercent : null,
      observedSpreadPercent,
    });
  }

  const fundingIntervals = Math.ceil(MAX_HOLD_HOURS / publicEvidence.fundingIntervalHours);
  const conservativeFundingRiskRate = Math.abs(publicEvidence.fundingRate) * fundingIntervals;
  const executionCostRate = (
    observedSpreadPercent
    + observedSlippagePercent
    + supplemental.latency.valuePercent
    + supplemental.liquidityImpact.valuePercent
    + supplemental.partialFillImpact.valuePercent
  ) / 100;

  const riskInput: RiskEngineInput = {
    market: 'crypto-futures',
    symbol: record.signal.symbol,
    side: 'short',
    accountBalance: account.equity,
    entryPrice: record.position.entryPrice,
    stopLossPrice: record.position.stopPrice,
    targetPrice1: null,
    targetPrice2: null,
    leverage: LEVERAGE,
    riskPercent: RISK_PERCENT,
    entryFeeRate: publicEvidence.takerFeeRate,
    exitFeeRate: publicEvidence.takerFeeRate,
    slippageRate: executionCostRate,
    estimatedFundingRate: conservativeFundingRiskRate,
    quantityStep: rules.quantityStep,
    quantityPrecision: rules.quantityPrecision,
    minimumQuantity: rules.minimumQuantity,
    minimumNotional: rules.minimumNotional,
    maintenanceMarginRate: rules.maintenanceMarginRate,
    maximumLeverage: rules.maximumLeverage,
    appMaximumLeverage: LEVERAGE,
    contractRulesStatus: 'live',
    dailyRealizedPnl: account.dailyRealizedPnl,
    weeklyRealizedPnl: account.weeklyRealizedPnl,
    consecutiveLosses: account.consecutiveLosses,
    openExposure: account.openExposure,
    sameDirectionExposure: account.sameDirectionExposure,
    dataStatus: 'live',
  };

  const riskResult = calculateTradingRisk(riskInput, new Date(nowMs));
  add(blockers, 'PUMP_RISK_ENGINE_NOT_APPROVED',
    riskResult.allowed !== true
    || !positive(riskResult.recommendedQuantity)
    || !positive(riskResult.notionalValue)
    || !finite(riskResult.actualRiskPercent)
    || riskResult.actualRiskPercent > RISK_PERCENT + 1e-9);
  add(blockers, 'PUMP_NOMINAL_CAP_EXCEEDED',
    positive(riskResult.notionalValue)
    && riskResult.notionalValue > maximumProbeNotional + Math.max(1e-9, maximumProbeNotional * 1e-12));

  let prospectiveEntryExecution: PumpProspectiveEntryExecutionSnapshot | null = null;
  if (riskResult.allowed === true
    && positive(riskResult.recommendedQuantity)
    && positive(riskResult.notionalValue)
    && observedSpreadPercent != null) {
    const finalExecution = buildPaperSimulatedExecutionEvidence({
      source: 'BITGET_PUBLIC_L2_PUMP_FINAL_ENTRY_EXECUTION',
      market: 'CRYPTO_FUTURES',
      symbol: record.signal.symbol,
      direction: 'SHORT',
      targetQuantity: riskResult.recommendedQuantity,
      bids: depth.bids,
      asks: depth.asks,
      observedAtMs: depth.observedAtMs,
      requestStartedAtMs: depth.requestStartedAtMs ?? depth.observedAtMs,
      requestCompletedAtMs: depth.requestCompletedAtMs ?? depth.observedAtMs,
      maximumAgeMs: MAX_EVIDENCE_AGE_MS,
      provenance: ['SIMULATED', 'public-L2', ...depth.provenance],
      calibratedFillModel: null,
      nowMs,
    }) as Readonly<Record<string, any>>;
    const finalSlippagePercent = Number(finalExecution?.estimated?.slippageEstimate?.percent);
    const visibleCoverageRatio = Number(finalExecution?.estimated?.liquidityEvidence?.visibleCoverageRatio);
    const liquidationPrice = riskResult.estimatedLiquidationPrice;
    const liquidationDistancePct = positive(liquidationPrice)
      ? Math.abs(record.position.entryPrice - liquidationPrice) / record.position.entryPrice * 100
      : null;
    add(blockers, 'PUMP_FINAL_ENTRY_SIMULATION_NOT_READY',
      finalExecution?.paperSimulation?.status !== 'READY'
      || !nonNegative(finalSlippagePercent)
      || !finite(visibleCoverageRatio)
      || visibleCoverageRatio < 1);
    add(blockers, 'PUMP_LIQUIDATION_DISTANCE_NOT_EVIDENCED', !positive(liquidationDistancePct));

    if (blockers.length === 0 && liquidationDistancePct != null) {
      const bidSize = visibleDepthSize(depth.bids);
      const askSize = visibleDepthSize(depth.asks);
      add(blockers, 'PUMP_VISIBLE_DEPTH_SIZE_INVALID', !positive(bidSize) || !positive(askSize));
      if (blockers.length === 0) {
        const providerProvenance = [
          'BITGET_PUBLIC_V2',
          'BITGET_PUBLIC_UTA_V3_ORDERBOOK',
          ...depth.provenance,
        ].join('+');
        prospectiveEntryExecution = Object.freeze({
          schemaVersion: 'crypto-pump-reversal-prospective-entry-execution-v1',
          style: 'SWING',
          timeframe: '1h',
          horizon: 72,
          quantity: riskResult.recommendedQuantity,
          evaluatedAtMs: nowMs,
          marketAdapterIdentity: Object.freeze({
            id: 'crypto-futures-bitget-execution',
            version: 'v2',
          }),
          costPolicy: Object.freeze({
            version: supplemental.costPolicyId.trim(),
            commissionRate: publicEvidence.takerFeeRate,
            taxRate: 0,
            spreadRate: observedSpreadPercent / 100,
            slippageRate: finalSlippagePercent / 100,
            fundingRate: 0,
            latencyRate: supplemental.latency.valuePercent / 100,
            liquidityImpactRate: supplemental.liquidityImpact.valuePercent / 100,
            partialFillImpactRate: supplemental.partialFillImpact.valuePercent / 100,
          }),
          executionPolicy: Object.freeze({
            version: 'crypto-pump-reversal-prospective-entry-execution-v1',
            fillModel: 'DEPTH_PARTICIPATION',
            sameBarPolicy: 'STOP_FIRST',
            allowPartialFill: false,
            maxParticipationRate: 1,
          }),
          dataEvidence: Object.freeze({
            provider: 'bitget',
            provenance: providerProvenance,
            publicOnly: true,
            dataQuality: 'READY',
            asOfMs: Math.min(publicEvidence.tickerTimestampMs, depth.observedAtMs, supplemental.observedAtMs),
            maxAgeMs: MAX_EVIDENCE_AGE_MS,
            tickSize: publicEvidence.priceStep,
            barProxyRealtimeAllowed: false,
            quoteEvidence: Object.freeze({
              available: true,
              bid: publicEvidence.bidPrice,
              ask: publicEvidence.askPrice,
              last: publicEvidence.lastPrice,
              asOfMs: publicEvidence.tickerTimestampMs,
              maxAgeMs: MAX_EVIDENCE_AGE_MS,
            }),
            depthEvidence: Object.freeze({
              available: true,
              bidSize,
              askSize,
            }),
            contractStatus: 'TRADABLE',
            minQty: rules.minimumQuantity,
            qtyStep: rules.quantityStep,
            quantityPrecision: rules.quantityPrecision,
            markPrice: publicEvidence.markPrice,
            indexPrice: publicEvidence.indexPrice,
            fundingRate: publicEvidence.fundingRate,
            openInterest: publicEvidence.openInterest,
            leverage: LEVERAGE,
            maxLeverage: rules.maximumLeverage,
            marginMode: 'ISOLATED',
            liquidationDistancePct,
            privateApiUsed: false,
            executionMode: 'SIMULATED_EXECUTION_ONLY',
            publicL2Only: true,
            realFillObserved: false,
            realFillClaim: false,
            publicDepthIsFillProof: false,
            liveSubmittedExecutionSampleCredit: 0,
            privateTradingApiAllowed: false,
            liveOrderAllowed: false,
            orderSubmitted: false,
            exchangeRequestSent: false,
          }),
          quote: Object.freeze({
            bid: publicEvidence.bidPrice,
            ask: publicEvidence.askPrice,
            last: publicEvidence.lastPrice,
            asOfMs: publicEvidence.tickerTimestampMs,
            maxAgeMs: MAX_EVIDENCE_AGE_MS,
          }),
          depth: Object.freeze({ bidSize, askSize }),
          observedSlippagePercent: finalSlippagePercent,
          visibleCoverageRatio,
          projectedFundingRiskRate: conservativeFundingRiskRate,
          fundingChargedAtEntry: false,
          actualExchangeFillClaim: false,
        });
      }
    }
  }

  return result(blockers, {
    riskInput,
    riskResult,
    maximumProbeNotional,
    maximumProbeQuantity,
    observedSlippagePercent,
    observedSpreadPercent,
    conservativeFundingRiskRate,
    finalQuantity: blockers.length === 0 && riskResult.allowed && positive(riskResult.recommendedQuantity)
      ? riskResult.recommendedQuantity : null,
    finalNotional: blockers.length === 0 && riskResult.allowed && positive(riskResult.notionalValue)
      ? riskResult.notionalValue : null,
    prospectiveEntryExecution: blockers.length === 0 ? prospectiveEntryExecution : null,
  });
}
