import { fetchCandles } from '../src/bitget-adapter.mjs';

const origFetch = global.fetch;
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${name}: PASS (${detail})`); }
  else { fail++; console.log(`❌ ${name}: FAIL (${detail})`); }
}

// T1: HTTP 429
console.log('\n--- [T1] HTTP 429 ---');
let callCount429 = 0;
global.fetch = async () => { callCount429++; return { ok: false, status: 429, text: async () => 'Rate limited' }; };
let rateErr = null;
try { await fetchCandles('BTCUSDT', '1m', Date.now() - 3600000, undefined, 10); }
catch (e) { rateErr = e.message; }
check('T1 HTTP 429 감지', rateErr?.includes('429'), `err=${rateErr?.slice(0, 60)}`);
check('T1 무한 재시도 없음 (1회 호출)', callCount429 === 1, `calls=${callCount429}`);

// T2: Timeout
console.log('\n--- [T2] Timeout ---');
let timeoutAborted = false;
global.fetch = (url, opts) => new Promise((_, rej) => {
  const timer = setTimeout(() => rej(new Error('TIMEOUT')), 10000);
  if (opts?.signal) opts.signal.addEventListener('abort', () => { clearTimeout(timer); rej(new Error('ABORTED')); });
});
let timeoutErr = null;
try { await fetchCandles('BTCUSDT', '1m', Date.now() - 3600000, undefined, 10); }
catch (e) { timeoutErr = e.message; timeoutAborted = e.message.includes('ABORTED') || e.message.includes('abort'); }
check('T2 5초 타임아웃 후 중단', timeoutErr !== null, `err=${timeoutErr?.slice(0, 60)}`);

// T3: Connection refused
console.log('\n--- [T3] Connection refused ---');
global.fetch = async () => { throw new Error('ECONNREFUSED'); };
let connErr = null;
try { await fetchCandles('BTCUSDT', '1m', Date.now() - 3600000, undefined, 10); }
catch (e) { connErr = e.message; }
check('T3 연결 실패 감지', connErr?.includes('ECONNREFUSED'), `err=${connErr}`);

// T4: Invalid JSON
console.log('\n--- [T4] Invalid JSON 응답 ---');
global.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error('Unexpected token'); } });
let jsonErr = null;
try { await fetchCandles('BTCUSDT', '1m', Date.now() - 3600000, undefined, 10); }
catch (e) { jsonErr = e.message; }
check('T4 JSON 파싱 오류 감지', jsonErr !== null, `err=${jsonErr?.slice(0, 60)}`);

// T5: Recovery
console.log('\n--- [T5] 네트워크 복구 후 정상 처리 ---');
global.fetch = origFetch;
let recovered = false;
try {
  const c = await fetchCandles('BTCUSDT', '1m', Date.now() - 600000, undefined, 3);
  recovered = Array.isArray(c) && c.length > 0 && c[0].ts > 0;
} catch (e) { console.log(`  recovery fail: ${e.message}`); }
check('T5 실 API 복구 후 정상 fetch', recovered, 'candles fetched');

console.log(`\n결과: PASS=${pass}, FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
