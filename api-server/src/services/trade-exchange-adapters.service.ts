import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { TradingPlanInput } from './trade-automation.types';
import { marketNumber } from '../providers/market-evidence';

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

function jsonBody(value: Record<string, unknown>) {
  return JSON.stringify(value);
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
  const positiveRule = (field: string) => {
    const value = marketNumber(contract[field]);
    if (value === null || value <= 0) throw new Error(`BITGET_CONTRACT_RULES_UNAVAILABLE:${field}`);
    return value;
  };
  const decimal = (value: number) => {
    const [coefficient, exponent = '0'] = value.toString().split('e');
    const fraction = coefficient.split('.')[1]?.length ?? 0;
    const scale = fraction - Number(exponent);
    const units = BigInt(coefficient.replace('.', ''));
    return scale < 0 ? { units: units * 10n ** BigInt(-scale), scale: 0 } : { units, scale };
  };
  const aligned = (value: number, step: number) => {
    const left = decimal(value), right = decimal(step);
    return (left.units * 10n ** BigInt(right.scale)) % (right.units * 10n ** BigInt(left.scale)) === 0n;
  };
  if (typeof contract.symbol !== 'string' || contract.symbol !== plan.symbol.toUpperCase()
    || contract.quoteCoin !== 'USDT' || !Array.isArray(contract.supportMarginCoins) || !contract.supportMarginCoins.includes('USDT')) throw new Error('BITGET_CONTRACT_IDENTITY_INVALID');
  if (contract.symbolStatus !== 'normal') throw new Error('BITGET_CONTRACT_NOT_TRADABLE');
  const quantity = plan.quantity;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) throw new Error('BITGET_QUANTITY_INVALID');
  const minimumQuantity = positiveRule('minTradeNum');
  const quantityStep = positiveRule('sizeMultiplier');
  const minimumNotional = positiveRule('minTradeUSDT');
  const maximumQuantity = positiveRule(plan.orderType === 'market' ? 'maxMarketOrderQty' : 'maxOrderQty');
  const minimumLeverage = positiveRule('minLever'), maximumLeverage = positiveRule('maxLever');
  if (maximumQuantity < minimumQuantity || maximumLeverage < minimumLeverage) throw new Error('BITGET_CONTRACT_RULES_INCONSISTENT');
  if (typeof plan.leverage !== 'number' || !Number.isFinite(plan.leverage) || plan.leverage < minimumLeverage || plan.leverage > maximumLeverage) throw new Error('BITGET_CONTRACT_LEVERAGE_INVALID');
  if (quantity < minimumQuantity) throw new Error('BITGET_MINIMUM_QUANTITY');
  if (!aligned(quantity, quantityStep)) {
    throw new Error('BITGET_QUANTITY_STEP');
  }
  if (quantity > maximumQuantity) throw new Error('BITGET_MAXIMUM_QUANTITY');
  if (plan.orderType === 'limit') {
    const price = plan.limitPrice;
    const pricePlace = marketNumber(contract.pricePlace);
    const priceEndStep = positiveRule('priceEndStep');
    if (pricePlace === null || !Number.isSafeInteger(pricePlace) || pricePlace < 0 || !Number.isSafeInteger(priceEndStep)) throw new Error('BITGET_PRICE_RULES_UNAVAILABLE');
    const priceStep = Number(`${priceEndStep}e-${pricePlace}`);
    if (!Number.isFinite(priceStep) || priceStep <= 0) throw new Error('BITGET_PRICE_RULES_UNAVAILABLE');
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) throw new Error('BITGET_PRICE_INVALID');
    if (!aligned(price, priceStep)) {
      throw new Error('BITGET_PRICE_STEP');
    }
  }
  const notionalPrice = plan.orderType === 'limit' ? plan.limitPrice : referencePrice;
  if (typeof notionalPrice !== 'number' || !Number.isFinite(notionalPrice) || notionalPrice <= 0
    || !Number.isFinite(notionalPrice * quantity)) throw new Error('BITGET_REFERENCE_PRICE_INVALID');
  const priceUnits = decimal(notionalPrice), quantityUnits = decimal(quantity), minimumUnits = decimal(minimumNotional);
  if (priceUnits.units * quantityUnits.units * 10n ** BigInt(minimumUnits.scale)
    < minimumUnits.units * 10n ** BigInt(priceUnits.scale + quantityUnits.scale)) {
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
