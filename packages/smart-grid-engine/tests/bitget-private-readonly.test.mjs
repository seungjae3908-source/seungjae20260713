import { getAccountAssets, getCurrentPositions, getUnfilledOrders, getFills } from '../src/bitget-private-readonly.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`✅ ${name}: PASS ${detail}`); }
  else { fail++; console.log(`❌ ${name}: FAIL ${detail}`); }
}
const creds = { apiKey: 'api_key_test_12345678', secretKey: 'secret_key_test_xxxxxxxxxx', passphrase: 'passphrase_test' };
function mockFetch(response, capture) {
  return async (url, opts) => {
    if (capture) { capture.url = url; capture.opts = opts; }
    return {
      ok: response.ok !== false, status: response.status || 200,
      text: async () => JSON.stringify(response.body || {}),
    };
  };
}

// [1] 계정 자산 조회 성공
let cap1 = {};
const r1 = await getAccountAssets({ credentials: creds, fetchImpl: mockFetch({ body: { code: '00000', msg: 'success', data: { accountEquity: '100.5', usdtEquity: '100.5', assets: [] } } }, cap1), now: () => 1700000000000 });
check('T1 계정 자산 조회', r1.accountEquity === '100.5', `url=${cap1.url}`);
check('T1 URL 정확', cap1.url === 'https://api.bitget.com/api/v3/account/assets', cap1.url);
check('T1 Method=GET', cap1.opts.method === 'GET', cap1.opts.method);
check('T1 인증 헤더 4개', cap1.opts.headers['ACCESS-KEY'] && cap1.opts.headers['ACCESS-SIGN'] && cap1.opts.headers['ACCESS-TIMESTAMP'] && cap1.opts.headers['ACCESS-PASSPHRASE'], '');

// [2] 포지션 조회 (category 필수)
let cap2 = {};
const r2 = await getCurrentPositions({ category: 'USDT-FUTURES', symbol: 'BTCUSDT', credentials: creds, fetchImpl: mockFetch({ body: { code: '00000', data: { list: [{ symbol: 'BTCUSDT', posSide: 'long', avgPrice: '78000' }] } } }, cap2), now: () => 1700000000000 });
check('T2 포지션 조회', r2.list?.length === 1 && r2.list[0].symbol === 'BTCUSDT', '');
check('T2 URL query 포함', cap2.url.includes('category=USDT-FUTURES') && cap2.url.includes('symbol=BTCUSDT'), cap2.url);

// [3] 미체결 주문 조회
let cap3 = {};
const r3 = await getUnfilledOrders({ category: 'USDT-FUTURES', limit: 50, credentials: creds, fetchImpl: mockFetch({ body: { code: '00000', data: { list: [], cursor: '' } } }, cap3), now: () => 1700000000000 });
check('T3 미체결 주문', Array.isArray(r3.list), `url=${cap3.url}`);
check('T3 limit=50 반영', cap3.url.includes('limit=50'), cap3.url);

// [4] 체결 내역 조회
let cap4 = {};
const r4 = await getFills({ category: 'USDT-FUTURES', orderId: '12345', credentials: creds, fetchImpl: mockFetch({ body: { code: '00000', data: { list: [{ execId: 'e1' }], cursor: '' } } }, cap4), now: () => 1700000000000 });
check('T4 체결 내역', r4.list?.[0]?.execId === 'e1', '');
check('T4 orderId 반영', cap4.url.includes('orderId=12345'), cap4.url);

// [5] API 오류 (code !== 00000)
let e5 = null;
try {
  await getAccountAssets({ credentials: creds, fetchImpl: mockFetch({ body: { code: '40001', msg: 'Invalid signature' } }), now: () => 1700000000000 });
} catch (e) { e5 = e; }
check('T5 API 오류 throw', e5?.code === 'API_40001', e5?.code);

// [6] Rate limit (HTTP 429)
let e6 = null;
try {
  await getAccountAssets({ credentials: creds, fetchImpl: mockFetch({ ok: false, status: 429, body: { code: '00003', msg: 'Rate limit exceeded' } }), now: () => 1700000000000 });
} catch (e) { e6 = e; }
check('T6 Rate limit throw', e6?.code === 'HTTP_429', e6?.code);

// [7] Invalid JSON 응답
let e7 = null;
try {
  const badFetch = async () => ({ ok: true, status: 200, text: async () => 'not json' });
  await getAccountAssets({ credentials: creds, fetchImpl: badFetch, now: () => 1700000000000 });
} catch (e) { e7 = e; }
check('T7 Invalid JSON throw', e7?.code === 'INVALID_JSON', e7?.code);

// [8] category 누락 (포지션 조회는 category 필수)
let e8 = null;
try { await getCurrentPositions({ category: '', credentials: creds }); }
catch (e) { e8 = e; }
check('T8 category 누락 throw', e8?.code === 'MISSING_CATEGORY', e8?.code);

// [9] 미지원 endpoint 접근 차단 (비공개 requestReadOnly로 직접 시도)
let e9 = null;
try {
  const { requestReadOnly } = await import('../src/bitget-private-readonly.mjs');
  await requestReadOnly({ method: 'POST', requestPath: '/api/v3/trade/place-order', credentials: creds, fetchImpl: mockFetch({ body: { code: '00000' } }), now: () => 1700000000000 });
} catch (e) { e9 = e; }
check('T9 주문 endpoint 차단', e9?.code === 'ENDPOINT_NOT_ALLOWED', e9?.code);

// [10] Timeout 처리 (AbortController)
let e10 = null;
try {
  const hangFetch = async (url, opts) => new Promise((_, rej) => {
    if (opts?.signal) opts.signal.addEventListener('abort', () => rej(new Error('ABORTED')));
  });
  await getAccountAssets({ credentials: creds, fetchImpl: hangFetch, now: () => 1700000000000 });
} catch (e) { e10 = e; }
check('T10 Timeout abort', e10 !== null && (e10.message === 'ABORTED' || e10.name === 'AbortError' || String(e10).includes('ABORT')), String(e10));

// [11] 로그/에러에 secret 노출 없음
const errStr = String(e5) + String(e6) + String(e7) + String(e8);
check('T11 에러에 Secret 미노출', !errStr.includes('secret_key_test_xxxxxxxxxx'), '');

// [12] 응답 스키마 (data 반환)
check('T12 data 필드 반환', r1 && typeof r1 === 'object', '');

console.log(`\n════════════ RESULT ════════════`);
console.log(`PASS=${pass}, FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
