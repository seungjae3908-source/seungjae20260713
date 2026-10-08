import type { ExchangeConnection } from './trade-automation.types';

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
