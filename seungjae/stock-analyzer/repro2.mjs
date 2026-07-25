import { createClient } from '@supabase/supabase-js';
const url = process.env.VITE_SUPABASE_URL, service = process.env.SUPABASE_SERVICE_ROLE_KEY;
const c = createClient(url, service, { auth: { persistSession: false } });
const { data: sess, error } = await c.auth.signInWithPassword({ email: 'agent-test-4cha@example.com', password: 'Test!23456' });
if (error) { console.log('signin err', error.message); process.exit(1); }
const token = sess.session.access_token;
const base = 'http://127.0.0.1:8080/api';
const urls = [
  '/crypto/spot/candles?symbol=KRW-BTC&unit=5&count=200',
  '/crypto/futures/candles?symbol=BTCUSDT&granularity=5m&limit=200',
  '/market/chart-signals?asset=coin&coinMarket=spot&symbol=KRW-BTC&interval=5m',
  '/market/chart-signals?asset=us&symbol=AAPL&interval=15m',
  '/market/ai-chart-plan?asset=stock&symbol=005930&interval=60m',
  '/stocks/005930/candles?tf=15m',
  '/stocks/AAPL/candles?tf=60m',
];
await Promise.all(urls.map(async (u) => {
  const t0 = Date.now();
  try {
    const r = await fetch(base + u, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) });
    const b = await r.text();
    console.log(r.status, `${Date.now()-t0}ms`, u, '->', b.slice(0, 110).replace(/\n/g,' '));
  } catch (e) { console.log('ERR', `${Date.now()-t0}ms`, u, e.message); }
}));
