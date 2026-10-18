#!/usr/bin/env node
// Intraday scalp / pump-catching backtest (Korean report). Research only, public data only.
//   node research-production/bin/intraday-scalp-backtest.mjs --out <dir>
// Data (all before 2026):
//   perpetual 5m 2023–2025 and 1h 2021–2025: Binance USDⓈ-M public kline archive
//     (data.binance.vision) as the price proxy for Bitget perps (same coins, arbitraged within bps)
//   Upbit KRW spot 1h 2022–2025: Upbit public minute-candle API, top KRW markets by traded value
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createIntradayAccumulatorV1, formatIntradayReportKoV1 } from '../src/intraday-scalp-zoo-v1.mjs';

export const INTRADAY_PERP_SYMBOLS_V1 = Object.freeze(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT', 'DOTUSDT',
  'LTCUSDT', 'BCHUSDT', 'TRXUSDT', 'ATOMUSDT', 'NEARUSDT', 'APTUSDT', 'ARBUSDT', 'OPUSDT', 'SUIUSDT', 'FILUSDT', 'UNIUSDT', 'AAVEUSDT', 'INJUSDT',
  'TIAUSDT', 'WLDUSDT', '1000PEPEUSDT']);
const UPBIT_TOP = 60;
const END = Date.UTC(2026, 0, 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, attempt = 0) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 research' }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 429 && attempt < 6) { await sleep(1_000 * (attempt + 1)); return fetchJson(url, attempt + 1); }
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return res.json();
}

async function binanceKlines(symbol, interval, fromYear, fromMonth = 1) {
  const dir = await mkdtemp(join(tmpdir(), 'klines-'));
  const bars = [];
  try {
    for (let y = fromYear; y <= 2025; y += 1) {
      for (let m = (y === fromYear ? fromMonth : 1); m <= 12; m += 1) {
        const mm = String(m).padStart(2, '0');
        const url = `https://data.binance.vision/data/futures/um/monthly/klines/${symbol}/${interval}/${symbol}-${interval}-${y}-${mm}.zip`;
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
          if (!res.ok) continue;
          const file = join(dir, `${y}${mm}.zip`);
          await writeFile(file, Buffer.from(await res.arrayBuffer()));
          const csv = execFileSync('unzip', ['-p', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
          for (const line of csv.split(/\r?\n/u)) {
            const f = line.split(','); let ts = Number(f[0]); if (!Number.isFinite(ts)) continue; if (ts > 1e14) ts = Math.floor(ts / 1000);
            const o = Number(f[1]); const h = Number(f[2]); const l = Number(f[3]); const c = Number(f[4]); const v = Number(f[5]);
            if ([o, h, l, c].every((x) => x > 0)) bars.push({ timestamp: ts, open: o, high: Math.max(o, h, c), low: Math.min(o, l, c), close: c, volume: Number.isFinite(v) ? v : 0 });
          }
          await rm(file, { force: true });
        } catch { /* missing month */ }
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
  bars.sort((a, b) => a.timestamp - b.timestamp);
  return bars.filter((b, i) => i === 0 || b.timestamp !== bars[i - 1].timestamp);
}

async function upbitHourly(market, start) {
  const byTs = new Map(); let to = new Date(END - 1000).toISOString().replace(/\.\d{3}Z$/u, 'Z'); let reachedListing = false;
  for (let page = 0; page < 400; page += 1) {
    const rows = await fetchJson(`https://api.upbit.com/v1/candles/minutes/60?market=${market}&count=200&to=${encodeURIComponent(to)}`);
    if (!Array.isArray(rows) || !rows.length) { reachedListing = true; break; }
    let oldest = Infinity;
    for (const x of rows) {
      const ts = Date.parse(`${x.candle_date_time_utc}Z`); if (!Number.isFinite(ts)) continue; oldest = Math.min(oldest, ts);
      if (ts < start || ts >= END) continue;
      byTs.set(ts, { timestamp: ts, open: x.opening_price, high: x.high_price, low: x.low_price, close: x.trade_price, volume: x.candle_acc_trade_volume });
    }
    if (rows.length < 200) { reachedListing = true; break; }
    if (oldest <= start) break;
    to = new Date(oldest - 1000).toISOString().replace(/\.\d{3}Z$/u, 'Z');
    await sleep(110);
  }
  const bars = [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
  // listed inside the window only if the history ran out after the window start (Upbit has no earlier candles)
  return { bars, listedInWindow: reachedListing && bars.length > 0 && bars[0].timestamp > start + (7 * 86_400_000) };
}

async function upbitTopMarkets() {
  const all = (await fetchJson('https://api.upbit.com/v1/market/all?isDetails=false')).map((x) => x.market).filter((m) => m.startsWith('KRW-'));
  const tick = [];
  for (let k = 0; k < all.length; k += 50) { tick.push(...await fetchJson(`https://api.upbit.com/v1/ticker?markets=${all.slice(k, k + 50).join(',')}`)); await sleep(150); }
  return tick.sort((a, b) => Number(b.acc_trade_price_24h) - Number(a.acc_trade_price_24h)).slice(0, UPBIT_TOP).map((x) => x.market);
}

const args = process.argv.slice(2);
if (args[0] !== '--out') { process.stderr.write('usage: --out <dir>\n'); process.exit(2); }
const root = resolve(args[1] ?? 'intraday-state');
await mkdir(root, { recursive: true });
const only = (process.env.INTRADAY_VENUES ?? '').split(',').filter(Boolean);
const want = (v) => !only.length || only.includes(v);
const results = [];

const PLAN = [
  { venue: 'BITGET_5M', interval: '5m', fromYear: 2023, from: Date.UTC(2023, 0, 1) },
  { venue: 'BITGET_1H', interval: '1h', fromYear: 2021, from: Date.UTC(2021, 0, 1) },
];
for (const p of PLAN) {
  if (!want(p.venue)) continue;
  const acc = createIntradayAccumulatorV1(p.venue);
  for (const symbol of INTRADAY_PERP_SYMBOLS_V1) {
    try {
      const candles = await binanceKlines(symbol, p.interval, p.fromYear);
      if (candles.length < 2000) throw new Error(`SHORT_HISTORY_${candles.length}`);
      acc.add({ symbol, candles });
      process.stderr.write(`FETCHED:${p.venue}:${symbol}:${candles.length}\n`);
    } catch (e) { process.stderr.write(`FETCH_FAILED:${p.venue}:${symbol}:${String(e?.message ?? e).slice(0, 100)}\n`); }
  }
  const span = { from: p.from, to: END };
  results.push(acc.finish({ span, splitTime: span.from + ((span.to - span.from) * 0.6) }));
}

if (want('UPBIT_1H')) {
  const from = Date.UTC(2022, 0, 1); const acc = createIntradayAccumulatorV1('UPBIT_1H');
  let markets = [];
  try { markets = await upbitTopMarkets(); } catch (e) { process.stderr.write(`UPBIT_TOP_FAILED:${e.message}\n`); }
  for (const market of markets) {
    try {
      const { bars, listedInWindow } = await upbitHourly(market, from);
      if (bars.length < 500) throw new Error(`SHORT_HISTORY_${bars.length}`);
      acc.add({ symbol: market, candles: bars, listedInWindow });
      process.stderr.write(`FETCHED:UPBIT_1H:${market}:${bars.length}:listed=${listedInWindow}\n`);
    } catch (e) { process.stderr.write(`FETCH_FAILED:UPBIT_1H:${market}:${String(e?.message ?? e).slice(0, 100)}\n`); }
  }
  const span = { from, to: END };
  results.push(acc.finish({ span, splitTime: span.from + ((span.to - span.from) * 0.6) }));
}

process.stdout.write(`${formatIntradayReportKoV1(results)}\n`);
await writeFile(join(root, 'intraday-scalp-v1.json'), `${JSON.stringify({ contract: 'intraday-scalp-zoo/v1', observedAt: new Date().toISOString(), venues: results, executionAuthority: 'NONE', liveTrading: false })}\n`);
