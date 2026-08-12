import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { TradingPlanInput } from './trade-automation.types';

export type PreparedExchangeRequest = {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string | null;
};

export type BitgetCredentials = { apiKey: string; secretKey: string; passphrase: string };
export type UpbitCredentials = { accessKey: string; secretKey: string };
export type KiwoomCredentials = { appKey: string; secretKey: string; accessToken?: string };
export type TossCredentials = { clientId: string; clientSecret: string; accessToken?: string };

export type TossOrderInput = {
  accountSeq: string;
  market: 'KR' | 'US';
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT';
  clientOrderId: string;
  quantity?: number | null;
  orderAmount?: number | null;
  price?: number | null;
};

export type TossAmendInput = {
  accountSeq: string;
  orderId: string;
  market: 'KR' | 'US';
  quantity?: number | null;
  price: number;
};

function jsonBody(value: Record<string, unknown>) {
  return JSON.stringify(value);
}

function tossAuthorizedRequest(
  credentials: TossCredentials,
  method: 'GET' | 'POST',
  path: string,
  accountSeq?: string,
  query = '',
  body: Record<string, unknown> | null = null,
): PreparedExchangeRequest {
  if (!credentials.accessToken?.trim()) throw new Error('TOSS_ACCESS_TOKEN_REQUIRED');
  return {
    method,
    path,
    query,
    headers: {
      Authorization: `Bearer ${credentials.accessToken.trim()}`,
      Accept: 'application/json',
      ...(accountSeq ? { 'X-Tossinvest-Account': accountSeq } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? jsonBody(body) : null,
  };
}

export function prepareTossToken(credentials: TossCredentials): PreparedExchangeRequest {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  }).toString();
  return {
    method: 'POST', path: '/oauth2/token', query: '',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  };
}

export function prepareTossAccounts(credentials: TossCredentials) {
  return tossAuthorizedRequest(credentials, 'GET', '/api/v1/accounts');
}

export function prepareTossHoldings(credentials: TossCredentials, accountSeq: string, symbol?: string) {
  const query = symbol ? `symbol=${encodeURIComponent(symbol.trim().toUpperCase())}` : '';
  return tossAuthorizedRequest(credentials, 'GET', '/api/v1/holdings', accountSeq, query);
}

export function prepareTossBuyingPower(
  credentials: TossCredentials,
  accountSeq: string,
  currency: 'KRW' | 'USD',
) {
  return tossAuthorizedRequest(credentials, 'GET', '/api/v1/buying-power', accountSeq, `currency=${currency}`);
}

export function prepareTossOrderHistory(
  credentials: TossCredentials,
  accountSeq: string,
  status: 'OPEN' | 'CLOSED',
  cursor?: string,
) {
  const query = new URLSearchParams({ status, ...(cursor ? { cursor } : {}) }).toString();
  return tossAuthorizedRequest(credentials, 'GET', '/api/v1/orders', accountSeq, query);
}

export function prepareTossOrderQuery(credentials: TossCredentials, accountSeq: string, orderId: string) {
  return tossAuthorizedRequest(credentials, 'GET', `/api/v1/orders/${encodeURIComponent(orderId)}`, accountSeq);
}

export function prepareTossOrder(credentials: TossCredentials, input: TossOrderInput) {
  const quantity = input.quantity == null ? null : Number(input.quantity);
  const orderAmount = input.orderAmount == null ? null : Number(input.orderAmount);
  if ((quantity == null) === (orderAmount == null)) throw new Error('TOSS_QUANTITY_OR_AMOUNT_REQUIRED');
  if (quantity != null && (!Number.isFinite(quantity) || quantity <= 0)) throw new Error('TOSS_QUANTITY_INVALID');
  if (orderAmount != null && (!Number.isFinite(orderAmount) || orderAmount <= 0)) throw new Error('TOSS_ORDER_AMOUNT_INVALID');
  if (orderAmount != null && (input.market !== 'US' || input.orderType !== 'MARKET' || input.side !== 'BUY')) {
    throw new Error('TOSS_AMOUNT_ORDER_US_MARKET_BUY_ONLY');
  }
  if (input.orderType === 'LIMIT' && (!Number.isFinite(Number(input.price)) || Number(input.price) <= 0)) {
    throw new Error('TOSS_LIMIT_PRICE_REQUIRED');
  }
  const body: Record<string, unknown> = {
    clientOrderId: input.clientOrderId,
    symbol: input.symbol.trim().toUpperCase(),
    side: input.side,
    orderType: input.orderType,
    ...(quantity != null ? { quantity: String(quantity) } : { orderAmount: String(orderAmount) }),
    ...(input.orderType === 'LIMIT' ? { price: String(input.price) } : {}),
  };
  return tossAuthorizedRequest(credentials, 'POST', '/api/v1/orders', input.accountSeq, '', body);
}

export function prepareTossCancel(credentials: TossCredentials, accountSeq: string, orderId: string) {
  return tossAuthorizedRequest(
    credentials, 'POST', `/api/v1/orders/${encodeURIComponent(orderId)}/cancel`, accountSeq, '', {},
  );
}

export function prepareTossAmend(credentials: TossCredentials, input: TossAmendInput) {
  if (!Number.isFinite(input.price) || input.price <= 0) throw new Error('TOSS_LIMIT_PRICE_REQUIRED');
  if (input.market === 'KR' && (!Number.isInteger(input.quantity) || Number(input.quantity) <= 0)) {
    throw new Error('TOSS_KR_AMEND_QUANTITY_REQUIRED');
  }
  if (input.market === 'US' && input.quantity != null) throw new Error('TOSS_US_AMEND_QUANTITY_NOT_SUPPORTED');
  return tossAuthorizedRequest(
    credentials,
    'POST',
    `/api/v1/orders/${encodeURIComponent(input.orderId)}/modify`,
    input.accountSeq,
    '',
    {
      orderType: 'LIMIT',
      ...(input.market === 'KR' ? { quantity: String(input.quantity) } : {}),
      price: String(input.price),
    },
  );
}

export function buildBitgetSignature(
  secretKey: string,
  timestamp: string,
  method: string,
  path: string,
  query: string,
  body: string,
) {
  const queryPart = query ? `?${query}` : '';
  return createHmac('sha256', secretKey)
    .update(`${timestamp}${method.toUpperCase()}${path}${queryPart}${body}`)
    .digest('base64');
}

function bitgetRequest(
  credentials: BitgetCredentials,
  method: 'GET' | 'POST',
  path: string,
  data: Record<string, unknown> | null,
  query = '',
  timestamp = Date.now().toString(),
): PreparedExchangeRequest {
  const body = data ? jsonBody(data) : '';
  return {
    method,
    path,
    query,
    body: body || null,
    headers: {
      'ACCESS-KEY': credentials.apiKey,
      'ACCESS-SIGN': buildBitgetSignature(credentials.secretKey, timestamp, method, path, query, body),
      'ACCESS-TIMESTAMP': timestamp,
      'ACCESS-PASSPHRASE': credentials.passphrase,
      'Content-Type': 'application/json',
      locale: 'en-US',
    },
  };
}

export function prepareBitgetContractConfig(symbol: string): PreparedExchangeRequest {
  return {
    method: 'GET', path: '/api/v2/mix/market/contracts',
    query: `productType=USDT-FUTURES&symbol=${encodeURIComponent(symbol.toUpperCase())}`,
    headers: { Accept: 'application/json' }, body: null,
  };
}

export function prepareBitgetTicker(symbol: string): PreparedExchangeRequest {
  return {
    method: 'GET', path: '/api/v2/mix/market/ticker',
    query: `symbol=${encodeURIComponent(symbol.toUpperCase())}&productType=USDT-FUTURES`,
    headers: { Accept: 'application/json' }, body: null,
  };
}

export function validateBitgetContractRules(
  plan: TradingPlanInput, contract: Record<string, unknown>, referencePrice?: number,
) {
  const quantity = Number(plan.quantity);
  const minimumQuantity = Number(contract.minTradeNum ?? 0);
  const quantityStep = Number(contract.sizeMultiplier ?? 0);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('BITGET_QUANTITY_INVALID');
  if (minimumQuantity > 0 && quantity < minimumQuantity) throw new Error('BITGET_MINIMUM_QUANTITY');
  if (quantityStep > 0 && Math.abs(quantity / quantityStep - Math.round(quantity / quantityStep)) > 1e-8) {
    throw new Error('BITGET_QUANTITY_STEP');
  }
  const maximumQuantity = Number(plan.orderType === 'market' ? contract.maxMarketOrderQty : contract.maxOrderQty);
  if (maximumQuantity > 0 && quantity > maximumQuantity) throw new Error('BITGET_MAXIMUM_QUANTITY');
  const contractStatus = String(contract.symbolStatus ?? '').toLowerCase();
  if (contractStatus && contractStatus !== 'normal') throw new Error('BITGET_CONTRACT_NOT_TRADABLE');
  if (plan.orderType === 'limit') {
    const price = Number(plan.limitPrice);
    const pricePlace = Number(contract.pricePlace ?? 0);
    const priceEndStep = Number(contract.priceEndStep ?? 1);
    const priceStep = priceEndStep * (10 ** -pricePlace);
    if (!Number.isFinite(price) || price <= 0) throw new Error('BITGET_PRICE_INVALID');
    if (priceStep > 0 && Math.abs(price / priceStep - Math.round(price / priceStep)) > 1e-8) {
      throw new Error('BITGET_PRICE_STEP');
    }
  }
  const notionalPrice = plan.orderType === 'limit' ? Number(plan.limitPrice) : Number(referencePrice);
  const minimumNotional = Number(contract.minTradeUSDT ?? 0);
  if (minimumNotional > 0 && (!Number.isFinite(notionalPrice) || notionalPrice * quantity < minimumNotional)) {
    throw new Error('BITGET_MINIMUM_NOTIONAL');
  }
}

export function prepareBitgetOrder(
  credentials: BitgetCredentials,
  plan: TradingPlanInput,
  clientOrderId: string,
  timestamp?: string,
) {
  const isOpenLong = plan.side === 'long' || plan.side === 'buy';
  const body: Record<string, unknown> = {
    symbol: plan.symbol.toUpperCase(),
    productType: 'USDT-FUTURES',
    marginMode: plan.marginMode,
    marginCoin: 'USDT',
    size: String(plan.quantity ?? ''),
    side: isOpenLong ? 'buy' : 'sell',
    orderType: plan.orderType,
    clientOid: clientOrderId,
    reduceOnly: plan.reduceOnly ? 'YES' : 'NO',
  };
  if (plan.orderType === 'limit') {
    body.price = String(plan.limitPrice ?? '');
    body.force = 'gtc';
  }
  return bitgetRequest(credentials, 'POST', '/api/v2/mix/order/place-order', body, '', timestamp);
}

export function prepareBitgetCancel(credentials: BitgetCredentials, symbol: string, clientOrderId: string, timestamp?: string) {
  return bitgetRequest(credentials, 'POST', '/api/v2/mix/order/cancel-order', {
    symbol: symbol.toUpperCase(), productType: 'USDT-FUTURES', clientOid: clientOrderId,
  }, '', timestamp);
}

export function prepareBitgetOrderQuery(
  credentials: BitgetCredentials,
  symbol: string,
  clientOrderId: string,
  timestamp?: string,
) {
  const query = `symbol=${encodeURIComponent(symbol.toUpperCase())}&clientOid=${encodeURIComponent(clientOrderId)}&productType=USDT-FUTURES`;
  return bitgetRequest(credentials, 'GET', '/api/v2/mix/order/detail', null, query, timestamp);
}

export function prepareBitgetAccount(credentials: BitgetCredentials, timestamp?: string) {
  return bitgetRequest(credentials, 'GET', '/api/v2/mix/account/accounts', null, 'productType=USDT-FUTURES', timestamp);
}

export function prepareBitgetPositions(credentials: BitgetCredentials, timestamp?: string) {
  return bitgetRequest(credentials, 'GET', '/api/v2/mix/position/all-position', null, 'productType=USDT-FUTURES&marginCoin=USDT', timestamp);
}

export function prepareBitgetPendingOrders(credentials: BitgetCredentials, symbol: string, timestamp?: string) {
  return bitgetRequest(credentials, 'GET', '/api/v2/mix/order/orders-pending', null,
    `symbol=${encodeURIComponent(symbol.toUpperCase())}&productType=USDT-FUTURES`, timestamp);
}

export type BitgetHistoryInput = {
  orderId?: string;
  clientOrderId?: string;
  symbol?: string;
  cursor?: string;
  startTimeMs?: number;
  endTimeMs?: number;
  limit?: number;
};

function bitgetHistoryQuery(input: BitgetHistoryInput, maximumWindowDays: number) {
  if (input.limit != null && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) {
    throw new Error('BITGET_HISTORY_LIMIT_INVALID');
  }
  if (input.startTimeMs != null && (!Number.isInteger(input.startTimeMs) || input.startTimeMs <= 0)) {
    throw new Error('BITGET_HISTORY_START_TIME_INVALID');
  }
  if (input.endTimeMs != null && (!Number.isInteger(input.endTimeMs) || input.endTimeMs <= 0)) {
    throw new Error('BITGET_HISTORY_END_TIME_INVALID');
  }
  if (input.startTimeMs != null && input.endTimeMs != null) {
    const windowMs = input.endTimeMs - input.startTimeMs;
    if (windowMs < 0 || windowMs > maximumWindowDays * 86_400_000) throw new Error('BITGET_HISTORY_WINDOW_INVALID');
  }
  return new URLSearchParams({
    productType: 'USDT-FUTURES',
    ...(input.orderId?.trim() ? { orderId: input.orderId.trim() } : {}),
    ...(!input.orderId?.trim() && input.clientOrderId?.trim() ? { clientOid: input.clientOrderId.trim() } : {}),
    ...(input.symbol?.trim() ? { symbol: input.symbol.trim().toUpperCase() } : {}),
    ...(input.cursor?.trim() ? { idLessThan: input.cursor.trim() } : {}),
    ...(input.startTimeMs != null ? { startTime: String(input.startTimeMs) } : {}),
    ...(input.endTimeMs != null ? { endTime: String(input.endTimeMs) } : {}),
    ...(input.limit != null ? { limit: String(input.limit) } : {}),
  }).toString();
}

export function prepareBitgetOrderHistory(
  credentials: BitgetCredentials,
  input: BitgetHistoryInput = {},
  timestamp?: string,
) {
  return bitgetRequest(credentials, 'GET', '/api/v2/mix/order/orders-history', null, bitgetHistoryQuery(input, 90), timestamp);
}

export function prepareBitgetFillHistory(
  credentials: BitgetCredentials,
  input: BitgetHistoryInput,
  timestamp?: string,
) {
  if (!input.orderId?.trim() && !input.clientOrderId?.trim()) throw new Error('BITGET_FILL_ORDER_REFERENCE_REQUIRED');
  return bitgetRequest(credentials, 'GET', '/api/v2/mix/order/fill-history', null, bitgetHistoryQuery(input, 7), timestamp);
}

export function prepareBitgetMarginMode(
  credentials: BitgetCredentials, symbol: string, marginMode: 'crossed' | 'isolated', timestamp?: string,
) {
  return bitgetRequest(credentials, 'POST', '/api/v2/mix/account/set-margin-mode', {
    symbol: symbol.toUpperCase(), productType: 'USDT-FUTURES', marginCoin: 'USDT', marginMode,
  }, '', timestamp);
}

export function prepareBitgetLeverage(credentials: BitgetCredentials, symbol: string, leverage: 2 | 3, timestamp?: string) {
  return bitgetRequest(credentials, 'POST', '/api/v2/mix/account/set-leverage', {
    symbol: symbol.toUpperCase(), productType: 'USDT-FUTURES', marginCoin: 'USDT', leverage: String(leverage),
  }, '', timestamp);
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString('base64url');
}

export function buildUpbitQuery(parameters: Record<string, string>) {
  return Object.entries(parameters).map(([key, value]) => `${key}=${value}`).join('&');
}

export function buildUpbitJwt(credentials: UpbitCredentials, query: string, nonce: string = randomUUID()) {
  const header = base64Url(JSON.stringify({ alg: 'HS512', typ: 'JWT' }));
  const payload: Record<string, string> = { access_key: credentials.accessKey, nonce };
  if (query) {
    payload.query_hash = createHash('sha512').update(query).digest('hex');
    payload.query_hash_alg = 'SHA512';
  }
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = createHmac('sha512', credentials.secretKey)
    .update(`${header}.${encodedPayload}`).digest('base64url');
  return `${header}.${encodedPayload}.${signature}`;
}

function upbitRequest(
  credentials: UpbitCredentials,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  parameters: Record<string, string>,
  nonce?: string,
): PreparedExchangeRequest {
  const query = buildUpbitQuery(parameters);
  const hasBody = method === 'POST';
  return {
    method,
    path,
    query: hasBody ? '' : query,
    body: hasBody ? JSON.stringify(parameters) : null,
    headers: {
      Authorization: `Bearer ${buildUpbitJwt(credentials, query, nonce)}`,
      Accept: 'application/json',
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
  };
}

export function prepareUpbitOrder(
  credentials: UpbitCredentials,
  plan: TradingPlanInput,
  identifier: string,
  nonce?: string,
) {
  const parameters: Record<string, string> = {
    market: `KRW-${plan.symbol.toUpperCase().replace(/^KRW-/, '')}`,
    side: plan.side === 'buy' ? 'bid' : 'ask',
    ord_type: plan.orderType === 'limit' ? 'limit' : plan.side === 'buy' ? 'price' : 'market',
    identifier,
  };
  if (plan.orderType === 'limit') {
    parameters.volume = String(plan.quantity ?? '');
    parameters.price = String(plan.limitPrice ?? '');
  } else if (plan.side === 'buy') {
    parameters.price = String(plan.quoteAmount ?? '');
  } else {
    parameters.volume = String(plan.quantity ?? '');
  }
  return upbitRequest(credentials, 'POST', '/v1/orders', parameters, nonce);
}

export function prepareUpbitOrderTest(credentials: UpbitCredentials, plan: TradingPlanInput, identifier: string, nonce?: string) {
  return { ...prepareUpbitOrder(credentials, plan, identifier, nonce), path: '/v1/orders/test' };
}

export function prepareUpbitCancel(credentials: UpbitCredentials, identifier: string, nonce?: string) {
  return upbitRequest(credentials, 'DELETE', '/v1/order', { identifier }, nonce);
}

export function prepareUpbitOrderQuery(credentials: UpbitCredentials, identifier: string, nonce?: string) {
  return upbitRequest(credentials, 'GET', '/v1/order', { identifier }, nonce);
}

export function prepareUpbitAccounts(credentials: UpbitCredentials, nonce?: string) {
  return upbitRequest(credentials, 'GET', '/v1/accounts', {}, nonce);
}

export function prepareUpbitOrderChance(credentials: UpbitCredentials, symbol: string, nonce?: string) {
  return upbitRequest(credentials, 'GET', '/v1/orders/chance', {
    market: `KRW-${symbol.toUpperCase().replace(/^KRW-/, '')}`,
  }, nonce);
}

export function prepareKiwoomToken(credentials: KiwoomCredentials): PreparedExchangeRequest {
  return {
    method: 'POST', path: '/oauth2/token', query: '',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: jsonBody({ grant_type: 'client_credentials', appkey: credentials.appKey, secretkey: credentials.secretKey }),
  };
}

function kiwoomReadRequest(
  credentials: KiwoomCredentials,
  apiId: 'ka00001' | 'kt00018' | 'ust21070',
  path: '/api/dostk/acnt' | '/api/us/acnt',
  body: Record<string, unknown>,
): PreparedExchangeRequest {
  if (!credentials.accessToken) throw new Error('KIWOOM_ACCESS_TOKEN_REQUIRED');
  return {
    method: 'POST', path, query: '',
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      'Content-Type': 'application/json;charset=UTF-8',
      'api-id': apiId,
    },
    body: jsonBody(body),
  };
}

export type UpbitOrderListInput = {
  market?: string;
  state?: 'wait' | 'watch' | 'done' | 'cancel';
  startTimeMs?: number;
  endTimeMs?: number;
  page?: number;
  limit?: number;
  orderBy?: 'asc' | 'desc';
};

function upbitOrderListParameters(input: UpbitOrderListInput, closed: boolean) {
  const maximumLimit = closed ? 1_000 : 100;
  if (input.limit != null && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > maximumLimit)) {
    throw new Error('UPBIT_ORDER_LIST_LIMIT_INVALID');
  }
  if (input.page != null && (closed || !Number.isInteger(input.page) || input.page < 1)) {
    throw new Error('UPBIT_ORDER_LIST_PAGE_INVALID');
  }
  if (input.state && !(closed ? ['done', 'cancel'] : ['wait', 'watch']).includes(input.state)) {
    throw new Error('UPBIT_ORDER_LIST_STATE_INVALID');
  }
  if (!closed && (input.startTimeMs != null || input.endTimeMs != null)) throw new Error('UPBIT_OPEN_ORDER_TIME_NOT_SUPPORTED');
  if (closed) {
    for (const value of [input.startTimeMs, input.endTimeMs]) {
      if (value != null && (!Number.isInteger(value) || value <= 0)) throw new Error('UPBIT_CLOSED_ORDER_TIME_INVALID');
    }
    if (input.startTimeMs != null && input.endTimeMs != null) {
      const windowMs = input.endTimeMs - input.startTimeMs;
      if (windowMs < 0 || windowMs > 7 * 86_400_000) throw new Error('UPBIT_CLOSED_ORDER_WINDOW_INVALID');
    }
  }
  return {
    ...(input.market?.trim() ? { market: input.market.trim().toUpperCase() } : {}),
    ...(input.state ? { state: input.state } : {}),
    ...(input.startTimeMs != null ? { start_time: String(input.startTimeMs) } : {}),
    ...(input.endTimeMs != null ? { end_time: String(input.endTimeMs) } : {}),
    ...(input.page != null ? { page: String(input.page) } : {}),
    ...(input.limit != null ? { limit: String(input.limit) } : {}),
    ...(input.orderBy ? { order_by: input.orderBy } : {}),
  };
}

export function prepareUpbitOpenOrders(credentials: UpbitCredentials, input: UpbitOrderListInput = {}, nonce?: string) {
  return upbitRequest(credentials, 'GET', '/v1/orders/open', upbitOrderListParameters(input, false), nonce);
}

export function prepareUpbitClosedOrders(credentials: UpbitCredentials, input: UpbitOrderListInput = {}, nonce?: string) {
  return upbitRequest(credentials, 'GET', '/v1/orders/closed', upbitOrderListParameters(input, true), nonce);
}

export function prepareKiwoomAccountNumber(credentials: KiwoomCredentials): PreparedExchangeRequest {
  return kiwoomReadRequest(credentials, 'ka00001', '/api/dostk/acnt', {});
}

export function prepareKiwoomDomesticAccount(credentials: KiwoomCredentials): PreparedExchangeRequest {
  return kiwoomReadRequest(credentials, 'kt00018', '/api/dostk/acnt', { qry_tp: '1', dmst_stex_tp: 'KRX' });
}

export function prepareKiwoomUsAccount(credentials: KiwoomCredentials): PreparedExchangeRequest {
  return kiwoomReadRequest(credentials, 'ust21070', '/api/us/acnt', {});
}

function kiwoomOrderBody(plan: TradingPlanInput) {
  return {
    dmst_stex_tp: 'KRX',
    stk_cd: plan.symbol,
    ord_qty: String(plan.quantity ?? ''),
    ord_uv: plan.orderType === 'limit' ? String(plan.limitPrice ?? '') : '',
    trde_tp: plan.orderType === 'limit' ? '0' : '3',
    cond_uv: '',
  };
}

export function prepareKiwoomOrder(credentials: KiwoomCredentials, plan: TradingPlanInput): PreparedExchangeRequest {
  if (!credentials.accessToken) throw new Error('KIWOOM_ACCESS_TOKEN_REQUIRED');
  return {
    method: 'POST', path: '/api/dostk/ordr', query: '',
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      'Content-Type': 'application/json;charset=UTF-8',
      'api-id': plan.side === 'buy' ? 'kt10000' : 'kt10001',
    },
    body: jsonBody(kiwoomOrderBody(plan)),
  };
}

export function prepareKiwoomCancel(
  credentials: KiwoomCredentials,
  input: { symbol: string; orderNo: string; quantity: number },
): PreparedExchangeRequest {
  if (!credentials.accessToken) throw new Error('KIWOOM_ACCESS_TOKEN_REQUIRED');
  return {
    method: 'POST', path: '/api/dostk/ordr', query: '',
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      'Content-Type': 'application/json;charset=UTF-8',
      'api-id': 'kt10003',
    },
    body: jsonBody({
      dmst_stex_tp: 'KRX', stk_cd: input.symbol, orig_ord_no: input.orderNo,
      cncl_qty: String(input.quantity),
    }),
  };
}

export function prepareKiwoomOrderable(credentials: KiwoomCredentials): PreparedExchangeRequest {
  if (!credentials.accessToken) throw new Error('KIWOOM_ACCESS_TOKEN_REQUIRED');
  return {
    method: 'POST', path: '/api/dostk/acnt', query: '',
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      'Content-Type': 'application/json;charset=UTF-8',
      'api-id': 'kt00010',
    },
    body: '{}',
  };
}

export function prepareKiwoomUnfilled(credentials: KiwoomCredentials): PreparedExchangeRequest {
  if (!credentials.accessToken) throw new Error('KIWOOM_ACCESS_TOKEN_REQUIRED');
  return {
    method: 'POST', path: '/api/dostk/acnt', query: '',
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      'Content-Type': 'application/json;charset=UTF-8',
      'api-id': 'ka10075',
    },
    body: '{}',
  };
}

export function redactPreparedRequest(request: PreparedExchangeRequest) {
  const hidden = new Set(['authorization', 'access-key', 'access-sign', 'access-passphrase']);
  return {
    ...request,
    headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [
      key, hidden.has(key.toLowerCase()) ? '[REDACTED]' : value,
    ])),
    body: request.path === '/oauth2/token' ? '[REDACTED]' : request.body,
  };
}
