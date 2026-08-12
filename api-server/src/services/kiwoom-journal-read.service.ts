import type { KiwoomCredentials, PreparedExchangeRequest } from './trade-exchange-adapters.service';

export type KiwoomJournalApiId = 'ka10076' | 'ust21150';

function authenticatedRequest(
  credentials: KiwoomCredentials,
  apiId: KiwoomJournalApiId,
  path: '/api/dostk/acnt' | '/api/us/acnt',
  body: Record<string, string>,
): PreparedExchangeRequest {
  const token = credentials.accessToken?.trim();
  if (!token) throw new Error('KIWOOM_ACCESS_TOKEN_REQUIRED');
  return {
    method: 'POST',
    path,
    query: '',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json;charset=UTF-8',
      'api-id': apiId,
    },
    body: JSON.stringify(body),
  };
}

/**
 * Official domestic fill inquiry (ka10076).
 * This is a private READ even though Kiwoom transports account inquiries over POST.
 * The fixed account path + fixed api-id boundary prevents an order mutation from
 * being substituted by caller-controlled input.
 */
export function prepareKiwoomDomesticFillHistory(
  credentials: KiwoomCredentials,
  input: {
    symbol?: string;
    side?: 'all' | 'sell' | 'buy';
    exchange?: 'all' | 'krx' | 'nxt';
  } = {},
): PreparedExchangeRequest {
  const side = input.side === 'sell' ? '1' : input.side === 'buy' ? '2' : '0';
  const exchange = input.exchange === 'krx' ? '1' : input.exchange === 'nxt' ? '2' : '0';
  const symbol = input.symbol?.trim().toUpperCase() ?? '';
  if (symbol && !/^[A-Z0-9]{1,12}$/.test(symbol)) throw new Error('KIWOOM_SYMBOL_INVALID');
  return authenticatedRequest(credentials, 'ka10076', '/api/dostk/acnt', {
    stk_cd: symbol,
    qry_tp: symbol ? '1' : '0',
    sell_tp: side,
    ord_no: '',
    stex_tp: exchange,
  });
}

function yyyymmdd(date: Date) {
  if (!Number.isFinite(date.getTime())) throw new Error('KIWOOM_ORDER_DATE_INVALID');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}${byType.month}${byType.day}`;
}

/**
 * Official US daily order/fill inquiry (ust21150), restricted to filled rows.
 * Query type 5 is fill-time ascending and side 0 means both buy/sell.
 */
export function prepareKiwoomUsDailyFillHistory(
  credentials: KiwoomCredentials,
  date = new Date(),
): PreparedExchangeRequest {
  return authenticatedRequest(credentials, 'ust21150', '/api/us/acnt', {
    query_tp: '5',
    slby_tp: '0',
    ord_dt: yyyymmdd(date),
  });
}

export function assertKiwoomJournalReadRequest(request: PreparedExchangeRequest) {
  if (request.method !== 'POST' || request.query !== '') throw new Error('KIWOOM_JOURNAL_MUTATION_FORBIDDEN');
  const apiId = request.headers['api-id'];
  const domestic = request.path === '/api/dostk/acnt' && apiId === 'ka10076';
  const us = request.path === '/api/us/acnt' && apiId === 'ust21150';
  if (!domestic && !us) throw new Error('KIWOOM_JOURNAL_MUTATION_FORBIDDEN');
  if (!request.body) throw new Error('KIWOOM_JOURNAL_READ_BODY_REQUIRED');
  if (/(?:\/ordr|withdraw|transfer|deposit)/i.test(request.path)) throw new Error('KIWOOM_JOURNAL_MUTATION_FORBIDDEN');
}
