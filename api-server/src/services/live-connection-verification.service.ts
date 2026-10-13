import type { ExchangeConnection, TradingPlanInput } from './trade-automation.types';

// A saved credential is not indefinite evidence of current broker authorization.
// Order-time account/risk snapshots have separate, stricter freshness checks.
export const LIVE_CONNECTION_VERIFICATION_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

export function liveConnectionVerificationFresh(
  connection: Pick<ExchangeConnection, 'configured' | 'accountMode' | 'lastVerifiedAt' | 'lastErrorCode'> | null | undefined,
  nowMs = Date.now(),
) {
  const verifiedAt = Date.parse(connection?.lastVerifiedAt ?? '');
  return connection?.configured === true
    && connection.accountMode === 'live'
    && !connection.lastErrorCode
    && Number.isFinite(nowMs)
    && Number.isFinite(verifiedAt)
    && verifiedAt <= nowMs + 5_000
    && nowMs - verifiedAt <= LIVE_CONNECTION_VERIFICATION_MAX_AGE_MS;
}

// Risk-reducing exits must not be held hostage by a 30-day re-verification age
// if the same verified credential is still configured and free from known errors.
// Fresh provider balance/position/risk rechecks remain mandatory at execution.
export function liveConnectionVerificationAllowsReducingExit(
  connection: Pick<ExchangeConnection, 'configured' | 'accountMode' | 'lastVerifiedAt' | 'lastErrorCode'> | null | undefined,
  nowMs = Date.now(),
) {
  const verifiedAt = Date.parse(connection?.lastVerifiedAt ?? '');
  return connection?.configured === true
    && connection.accountMode === 'live'
    && !connection.lastErrorCode
    && Number.isFinite(nowMs)
    && Number.isFinite(verifiedAt)
    && verifiedAt <= nowMs + 5_000;
}

export function isRiskReducingExitPlan(
  plan: Pick<TradingPlanInput, 'reduceOnly' | 'exchange' | 'side'>,
) {
  // Cash markets are long-only, so a SELL can reduce risk. Bitget must carry
  // reduceOnly at the provider, and its close sides are LONG or SHORT.
  return plan.reduceOnly === true
    && (plan.exchange === 'bitget'
      ? plan.side === 'long' || plan.side === 'short'
      : plan.side === 'sell');
}
