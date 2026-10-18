#!/usr/bin/env node
// Strategy zoo backtest (Korean report). Research only, public data only.
//   node research-production/bin/strategy-zoo-backtest.mjs --fetch <dir>
// Data (all before 2026; the final holdout is never read):
//   KR/US stocks + US ETFs: Yahoo daily 2005–2025, dividend/split adjusted (adjclose)
//   Upbit KRW spot: daily since listing (Upbit days endpoint)
//   Bitget USDT perpetuals: daily since listing + funding history
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { BitgetPublicClient } from '../../market-prediction-lab/src/bitget-public-client.js';
import { collectBitgetCandles } from '../../market-prediction-lab/src/bitget-candle-collector.js';
import { collectFundingRateHistory } from '../../market-prediction-lab/src/derivatives-history.js';
import { evaluateStrategyZooMarketV1, formatStrategyZooReportKoV1 } from '../src/strategy-zoo-v1.mjs';

const END = Date.UTC(2026, 0, 1) - 1;
const STOCK_START = Date.UTC(2005, 0, 1);
const CRYPTO_START = Date.UTC(2017, 0, 1);

export const STRATEGY_ZOO_UNIVERSE_V1 = Object.freeze({
  KR_STOCK: ['069500', '229200', '005930', '000660', '005380', '000270', '068270', '035420', '035720', '051910', '006400', '005490', '105560',
    '055550', '012330', '028260', '066570', '003550', '034730', '017670', '207940', '015760', '032830', '086790', '009150', '010950', '096770',
    '011170', '018260', '034020', '010130', '000810', '024110', '033780', '090430', '004020', '011200', '316140', '003490', '251270', '036570',
    '097950', '047050', '009540', '042660', '010140', '000100', '128940', '271560', '259960'],
  US_STOCK: ['SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'NVDA', 'TSLA', 'JPM', 'JNJ', 'V', 'PG', 'XOM', 'CVX', 'UNH', 'HD', 'MA',
    'BAC', 'KO', 'PEP', 'MRK', 'ABBV', 'AVGO', 'COST', 'WMT', 'DIS', 'CSCO', 'ORCL', 'INTC', 'AMD', 'QCOM', 'TXN', 'IBM', 'CAT', 'GE', 'BA',
    'MMM', 'HON', 'NKE', 'MCD', 'SBUX', 'GS', 'MS', 'C', 'WFC', 'T', 'VZ', 'PFE', 'LLY', 'ADBE', 'CRM', 'NFLX'],
  US_TAA: ['SPY', 'QQQ', 'IWM', 'EFA', 'EEM', 'VGK', 'EWJ', 'VWO', 'VNQ', 'DBC', 'GLD', 'TLT', 'IEF', 'SHY', 'LQD', 'AGG', 'BND', 'BIL', 'TIP', 'HYG',
    'VEA', 'SCZ', 'REM', 'VTI', 'VEU', 'TQQQ'],
  CRYPTO_SPOT: ['BTC', 'ETH', 'XRP', 'ADA', 'DOGE', 'SOL', 'TRX', 'LINK', 'BCH', 'ETC', 'XLM', 'DOT', 'AVAX', 'SAND', 'MANA', 'ATOM', 'NEAR',
    'HBAR', 'AAVE', 'VET', 'THETA', 'ALGO', 'EOS', 'SUI', 'STX', 'QTUM', 'NEO', 'BTG', 'ZRX', 'BAT'].map((x) => `KRW-${x}`),
  CRYPTO_FUTURES: ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'SOLUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'LTCUSDT', 'BCHUSDT', 'DOTUSDT', 'AVAXUSDT',
    'TRXUSDT', 'ATOMUSDT', 'ETCUSDT', 'XLMUSDT', 'FILUSDT', 'UNIUSDT', 'NEARUSDT', 'AAVEUSDT', 'APTUSDT'],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fallback mid/small-cap US list if the Nasdaq screener is unreachable (current listings → survivorship bias, reported).
const US_WIDE_FALLBACK_V1 = ['SMCI', 'CELH', 'ELF', 'DECK', 'AXON', 'ENPH', 'FSLR', 'MSTR', 'COIN', 'PLTR', 'CRWD', 'DDOG', 'NET', 'ZS', 'MDB', 'SNOW', 'HUBS',
  'TTD', 'ROKU', 'ETSY', 'PINS', 'SNAP', 'UBER', 'LYFT', 'DKNG', 'RBLX', 'U', 'TWLO', 'OKTA', 'DOCU', 'ZM', 'SHOP', 'SQ', 'PYPL', 'AFRM', 'UPST',
  'SOFI', 'HOOD', 'RIVN', 'LCID', 'NIO', 'XPEV', 'LI', 'PLUG', 'RUN', 'SEDG', 'ON', 'MPWR', 'LSCC', 'WOLF', 'CRUS', 'SWKS', 'QRVO', 'MRVL', 'MU',
  'AMAT', 'LRCX', 'KLAC', 'TER', 'ENTG', 'ONTO', 'AEHR', 'ACLS', 'VRT', 'ANET', 'CIEN', 'LITE', 'COHR', 'IONQ', 'RGTI', 'APP', 'CVNA', 'W', 'CHWY',
  'FIVE', 'LULU', 'CROX', 'ONON', 'BIRK', 'WING', 'CMG', 'CAVA', 'TXRH', 'SHAK', 'BOOT', 'ANF', 'URBN', 'AEO', 'GPS', 'TPR', 'RL', 'SKX', 'YETI',
  'POOL', 'TREX', 'BLDR', 'UFPI', 'IBP', 'TOL', 'LEN', 'DHI', 'PHM', 'KBH', 'MTH', 'NVR', 'MHO', 'GRBK', 'SAIA', 'ODFL', 'XPO', 'JBHT', 'KNX',
  'CAR', 'HTZ', 'AAL', 'UAL', 'DAL', 'LUV', 'JBLU', 'ALK', 'CCL', 'RCL', 'NCLH', 'EXPE', 'ABNB', 'BKNG', 'MAR', 'H', 'WYNN', 'LVS', 'MGM', 'CZR',
  'PENN', 'CHDN', 'MRNA', 'BNTX', 'NVAX', 'VRTX', 'REGN', 'ALNY', 'SRPT', 'EXAS', 'NTRA', 'DXCM', 'PODD', 'TNDM', 'ISRG', 'IDXX', 'ALGN', 'HZNP',
  'INCY', 'BMRN', 'NBIX', 'EXEL', 'HALO', 'UTHR', 'CRSP', 'NTLA', 'BEAM', 'EDIT', 'VKTX', 'MDGL', 'CYTK', 'APLS', 'KRYS', 'AXSM', 'ITCI', 'IONS',
  'OXY', 'DVN', 'FANG', 'APA', 'MRO', 'EQT', 'AR', 'RRC', 'SWN', 'CTRA', 'MTDR', 'SM', 'CHRD', 'PR', 'CIVI', 'NOG', 'TALO', 'CLF', 'X', 'NUE',
  'STLD', 'AA', 'FCX', 'MP', 'ALB', 'LTHM', 'SQM', 'CCJ', 'UEC', 'URA', 'CENX', 'ATI', 'CRS', 'HWM', 'TDG', 'HEI', 'AXON', 'KTOS', 'AVAV', 'RKLB',
  'ACHR', 'JOBY', 'GME', 'AMC', 'BBBY', 'TLRY', 'CGC', 'SPCE', 'OPEN', 'Z', 'RDFN', 'EXPI', 'COMP', 'CSGP', 'FICO', 'MSCI', 'SPGI', 'MCO', 'NDAQ',
  'CBOE', 'IBKR', 'SCHW', 'LPLA', 'RJF', 'EVR', 'LAZ', 'PJT', 'HLI', 'KKR', 'BX', 'APO', 'ARES', 'OWL', 'TPG', 'CG', 'ALLY', 'COF', 'DFS', 'SYF'];

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) research', accept: '*/*' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return res.text();
}

/** Wide universes, resolved at run time from public listings (current members → survivorship bias, stated in the report). */
async function resolveWideUniverse() {
  const wide = {};
  // KR: Naver market-cap ranking, KOSPI (sosok=0) and KOSDAQ (sosok=1) top 200 each
  const kr = new Set(STRATEGY_ZOO_UNIVERSE_V1.KR_STOCK);
  for (const sosok of [0, 1]) for (let page = 1; page <= 4; page += 1) {
    try { const html = await fetchText(`https://finance.naver.com/sise/sise_market_sum.naver?sosok=${sosok}&page=${page}`);
      for (const m of html.matchAll(/main\.naver\?code=(\d{6})/gu)) kr.add(m[1]); } catch (e) { process.stderr.write(`UNIVERSE_KR_FAILED:${sosok}:${page}:${e.message}\n`); }
    await sleep(300);
  }
  wide.KR_STOCK = [...kr];
  // US: Nasdaq screener, stratified sample of mid/small caps (rank 100…1700 by market cap, every 5th)
  let us = [];
  try {
    const json = await fetchJson('https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&download=true');
    const rows = (json?.data?.rows ?? []).filter((r) => /^[A-Z]{1,5}$/u.test(r.symbol) && Number(r.marketCap) >= 3e8).sort((a, b) => Number(b.marketCap) - Number(a.marketCap));
    us = rows.slice(100, 1700).filter((_, k) => k % 5 === 0).map((r) => r.symbol);
  } catch (e) { process.stderr.write(`UNIVERSE_US_SCREENER_FAILED:${e.message}\n`); }
  if (us.length < 100) us = [...new Set([...us, ...US_WIDE_FALLBACK_V1])];
  wide.US_STOCK = [...new Set([...STRATEGY_ZOO_UNIVERSE_V1.US_STOCK, ...us])];
  // Upbit: every KRW market
  try { const all = await fetchJson('https://api.upbit.com/v1/market/all?isDetails=false');
    wide.CRYPTO_SPOT = [...new Set([...STRATEGY_ZOO_UNIVERSE_V1.CRYPTO_SPOT, ...all.map((x) => x.market).filter((m) => m.startsWith('KRW-'))])];
  } catch (e) { process.stderr.write(`UNIVERSE_UPBIT_FAILED:${e.message}\n`); wide.CRYPTO_SPOT = [...STRATEGY_ZOO_UNIVERSE_V1.CRYPTO_SPOT]; }
  // Bitget: top 60 USDT perpetuals by 24h quote volume
  try { const json = await fetchJson('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES');
    const top = (json?.data ?? []).filter((x) => /USDT$/u.test(x.symbol)).sort((a, b) => Number(b.usdtVolume ?? b.quoteVolume ?? 0) - Number(a.usdtVolume ?? a.quoteVolume ?? 0)).slice(0, 60).map((x) => x.symbol);
    wide.CRYPTO_FUTURES = [...new Set([...STRATEGY_ZOO_UNIVERSE_V1.CRYPTO_FUTURES, ...top])];
  } catch (e) { process.stderr.write(`UNIVERSE_BITGET_FAILED:${e.message}\n`); wide.CRYPTO_FUTURES = [...STRATEGY_ZOO_UNIVERSE_V1.CRYPTO_FUTURES]; }
  wide.US_TAA = [...STRATEGY_ZOO_UNIVERSE_V1.US_TAA];
  for (const [m, xs] of Object.entries(wide)) process.stderr.write(`UNIVERSE_WIDE:${m}:${xs.length}\n`);
  return wide;
}

async function fetchJson(url, attempt = 0) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 research' }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 429 && attempt < 4) { await sleep(1_500 * (attempt + 1)); return fetchJson(url, attempt + 1); }
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return res.json();
}

/** Yahoo daily, scaled to adjusted close (dividends + splits). */
async function fetchYahoo(market, symbol) {
  const candidates = market === 'KR_STOCK' ? [`${symbol}.KS`, `${symbol}.KQ`] : [symbol];
  for (const y of candidates) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?period1=${Math.floor(STOCK_START / 1000)}&period2=${Math.floor(END / 1000)}&interval=1d&events=div%2Csplit&includeAdjustedClose=true`;
      const json = await fetchJson(url);
      const r = json?.chart?.result?.[0]; const q = r?.indicators?.quote?.[0]; const adj = r?.indicators?.adjclose?.[0]?.adjclose;
      if (!r?.timestamp?.length || !q) continue;
      const out = [];
      r.timestamp.forEach((ts, i) => {
        const o = q.open?.[i]; const h = q.high?.[i]; const l = q.low?.[i]; const c = q.close?.[i]; const v = q.volume?.[i]; const a = adj?.[i];
        if (![o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) return;
        const f = Number.isFinite(a) && a > 0 ? a / c : 1;
        out.push({ timestamp: ts * 1000, open: o * f, high: Math.max(o, h, c) * f, low: Math.min(o, l, c) * f, close: c * f, volume: Number.isFinite(v) ? v : 0 });
      });
      if (out.length > 250) return out;
    } catch { /* next candidate */ }
  }
  throw new Error('YAHOO_NO_DATA');
}

async function fetchUpbitDaily(market) {
  const byTs = new Map(); let to = new Date(END).toISOString().replace(/\.\d{3}Z$/u, 'Z');
  for (let page = 0; page < 20; page += 1) {
    const rows = await fetchJson(`https://api.upbit.com/v1/candles/days?market=${market}&count=200&to=${encodeURIComponent(to)}`);
    if (!Array.isArray(rows) || !rows.length) break;
    let oldest = Infinity;
    for (const x of rows) {
      const ts = Date.parse(`${x.candle_date_time_utc}Z`);
      if (!Number.isFinite(ts)) continue; oldest = Math.min(oldest, ts);
      if (ts < CRYPTO_START || ts > END) continue;
      byTs.set(ts, { timestamp: ts, open: x.opening_price, high: x.high_price, low: x.low_price, close: x.trade_price, volume: x.candle_acc_trade_volume });
    }
    if (oldest <= CRYPTO_START || rows.length < 200) break;
    to = new Date(oldest - 1000).toISOString().replace(/\.\d{3}Z$/u, 'Z');
    await sleep(150);
  }
  return [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** Binance USDⓈ-M monthly funding archive → [{timestamp, rate}] (proxy for Bitget). */
async function fetchBinanceVisionFunding(symbol) {
  const { execFileSync } = await import('node:child_process');
  const { mkdtemp, rm, writeFile: write } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'funding-'));
  const rows = [];
  try {
    for (let y = 2019; y <= 2025; y += 1) {
      for (let m = 1; m <= 12; m += 1) {
        const mm = String(m).padStart(2, '0');
        const url = `https://data.binance.vision/data/futures/um/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${y}-${mm}.zip`;
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
          if (!res.ok) continue;
          const file = join(dir, `${y}${mm}.zip`);
          await write(file, Buffer.from(await res.arrayBuffer()));
          const csv = execFileSync('unzip', ['-p', file], { encoding: 'utf8' });
          for (const line of csv.split(/\r?\n/u)) {
            const [t, , rate] = line.split(',');
            const ts = Number(t); const r = Number(rate);
            if (Number.isSafeInteger(ts) && Number.isFinite(r)) rows.push({ timestamp: ts, rate: r });
          }
        } catch { /* missing month */ }
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
  process.stderr.write(`FUNDING_BINANCE_VISION:${symbol}:${rows.length}\n`);
  return rows.sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchAll(root) {
  const data = {};
  const bitget = new BitgetPublicClient({ fetchImpl: globalThis.fetch });
  const wide = await resolveWideUniverse();
  for (const [market, symbols] of Object.entries(wide)) {
    data[market] = [];
    for (const symbol of symbols) {
      try {
        let candles; let fundingRates = [];
        if (market === 'CRYPTO_SPOT') candles = await fetchUpbitDaily(symbol);
        else if (market === 'CRYPTO_FUTURES') {
          // Bitget serves only ~90 daily bars; 4h history goes back years → aggregate full UTC days (6 bars)
          const h4 = (await collectBitgetCandles({ client: bitget, market, symbol, timeframe: '4h', startTime: Date.UTC(2019, 0, 1), endTime: END, maxCandles: 16_000, productType: 'usdt-futures' })).candles;
          const days = new Map();
          for (const c of h4) { const k = Math.floor(c.timestamp / 86_400_000) * 86_400_000; if (!days.has(k)) days.set(k, []); days.get(k).push(c); }
          candles = [...days.entries()].filter(([, rows]) => rows.length === 6).sort((x, y) => x[0] - y[0]).map(([k, rows]) => {
            rows.sort((x, y) => x.timestamp - y.timestamp);
            return { timestamp: k, open: rows[0].open, high: Math.max(...rows.map((x) => x.high)), low: Math.min(...rows.map((x) => x.low)), close: rows.at(-1).close, volume: rows.reduce((t, x) => t + x.volume, 0) };
          });
          // Bitget funding history directly (newest → oldest pages). The shared helper falls
          // back to a Binance proxy when the page cap is hit, and Binance is geo-blocked here.
          // Bitget keeps only ~1 year of funding; Binance's public archive (data.binance.vision)
          // has monthly files since 2019 and serves as the funding proxy (venues track closely).
          fundingRates = await fetchBinanceVisionFunding(symbol);
          try {
            const history = await collectFundingRateHistory({ client: bitget, symbol, startTime: Date.UTC(2024, 0, 1), endTime: END, maxPages: 200 });
            const own = history.records.map((x) => ({ timestamp: x.timestamp, rate: x.rate })).filter((x) => Number.isSafeInteger(x.timestamp) && Number.isFinite(x.rate));
            if (own.length) { const from = Math.min(...own.map((x) => x.timestamp)); fundingRates = [...fundingRates.filter((x) => x.timestamp < from), ...own]; }
          } catch (error) { process.stderr.write(`FUNDING_BITGET_UNAVAILABLE:${symbol}:${String(error?.message ?? error).slice(0, 80)}\n`); }
          const firstCandle = candles[0]?.timestamp ?? 0;
          const covered = fundingRates.length ? Math.min(...fundingRates.map((x) => x.timestamp)) : null;
          if (covered === null || covered > firstCandle + (30 * 86_400_000)) {
            // never backtest a perpetual on days without funding: trim candles to the funding span
            candles = covered === null ? [] : candles.filter((c) => c.timestamp >= covered);
            process.stderr.write(`FUNDING_TRIMMED:${symbol}:from=${covered ? new Date(covered).toISOString().slice(0, 10) : 'none'}\n`);
          }
        } else candles = await fetchYahoo(market, symbol);
        if (candles.length < 300) throw new Error(`SHORT_HISTORY_${candles.length}`);
        data[market].push({ symbol, candles, fundingRates });
        process.stderr.write(`FETCHED:${market}:${symbol}:${candles.length}:funding=${fundingRates.length}\n`);
      } catch (error) {
        process.stderr.write(`FETCH_FAILED:${market}:${symbol}:${String(error?.message ?? error).slice(0, 120)}\n`);
      }
      await sleep(market.startsWith('CRYPTO') ? 120 : 250);
    }
  }
  // no dataset cache: the wide universe is too large for one JSON string
  return data;
}

const args = process.argv.slice(2);
if (args[0] !== '--fetch') { process.stderr.write('usage: --fetch <dir>\n'); process.exit(2); }
const root = resolve(args[1] ?? 'strategy-zoo-state');
await mkdir(join(root, 'latest'), { recursive: true });
const data = await fetchAll(root);
const results = [];
for (const market of ['KR_STOCK', 'US_STOCK', 'US_TAA', 'CRYPTO_SPOT', 'CRYPTO_FUTURES']) {
  const all = data[market] ?? [];
  const core = new Set(STRATEGY_ZOO_UNIVERSE_V1[market]);
  const coreSets = all.filter((d) => core.has(d.symbol));
  results.push(coreSets.length ? evaluateStrategyZooMarketV1({ market, datasets: coreSets }) : { market, label: market, rows: [] });
  if (market !== 'US_TAA' && all.length > coreSets.length) {
    // wide universe: keep the market index first so index filters still find it
    results.push(evaluateStrategyZooMarketV1({ market, datasets: all, universe: 'WIDE' }));
  }
  process.stderr.write(`EVALUATED:${market}:core=${coreSets.length}:wide=${all.length}\n`);
}
process.stdout.write(`${formatStrategyZooReportKoV1(results)}\n`);
await writeFile(join(root, 'latest', 'strategy-zoo-v1.json'), `${JSON.stringify({ contract: 'strategy-zoo/v1', observedAt: new Date().toISOString(),
  markets: results.map((m) => ({ ...m, rows: m.rows.map((r) => ({ ...r })) })), executionAuthority: 'NONE', liveTrading: false })}\n`);
