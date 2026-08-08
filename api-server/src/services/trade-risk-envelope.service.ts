import type {
  TradingMarketSnapshot,
  TradingPlan,
  TradingPolicy,
} from './trade-automation.types';

export type TradingRiskEnvelope = {
  version: 1;
  investmentKrw: number;
  maxLossKrw: number;
  maxSlippagePercent: number;
  maxSplitCount: number;
  allowCancelUnfilled: boolean;
  stopMethod: 'fixed_stop';
  emergencyExitScope: 'cancel_unfilled_and_reduce_only';
  approvedAt: string;
  expiresAt: string;
};

type EnvelopedTradingPlan = TradingPlan & {
  riskEnvelope?: TradingRiskEnvelope | null;
};

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function referencePrice(plan: TradingPlan) {
  const candidates = [
    plan.marketSnapshot.currentPrice,
    plan.marketSnapshot.plannedPrice,
    plan.entryPrice,
    plan.limitPrice,
    plan.quoteAmount != null && plan.quantity != null && plan.quantity > 0
      ? plan.quoteAmount / plan.quantity
      : null,
  ];
  return candidates.find((value): value is number => finitePositive(value)) ?? null;
}

function expectedStopLossKrw(plan: TradingPlan, reference: number) {
  if (!finitePositive(plan.stopPrice) || !(reference > 0)) return null;
  const stopDistancePercent = Math.abs(reference - plan.stopPrice) / reference * 100;
  const value = plan.estimatedKrw * stopDistancePercent / 100;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function parseEnvelope(value: unknown): TradingRiskEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<TradingRiskEnvelope>;
  if (candidate.version !== 1
    || !finitePositive(candidate.investmentKrw)
    || !finitePositive(candidate.maxLossKrw)
    || !finiteNonNegative(candidate.maxSlippagePercent)
    || !Number.isInteger(candidate.maxSplitCount)
    || Number(candidate.maxSplitCount) < 1
    || candidate.allowCancelUnfilled !== true
    || candidate.stopMethod !== 'fixed_stop'
    || candidate.emergencyExitScope !== 'cancel_unfilled_and_reduce_only'
    || typeof candidate.approvedAt !== 'string'
    || !Number.isFinite(Date.parse(candidate.approvedAt))
    || typeof candidate.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(candidate.expiresAt))) return null;
  return candidate as TradingRiskEnvelope;
}

export function riskEnvelopeForPlan(plan: TradingPlan) {
  return parseEnvelope((plan as EnvelopedTradingPlan).riskEnvelope);
}

export function withRiskEnvelope(plan: TradingPlan, envelope: TradingRiskEnvelope): TradingPlan {
  return { ...plan, riskEnvelope: envelope } as EnvelopedTradingPlan;
}

export function buildRiskEnvelope(plan: TradingPlan, policy: TradingPolicy, approvedAt: string): TradingRiskEnvelope {
  if (!plan.approvalExpiresAt || !Number.isFinite(Date.parse(plan.approvalExpiresAt))) {
    throw new Error('RISK_ENVELOPE_EXPIRATION_REQUIRED');
  }
  const reference = referencePrice(plan);
  if (reference == null) throw new Error('RISK_ENVELOPE_REFERENCE_PRICE_REQUIRED');
  const stopLossKrw = expectedStopLossKrw(plan, reference);
  if (stopLossKrw == null) throw new Error('RISK_ENVELOPE_STOP_REQUIRED');

  const slippageBudget = plan.estimatedKrw * policy.maxEstimatedSlippagePercent / 100;
  const worstApprovedLoss = stopLossKrw + slippageBudget;
  const accountDailyRiskBudget = policy.totalCapitalKrw * policy.totalDailyLossLimitPercent / 100;
  if (!(accountDailyRiskBudget > 0) || worstApprovedLoss > accountDailyRiskBudget + 1e-9) {
    throw new Error('RISK_ENVELOPE_MAX_LOSS_EXCEEDED');
  }
  if (!Number.isInteger(plan.splitRatios.length) || plan.splitRatios.length < 1 || plan.splitRatios.length > 20) {
    throw new Error('RISK_ENVELOPE_SPLIT_COUNT_INVALID');
  }

  return {
    version: 1,
    investmentKrw: plan.estimatedKrw,
    maxLossKrw: worstApprovedLoss,
    maxSlippagePercent: policy.maxEstimatedSlippagePercent,
    maxSplitCount: plan.splitRatios.length,
    allowCancelUnfilled: true,
    stopMethod: 'fixed_stop',
    emergencyExitScope: 'cancel_unfilled_and_reduce_only',
    approvedAt,
    expiresAt: plan.approvalExpiresAt,
  };
}

export type RiskEnvelopeCheckResult = {
  allowed: boolean;
  blockCodes: string[];
};

export function evaluateRiskEnvelope(input: {
  plan: TradingPlan;
  snapshot: TradingMarketSnapshot;
  now?: Date;
}): RiskEnvelopeCheckResult {
  const blockCodes: string[] = [];
  const envelope = riskEnvelopeForPlan(input.plan);
  const now = input.now ?? new Date();
  if (!envelope) return { allowed: false, blockCodes: ['RISK_ENVELOPE_MISSING_OR_INVALID'] };

  if (Date.parse(envelope.expiresAt) <= now.getTime()) blockCodes.push('RISK_ENVELOPE_EXPIRED');
  if (input.plan.estimatedKrw > envelope.investmentKrw + 1e-9) blockCodes.push('RISK_ENVELOPE_INVESTMENT_EXCEEDED');
  if (input.plan.splitRatios.length > envelope.maxSplitCount) blockCodes.push('RISK_ENVELOPE_SPLIT_COUNT_EXCEEDED');

  const slippage = input.snapshot.estimatedSlippagePercent;
  if (!finiteNonNegative(slippage)) {
    if (input.plan.accountMode !== 'paper' && input.plan.accountMode !== 'mock') {
      blockCodes.push('RISK_ENVELOPE_SLIPPAGE_UNKNOWN');
    }
  } else if (slippage > envelope.maxSlippagePercent + 1e-9) {
    blockCodes.push('RISK_ENVELOPE_SLIPPAGE_EXCEEDED');
  }

  const currentReference = finitePositive(input.snapshot.currentPrice)
    ? input.snapshot.currentPrice
    : referencePrice(input.plan);
  if (currentReference == null) {
    blockCodes.push('RISK_ENVELOPE_REFERENCE_PRICE_UNAVAILABLE');
  } else {
    const stopLossKrw = expectedStopLossKrw(input.plan, currentReference);
    if (stopLossKrw == null) blockCodes.push('RISK_ENVELOPE_STOP_UNAVAILABLE');
    else {
      const slippageCost = input.plan.estimatedKrw * (finiteNonNegative(slippage) ? slippage : envelope.maxSlippagePercent) / 100;
      if (stopLossKrw + slippageCost > envelope.maxLossKrw + 1e-9) blockCodes.push('RISK_ENVELOPE_MAX_LOSS_EXCEEDED');
    }
    const stopBreached = (input.plan.side === 'buy' || input.plan.side === 'long')
      ? currentReference <= input.plan.stopPrice
      : currentReference >= input.plan.stopPrice;
    if (stopBreached) blockCodes.push('RISK_ENVELOPE_STOP_BREACHED');
  }

  return { allowed: blockCodes.length === 0, blockCodes };
}

export function assertCancellationAllowed(plan: TradingPlan) {
  const envelope = riskEnvelopeForPlan(plan);
  if (!envelope || envelope.allowCancelUnfilled !== true) throw new Error('RISK_ENVELOPE_CANCEL_NOT_ALLOWED');
}
