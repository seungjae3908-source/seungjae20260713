// Bitget V3 Private API HMAC-SHA256 Auth Module (SERVER-ONLY, READ-ONLY)
// 공식 문서: https://www.bitget.com/api-doc/common/signature
// 서명 규칙: timestamp + METHOD + requestPath + "?" + queryString + body → HMAC-SHA256 → Base64
import crypto from 'node:crypto';

const BASE_URL = 'https://api.bitget.com';
const ALLOWED_ENDPOINTS = new Set([
  'GET /api/v3/account/assets',
  'GET /api/v3/position/current-position',
  'GET /api/v3/trade/unfilled-orders',
  'GET /api/v3/trade/fills',
]);

// 강제 차단 엔드포인트 (화이트리스트 외 전부 차단되지만 명시적으로 문서화)
const FORBIDDEN_PATTERNS = [
  /place-order/i, /cancel-order/i, /modify-order/i, /close-position/i,
  /set-leverage/i, /set-margin/i, /withdraw/i, /transfer/i, /deposit/i,
];

export class PrivateAuthError extends Error {
  constructor(code, message) { super(`[${code}] ${message}`); this.code = code; }
}

export function loadCredentials(env = process.env) {
  const apiKey = env.BITGET_PRIVATE_API_KEY;
  const secretKey = env.BITGET_PRIVATE_SECRET_KEY;
  const passphrase = env.BITGET_PRIVATE_PASSPHRASE;
  if (!apiKey || apiKey.length < 10) throw new PrivateAuthError('MISSING_API_KEY', 'BITGET_PRIVATE_API_KEY not set');
  if (!secretKey || secretKey.length < 10) throw new PrivateAuthError('MISSING_SECRET_KEY', 'BITGET_PRIVATE_SECRET_KEY not set');
  if (!passphrase || passphrase.length < 4) throw new PrivateAuthError('MISSING_PASSPHRASE', 'BITGET_PRIVATE_PASSPHRASE not set');
  return { apiKey, secretKey, passphrase };
}

export function assertAllowedEndpoint(method, requestPath) {
  const m = String(method || '').toUpperCase();
  const key = `${m} ${requestPath}`;
  if (!ALLOWED_ENDPOINTS.has(key)) {
    throw new PrivateAuthError('ENDPOINT_NOT_ALLOWED', `${key} is not in read-only allowlist`);
  }
  for (const re of FORBIDDEN_PATTERNS) {
    if (re.test(requestPath)) throw new PrivateAuthError('FORBIDDEN_PATTERN', requestPath);
  }
}

export function buildSignature({ timestamp, method, requestPath, queryString = '', body = '', secretKey }) {
  if (!secretKey) throw new PrivateAuthError('MISSING_SECRET_KEY', 'secretKey required');
  if (!timestamp || !/^\d{13}$/.test(String(timestamp))) throw new PrivateAuthError('INVALID_TIMESTAMP', '13-digit ms timestamp required');
  const m = String(method).toUpperCase();
  if (m !== 'GET' && m !== 'POST') throw new PrivateAuthError('INVALID_METHOD', m);
  let payload = `${timestamp}${m}${requestPath}`;
  if (queryString) payload += `?${queryString}`;
  if (body) payload += body;
  return crypto.createHmac('sha256', secretKey).update(payload, 'utf8').digest('base64');
}

export function buildHeaders({ method, requestPath, queryString = '', body = '', credentials, now = Date.now }) {
  assertAllowedEndpoint(method, requestPath);
  const creds = credentials || loadCredentials();
  const timestamp = String(now());
  const signature = buildSignature({ timestamp, method, requestPath, queryString, body, secretKey: creds.secretKey });
  return {
    'ACCESS-KEY': creds.apiKey,
    'ACCESS-SIGN': signature,
    'ACCESS-TIMESTAMP': timestamp,
    'ACCESS-PASSPHRASE': creds.passphrase,
    'Content-Type': 'application/json',
    'locale': 'en-US',
  };
}

export function buildUrl(requestPath, queryString = '') {
  return `${BASE_URL}${requestPath}${queryString ? '?' + queryString : ''}`;
}

export function encodeQuery(params = {}) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}

export { ALLOWED_ENDPOINTS, BASE_URL };
