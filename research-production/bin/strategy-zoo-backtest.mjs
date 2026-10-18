#!/usr/bin/env node
// Strategy zoo backtest (Korean report). Research only, public data only.
//   node research-production/bin/strategy-zoo-backtest.mjs --fetch <dir>
// Data (all before 2026; the final holdout is never read):
//   KR/US stocks + US ETFs: Yahoo daily 2005–2025, dividend/split adjusted (adjclose)
//   Upbit KRW spot: daily since listing (Upbit days endpoint)
//   Bitget USDT perpetuals: daily since listing + funding history
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { BitgetPublicClient } from '../../market-prediction-lab/src/bitget-public-client.js';
import { collectBitgetCandles } from '../../market-prediction-lab/src/bitget-candle-collector.js';
import { fetchCombinationFundingRatesV1 } from '../src/combination-search-lane-v1.mjs';
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

async function fetchAll(root) {
  const cache = join(root, 'strategy-zoo-datasets.json');
  try { return JSON.parse(await readFile(cache, 'utf8')); } catch { /* fetch */ }
  const data = {};
  const bitget = new BitgetPublicClient({ fetchImpl: globalThis.fetch });
  for (const [market, symbols] of Object.entries(STRATEGY_ZOO_UNIVERSE_V1)) {
    data[market] = [];
    for (const symbol of symbols) {
      try {
        let candles; let fundingRates = [];
        if (market === 'CRYPTO_SPOT') candles = await fetchUpbitDaily(symbol);
        else if (market === 'CRYPTO_FUTURES') {
          candles = (await collectBitgetCandles({ client: bitget, market, symbol, timeframe: '1d', startTime: Date.UTC(2019, 0, 1), endTime: END, maxCandles: 4_000, productType: 'usdt-futures' })).candles
            .map((c) => ({ timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
          try { fundingRates = (await fetchCombinationFundingRatesV1({ source: 'BITGET_1H', symbol, startTime: Date.UTC(2019, 0, 1), endTime: END, fetchImpl: globalThis.fetch, minimumRecords: 0 })).rows; }
          catch (error) { process.stderr.write(`FUNDING_UNAVAILABLE:${symbol}:${String(error?.message ?? error).slice(0, 80)}\n`); }
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
  await writeFile(cache, JSON.stringify(data));
  return data;
}

const args = process.argv.slice(2);
if (args[0] !== '--fetch') { process.stderr.write('usage: --fetch <dir>\n'); process.exit(2); }
const root = resolve(args[1] ?? 'strategy-zoo-state');
await mkdir(join(root, 'latest'), { recursive: true });
const data = await fetchAll(root);
const results = [];
for (const market of ['KR_STOCK', 'US_STOCK', 'US_TAA', 'CRYPTO_SPOT', 'CRYPTO_FUTURES']) {
  const datasets = data[market] ?? [];
  results.push(datasets.length ? evaluateStrategyZooMarketV1({ market, datasets }) : { market, label: market, rows: [] });
}
process.stdout.write(`${formatStrategyZooReportKoV1(results)}\n`);
await writeFile(join(root, 'latest', 'strategy-zoo-v1.json'), `${JSON.stringify({ contract: 'strategy-zoo/v1', observedAt: new Date().toISOString(),
  markets: results.map((m) => ({ ...m, rows: m.rows.map((r) => ({ ...r })) })), executionAuthority: 'NONE', liveTrading: false })}\n`);
