import type { TradingPlanInput, TradingPolicy } from './trade-automation.types';

/**
 * Paper simulation policy is independent of the stored LIVE/provider limits.
 * Only a fresh, canonical automatic PAPER futures plan may consume 7x.
 * Do not persist this projection or reuse it for LIVE or private provider calls.
 */
export const AUTOMATIC_PAPER_FUTURES_LEVERAGE = 7 as const;
export const MANUAL_PAPER_FUTURES_MIN_LEVERAGE = 1 as const;
export const MANUAL_PAPER_FUTURES_MAX_LEVERAGE = 125 as const;

type PlanScope = Pick<TradingPlanInput, 'accountMode' | 'exchange' | 'leverage' | 'marginMode'>;
export type PaperExecutionMode = 'automatic' | 'manual';

export function automaticPaperFuturesLeverageBlockers(
  plan: PlanScope, executionMode: PaperExecutionMode,
): string[] {
  if (plan.accountMode !== 'paper' || plan.exchange !== 'bitget' || executionMode !== 'automatic') {
    return [];
  }
  const blockers: string[] = [];
  if (plan.leverage !== AUTOMATIC_PAPER_FUTURES_LEVERAGE) {
    blockers.push('AUTOMATIC_PAPER_FUTURES_7X_REQUIRED');
  }
  if (plan.marginMode !== 'isolated') {
    blockers.push('AUTOMATIC_PAPER_FUTURES_ISOLATED_REQUIRED');
  }
  return blockers;
}

export function scopeAutomaticPaperFuturesRiskPolicy(
  policy: TradingPolicy,
  plan: PlanScope,
  executionMode: PaperExecutionMode,
): TradingPolicy {
  if (plan.accountMode !== 'paper' || plan.exchange !== 'bitget' || executionMode !== 'automatic') {
    return policy;
  }
  // Avoid mutating or persisting the role-scoped LIVE policy.
  return { ...policy, bitgetLeverage: AUTOMATIC_PAPER_FUTURES_LEVERAGE };
}

export function validateManualPaperFuturesLeverage(value: unknown): boolean {
  return Number.isInteger(value)
    && (value as number) >= MANUAL_PAPER_FUTURES_MIN_LEVERAGE
    && (value as number) <= MANUAL_PAPER_FUTURES_MAX_LEVERAGE;
}
