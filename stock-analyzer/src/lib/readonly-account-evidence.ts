import type { CanonicalAccountSnapshot } from '../components/brokerage-account-connections';
import { evidenceInstant, evidenceNumber, evidenceRecord } from './server-evidence';

const statuses = ['CONNECTED', 'CONFIGURED_UNVERIFIED', 'NOT_CONFIGURED', 'STALE', 'AUTH_FAILED', 'RATE_LIMITED', 'UNAVAILABLE'];
const numericFields = ['available', 'locked', 'total', 'estimatedKrwValue', 'quantity', 'availableQuantity', 'averageEntryPrice', 'currentPrice', 'marketValue', 'unrealizedPnl', 'unrealizedPnlPercent', 'leverage', 'liquidationPrice', 'buyingPower', 'price', 'remainingQuantity'];
const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;

export function parseReadonlyAccount(value: unknown, provider: CanonicalAccountSnapshot['provider'], now = Date.now()): CanonicalAccountSnapshot {
  if (!evidenceRecord(value) || value.provider !== provider || value.readOnly !== true
    || typeof value.connected !== 'boolean' || typeof value.stale !== 'boolean'
    || typeof value.status !== 'string' || !statuses.includes(value.status)
    || !evidenceInstant(value.checkedAt, now)
    || !(value.lastGoodAt === null || evidenceInstant(value.lastGoodAt, now))
    || !(value.errorCode === null || typeof value.errorCode === 'string')
    || !['orderRequests', 'cancelRequests', 'amendRequests', 'transferRequests', 'withdrawalRequests'].every((key) => value[key] === 0)
    || !['credentialsReturned', 'liveTradingEnabled', 'autoTradingEnabled'].every((key) => value[key] === false)) throw new Error('ACCOUNT_RESPONSE_INVALID');
  for (const key of ['accounts', 'balances', 'positions', 'openOrders']) {
    const rows = value[key];
    if (rows === null || rows === undefined) continue;
    if (!Array.isArray(rows) || !rows.every((row) => evidenceRecord(row)
      && numericFields.every((field) => row[field] == null || evidenceNumber(row[field]))
      && (key !== 'balances' || text(row.currency))
      && (key !== 'positions' || (text(row.symbol) && text(row.market)))
      && (key !== 'accounts' || (typeof row.market === 'string' && ['KR', 'US', 'UPBIT', 'BITGET'].includes(row.market)))
    )) throw new Error('ACCOUNT_DATA_INVALID');
  }
  if ((value.connected && !['CONNECTED', 'STALE'].includes(value.status))
    || (value.status === 'CONNECTED' && (!value.connected || value.stale))
    || (value.status === 'STALE' && !value.stale)) throw new Error('ACCOUNT_STATUS_INVALID');
  return value as CanonicalAccountSnapshot;
}

export function accountSnapshotForDisplay(snapshot: CanonicalAccountSnapshot | undefined, now: number) {
  if (!snapshot?.connected) return snapshot;
  if (snapshot.lastGoodAt === null || now - Date.parse(snapshot.lastGoodAt) > 60_000) {
    return { ...snapshot, status: 'STALE' as const, stale: true };
  }
  return snapshot;
}
