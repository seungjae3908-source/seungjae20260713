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
export type TossCredentials = { clientId: string; clientSecret: string; accountSeq: string; accessToken?: string };

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
  const token = credentials.accessToken?.trim();
  if (!token) throw new Error('TOSS_ACCESS_TOKEN_REQUIRED');
  const selectedAccount = String(accountSeq ?? credentials.accountSeq ?? '').trim();
  return {
    method,
    path,
    query,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(selectedAccount ? { 'X-Tossinvest-Account': selectedAccount } : {}),
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
    method: 'POST',
    path: '/oauth2/token',
    query: '',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  };
}

export function prepareTossAccounts(credentials: TossCredentials) {
  return tossAuthorizedRequest(credentials, 'GET', '/api/v1/accounts', '');
}

export function prepareTossOrderbook(credentials: TossCredentials, symbol: string) {
  return tossAuthorizedRequest(
    credentials,
    'GET',
    '/api/v1/orderbook',
    '',
    `symbol=${encodeURIComponent(symbol.trim().toUpperCase())}`,
  );
}

export function prepareTossPrices(credentials: TossCredentials, symbol: string) {
  return tossAuthorizedRequest(
    credentials,
    'GET',
    '/api/v1/prices',
    '',
    `symbols=${encodeURIComponent(symbol.trim().toUpperCase())}`,
  );
}

export function prepareTossBuyingPower(credentials: TossCredentials, currency: 'KRW' | 'USD') {
  return tossAuthorizedRequest(
    credentials,
    'GET',
    '/api/v1/buying-power',
    credentials.accountSeq,
    `currency=${currency}`,
  );
}

export function prepareTossSellableQuantity(credentials: TossCredentials, symbol: string) {
  return tossAuthorizedRequest(
    credentials,
    'GET',
    '/api/v1/sellable-quantity',
    credentials.accountSeq,
    `symbol=${encodeURIComponent(symbol.trim().toUpperCase())}`,
  );
}

export function prepareTossCommissions(credentials: TossCredentials) {
  return tossAuthorizedRequest(credentials, 'GET', '/api/v1/commissions', credentials.accountSeq);
}

export function prepareTossMarketCalendar(credentials: TossCredentials, market: 'KR' | 'US') {
  return tossAuthorizedRequest(credentials, 'GET', `/api/v1/market-calendar/${market}`);
}

export function prepareTossOpenOrders(credentials: TossCredentials, symbol?: string) {
  const query = new URLSearchParams({
    status: 'OPEN',
    ...(symbol?.trim() ? { symbol: symbol.trim().toUpperCase() } : {}),
  }).toString();
  return tossAuthorizedRequest(credentials, 'GET', '/api/v1/orders', credentials.accountSeq, query);
}

export function prepareTossOrderQuery(credentials: TossCredentials, orderId: string) {
  if (!orderId.trim()) throw new Error('TOSS_ORDER_ID_REQUIRED');
  return tossAuthorizedRequest(
    credentials,
    'GET',
    `/api/v1/orders/${encodeURIComponent(orderId.trim())}`,
    credentials.accountSeq,
  );
}

export function prepareTossOrder(
  credentials: TossCredentials,
  plan: TradingPlanInput,
  clientOrderId: string,
) {
  const market = plan.market.toUpperCase();
  if (market !== 'KR' && market !== 'US') throw new Error('TOSS_MARKET_INVALID');
  const side = plan.side === 'buy' ? 'BUY' : plan.side === 'sell' ? 'SELL' : null;
  if (!side) throw new Error('TOSS_SIDE_INVALID');
  const orderType = plan.orderType === 'limit' ? 'LIMIT' : 'MARKET';
  const quantity = plan.quantity == null ? null : Number(plan.quantity);
  const orderAmount = plan.quoteAmount == null ? null : Number(plan.quoteAmount);
  if ((quantity == null) === (orderAmount == null)) throw new Error('TOSS_QUANTITY_OR_AMOUNT_REQUIRED');
  if (quantity != null && (!Number.isFinite(quantity) || quantity <= 0)) throw new Error('TOSS_QUANTITY_INVALID');
  if (market === 'KR' && quantity != null && !Number.isSafeInteger(quantity)) throw new Error('TOSS_KR_QUANTITY_INVALID');
  if (orderAmount != null && (market !== 'US' || orderType !== 'MARKET' || side !== 'BUY')) {
    throw new Error('TOSS_AMOUNT_ORDER_US_MARKET_BUY_ONLY');
  }
  const limitPrice = plan.limitPrice == null ? null : Number(plan.limitPrice);
  if (orderType === 'LIMIT' && (!Number.isFinite(limitPrice) || Number(limitPrice) <= 0)) {
    throw new Error('TOSS_LIMIT_PRICE_REQUIRED');
  }
  return tossAuthorizedRequest(credentials, 'POST', '/api/v1/orders', credentials.accountSeq, '', {
    clientOrderId,
    symbol: plan.symbol.trim().toUpperCase(),
    side,
    orderType,
    ...(quantity != null ? { quantity: String(quantity) } : { orderAmount: String(orderAmount) }),
    ...(orderType === 'LIMIT' ? { price: String(limitPrice) } : {}),
  });
}

export function prepareTossCancel(credentials: TossCredentials, orderId: string) {
  if (!orderId.trim()) throw new Error('TOSS_ORDER_ID_REQUIRED');
  return tossAuthorizedRequest(
    credentials,
    'POST',
    `/api/v1/orders/${encodeURIComponent(orderId.trim())}/cancel`,
    credentials.accountSeq,
    '',
    {},
  );
}

export function prepareTossAmend(
  credentials: TossCredentials,
  input: { orderId: string; market: 'KR' | 'US'; quantity?: number | null; price: number },
) {
  if (!input.orderId.trim()) throw new Error('TOSS_ORDER_ID_REQUIRED');
  if (!Number.isFinite(input.price) || input.price <= 0) throw new Error('TOSS_LIMIT_PRICE_REQUIRED');
  if (input.market === 'KR' && (!Number.isSafeInteger(input.quantity) || Number(input.quantity) <= 0)) {
    throw new Error('TOSS_KR_AMEND_QUANTITY_REQUIRED');
  }
  if (input.market === 'US' && input.quantity != null) throw new Error('TOSS_US_AMEND_QUANTITY_NOT_SUPPORTED');
  return tossAuthorizedRequest(
    credentials,
    'POST',
    `/api/v1/orders/${encodeURIComponent(input.orderId.trim())}/modify`,
    credentials.accountSeq,
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

export function prepareBitgetAmend(
  credentials: BitgetCredentials,
  input: {
    symbol: string;
    clientOrderId: string;
    newClientOrderId: string;
    quantity?: number | null;
    price?: number | null;
  },
  timestamp?: string,
) {
  if (!input.newClientOrderId.trim() || input.newClientOrderId === input.clientOrderId) {
    throw new Error('BITGET_AMEND_NEW_CLIENT_ORDER_ID_REQUIRED');
  }
  const body: Record<string, unknown> = {
    symbol: input.symbol.trim().toUpperCase(),
    productType: 'USDT-FUTURES',
    clientOid: input.clientOrderId,
    newClientOid: input.newClientOrderId,
  };
  if (input.quantity != null) {
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) throw new Error('BITGET_AMEND_QUANTITY_INVALID');
    body.newSize = String(input.quantity);
  }
  if (input.price != null) {
    if (!Number.isFinite(input.price) || input.price <= 0) throw new Error('BITGET_AMEND_PRICE_INVALID');
    body.newPrice = String(input.price);
  }
  if (body.newSize == null && body.newPrice == null) throw new Error('BITGET_AMEND_CHANGE_REQUIRED');
  return bitgetRequest(credentials, 'POST', '/api/v2/mix/order/modify-order', body, '', timestamp);
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

export function prepareBitgetPendingOrders(credentials: BitgetCredentials, symbol?: string, timestamp?: string) {
  const normalizedSymbol = symbol?.trim().toUpperCase();
  const query = [
    'productType=USDT-FUTURES',
    ...(normalizedSymbol ? [`symbol=${encodeURIComponent(normalizedSymbol)}`] : []),
  ].join('&');
  return bitgetRequest(credentials, 'GET', '/api/v2/mix/order/orders-pending', null, query, timestamp);
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

export function prepareUpbitAmend(
  credentials: UpbitCredentials,
  input: {
    previousIdentifier: string;
    newIdentifier: string;
    quantity: number;
    price: number;
  },
  nonce?: string,
) {
  if (!input.previousIdentifier.trim() || !input.newIdentifier.trim()
    || input.previousIdentifier === input.newIdentifier) {
    throw new Error('UPBIT_AMEND_IDENTIFIER_INVALID');
  }
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) throw new Error('UPBIT_AMEND_QUANTITY_INVALID');
  if (!Number.isFinite(input.price) || input.price <= 0) throw new Error('UPBIT_AMEND_PRICE_INVALID');
  return upbitRequest(credentials, 'POST', '/v1/orders/cancel_and_new', {
    prev_order_identifier: input.previousIdentifier,
    new_ord_type: 'limit',
    new_volume: String(input.quantity),
    new_price: String(input.price),
    new_identifier: input.newIdentifier,
  }, nonce);
}

export function prepareUpbitOrderQuery(credentials: UpbitCredentials, identifier: string, nonce?: string) {
  return upbitRequest(credentials, 'GET', '/v1/order', { identifier }, nonce);
}

export function prepareUpbitAccounts(credentials: UpbitCredentials, nonce?: string) {
  return upbitRequest(credentials, 'GET', '/v1/accounts', {}, nonce);
}

export function prepareUpbitOpenOrders(
  credentials: UpbitCredentials,
  state: 'wait' | 'watch',
  nonce?: string,
) {
  return upbitRequest(credentials, 'GET', '/v1/orders/open', {
    state,
    limit: '100',
    order_by: 'desc',
  }, nonce);
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

export function prepareKiwoomAccountNumber(credentials: KiwoomCredentials): PreparedExchangeRequest {
  return kiwoomReadRequest(credentials, 'ka00001', '/api/dostk/acnt', {});
}

export function prepareKiwoomDomesticAccount(credentials: KiwoomCredentials): PreparedExchangeRequest {
  return kiwoomReadRequest(credentials, 'kt00018', '/api/dostk/acnt', { qry_tp: '1', dmst_stex_tp: 'KRX' });
}

export function prepareKiwoomUsAccount(credentials: KiwoomCredentials): PreparedExchangeRequest {
  return kiwoomReadRequest(credentials, 'ust21070', '/api/us/acnt', {});
}


function kiwoomDomesticExchange(plan: TradingPlanInput) {
  const requested = String(plan.stockExchange ?? 'KRX').toUpperCase();
  if (!['KRX', 'NXT', 'SOR'].includes(requested)) throw new Error('KIWOOM_DOMESTIC_EXCHANGE_INVALID');
  return requested;
}

function kiwoomUsExchange(plan: TradingPlanInput) {
  const requested = String(plan.stockExchange ?? '').toUpperCase();
  const codes: Record<string, string> = { NASDAQ: 'ND', NYSE: 'NY', AMEX: 'NA' };
  const code = codes[requested];
  if (!code) throw new Error('KIWOOM_US_EXCHANGE_REQUIRED');
  return code;
}

function kiwoomOrderHeaders(credentials: KiwoomCredentials, apiId: string) {
  if (!credentials.accessToken) throw new Error('KIWOOM_ACCESS_TOKEN_REQUIRED');
  return {
    Authorization: `Bearer ${credentials.accessToken}`,
    'Content-Type': 'application/json;charset=UTF-8',
    'api-id': apiId,
  };
}

export function prepareKiwoomOrder(credentials: KiwoomCredentials, plan: TradingPlanInput): PreparedExchangeRequest {
  const quantity = Number(plan.quantity);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('KIWOOM_QUANTITY_INVALID');
  if (plan.side !== 'buy' && plan.side !== 'sell') throw new Error('KIWOOM_SIDE_INVALID');
  const limitPrice = plan.limitPrice == null ? null : Number(plan.limitPrice);
  if (plan.orderType === 'limit' && (!Number.isFinite(limitPrice) || Number(limitPrice) <= 0)) {
    throw new Error('KIWOOM_LIMIT_PRICE_REQUIRED');
  }
  if (plan.market.toUpperCase() === 'US') {
    const stexTp = kiwoomUsExchange(plan);
    return {
      method: 'POST',
      path: '/api/us/ordr',
      query: '',
      headers: kiwoomOrderHeaders(credentials, plan.side === 'buy' ? 'ust20000' : 'ust20001'),
      body: jsonBody({
        stex_tp: stexTp,
        stk_cd: plan.symbol.trim().toUpperCase(),
        ord_qty: String(quantity),
        ord_uv: plan.orderType === 'limit' ? String(limitPrice) : '',
        trde_tp: plan.orderType === 'limit' ? '0' : '3',
      }),
    };
  }
  return {
    method: 'POST',
    path: '/api/dostk/ordr',
    query: '',
    headers: kiwoomOrderHeaders(credentials, plan.side === 'buy' ? 'kt10000' : 'kt10001'),
    body: jsonBody({
      dmst_stex_tp: kiwoomDomesticExchange(plan),
      stk_cd: plan.symbol.trim().toUpperCase(),
      ord_qty: String(quantity),
      ord_uv: plan.orderType === 'limit' ? String(limitPrice) : '',
      trde_tp: plan.orderType === 'limit' ? '0' : '3',
      cond_uv: '',
    }),
  };
}

export function prepareKiwoomAmend(
  credentials: KiwoomCredentials,
  plan: TradingPlanInput,
  input: { orderNo: string; quantity: number; price: number },
): PreparedExchangeRequest {
  if (!input.orderNo.trim()) throw new Error('KIWOOM_ORDER_ID_REQUIRED');
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw new Error('KIWOOM_AMEND_QUANTITY_INVALID');
  if (!Number.isFinite(input.price) || input.price <= 0) throw new Error('KIWOOM_AMEND_PRICE_INVALID');
  if (plan.market.toUpperCase() === 'US') {
    return {
      method: 'POST',
      path: '/api/us/ordr',
      query: '',
      headers: kiwoomOrderHeaders(credentials, 'ust20002'),
      body: jsonBody({
        orig_ord_no: input.orderNo,
        stex_tp: kiwoomUsExchange(plan),
        stk_cd: plan.symbol.trim().toUpperCase(),
        mdfy_qty: String(input.quantity),
        mdfy_uv: String(input.price),
      }),
    };
  }
  return {
    method: 'POST',
    path: '/api/dostk/ordr',
    query: '',
    headers: kiwoomOrderHeaders(credentials, 'kt10002'),
    body: jsonBody({
      dmst_stex_tp: kiwoomDomesticExchange(plan),
      orig_ord_no: input.orderNo,
      stk_cd: plan.symbol.trim().toUpperCase(),
      mdfy_qty: String(input.quantity),
      mdfy_uv: String(input.price),
      mdfy_cond_uv: '',
    }),
  };
}

export function prepareKiwoomCancel(
  credentials: KiwoomCredentials,
  plan: TradingPlanInput,
  input: { orderNo: string; quantity: number },
): PreparedExchangeRequest {
  if (!input.orderNo.trim()) throw new Error('KIWOOM_ORDER_ID_REQUIRED');
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 0) throw new Error('KIWOOM_CANCEL_QUANTITY_INVALID');
  if (plan.market.toUpperCase() === 'US') {
    return {
      method: 'POST',
      path: '/api/us/ordr',
      query: '',
      headers: kiwoomOrderHeaders(credentials, 'ust20003'),
      body: jsonBody({
        orig_ord_no: input.orderNo,
        stex_tp: kiwoomUsExchange(plan),
        stk_cd: plan.symbol.trim().toUpperCase(),
      }),
    };
  }
  return {
    method: 'POST',
    path: '/api/dostk/ordr',
    query: '',
    headers: kiwoomOrderHeaders(credentials, 'kt10003'),
    body: jsonBody({
      dmst_stex_tp: kiwoomDomesticExchange(plan),
      orig_ord_no: input.orderNo,
      stk_cd: plan.symbol.trim().toUpperCase(),
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
