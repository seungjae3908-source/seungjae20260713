import { Router, type IRouter } from 'express';
import { createHmac, randomUUID } from 'node:crypto';
import { requireAdmin, requireMember } from '../middleware/auth';
import cryptoAutoRouter from './crypto-auto';
import upbitAutoRouter from './upbit-auto';

const router: IRouter = Router();
const UPBIT_BASE = 'https://api.upbit.com';
const BITGET_BASE = 'https://api.bitget.com';
const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';

function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function createUpbitToken(accessKey: string, secretKey: string) {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({ access_key: accessKey, nonce: randomUUID() }));
  const signature = base64Url(createHmac('sha256', secretKey).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

async function fetchJsonWithHeaders<T>(url: string, headers: Record<string, string>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'knowledge-info-app/1.0', ...headers }, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP_${response.status}:${body.slice(0, 200)}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function bitgetHeaders(method: 'GET' | 'POST', requestPath: string, query = '', body = '') {
  const apiKey = String(process.env.BITGET_API_KEY ?? '').trim();
  const secret = String(process.env.BITGET_SECRET_KEY ?? '').trim();
  const passphrase = String(process.env.BITGET_PASSPHRASE ?? '').trim();
  if (!apiKey || !secret || !passphrase) throw new Error('BITGET_PRIVATE_KEYS_NOT_CONFIGURED');
  const timestamp = Date.now().toString();
  const queryPart = query ? `?${query}` : '';
  const signature = createHmac('sha256', secret).update(`${timestamp}${method}${requestPath}${queryPart}${body}`).digest('base64');
  return {
    'ACCESS-KEY': apiKey,
    'ACCESS-SIGN': signature,
    'ACCESS-TIMESTAMP': timestamp,
    'ACCESS-PASSPHRASE': passphrase,
    'Content-Type': 'application/json',
    locale: 'en-US',
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'seungjae-investment-app/1.0' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function safeSymbol(value: unknown) {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30);
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

type CryptoCandle = {
  time: string | number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume?: number;
  tradingValue?: number;
};

function cryptoCandleTime(value: string | number) {
  if (typeof value === 'number') return value < 1_000_000_000_000 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function aggregateCryptoCandles(rows: CryptoCandle[], size: number): CryptoCandle[] {
  const sorted = [...rows].sort((a, b) => cryptoCandleTime(a.time) - cryptoCandleTime(b.time));
  if (size <= 1) return sorted;
  const result: CryptoCandle[] = [];
  for (let index = 0; index < sorted.length; index += size) {
    const chunk = sorted.slice(index, index + size);
    if (!chunk.length) continue;
    result.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((row) => row.high)),
      low: Math.min(...chunk.map((row) => row.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((sum, row) => sum + row.volume, 0),
      quoteVolume: chunk.reduce((sum, row) => sum + Number(row.quoteVolume ?? 0), 0),
      tradingValue: chunk.reduce((sum, row) => sum + Number(row.tradingValue ?? 0), 0),
    });
  }
  return result;
}

router.use('/crypto', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

router.get('/crypto/status', async (_req, res) => {
  const [upbit, bitget] = await Promise.allSettled([
    fetchJson<unknown[]>(`${UPBIT_BASE}/v1/market/all?isDetails=true`),
    fetchJson<any>(`${BITGET_BASE}/api/v2/mix/market/tickers?productType=${BITGET_PRODUCT_TYPE}`),
  ]);
  return res.json({
    upbit: {
      ok: upbit.status === 'fulfilled' && Array.isArray(upbit.value),
      privateKeyConfigured: Boolean(process.env.UPBIT_ACCESS_KEY && process.env.UPBIT_SECRET_KEY),
    },
    bitget: {
      ok: bitget.status === 'fulfilled' && Array.isArray(bitget.value?.data),
      privateKeyConfigured: Boolean(
        process.env.BITGET_API_KEY && process.env.BITGET_SECRET_KEY && process.env.BITGET_PASSPHRASE,
      ),
      productType: BITGET_PRODUCT_TYPE,
    },
    checkedAt: new Date().toISOString(),
  });
});

router.get('/crypto/spot/markets', async (_req, res) => {
  try {
    const markets = await fetchJson<any[]>(`${UPBIT_BASE}/v1/market/all?isDetails=true`);
    const rows = markets
      .filter((item) => String(item.market ?? '').startsWith('KRW-'))
      .map((item) => ({
        market: String(item.market),
        symbol: String(item.market).replace(/^KRW-/, ''),
        koreanName: String(item.korean_name ?? item.market),
        englishName: String(item.english_name ?? item.market),
        warning: String(item.market_warning ?? 'NONE') !== 'NONE',
      }));
    return res.json({ exchange: 'UPBIT', quoteCurrency: 'KRW', markets: rows, count: rows.length, updatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('upbit markets error:', error);
    return res.status(502).json({ exchange: 'UPBIT', markets: [], count: 0, error: 'UPBIT_MARKETS_UNAVAILABLE' });
  }
});

router.get('/crypto/spot/tickers', async (req, res) => {
  try {
    const requested = String(req.query.markets ?? '').split(',').map(safeSymbol).filter(Boolean);
    let markets = requested.map((symbol) => (symbol.startsWith('KRW-') ? symbol : `KRW-${symbol}`));
    const master = await fetchJson<any[]>(`${UPBIT_BASE}/v1/market/all?isDetails=false`);
    if (!markets.length) {
      // KRW 마켓 전체 조회(청크로 나눠 요청). 앞 100개만 자르면 BTC·ETH·XRP가 빠지는 실데이터 누락이 생긴다.
      markets = master.filter((item) => String(item.market ?? '').startsWith('KRW-')).map((item) => String(item.market));
    }
    const namesByMarket = new Map(
      master.map((item) => [
        String(item.market ?? ''),
        {
          koreanName: String(item.korean_name ?? item.market ?? ''),
          englishName: String(item.english_name ?? item.market ?? ''),
        },
      ]),
    );
    const chunks: string[][] = [];
    for (let index = 0; index < markets.length; index += 100) chunks.push(markets.slice(index, index + 100));
    const payloads = await Promise.all(chunks.map((chunk) => fetchJson<any[]>(`${UPBIT_BASE}/v1/ticker?markets=${encodeURIComponent(chunk.join(','))}`)));
    const tickers = payloads.flat().map((item) => {
      const market = String(item.market);
      const names = namesByMarket.get(market);

      return {
        market,
        symbol: market.replace(/^KRW-/, ''),
        koreanName: names?.koreanName ?? market,
        englishName: names?.englishName ?? market,
        price: finite(item.trade_price),
        change: String(item.change ?? ''),
        changeRate: finite(item.signed_change_rate),
        changePercent: finite(item.signed_change_rate) == null ? null : Number(item.signed_change_rate) * 100,
        changePrice: finite(item.signed_change_price),
        high24h: finite(item.high_price),
        low24h: finite(item.low_price),
        volume24h: finite(item.acc_trade_volume_24h),
        tradingValue24h: finite(item.acc_trade_price_24h),
        timestamp: finite(item.timestamp),
      };
    });
    return res.json({ exchange: 'UPBIT', quoteCurrency: 'KRW', tickers, count: tickers.length, updatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('upbit tickers error:', error);
    return res.status(502).json({ exchange: 'UPBIT', tickers: [], count: 0, error: 'UPBIT_TICKERS_UNAVAILABLE' });
  }
});

router.get('/crypto/spot/orderbook', async (req, res) => {
  const symbol = safeSymbol(req.query.symbol || 'BTC');
  try {
    const rows = await fetchJson<any[]>(`${UPBIT_BASE}/v1/orderbook?markets=${encodeURIComponent(`KRW-${symbol}`)}&level=0`);
    const item = rows[0];
    if (!item) return res.status(404).json({ error: 'ORDERBOOK_NOT_FOUND' });
    return res.json({
      exchange: 'UPBIT',
      market: item.market,
      totalAskSize: finite(item.total_ask_size),
      totalBidSize: finite(item.total_bid_size),
      units: Array.isArray(item.orderbook_units) ? item.orderbook_units.map((unit: any) => ({ askPrice: finite(unit.ask_price), bidPrice: finite(unit.bid_price), askSize: finite(unit.ask_size), bidSize: finite(unit.bid_size) })) : [],
      timestamp: finite(item.timestamp),
    });
  } catch (error) {
    console.error('upbit orderbook error:', error);
    return res.status(502).json({ exchange: 'UPBIT', units: [], error: 'UPBIT_ORDERBOOK_UNAVAILABLE' });
  }
});

router.get('/crypto/spot/candles', async (req, res) => {
  const symbol = safeSymbol(req.query.symbol || 'BTC');
  const unit = Math.max(1, Math.min(240, Number(req.query.unit ?? 15) || 15));
  const count = Math.max(1, Math.min(200, Number(req.query.count ?? 120) || 120));
  const rawTf = String(req.query.tf ?? '').trim();
  const supported = new Set(['1m', '3m', '5m', '15m', '30m', '1H', '4H', '8H', '12H', '1D', '3D', '5D', '15D', '1M', '3M', '6M', '1Y']);
  const tf = supported.has(rawTf) ? rawTf : '';
  const minuteUnit: Record<string, number> = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1H': 60, '4H': 240, '8H': 240, '12H': 240 };
  const aggregateSize: Record<string, number> = { '8H': 2, '12H': 3, '3D': 3, '5D': 5, '15D': 15, '3M': 3, '6M': 6, '1Y': 12 };
  const size = aggregateSize[tf] ?? 1;
  const path = minuteUnit[tf]
    ? `minutes/${minuteUnit[tf]}`
    : ['1D', '3D', '5D', '15D'].includes(tf)
      ? 'days'
      : ['1M', '3M', '6M', '1Y'].includes(tf)
        ? 'months'
        : `minutes/${unit}`;
  const requestCount = Math.min(200, Math.max(count, count * size));
  const url = `${UPBIT_BASE}/v1/candles/${path}?market=${encodeURIComponent(`KRW-${symbol}`)}&count=${requestCount}`;
  try {
    const rows = await fetchJson<any[]>(url);
    const normalized = rows.flatMap((row): CryptoCandle[] => {
      const open = finite(row.opening_price);
      const high = finite(row.high_price);
      const low = finite(row.low_price);
      const close = finite(row.trade_price);
      if (open == null || high == null || low == null || close == null) return [];
      return [{ time: String(row.candle_date_time_kst ?? ''), open, high, low, close, volume: finite(row.candle_acc_trade_volume) ?? 0, tradingValue: finite(row.candle_acc_trade_price) ?? 0 }];
    });
    const candles = aggregateCryptoCandles(normalized, size);
    return res.json({ ok: true, provider: 'upbit', fetchedAt: new Date().toISOString(), exchange: 'UPBIT', market: `KRW-${symbol}`, unit: tf || `${unit}m`, timeframe: tf || `${unit}m`, candles, count: candles.length, updatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('upbit candles error:', error);
    return res.status(502).json({ ok: false, provider: 'upbit', exchange: 'UPBIT', candles: [], count: 0, error: 'UPBIT_CANDLES_UNAVAILABLE', message: '업비트 캔들 조회 실패 — 결과 0건이 아니라 조회 오류입니다.' });
  }
});

router.get('/crypto/futures/tickers', async (req, res) => {
  const requested = safeSymbol(req.query.symbol);
  try {
    const [payload, contractsPayload] = await Promise.all([
      fetchJson<any>(`${BITGET_BASE}/api/v2/mix/market/tickers?productType=${BITGET_PRODUCT_TYPE}${requested ? `&symbol=${encodeURIComponent(requested)}` : ''}`),
      fetchJson<any>(`${BITGET_BASE}/api/v2/mix/market/contracts?productType=${BITGET_PRODUCT_TYPE}`),
    ]);
    if (String(payload?.code ?? '') !== '00000' || !Array.isArray(payload?.data)) throw new Error(`BITGET_${String(payload?.code ?? 'INVALID')}`);
    if (String(contractsPayload?.code ?? '') !== '00000' || !Array.isArray(contractsPayload?.data)) throw new Error(`BITGET_CONTRACTS_${String(contractsPayload?.code ?? 'INVALID')}`);
    const contractsBySymbol = new Map(
      contractsPayload.data.map((item: any) => [String(item.symbol ?? ''), item]),
    );
    const tickers = payload.data.map((item: any) => {
      const symbol = String(item.symbol ?? '');
      const contract = contractsBySymbol.get(symbol) as Record<string, unknown> | undefined;
      const changeRate24h = finite(item.change24h);
      const changePercent24h =
        changeRate24h == null ? null : changeRate24h * 100;
      const fundingRate = finite(item.fundingRate);

      return {
        symbol,
        baseCoin: String(contract?.baseCoin ?? symbol.replace(/USDT$/u, '')),
        quoteCoin: String(contract?.quoteCoin ?? 'USDT'),
        englishName: String(contract?.baseCoin ?? symbol.replace(/USDT$/u, '')),
        price: finite(item.lastPr),
        markPrice: finite(item.markPrice),
        indexPrice: finite(item.indexPrice),
        changeRate24h,
        changePercent24h,
        // 기존 코인 화면과 신규 롱·숏 워크스페이스가 모두 사용할 수 있는 별칭.
        changePercent: changePercent24h,
        high24h: finite(item.high24h),
        low24h: finite(item.low24h),
        volume24h: finite(item.baseVolume),
        tradingValue24h: finite(item.usdtVolume),
        fundingRate,
        fundingRatePercent: fundingRate == null ? null : fundingRate * 100,
        openInterest: finite(item.holdingAmount),
        bidPrice: finite(item.bidPr),
        askPrice: finite(item.askPr),
        timestamp: finite(item.ts),
      };
    });
    const now = new Date().toISOString();
    return res.json({
      ok: true,
      provider: 'bitget',
      fetchedAt: now,
      exchange: 'BITGET',
      productType: BITGET_PRODUCT_TYPE,
      tickers,
      count: tickers.length,
      updatedAt: now,
    });
  } catch (error) {
    console.error('bitget tickers error:', error);
    return res.status(502).json({ ok: false, provider: 'bitget', exchange: 'BITGET', productType: BITGET_PRODUCT_TYPE, tickers: [], count: 0, error: 'BITGET_TICKERS_UNAVAILABLE', message: '비트겟 선물 시세 조회에 실패했습니다.' });
  }
});

router.get('/crypto/futures/candles', async (req, res) => {
  const symbol = safeSymbol(req.query.symbol || 'BTCUSDT');
  const allowed = new Set(['1m', '3m', '5m', '15m', '30m', '1H', '4H', '8H', '12H', '1D', '3D', '5D', '15D', '1M', '3M', '6M', '1Y']);
  const rawGranularity = String(req.query.granularity ?? '15m').trim();
  const timeframe = allowed.has(rawGranularity) ? rawGranularity : '15m';
  const aggregateSize: Record<string, number> = { '8H': 2, '3D': 3, '5D': 5, '15D': 15, '3M': 3, '6M': 6, '1Y': 12 };
  const size = aggregateSize[timeframe] ?? 1;
  const granularity = timeframe === '8H' ? '4H' : ['3D', '5D', '15D'].includes(timeframe) ? '1D' : ['3M', '6M', '1Y'].includes(timeframe) ? '1M' : timeframe;
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit ?? 200) || 200));
  try {
    const payload = await fetchJson<any>(`${BITGET_BASE}/api/v2/mix/market/candles?symbol=${encodeURIComponent(symbol)}&productType=${BITGET_PRODUCT_TYPE}&granularity=${encodeURIComponent(granularity)}&limit=${Math.min(1000, limit * size)}`);
    if (String(payload?.code ?? '') !== '00000' || !Array.isArray(payload?.data)) throw new Error(`BITGET_${String(payload?.code ?? 'INVALID')}`);
    const normalized = payload.data.flatMap((row: any[]): CryptoCandle[] => {
      const time = finite(row[0]);
      const open = finite(row[1]);
      const high = finite(row[2]);
      const low = finite(row[3]);
      const close = finite(row[4]);
      if (time == null || open == null || high == null || low == null || close == null) return [];
      return [{ time, open, high, low, close, volume: finite(row[5]) ?? 0, quoteVolume: finite(row[6]) ?? 0 }];
    });
    const candles = aggregateCryptoCandles(normalized, size);
    const now = new Date().toISOString();
    return res.json({
      ok: true,
      provider: 'bitget',
      fetchedAt: now,
      exchange: 'BITGET',
      symbol,
      productType: BITGET_PRODUCT_TYPE,
      granularity,
      timeframe,
      candles,
      count: candles.length,
      updatedAt: now,
    });
  } catch (error) {
    console.error('bitget candles error:', error);
    return res.status(502).json({ ok: false, provider: 'bitget', exchange: 'BITGET', productType: BITGET_PRODUCT_TYPE, candles: [], count: 0, error: 'BITGET_CANDLES_UNAVAILABLE', message: '비트겟 선물 캔들 조회에 실패했습니다.' });
  }
});

// 개인 계좌/포지션 조회는 회원 인증 필수 (서버 측 키로 조회되는 민감 정보).
router.get('/crypto/spot/accounts', requireMember, requireAdmin, async (_req, res) => {
  const accessKey = String(process.env.UPBIT_ACCESS_KEY ?? '').trim();
  const secretKey = String(process.env.UPBIT_SECRET_KEY ?? '').trim();
  if (!accessKey || !secretKey) return res.status(503).json({ exchange: 'UPBIT', configured: false, accounts: [], error: 'UPBIT_PRIVATE_KEYS_NOT_CONFIGURED' });
  try {
    const token = createUpbitToken(accessKey, secretKey);
    const rows = await fetchJsonWithHeaders<any[]>(`${UPBIT_BASE}/v1/accounts`, { Authorization: `Bearer ${token}` });
    const accounts = rows.map((row) => ({
      currency: String(row.currency ?? ''),
      balance: finite(row.balance),
      locked: finite(row.locked),
      averageBuyPrice: finite(row.avg_buy_price),
      averageBuyPriceModified: Boolean(row.avg_buy_price_modified),
      unitCurrency: String(row.unit_currency ?? 'KRW'),
    }));
    return res.json({ exchange: 'UPBIT', configured: true, accounts, count: accounts.length, updatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('upbit accounts error:', error instanceof Error ? error.message : error);
    return res.status(502).json({ exchange: 'UPBIT', configured: true, accounts: [], error: 'UPBIT_ACCOUNTS_UNAVAILABLE' });
  }
});

router.get('/crypto/futures/account', requireMember, requireAdmin, async (_req, res) => {
  const path = '/api/v2/mix/account/accounts';
  const query = `productType=${BITGET_PRODUCT_TYPE}`;
  try {
    const payload = await fetchJsonWithHeaders<any>(`${BITGET_BASE}${path}?${query}`, bitgetHeaders('GET', path, query));
    if (String(payload?.code ?? '') !== '00000' || !Array.isArray(payload?.data)) throw new Error(`BITGET_${String(payload?.code ?? 'INVALID')}`);
    const accounts = payload.data.map((row: any) => ({
      marginCoin: String(row.marginCoin ?? ''),
      available: finite(row.available),
      locked: finite(row.locked),
      accountEquity: finite(row.accountEquity),
      unrealizedPL: finite(row.unrealizedPL),
      crossedMaxAvailable: finite(row.crossedMaxAvailable),
      isolatedMaxAvailable: finite(row.isolatedMaxAvailable),
    }));
    return res.json({ ok: true, provider: 'bitget', exchange: 'BITGET', productType: BITGET_PRODUCT_TYPE, configured: true, accounts, count: accounts.length, updatedAt: new Date().toISOString() });
  } catch (error) {
    const notConfigured = error instanceof Error && error.message === 'BITGET_PRIVATE_KEYS_NOT_CONFIGURED';
    console.error('bitget account error:', error instanceof Error ? error.message : error);
    return res.status(notConfigured ? 503 : 502).json({ exchange: 'BITGET', configured: !notConfigured, accounts: [], error: notConfigured ? 'BITGET_PRIVATE_KEYS_NOT_CONFIGURED' : 'BITGET_ACCOUNT_UNAVAILABLE', message: notConfigured ? '비트겟 API Key·Secret·Passphrase 설정이 필요합니다.' : '비트겟 선물 계좌 조회에 실패했습니다.' });
  }
});

router.get('/crypto/futures/positions', requireMember, requireAdmin, async (_req, res) => {
  const path = '/api/v2/mix/position/all-position';
  const query = `productType=${BITGET_PRODUCT_TYPE}&marginCoin=USDT`;
  try {
    const payload = await fetchJsonWithHeaders<any>(`${BITGET_BASE}${path}?${query}`, bitgetHeaders('GET', path, query));
    if (String(payload?.code ?? '') !== '00000' || !Array.isArray(payload?.data)) throw new Error(`BITGET_${String(payload?.code ?? 'INVALID')}`);
    const positions = payload.data
      .map((row: any) => ({
        symbol: String(row.symbol ?? ''),
        holdSide: String(row.holdSide ?? ''),
        total: finite(row.total),
        available: finite(row.available),
        openPriceAvg: finite(row.openPriceAvg),
        markPrice: finite(row.markPrice),
        unrealizedPL: finite(row.unrealizedPL),
        liquidationPrice: finite(row.liquidationPrice),
        leverage: finite(row.leverage),
        marginMode: String(row.marginMode ?? ''),
        marginSize: finite(row.marginSize),
        breakEvenPrice: finite(row.breakEvenPrice),
      }))
      .filter((row: any) => Number(row.total ?? 0) !== 0);
    return res.json({ ok: true, provider: 'bitget', exchange: 'BITGET', productType: BITGET_PRODUCT_TYPE, configured: true, positions, count: positions.length, updatedAt: new Date().toISOString() });
  } catch (error) {
    const notConfigured = error instanceof Error && error.message === 'BITGET_PRIVATE_KEYS_NOT_CONFIGURED';
    console.error('bitget positions error:', error instanceof Error ? error.message : error);
    return res.status(notConfigured ? 503 : 502).json({ exchange: 'BITGET', configured: !notConfigured, positions: [], error: notConfigured ? 'BITGET_PRIVATE_KEYS_NOT_CONFIGURED' : 'BITGET_POSITIONS_UNAVAILABLE', message: notConfigured ? '비트겟 API Key·Secret·Passphrase 설정이 필요합니다.' : '비트겟 선물 포지션 조회에 실패했습니다.' });
  }
});

router.use(upbitAutoRouter);
router.use(cryptoAutoRouter);

export default router;
