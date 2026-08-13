import { createHash } from 'node:crypto';

export type TossReadonlyCredentials = {
  clientId: string;
  clientSecret: string;
};

export type TossReadonlyRequest = {
  method: 'GET' | 'POST';
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string | null;
};

export type TossReadonlyTransport = {
  send<T>(request: TossReadonlyRequest): Promise<T>;
};

type JsonRecord = Record<string, unknown>;

const TOSS_BASE = 'https://openapi.tossinvest.com';
const ALLOWED_PATHS = new Set([
  '/oauth2/token',
  '/api/v1/accounts',
  '/api/v1/holdings',
  '/api/v1/buying-power',
]);

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function finite(value: unknown): number | null {
  const normalized = typeof value === 'string' ? value.replace(/[,+%₩$]/g, '').trim() : value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function maskAccount(accountSeq: string): string {
  const value = accountSeq.trim();
  if (!value) return '***';
  if (value.length <= 2) return '*'.repeat(value.length);
  return `${value.slice(0, 1)}${'*'.repeat(Math.max(2, value.length - 2))}${value.slice(-1)}`;
}

function accountRef(userId: string, accountSeq: string): string {
  return createHash('sha256').update(`${userId}:${accountSeq}`).digest('hex').slice(0, 16);
}

function authorizedGet(accessToken: string, path: string, accountSeq?: string, query = ''): TossReadonlyRequest {
  if (!ALLOWED_PATHS.has(path) || path === '/oauth2/token') throw new Error('TOSS_READONLY_PATH_FORBIDDEN');
  return {
    method: 'GET',
    path,
    query,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(accountSeq ? { 'X-Tossinvest-Account': accountSeq } : {}),
    },
    body: null,
  };
}

function tokenRequest(credentials: TossReadonlyCredentials): TossReadonlyRequest {
  const clientId = credentials.clientId.trim();
  const clientSecret = credentials.clientSecret.trim();
  if (!clientId || !clientSecret) throw new Error('TOSS_CREDENTIALS_REQUIRED');
  return {
    method: 'POST',
    path: '/oauth2/token',
    query: '',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  };
}

function assertReadonlyRequest(request: TossReadonlyRequest) {
  if (!ALLOWED_PATHS.has(request.path)) throw new Error('TOSS_READONLY_PATH_FORBIDDEN');
  const token = request.path === '/oauth2/token';
  if (token) {
    if (request.method !== 'POST') throw new Error('TOSS_AUTH_METHOD_FORBIDDEN');
    return;
  }
  if (request.method !== 'GET' || request.body !== null) throw new Error('TOSS_PRIVATE_MUTATION_FORBIDDEN');
}

export class HttpTossReadonlyTransport implements TossReadonlyTransport {
  constructor(private readonly timeoutMs = 12_000) {}

  async send<T>(request: TossReadonlyRequest): Promise<T> {
    assertReadonlyRequest(request);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${TOSS_BASE}${request.path}${request.query ? `?${request.query}` : ''}`, {
        method: request.method,
        headers: {
          ...request.headers,
          'User-Agent': 'seungjae-investment-app/1.0',
        },
        body: request.body,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`TOSS_HTTP_${response.status}`);
      return await response.json() as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export type TossReadonlyHolding = {
  symbol: string;
  name: string | null;
  market: 'KR' | 'US' | 'UNKNOWN';
  currency: string | null;
  quantity: number | null;
  availableQuantity: number | null;
  averagePrice: number | null;
  currentPrice: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  profitRatePercent: number | null;
};

export type TossReadonlyAccountSnapshot = {
  accountRef: string;
  accountMasked: string;
  accountType: string | null;
  holdings: TossReadonlyHolding[];
  buyingPower: {
    KRW: number | null;
    USD: number | null;
  };
  summary: {
    marketValueKrw: number | null;
    marketValueUsd: number | null;
    unrealizedPnlKrw: number | null;
    unrealizedPnlUsd: number | null;
    profitRatePercent: number | null;
  };
  warnings: string[];
};

function currencyPair(value: unknown) {
  const row = record(value);
  return {
    KRW: finite(row.krw ?? row.KRW),
    USD: finite(row.usd ?? row.USD),
  };
}

function normalizeHolding(row: JsonRecord): TossReadonlyHolding {
  const marketValue = record(row.marketValue);
  const profitLoss = record(row.profitLoss);
  const rawRate = finite(profitLoss.rate ?? row.profitRate);
  const country = text(row.marketCountry).toUpperCase();
  return {
    symbol: text(row.symbol).toUpperCase(),
    name: text(row.name) || null,
    market: country === 'KR' ? 'KR' : country === 'US' ? 'US' : 'UNKNOWN',
    currency: text(row.currency) || null,
    quantity: finite(row.quantity),
    availableQuantity: finite(row.availableQuantity ?? row.sellableQuantity),
    averagePrice: finite(row.averagePurchasePrice ?? row.averagePrice),
    currentPrice: finite(row.lastPrice ?? row.currentPrice),
    marketValue: finite(marketValue.amount ?? row.marketValue),
    unrealizedPnl: finite(profitLoss.amount ?? row.profitLoss),
    profitRatePercent: rawRate == null ? null : rawRate * 100,
  };
}

function buyingPowerValue(payload: unknown): number | null {
  const result = record(record(payload).result);
  return finite(result.cashBuyingPower ?? result.buyingPower ?? result.availableAmount);
}

export async function readTossAccountSnapshot(input: {
  userId: string;
  credentials: TossReadonlyCredentials;
  transport: TossReadonlyTransport;
}) {
  const requests: TossReadonlyRequest[] = [];
  const send = async <T>(request: TossReadonlyRequest) => {
    assertReadonlyRequest(request);
    requests.push(request);
    return input.transport.send<T>(request);
  };

  const tokenPayload = record(await send<unknown>(tokenRequest(input.credentials)));
  const accessToken = text(tokenPayload.access_token);
  if (!accessToken) throw new Error('TOSS_ACCESS_TOKEN_MISSING');

  const accountsPayload = record(await send<unknown>(authorizedGet(accessToken, '/api/v1/accounts')));
  const accounts = Array.isArray(accountsPayload.result)
    ? accountsPayload.result.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];

  const normalized: TossReadonlyAccountSnapshot[] = [];
  for (const account of accounts) {
    const seq = text(account.accountSeq ?? account.accountId);
    if (!seq) continue;
    const warnings: string[] = [];

    let holdingsPayload: JsonRecord = {};
    try {
      holdingsPayload = record(await send<unknown>(authorizedGet(accessToken, '/api/v1/holdings', seq)));
    } catch {
      warnings.push('TOSS_HOLDINGS_UNAVAILABLE');
    }
    const holdingsResult = record(holdingsPayload.result);
    const holdingRows = Array.isArray(holdingsResult.items)
      ? holdingsResult.items.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      : [];

    let krwPower: number | null = null;
    let usdPower: number | null = null;
    try {
      krwPower = buyingPowerValue(await send<unknown>(authorizedGet(accessToken, '/api/v1/buying-power', seq, 'currency=KRW')));
    } catch {
      warnings.push('TOSS_KRW_BUYING_POWER_UNAVAILABLE');
    }
    try {
      usdPower = buyingPowerValue(await send<unknown>(authorizedGet(accessToken, '/api/v1/buying-power', seq, 'currency=USD')));
    } catch {
      warnings.push('TOSS_USD_BUYING_POWER_UNAVAILABLE');
    }

    const marketValue = currencyPair(record(holdingsResult.marketValue).amount ?? holdingsResult.marketValue);
    const pnl = currencyPair(record(holdingsResult.profitLoss).amount ?? holdingsResult.profitLoss);
    const pnlRate = finite(record(holdingsResult.profitLoss).rate);

    normalized.push({
      accountRef: accountRef(input.userId, seq),
      accountMasked: maskAccount(seq),
      accountType: text(account.accountType ?? account.type) || null,
      holdings: holdingRows.map(normalizeHolding),
      buyingPower: { KRW: krwPower, USD: usdPower },
      summary: {
        marketValueKrw: marketValue.KRW,
        marketValueUsd: marketValue.USD,
        unrealizedPnlKrw: pnl.KRW,
        unrealizedPnlUsd: pnl.USD,
        profitRatePercent: pnlRate == null ? null : pnlRate * 100,
      },
      warnings,
    });
  }

  return {
    ok: true,
    provider: 'toss' as const,
    readOnly: true,
    connected: true,
    accounts: normalized,
    providerRequests: requests.length,
    privateReadRequests: Math.max(0, requests.length - 1),
    authRequests: 1,
    orderRequests: 0,
    cancelRequests: 0,
    amendRequests: 0,
    transferRequests: 0,
    withdrawalRequests: 0,
    credentialsReturned: false,
    fullAccountNumberReturned: false,
    checkedAt: new Date().toISOString(),
  };
}

export function assertTossReadonlyContract(requests: TossReadonlyRequest[]) {
  for (const request of requests) assertReadonlyRequest(request);
  return true;
}
