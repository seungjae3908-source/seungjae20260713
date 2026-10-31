import { buildSignature, buildHeaders, loadCredentials, assertAllowedEndpoint, encodeQuery, PrivateAuthError } from '../src/bitget-private-auth.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`✅ ${name}: PASS ${detail}`); }
  else { fail++; console.log(`❌ ${name}: FAIL ${detail}`); }
}

// [1] 서명 결정성 (고정 timestamp + secret → 고정 signature)
const sig1 = buildSignature({ timestamp: '1700000000000', method: 'GET', requestPath: '/api/v3/account/assets', secretKey: 'test_secret_key_1234567890' });
const sig2 = buildSignature({ timestamp: '1700000000000', method: 'GET', requestPath: '/api/v3/account/assets', secretKey: 'test_secret_key_1234567890' });
check('T1 서명 결정성', sig1 === sig2 && sig1.length > 20, `sig=${sig1.slice(0,12)}...`);

// [2] 서명 형식 (base64)
check('T2 서명 Base64 형식', /^[A-Za-z0-9+/]+=*$/.test(sig1), `len=${sig1.length}`);

// [3] 다른 secret → 다른 서명
const sigDiff = buildSignature({ timestamp: '1700000000000', method: 'GET', requestPath: '/api/v3/account/assets', secretKey: 'different_secret_xxxxxxxxxx' });
check('T3 다른 Secret → 다른 서명', sig1 !== sigDiff, '');

// [4] queryString 포함 서명
const sigQ = buildSignature({ timestamp: '1700000000000', method: 'GET', requestPath: '/api/v3/position/current-position', queryString: 'category=USDT-FUTURES&symbol=BTCUSDT', secretKey: 'test_secret_key_1234567890' });
const sigQ2 = buildSignature({ timestamp: '1700000000000', method: 'GET', requestPath: '/api/v3/position/current-position', queryString: 'category=USDT-FUTURES&symbol=BTCUSDT', secretKey: 'test_secret_key_1234567890' });
check('T4 queryString 포함 서명', sigQ === sigQ2 && sigQ !== sig1, '');

// [5] timestamp 형식 (13자리 ms)
let threw = false;
try { buildSignature({ timestamp: '17000', method: 'GET', requestPath: '/api/v3/account/assets', secretKey: 'x'.repeat(20) }); }
catch (e) { threw = e.code === 'INVALID_TIMESTAMP'; }
check('T5 13자리 아닌 timestamp 거부', threw, '');

// [6] API Key 누락 fail-closed
let e6 = null;
try { loadCredentials({ BITGET_PRIVATE_SECRET_KEY: 'x'.repeat(20), BITGET_PRIVATE_PASSPHRASE: 'pass1234' }); }
catch (e) { e6 = e; }
check('T6 API Key 누락 fail-closed', e6?.code === 'MISSING_API_KEY', e6?.code);

// [7] Secret 누락 fail-closed
let e7 = null;
try { loadCredentials({ BITGET_PRIVATE_API_KEY: 'api_key_12345678', BITGET_PRIVATE_PASSPHRASE: 'pass1234' }); }
catch (e) { e7 = e; }
check('T7 Secret 누락 fail-closed', e7?.code === 'MISSING_SECRET_KEY', e7?.code);

// [8] Passphrase 누락 fail-closed
let e8 = null;
try { loadCredentials({ BITGET_PRIVATE_API_KEY: 'api_key_12345678', BITGET_PRIVATE_SECRET_KEY: 'x'.repeat(20) }); }
catch (e) { e8 = e; }
check('T8 Passphrase 누락 fail-closed', e8?.code === 'MISSING_PASSPHRASE', e8?.code);

// [9] 허용 endpoint 통과 (4개)
const allowed = [
  ['GET', '/api/v3/account/assets'],
  ['GET', '/api/v3/position/current-position'],
  ['GET', '/api/v3/trade/unfilled-orders'],
  ['GET', '/api/v3/trade/fills'],
];
let allowCount = 0;
for (const [m, p] of allowed) {
  try { assertAllowedEndpoint(m, p); allowCount++; } catch (e) { console.log(`  unexpected: ${m} ${p} → ${e.code}`); }
}
check('T9 허용 endpoint 4개 통과', allowCount === 4, `allowed=${allowCount}/4`);

// [10] 주문 endpoint 차단
const blockedOrders = [
  ['POST', '/api/v3/trade/place-order'],
  ['POST', '/api/v3/trade/cancel-order'],
  ['POST', '/api/v3/trade/modify-order'],
  ['POST', '/api/v3/position/close-position'],
];
let blockedOrderCount = 0;
for (const [m, p] of blockedOrders) {
  try { assertAllowedEndpoint(m, p); } catch (e) { blockedOrderCount++; }
}
check('T10 주문 endpoint 차단', blockedOrderCount === 4, `blocked=${blockedOrderCount}/4`);

// [11] 출금/이체 endpoint 차단
const blockedFunds = [
  ['POST', '/api/v3/account/withdraw'],
  ['POST', '/api/v3/account/transfer'],
  ['GET', '/api/v3/account/withdraw-records'],
];
let blockedFundsCount = 0;
for (const [m, p] of blockedFunds) {
  try { assertAllowedEndpoint(m, p); } catch (e) { blockedFundsCount++; }
}
check('T11 출금/이체 endpoint 차단', blockedFundsCount === 3, `blocked=${blockedFundsCount}/3`);

// [12] 레버리지/마진 설정 차단
const blockedLeverage = [
  ['POST', '/api/v3/position/set-leverage'],
  ['POST', '/api/v3/position/set-margin-mode'],
];
let blockedLevCount = 0;
for (const [m, p] of blockedLeverage) {
  try { assertAllowedEndpoint(m, p); } catch (e) { blockedLevCount++; }
}
check('T12 레버리지/마진 차단', blockedLevCount === 2, `blocked=${blockedLevCount}/2`);

// [13] buildHeaders에 secret 노출 없음
const headers = buildHeaders({
  method: 'GET', requestPath: '/api/v3/account/assets',
  credentials: { apiKey: 'api_key_test_12345678', secretKey: 'secret_test_xxxxxxxxxx', passphrase: 'pass_test_9999' },
  now: () => 1700000000000,
});
const headerStr = JSON.stringify(headers);
check('T13 헤더에 Secret 미노출', !headerStr.includes('secret_test_xxxxxxxxxx'), '');
check('T13 헤더에 Passphrase 노출됨(정상, ACCESS-PASSPHRASE)', headers['ACCESS-PASSPHRASE'] === 'pass_test_9999', '');

// [14] encodeQuery 정확성
const q = encodeQuery({ category: 'USDT-FUTURES', symbol: 'BTCUSDT', limit: 100, empty: '', undef: undefined });
check('T14 encodeQuery 필터링', q === 'category=USDT-FUTURES&symbol=BTCUSDT&limit=100', `q=${q}`);

// [15] 에러 메시지에 secret 미노출
let e15 = null;
try { buildSignature({ timestamp: '1700000000000', method: 'INVALID', requestPath: '/x', secretKey: 'supersecret1234567890' }); }
catch (e) { e15 = e.message; }
check('T15 에러 메시지 secret 미노출', e15 && !e15.includes('supersecret1234567890'), e15);

console.log(`\n════════════ RESULT ════════════`);
console.log(`PASS=${pass}, FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
