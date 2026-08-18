import { createHash } from 'node:crypto';
import { AccountReadonlyError } from '../account-readonly.errors';
import {
  emptySnapshot,
  maskAccountRef,
  nullableNumber,
  type CanonicalAccount,
  type CanonicalAccountSnapshot,
  type CanonicalPosition,
} from '../account-readonly.contract';

export type TossCredentials = { clientId: string; clientSecret: string; accountSeq?: string };
export type ReadonlyTransport = (request: {
  method: 'GET' | 'POST';
  path: string;
  headers: Record<string, string>;
  body: string | null;
  signal?: AbortSignal;
}) => Promise<{ status: number; headers?: Record<string, string>; body: unknown }>;

const PRIVATE_GETS = new Set(['/api/v1/accounts', '/api/v1/holdings']);
const TOSS_API_ORIGIN = 'https://openapi.tossinvest.com';
const TOSS_OAUTH_ORIGIN = 'https://oauth2.tossinvest.com';

function credentialKey(credentials: TossCredentials) {
  return createHash('sha256')
    .update(credentials.clientId)
    .update('\0')
    .update(credentials.clientSecret)
    .digest('hex');
}

export function createTossReadonlyTransport(
  fetchImpl: typeof fetch = fetch,
  apiOrigin = TOSS_API_ORIGIN,
  oauthOrigin = TOSS_OAUTH_ORIGIN,
): ReadonlyTransport {
  const normalizedApiOrigin = new URL(apiOrigin).origin;
  const normalizedOauthOrigin = new URL(oauthOrigin).origin;
  return async (request) => {
    const origin = request.path === '/oauth2/token' ? normalizedOauthOrigin : normalizedApiOrigin;
    if (request.path !== '/oauth2/token' && !PRIVATE_GETS.has(request.path)) {
      throw new AccountReadonlyError('READONLY_PATH_REJECTED');
    }
    if (request.path === '/oauth2/token' && request.method !== 'POST') {
      throw new AccountReadonlyError('READONLY_REQUEST_REJECTED');
    }
    if (request.path !== '/oauth2/token' && (request.method !== 'GET' || request.body !== null)) {
      throw new AccountReadonlyError('READONLY_REQUEST_REJECTED');
    }
    const url = new URL(request.path, origin);
    if (url.origin !== origin) throw new AccountReadonlyError('READONLY_REQUEST_REJECTED');
    const response = await fetchImpl(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
      redirect: 'error',
      cache: 'no-store',
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    let body: unknown = null;
    try { body = await response.json(); } catch { body = null; }
    return { status: response.status, headers, body };
  };
}

export class TossTokenManager {
  private readonly cached = new Map<string, { token: string; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<string>>();

  constructor(private readonly transport: ReadonlyTransport, private readonly now = () => Date.now()) {}

  async token(credentials: TossCredentials, signal?: AbortSignal): Promise<string> {
    const key = credentialKey(credentials);
    const cached = this.cached.get(key);
    if (cached && cached.expiresAt - 30_000 > this.now()) return cached.token;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const issued = this.issue(key, credentials, signal).finally(() => { this.pending.delete(key); });
    this.pending.set(key, issued);
    return issued;
  }

  private async issue(key: string, credentials: TossCredentials, signal?: AbortSignal) {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }).toString();
    const response = await this.transport({
      method: 'POST',
      path: '/oauth2/token',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal,
    });
    if (response.status === 401 || response.status === 403) throw new AccountReadonlyError('AUTH_FAILED');
    if (response.status === 429) throw new AccountReadonlyError('RATE_LIMITED', true);
    if (response.status >= 400) throw new AccountReadonlyError(`TOSS_HTTP_${response.status}`, response.status >= 500);
    const row = record(response.body);
    const token = String(row?.access_token ?? '');
    const expires = nullableNumber(row?.expires_in);
    if (!token || expires === null || expires <= 0) throw new AccountReadonlyError('TOSS_TOKEN_RESPONSE_INVALID');
    this.cached.set(key, { token, expiresAt: this.now() + expires * 1000 });
    return token;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function records(value: unknown, preferredKey?: string): Record<string, unknown>[] {
  const root = record(value);
  const result = record(root?.result);
  const preferred = preferredKey
    ? root?.[preferredKey] ?? result?.[preferredKey]
    : undefined;
  const candidate = preferred ?? root?.result ?? root?.data ?? value;
  if (Array.isArray(candidate)) return candidate.map(record).filter((row): row is Record<string, unknown> => row !== null);
  const single = record(candidate);
  return single ? [single] : [];
}

function normalizeTossMarket(row: Record<string, unknown>) {
  const currency = String(row.currency ?? '').toUpperCase();
  const exchange = String(row.exchangeCode ?? row.exchange ?? '').toUpperCase();
  if (currency === 'KRW' || /KRX|KOSPI|KOSDAQ/.test(exchange)) return 'KR';
  if (currency === 'USD' || /NASDAQ|NYSE|AMEX|NASD/.test(exchange)) return 'US';
  return exchange || 'UNKNOWN';
}

function selectAccountSeq(accountRows: Record<string, unknown>[], requested?: string) {
  const normalized = accountRows.flatMap((row) => {
    const accountSeq = String(row.accountSeq ?? '').trim();
    return accountSeq ? [{ row, accountSeq }] : [];
  });
  if (requested?.trim()) {
    const exact = normalized.find((entry) => entry.accountSeq === requested.trim());
    if (!exact) throw new AccountReadonlyError('TOSS_ACCOUNT_NOT_FOUND');
    return exact.accountSeq;
  }
  const brokerage = normalized.filter(({ row }) => String(row.accountType ?? '').toLowerCase() === 'brokerage');
  if (brokerage.length === 1) return brokerage[0]!.accountSeq;
  if (normalized.length === 1) return normalized[0]!.accountSeq;
  if (normalized.length === 0) throw new AccountReadonlyError('TOSS_ACCOUNT_NOT_FOUND');
  throw new AccountReadonlyError('TOSS_ACCOUNT_SELECTION_REQUIRED');
}

export class TossReadonlyProvider {
  constructor(
    private readonly transport: ReadonlyTransport,
    private readonly tokens: TossTokenManager,
    private readonly now = () => new Date(),
  ) {}

  async request(path: string, credentials: TossCredentials, signal?: AbortSignal, accountSeq?: string) {
    if (!PRIVATE_GETS.has(path)) throw new AccountReadonlyError('READONLY_PATH_REJECTED');
    const token = await this.tokens.token(credentials, signal);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (path !== '/api/v1/accounts') {
      const selected = String(accountSeq ?? credentials.accountSeq ?? '').trim();
      if (!selected) throw new AccountReadonlyError('TOSS_ACCOUNT_NOT_CONFIGURED');
      headers['X-Tossinvest-Account'] = selected;
    }
    const response = await this.transport({ method: 'GET', path, headers, body: null, signal });
    if (response.status === 401 || response.status === 403) throw new AccountReadonlyError('AUTH_FAILED');
    if (response.status === 429) {
      const retryAfter = nullableNumber(response.headers?.['retry-after']);
      throw new AccountReadonlyError('RATE_LIMITED', true, retryAfter === null ? null : retryAfter * 1000);
    }
    if (response.status >= 400) throw new AccountReadonlyError(`TOSS_HTTP_${response.status}`, response.status >= 500);
    return response.body;
  }

  async snapshot(credentials: TossCredentials, signal?: AbortSignal): Promise<CanonicalAccountSnapshot> {
    const checkedAt = this.now().toISOString();
    const accountsRaw = await this.request('/api/v1/accounts', credentials, signal);
    const accountRows = records(accountsRaw, 'accounts');
    const accountSeq = selectAccountSeq(accountRows, credentials.accountSeq);
    const holdingsRaw = await this.request('/api/v1/holdings', credentials, signal, accountSeq);
    const products = records(holdingsRaw, 'products');

    const positions: CanonicalPosition[] = products.map((row) => ({
      market: normalizeTossMarket(row),
      symbol: String(row.productCode ?? row.symbol ?? '').trim(),
      quantity: nullableNumber(row.quantity),
      availableQuantity: nullableNumber(row.tradableQuantity ?? row.availableQuantity),
      averageEntryPrice: nullableNumber(row.averagePurchasePrice),
      currentPrice: nullableNumber(row.currentPrice),
      marketValue: nullableNumber(row.evaluationAmount ?? row.marketValue),
      unrealizedPnl: nullableNumber(row.evaluationProfitLoss ?? row.profitLoss),
      unrealizedPnlPercent: nullableNumber(row.yield ?? row.profitLossRate),
      leverage: null,
      liquidationPrice: null,
      marginMode: null,
      side: null,
    })).filter((row) => row.symbol.length > 0);

    const detectedMarkets = new Set(positions.map((row) => row.market).filter((market) => market === 'KR' || market === 'US'));
    const accounts: CanonicalAccount[] = [...detectedMarkets].map((market) => ({
      market: market as 'KR' | 'US',
      accountRef: maskAccountRef(accountSeq),
      currency: market === 'KR' ? 'KRW' : 'USD',
      buyingPower: null,
    }));

    return {
      ...emptySnapshot('toss', 'CONNECTED', checkedAt),
      connected: true,
      accounts,
      positions,
      lastGoodAt: checkedAt,
    };
  }
}
