export type FourMarketAutoMarket = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
export type FourMarketAutoProvider = 'TOSS' | 'UPBIT' | 'BITGET';
export type FourMarketAutoDirection = 'BUY' | 'SELL_EXIT' | 'LONG' | 'SHORT';
export type FourMarketAutoMarginMode = 'isolated' | 'crossed';

export interface FourMarketStrategyIdentity {
  provider: FourMarketAutoProvider;
  market: FourMarketAutoMarket;
  symbolOrUniverse: string;
  strategyFamily: string;
  strategyVersion: string;
  parameterHash: string;
  timeframe: string;
  horizon: string;
  direction: FourMarketAutoDirection;
  regime: string;
  costPolicyVersion: string;
  researchCodeSha: string;
}

export interface FourMarketAutoCostPolicy {
  version: string;
  commissionBps: number;
  taxBps: number;
  spreadBps: number;
  slippageBps: number;
  latencyMs: number;
  fundingBps?: number;
}

export interface FourMarketAutoRiskEvidence {
  quantity: number;
  maxLossPerTradeKrw: number;
  dailyLossLimitKrw: number;
  totalExposureKrw: number;
  concentrationPercent: number;
  correlatedExposurePercent: number;
  staleDataKillEnabled: boolean;
  providerFailureKillEnabled: boolean;
  strategyDriftKillEnabled: boolean;
  duplicatePreventionReady: boolean;
  partialFillStateReady: boolean;
  restartReconciliationReady: boolean;
}

export interface TossAutoEvidence {
  kind: 'TOSS';
  sessionOpen: boolean;
  halted: boolean;
  tickSize: number;
  sellableQuantity?: number;
}

export interface UpbitAutoEvidence {
  kind: 'UPBIT';
  tickSize: number;
  minOrderKrw: number;
  availableQuantity?: number;
}

export interface BitgetAutoEvidence {
  kind: 'BITGET';
  markPrice: number;
  fundingRate: number;
  openInterest: number;
  minQty: number;
  qtyStep: number;
  priceTick: number;
  leverage: number;
  marginMode: FourMarketAutoMarginMode;
  liquidationDistancePercent: number;
}

export type FourMarketAutoProviderEvidence = TossAutoEvidence | UpbitAutoEvidence | BitgetAutoEvidence;

export interface FourMarketAutoReadinessInput {
  market: FourMarketAutoMarket;
  provider: FourMarketAutoProvider;
  symbol: string;
  direction: FourMarketAutoDirection;
  reduceOnly: boolean;
  observedAt: string;
  staleAfterMs: number;
  strategyIdentity: FourMarketStrategyIdentity;
  costPolicy: FourMarketAutoCostPolicy;
  risk: FourMarketAutoRiskEvidence;
  providerEvidence: FourMarketAutoProviderEvidence;
  paperGateReady: boolean;
  shadowGateReady: boolean;
}

export type FourMarketAutoReadinessReason =
  | 'PROVIDER_AUTHORITY_MISMATCH'
  | 'STRATEGY_IDENTITY_MISMATCH'
  | 'STRATEGY_IDENTITY_INCOMPLETE'
  | 'DATA_TIMESTAMP_INVALID'
  | 'DATA_TIMESTAMP_STALE'
  | 'DATA_TIMESTAMP_FUTURE'
  | 'UNKNOWN_COST_POLICY'
  | 'COST_COMPONENT_INVALID'
  | 'RISK_CONTRACT_INVALID'
  | 'RISK_KILL_SWITCH_INCOMPLETE'
  | 'DUPLICATE_OR_RECOVERY_CONTRACT_INCOMPLETE'
  | 'PAPER_GATE_NOT_READY'
  | 'SHADOW_GATE_NOT_READY'
  | 'CASH_DIRECTION_NOT_ALLOWED'
  | 'CASH_SELL_MUST_REDUCE'
  | 'TOSS_EVIDENCE_MISMATCH'
  | 'TOSS_SESSION_CLOSED'
  | 'TOSS_MARKET_HALTED'
  | 'TOSS_TICK_SIZE_INVALID'
  | 'TOSS_SELLABLE_QUANTITY_INVALID'
  | 'UPBIT_EVIDENCE_MISMATCH'
  | 'UPBIT_MARKET_RULE_INVALID'
  | 'UPBIT_AVAILABLE_QUANTITY_INVALID'
  | 'BITGET_EVIDENCE_MISMATCH'
  | 'BITGET_DIRECTION_INVALID'
  | 'BITGET_CONTRACT_EVIDENCE_INVALID'
  | 'BITGET_LEVERAGE_OR_MARGIN_INVALID'
  | 'BITGET_LIQUIDATION_DISTANCE_INVALID';

export interface FourMarketAutoFrozenPlan {
  readonly provider: FourMarketAutoProvider;
  readonly market: FourMarketAutoMarket;
  readonly symbol: string;
  readonly direction: FourMarketAutoDirection;
  readonly reduceOnly: boolean;
  readonly quantity: number;
  readonly costPolicyVersion: string;
  readonly researchCodeSha: string;
}

export interface FourMarketAutoReadinessResult {
  status: 'AUTO_PREDEPLOY_READY' | 'BLOCKED';
  reasons: FourMarketAutoReadinessReason[];
  frozenOrderPlan: FourMarketAutoFrozenPlan | null;
  orderSubmitted: false;
  exchangeRequestSent: false;
  privateTradingRequestAllowed: false;
  liveActivationAllowed: false;
}

const PROVIDER_AUTHORITY: Readonly<Record<FourMarketAutoMarket, FourMarketAutoProvider>> = Object.freeze({
  KR_STOCK: 'TOSS',
  US_STOCK: 'TOSS',
  CRYPTO_SPOT: 'UPBIT',
  CRYPTO_FUTURES: 'BITGET',
});

const CASH_MARKETS = new Set<FourMarketAutoMarket>(['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT']);

const nonEmpty = (value: string): boolean => value.trim().length > 0;
const finiteNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0;
const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0;

function identityComplete(identity: FourMarketStrategyIdentity): boolean {
  return [
    identity.symbolOrUniverse,
    identity.strategyFamily,
    identity.strategyVersion,
    identity.parameterHash,
    identity.timeframe,
    identity.horizon,
    identity.regime,
    identity.costPolicyVersion,
    identity.researchCodeSha,
  ].every(nonEmpty);
}

function identityMatches(input: FourMarketAutoReadinessInput): boolean {
  const identity = input.strategyIdentity;
  return identity.provider === input.provider
    && identity.market === input.market
    && identity.symbolOrUniverse === input.symbol
    && identity.direction === input.direction
    && identity.costPolicyVersion === input.costPolicy.version;
}

function validateCommon(input: FourMarketAutoReadinessInput, nowMs: number, reasons: FourMarketAutoReadinessReason[]): void {
  if (PROVIDER_AUTHORITY[input.market] !== input.provider) reasons.push('PROVIDER_AUTHORITY_MISMATCH');
  if (!identityComplete(input.strategyIdentity)) reasons.push('STRATEGY_IDENTITY_INCOMPLETE');
  if (!identityMatches(input)) reasons.push('STRATEGY_IDENTITY_MISMATCH');

  const observedMs = Date.parse(input.observedAt);
  if (!Number.isFinite(observedMs) || !finitePositive(input.staleAfterMs)) {
    reasons.push('DATA_TIMESTAMP_INVALID');
  } else {
    if (observedMs > nowMs + 1_000) reasons.push('DATA_TIMESTAMP_FUTURE');
    if (nowMs - observedMs > input.staleAfterMs) reasons.push('DATA_TIMESTAMP_STALE');
  }

  if (!nonEmpty(input.costPolicy.version) || input.costPolicy.version === 'UNKNOWN') {
    reasons.push('UNKNOWN_COST_POLICY');
  }
  const baseCosts = [
    input.costPolicy.commissionBps,
    input.costPolicy.taxBps,
    input.costPolicy.spreadBps,
    input.costPolicy.slippageBps,
    input.costPolicy.latencyMs,
  ];
  if (!baseCosts.every(finiteNonNegative)) reasons.push('COST_COMPONENT_INVALID');
  if (input.market === 'CRYPTO_FUTURES'
    && (input.costPolicy.fundingBps === undefined || !Number.isFinite(input.costPolicy.fundingBps))) {
    reasons.push('COST_COMPONENT_INVALID');
  }

  const risk = input.risk;
  if (!finitePositive(risk.quantity)
    || !finiteNonNegative(risk.maxLossPerTradeKrw)
    || !finiteNonNegative(risk.dailyLossLimitKrw)
    || !finiteNonNegative(risk.totalExposureKrw)
    || !finiteNonNegative(risk.concentrationPercent)
    || risk.concentrationPercent > 100
    || !finiteNonNegative(risk.correlatedExposurePercent)
    || risk.correlatedExposurePercent > 100) {
    reasons.push('RISK_CONTRACT_INVALID');
  }
  if (!risk.staleDataKillEnabled || !risk.providerFailureKillEnabled || !risk.strategyDriftKillEnabled) {
    reasons.push('RISK_KILL_SWITCH_INCOMPLETE');
  }
  if (!risk.duplicatePreventionReady || !risk.partialFillStateReady || !risk.restartReconciliationReady) {
    reasons.push('DUPLICATE_OR_RECOVERY_CONTRACT_INCOMPLETE');
  }
  if (!input.paperGateReady) reasons.push('PAPER_GATE_NOT_READY');
  if (!input.shadowGateReady) reasons.push('SHADOW_GATE_NOT_READY');
}

function validateCashDirection(input: FourMarketAutoReadinessInput, reasons: FourMarketAutoReadinessReason[]): void {
  if (input.direction !== 'BUY' && input.direction !== 'SELL_EXIT') reasons.push('CASH_DIRECTION_NOT_ALLOWED');
  if (input.direction === 'SELL_EXIT' && !input.reduceOnly) reasons.push('CASH_SELL_MUST_REDUCE');
  if (input.direction === 'BUY' && input.reduceOnly) reasons.push('CASH_DIRECTION_NOT_ALLOWED');
}

function validateProviderEvidence(input: FourMarketAutoReadinessInput, reasons: FourMarketAutoReadinessReason[]): void {
  if (input.market === 'KR_STOCK' || input.market === 'US_STOCK') {
    if (input.providerEvidence.kind !== 'TOSS') {
      reasons.push('TOSS_EVIDENCE_MISMATCH');
      return;
    }
    if (!input.providerEvidence.sessionOpen) reasons.push('TOSS_SESSION_CLOSED');
    if (input.providerEvidence.halted) reasons.push('TOSS_MARKET_HALTED');
    if (!finitePositive(input.providerEvidence.tickSize)) reasons.push('TOSS_TICK_SIZE_INVALID');
    if (input.direction === 'SELL_EXIT'
      && (!finiteNonNegative(input.providerEvidence.sellableQuantity ?? Number.NaN)
        || (input.providerEvidence.sellableQuantity ?? 0) < input.risk.quantity)) {
      reasons.push('TOSS_SELLABLE_QUANTITY_INVALID');
    }
    return;
  }

  if (input.market === 'CRYPTO_SPOT') {
    if (input.providerEvidence.kind !== 'UPBIT') {
      reasons.push('UPBIT_EVIDENCE_MISMATCH');
      return;
    }
    if (!finitePositive(input.providerEvidence.tickSize) || !finitePositive(input.providerEvidence.minOrderKrw)) {
      reasons.push('UPBIT_MARKET_RULE_INVALID');
    }
    if (input.direction === 'SELL_EXIT'
      && (!finiteNonNegative(input.providerEvidence.availableQuantity ?? Number.NaN)
        || (input.providerEvidence.availableQuantity ?? 0) < input.risk.quantity)) {
      reasons.push('UPBIT_AVAILABLE_QUANTITY_INVALID');
    }
    return;
  }

  if (input.providerEvidence.kind !== 'BITGET') {
    reasons.push('BITGET_EVIDENCE_MISMATCH');
    return;
  }
  if (input.direction !== 'LONG' && input.direction !== 'SHORT') reasons.push('BITGET_DIRECTION_INVALID');
  if (!finitePositive(input.providerEvidence.markPrice)
    || !Number.isFinite(input.providerEvidence.fundingRate)
    || !finiteNonNegative(input.providerEvidence.openInterest)
    || !finitePositive(input.providerEvidence.minQty)
    || !finitePositive(input.providerEvidence.qtyStep)
    || !finitePositive(input.providerEvidence.priceTick)) {
    reasons.push('BITGET_CONTRACT_EVIDENCE_INVALID');
  }
  if (!finitePositive(input.providerEvidence.leverage)
    || (input.providerEvidence.marginMode !== 'isolated' && input.providerEvidence.marginMode !== 'crossed')) {
    reasons.push('BITGET_LEVERAGE_OR_MARGIN_INVALID');
  }
  if (!finitePositive(input.providerEvidence.liquidationDistancePercent)) {
    reasons.push('BITGET_LIQUIDATION_DISTANCE_INVALID');
  }
}

export function evaluateFourMarketAutoPredeployReadiness(
  input: FourMarketAutoReadinessInput,
  nowMs: number = Date.now(),
): FourMarketAutoReadinessResult {
  const reasons: FourMarketAutoReadinessReason[] = [];
  validateCommon(input, nowMs, reasons);
  if (CASH_MARKETS.has(input.market)) validateCashDirection(input, reasons);
  validateProviderEvidence(input, reasons);

  const uniqueReasons = [...new Set(reasons)];
  const frozenOrderPlan = uniqueReasons.length === 0
    ? Object.freeze<FourMarketAutoFrozenPlan>({
        provider: input.provider,
        market: input.market,
        symbol: input.symbol,
        direction: input.direction,
        reduceOnly: input.reduceOnly,
        quantity: input.risk.quantity,
        costPolicyVersion: input.costPolicy.version,
        researchCodeSha: input.strategyIdentity.researchCodeSha,
      })
    : null;

  return {
    status: uniqueReasons.length === 0 ? 'AUTO_PREDEPLOY_READY' : 'BLOCKED',
    reasons: uniqueReasons,
    frozenOrderPlan,
    orderSubmitted: false,
    exchangeRequestSent: false,
    privateTradingRequestAllowed: false,
    liveActivationAllowed: false,
  };
}
