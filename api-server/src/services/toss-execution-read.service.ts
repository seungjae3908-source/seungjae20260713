import type { PreparedExchangeRequest, TossCredentials } from './trade-exchange-adapters.service';

function token(credentials: TossCredentials) {
  const accessToken = credentials.accessToken?.trim();
  if (!accessToken) throw new Error('TOSS_ACCESS_TOKEN_REQUIRED');
  return accessToken;
}

function symbol(value: string) {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,20}$/.test(normalized)) throw new Error('TOSS_SYMBOL_INVALID');
  return normalized;
}

function get(
  credentials: TossCredentials,
  path: string,
  query: string,
  accountSeq?: string,
): PreparedExchangeRequest {
  return {
    method: 'GET',
    path,
    query,
    headers: {
      Authorization: `Bearer ${token(credentials)}`,
      Accept: 'application/json',
      ...(accountSeq ? { 'X-Tossinvest-Account': accountSeq } : {}),
    },
    body: null,
  };
}

export function prepareTossOrderbook(credentials: TossCredentials, rawSymbol: string) {
  return get(credentials, '/api/v1/orderbook', `symbol=${encodeURIComponent(symbol(rawSymbol))}`);
}

export function prepareTossPrices(credentials: TossCredentials, rawSymbol: string) {
  return get(credentials, '/api/v1/prices', `symbols=${encodeURIComponent(symbol(rawSymbol))}`);
}

export function prepareTossMarketCalendar(credentials: TossCredentials, market: 'KR' | 'US') {
  if (market !== 'KR' && market !== 'US') throw new Error('TOSS_MARKET_INVALID');
  return get(credentials, `/api/v1/market-calendar/${market}`, '');
}

export function prepareTossSellableQuantity(
  credentials: TossCredentials,
  accountSeq: string,
  rawSymbol: string,
) {
  if (!accountSeq.trim()) throw new Error('TOSS_ACCOUNT_ID_REQUIRED');
  return get(
    credentials,
    '/api/v1/sellable-quantity',
    `symbol=${encodeURIComponent(symbol(rawSymbol))}`,
    accountSeq.trim(),
  );
}

export function prepareTossCommissions(credentials: TossCredentials, accountSeq: string) {
  if (!accountSeq.trim()) throw new Error('TOSS_ACCOUNT_ID_REQUIRED');
  return get(credentials, '/api/v1/commissions', '', accountSeq.trim());
}

export function assertTossPreSubmissionRead(request: PreparedExchangeRequest) {
  if (request.method !== 'GET' || request.body !== null) throw new Error('TOSS_PRESUBMISSION_MUTATION_FORBIDDEN');
  const allowed = new Set([
    '/api/v1/orderbook',
    '/api/v1/prices',
    '/api/v1/market-calendar/KR',
    '/api/v1/market-calendar/US',
    '/api/v1/buying-power',
    '/api/v1/sellable-quantity',
    '/api/v1/commissions',
    '/api/v1/accounts',
  ]);
  if (!allowed.has(request.path)) throw new Error('TOSS_PRESUBMISSION_MUTATION_FORBIDDEN');
  if (/\/orders|cancel|modify|withdraw|transfer/i.test(request.path)) throw new Error('TOSS_PRESUBMISSION_MUTATION_FORBIDDEN');
}