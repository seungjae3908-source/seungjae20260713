import { createClient } from '@supabase/supabase-js';
const url = process.env.VITE_SUPABASE_URL;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(url, service, { auth: { persistSession: false } });
const email = 'agent-test-4cha@example.com';
// create or fetch test user
let userId;
const { data: created, error: cErr } = await admin.auth.admin.createUser({ email, password: 'Test!23456', email_confirm: true, user_metadata: { login_name: 'agenttest4', display_name: '테스트' } });
if (cErr) {
  console.log('create err:', cErr.message);
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  userId = list?.users?.find(u => u.email === email)?.id;
} else userId = created.user.id;
console.log('userId', userId);
// upsert profile approved full
const { error: pErr } = await admin.from('profiles').upsert({ id: userId, login_name: 'agenttest4', display_name: '테스트', role: 'full', status: 'approved' });
console.log('profile upsert err:', pErr?.message ?? 'ok');
// sign in
const anonKeyless = createClient(url, service, { auth: { persistSession: false } });
const { data: sess, error: sErr } = await anonKeyless.auth.signInWithPassword({ email, password: 'Test!23456' });
if (sErr) { console.log('signin err', sErr.message); process.exit(1); }
const token = sess.session.access_token;
console.log('TOKEN_LEN', token.length);
const base = 'http://127.0.0.1:8080/api';
for (const u of [
  '/stocks/005930/candles?tf=5m',
  '/stocks/AAPL/candles?tf=5m',
  '/crypto/spot/candles?symbol=KRW-BTC&unit=5&count=200',
  '/crypto/futures/candles?symbol=BTCUSDT&granularity=5m&limit=200',
  '/market/chart-signals?asset=stock&symbol=005930&interval=5m',
  '/market/ai-chart-plan?asset=coin&coinMarket=spot&symbol=KRW-BTC&interval=5m',
]) {
  const t0 = Date.now();
  try {
    const r = await fetch(base + u, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
    const body = await r.text();
    console.log(r.status, `${Date.now()-t0}ms`, u, '->', body.slice(0, 160).replace(/\n/g,' '));
  } catch (e) { console.log('FETCH_ERR', `${Date.now()-t0}ms`, u, e.message); }
}
