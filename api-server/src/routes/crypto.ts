import { Router, type IRouter } from 'express';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { requireMember } from '../middleware/auth';
import cryptoAutoRouter from './crypto-auto';

const router: IRouter = Router();
const UPBIT_BASE = 'https://api.upbit.com';
const BITGET_BASE = 'https://api.bitget.com';
const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';

function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function createUpbitToken(accessKey: string, secretKey: string, query = '') {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims: Record<string, string> = { access_key: accessKey, nonce: randomUUID() };
  if (query) {
    claims.query_hash = createHash('sha512').update(query).digest('hex');
    claims.query_hash_alg = 'SHA512';
  }
  const payload = base64Url(JSON.stringify(claims));
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
    if (!markets.length) {
      const master = await fetchJson<any[]>(`${UPBIT_BASE}/v1/market/all?isDetails=false`);
      // KRW 마켓 전체 조회(청크로 나눠 요청). 앞 100개만 자르면 BTC·ETH·XRP가 빠지는 실데이터 누락이 생긴다.
      markets = master.filter((item) => String(item.market ?? '').startsWith('KRW-')).map((item) => String(item.market));
    }
    const chunks: string[][] = [];
    for (let index = 0; index < markets.length; index += 100) chunks.push(markets.slice(index, index + 100));
    const payloads = await Promise.all(chunks.map((chunk) => fetchJson<any[]>(`${UPBIT_BASE}/v1/ticker?markets=${encodeURIComponent(chunk.join(','))}`)));
    const tickers = payloads.flat().map((item) => ({
      market: String(item.market),
      symbol: String(item.market).replace(/^KRW-/, ''),
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
    }));
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
  const before = String(req.query.before ?? '').trim();
  // tf가 있으면 일·주·월·사용자 집계봉, 없으면 기존 분봉 동작을 유지한다.
  const tf = String(req.query.tf ?? '').toUpperCase();
  const custom = tf ? CUSTOM_GRANULARITY[tf] : undefined;
  const source = custom?.source ?? tf;
  const sourceUnit =
    source === '1H'
      ? 60
      : source === '4H'
        ? 240
        : unit;
  const tfPath =
    source === '1D'
      ? 'days'
      : source === '1W'
        ? 'weeks'
        : source === '1M'
          ? 'months'
          : null;
  const sourceCount = Math.min(200, Math.max(count, count * (custom?.factor ?? 1)));
  const baseUrl = tfPath
    ? `${UPBIT_BASE}/v1/candles/${tfPath}?market=${encodeURIComponent(`KRW-${symbol}`)}&count=${sourceCount}`
    : `${UPBIT_BASE}/v1/candles/minutes/${sourceUnit}?market=${encodeURIComponent(`KRW-${symbol}`)}&count=${sourceCount}`;
  const url = before ? `${baseUrl}&to=${encodeURIComponent(before)}` : baseUrl;
  try {
    const rows = await fetchJson<any[]>(url);
    const ordered = rows.slice().reverse();
    const normalized = ordered.map((row) => ({ time: row.candle_date_time_kst, open: finite(row.opening_price), high: finite(row.high_price), low: finite(row.low_price), close: finite(row.trade_price), volume: finite(row.candle_acc_trade_volume), quoteVolume: finite(row.candle_acc_trade_price) }));
    const candles = custom
      ? aggregateCandles(normalized, tf, custom.factor, custom.calendar).slice(-count)
      : normalized;
    const earliestUtc = String(ordered[0]?.candle_date_time_utc ?? '').trim();
    const nextBefore = earliestUtc ? `${earliestUtc.replace(/Z$/i, '')}Z` : null;
    return res.json({
      ok: true,
      provider: 'upbit',
      fetchedAt: new Date().toISOString(),
      exchange: 'UPBIT',
      market: `KRW-${symbol}`,
      unit: tf || `${unit}m`,
      candles,
      count: candles.length,
      pagination: {
        nextBefore,
        hasMore: rows.length >= sourceCount,
      },
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('upbit candles error:', error);
    return res.status(502).json({ ok: false, provider: 'upbit', exchange: 'UPBIT', candles: [], count: 0, error: 'UPBIT_CANDLES_UNAVAILABLE', message: '업비트 캔들 조회 실패 — 결과 0건이 아니라 조회 오류입니다.' });
  }
});

router.get('/crypto/futures/tickers', async (req, res) => {
  const requested = safeSymbol(req.query.symbol);
  try {
    const payload = await fetchJson<any>(`${BITGET_BASE}/api/v2/mix/market/tickers?productType=${BITGET_PRODUCT_TYPE}${requested ? `&symbol=${encodeURIComponent(requested)}` : ''}`);
    if (String(payload?.code ?? '') !== '00000' || !Array.isArray(payload?.data)) throw new Error(`BITGET_${String(payload?.code ?? 'INVALID')}`);
    const tickers = payload.data.map((item: any) => {
      const changeRate24h = finite(item.change24h);
      const changePercent24h =
        changeRate24h == null ? null : changeRate24h * 100;
      const fundingRate = finite(item.fundingRate);

      return {
        symbol: String(item.symbol ?? ''),
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


type RawCandle = {
  time: number | string | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  quoteVolume: number | null;
};

const CUSTOM_GRANULARITY: Record<string, { source: string; factor: number; calendar?: 'year' }> = {
  '12H': { source: '4H', factor: 3 },
  '3D': { source: '1D', factor: 3 },
  '8H': { source: '4H', factor: 2 },
  '5D': { source: '1D', factor: 5 },
  '10D': { source: '1D', factor: 10 },
  '15D': { source: '1D', factor: 15 },
  '30D': { source: '1D', factor: 30 },
  '3M': { source: '1M', factor: 3 },
  '6M': { source: '1M', factor: 6 },
  '1Y': { source: '1M', factor: 12, calendar: 'year' },
  '3Y': { source: '1M', factor: 36 },
  '5Y': { source: '1M', factor: 60 },
  '10Y': { source: '1M', factor: 120 },
  'ALL': { source: '1M', factor: 1 },
};

function aggregateCandles(rows: RawCandle[], requested: string, factor: number, calendar?: 'year') {
  const valid = rows.filter((row) => row.time != null && row.open != null && row.high != null && row.low != null && row.close != null);
  if (factor <= 1) return valid;
  const groups: RawCandle[][] = [];
  if (calendar === 'year') {
    const byYear = new Map<number, RawCandle[]>();
    for (const row of valid) {
      const numeric = Number(row.time);
      const timestamp = Number.isFinite(numeric) ? numeric : Date.parse(String(row.time));
      if (!Number.isFinite(timestamp)) continue;
      const year = new Date(timestamp).getUTCFullYear();
      const list = byYear.get(year) ?? [];
      list.push(row);
      byYear.set(year, list);
    }
    groups.push(...Array.from(byYear.keys()).sort((a, b) => a - b).map((year) => byYear.get(year) ?? []));
  } else {
    for (let index = 0; index < valid.length; index += factor) {
      const chunk = valid.slice(index, index + factor);
      if (chunk.length === factor || index + factor >= valid.length) groups.push(chunk);
    }
  }
  return groups.filter((group) => group.length).map((group) => ({
    time: group[0].time,
    open: group[0].open,
    high: Math.max(...group.map((row) => Number(row.high))),
    low: Math.min(...group.map((row) => Number(row.low))),
    close: group[group.length - 1].close,
    volume: group.reduce((sum, row) => sum + Number(row.volume ?? 0), 0),
    quoteVolume: group.reduce((sum, row) => sum + Number(row.quoteVolume ?? 0), 0),
  }));
}

router.get('/crypto/futures/candles', async (req, res) => {
  const symbol = safeSymbol(req.query.symbol || 'BTCUSDT');
  const direct = new Set(['1m', '3m', '5m', '15m', '30m', '1H', '4H', '6H', '12H', '1D', '3D', '1W', '1M']);
  const requested = String(req.query.granularity ?? '15m');
  const custom = CUSTOM_GRANULARITY[requested];
  const sourceGranularity = custom?.source ?? (direct.has(requested) ? requested : '15m');
  const outputLimit = Math.max(1, Math.min(1000, Number(req.query.limit ?? 200) || 200));
  const sourceLimit = Math.max(1, Math.min(1000, outputLimit * (custom?.factor ?? 1)));
  const before = Number(req.query.before);
  const endTime =
    Number.isFinite(before) && before > 0
      ? Math.max(0, Math.floor(before) - 1)
      : null;
  try {
    const payload = await fetchJson<any>(`${BITGET_BASE}/api/v2/mix/market/candles?symbol=${encodeURIComponent(symbol)}&productType=${BITGET_PRODUCT_TYPE}&granularity=${encodeURIComponent(sourceGranularity)}&limit=${sourceLimit}${endTime == null ? '' : `&endTime=${endTime}`}`);
    if (String(payload?.code ?? '') !== '00000' || !Array.isArray(payload?.data)) throw new Error(`BITGET_${String(payload?.code ?? 'INVALID')}`);
    const raw: RawCandle[] = payload.data.reverse().map((row: any[]) => ({
      time: finite(row[0]),
      open: finite(row[1]),
      high: finite(row[2]),
      low: finite(row[3]),
      close: finite(row[4]),
      volume: finite(row[5]),
      quoteVolume: finite(row[6]),
    }));
    const aggregated = custom ? aggregateCandles(raw, requested, custom.factor, custom.calendar) : raw;
    const candles = aggregated.slice(-outputLimit);
    const now = new Date().toISOString();
    return res.json({
      ok: true,
      provider: 'bitget',
      fetchedAt: now,
      exchange: 'BITGET',
      symbol,
      productType: BITGET_PRODUCT_TYPE,
      granularity: requested,
      timeframe: requested,
      sourceGranularity,
      aggregated: Boolean(custom),
      aggregationFactor: custom?.factor ?? 1,
      candles,
      count: candles.length,
      pagination: {
        nextBefore: raw[0]?.time ?? null,
        hasMore: raw.length >= sourceLimit,
      },
      updatedAt: now,
    });
  } catch (error) {
    console.error('bitget candles error:', error);
    return res.status(502).json({ ok: false, provider: 'bitget', exchange: 'BITGET', productType: BITGET_PRODUCT_TYPE, candles: [], count: 0, error: 'BITGET_CANDLES_UNAVAILABLE', message: '비트겟 선물 캔들 조회에 실패했습니다.' });
  }
});

// 개인 계좌/포지션 조회는 회원 인증 필수 (서버 측 키로 조회되는 민감 정보).
router.get('/crypto/spot/accounts', requireMember, async (_req, res) => {
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

// 업비트 실제 체결·취소 주문을 자동매매 일지 화면에 표시합니다.
router.get('/crypto/spot/journal', requireMember, async (req, res) => {
  const accessKey = String(process.env.UPBIT_ACCESS_KEY ?? '').trim();
  const secretKey = String(process.env.UPBIT_SECRET_KEY ?? '').trim();
  if (!accessKey || !secretKey) {
    return res.status(503).json({ exchange: 'UPBIT', configured: false, entries: [], error: 'UPBIT_PRIVATE_KEYS_NOT_CONFIGURED' });
  }
  const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 100) || 100));
  const query = new URLSearchParams({ limit: String(limit), order_by: 'desc' }).toString();
  try {
    const token = createUpbitToken(accessKey, secretKey, query);
    const rows = await fetchJsonWithHeaders<any[]>(`${UPBIT_BASE}/v1/orders/closed?${query}`, { Authorization: `Bearer ${token}` });
    const entries = rows.map((row) => {
      const trades = Array.isArray(row.trades) ? row.trades : [];
      const executedVolume = finite(row.executed_volume) ?? trades.reduce((sum: number, trade: any) => sum + Number(trade.volume ?? 0), 0);
      const executedFunds = trades.reduce((sum: number, trade: any) => sum + Number(trade.funds ?? 0), 0);
      const weightedAverage = executedVolume && executedFunds ? executedFunds / executedVolume : null;
      const market = String(row.market ?? '');
      return {
        id: String(row.uuid ?? ''),
        market,
        symbol: market.replace(/^KRW-/, ''),
        side: String(row.side ?? ''),
        sideLabel: String(row.side ?? '') === 'bid' ? '매수' : String(row.side ?? '') === 'ask' ? '매도' : String(row.side ?? ''),
        orderType: String(row.ord_type ?? ''),
        state: String(row.state ?? ''),
        price: finite(row.price),
        averagePrice: finite(row.avg_price) ?? weightedAverage,
        volume: finite(row.volume),
        remainingVolume: finite(row.remaining_volume),
        executedVolume,
        executedFunds: executedFunds || null,
        paidFee: finite(row.paid_fee),
        tradesCount: Number(row.trades_count ?? trades.length ?? 0),
        createdAt: String(row.created_at ?? ''),
      };
    });
    return res.json({ ok: true, exchange: 'UPBIT', configured: true, entries, count: entries.length, updatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('upbit closed orders error:', error instanceof Error ? error.message : error);
    return res.status(502).json({ exchange: 'UPBIT', configured: true, entries: [], error: 'UPBIT_JOURNAL_UNAVAILABLE', message: '업비트 실제 주문내역을 불러오지 못했습니다.' });
  }
});

router.get('/crypto/futures/account', requireMember, async (_req, res) => {
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

router.get('/crypto/futures/positions', requireMember, async (_req, res) => {
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

router.use(cryptoAutoRouter);

export default router;
