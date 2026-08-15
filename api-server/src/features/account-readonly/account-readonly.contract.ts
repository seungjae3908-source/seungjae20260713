export type AccountProvider = 'toss' | 'upbit' | 'bitget';
export type AccountReadStatus = 'CONNECTED' | 'CONFIGURED_UNVERIFIED' | 'NOT_CONFIGURED' | 'STALE' | 'AUTH_FAILED' | 'RATE_LIMITED' | 'UNAVAILABLE';

export type CanonicalBalance = { currency: string; available: number | null; locked: number | null; total: number | null; estimatedKrwValue: number | null };
export type CanonicalPosition = { market: string; symbol: string; quantity: number | null; availableQuantity: number | null; averageEntryPrice: number | null; currentPrice: number | null; marketValue: number | null; unrealizedPnl: number | null; unrealizedPnlPercent: number | null; leverage: number | null; liquidationPrice: number | null; marginMode: string | null; side: string | null };
export type CanonicalReadonlyOrder = { id: string | null; market: string | null; symbol: string | null; side: string | null; price: number | null; quantity: number | null; remainingQuantity: number | null; status: string | null };
export type CanonicalAccount = { market: 'KR' | 'US' | 'UPBIT' | 'BITGET'; accountRef: string | null; currency: string | null; buyingPower: number | null };

export type CanonicalAccountSnapshot = {
  provider: AccountProvider; readOnly: true; connected: boolean; status: AccountReadStatus;
  accounts: CanonicalAccount[]; balances: CanonicalBalance[]; positions: CanonicalPosition[]; openOrders: CanonicalReadonlyOrder[];
  checkedAt: string; lastGoodAt: string | null; stale: boolean; errorCode: string | null;
  orderRequests: 0; cancelRequests: 0; amendRequests: 0; transferRequests: 0; withdrawalRequests: 0;
  credentialsReturned: false; liveTradingEnabled: false; autoTradingEnabled: false;
};

export function emptySnapshot(provider: AccountProvider, status: AccountReadStatus, checkedAt: string, errorCode: string | null = null): CanonicalAccountSnapshot {
  return { provider, readOnly: true, connected: false, status, accounts: [], balances: [], positions: [], openOrders: [], checkedAt, lastGoodAt: null, stale: status === 'STALE', errorCode, orderRequests: 0, cancelRequests: 0, amendRequests: 0, transferRequests: 0, withdrawalRequests: 0, credentialsReturned: false, liveTradingEnabled: false, autoTradingEnabled: false };
}

export function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function maskAccountRef(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  return raw.length <= 4 ? '*'.repeat(raw.length) : `${raw.slice(0, 2)}${'*'.repeat(Math.min(8, raw.length - 4))}${raw.slice(-2)}`;
}
