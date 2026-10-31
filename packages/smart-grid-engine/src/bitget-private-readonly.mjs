// Bitget V3 Private Read-Only API - 4 endpoints only
// 주문/취소/레버리지/출금/이체 절대 불가
import { buildHeaders, buildUrl, encodeQuery, loadCredentials, PrivateAuthError } from './bitget-private-auth.mjs';

const TIMEOUT_MS = 8000;

async function requestReadOnly({ method, requestPath, params = {}, credentials, fetchImpl = fetch, now = Date.now }) {
  const queryString = method === 'GET' ? encodeQuery(params) : '';
  const headers = buildHeaders({ method, requestPath, queryString, body: '', credentials, now });
  const url = buildUrl(requestPath, queryString);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('TIMEOUT')), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { method, headers, signal: controller.signal });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new PrivateAuthError('INVALID_JSON', `status=${res.status}`); }
    if (!res.ok) {
      throw new PrivateAuthError(`HTTP_${res.status}`, `${json?.code || ''} ${json?.msg || text.slice(0, 80)}`);
    }
    if (json.code !== '00000') {
      throw new PrivateAuthError(`API_${json.code}`, json.msg || 'API error');
    }
    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

export async function getAccountAssets(opts = {}) {
  return requestReadOnly({ method: 'GET', requestPath: '/api/v3/account/assets', params: {}, ...opts });
}

export async function getCurrentPositions(opts = {}) {
  const { category = 'USDT-FUTURES', symbol, posSide, ...rest } = opts;
  if (!category) throw new PrivateAuthError('MISSING_CATEGORY', 'category required');
  return requestReadOnly({ method: 'GET', requestPath: '/api/v3/position/current-position', params: { category, symbol, posSide }, ...rest });
}

export async function getUnfilledOrders(opts = {}) {
  const { category = 'USDT-FUTURES', symbol, startTime, endTime, limit = 100, cursor, ...rest } = opts;
  return requestReadOnly({ method: 'GET', requestPath: '/api/v3/trade/unfilled-orders', params: { category, symbol, startTime, endTime, limit, cursor }, ...rest });
}

export async function getFills(opts = {}) {
  const { category = 'USDT-FUTURES', orderId, startTime, endTime, limit = 100, cursor, ...rest } = opts;
  return requestReadOnly({ method: 'GET', requestPath: '/api/v3/trade/fills', params: { category, orderId, startTime, endTime, limit, cursor }, ...rest });
}

export { requestReadOnly };
