// Public kline fetchers shared by research backtests (no keys, read-only GETs).
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const UPBIT_TOP_DEFAULT = 60;
/** Liquid USDⓈ-M perpetuals also listed on Bitget. */
export const INTRADAY_PERP_SYMBOLS_V1 = Object.freeze(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT', 'DOTUSDT',
  'LTCUSDT', 'BCHUSDT', 'TRXUSDT', 'ATOMUSDT', 'NEARUSDT', 'APTUSDT', 'ARBUSDT', 'OPUSDT', 'SUIUSDT', 'FILUSDT', 'UNIUSDT', 'AAVEUSDT', 'INJUSDT',
  'TIAUSDT', 'WLDUSDT', '1000PEPEUSDT']);

export const KLINE_END = Date.UTC(2026, 0, 1);
const END = KLINE_END;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson(url, attempt = 0) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 research' }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 429 && attempt < 6) { await sleep(1_000 * (attempt + 1)); return fetchJson(url, attempt + 1); }
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return res.json();
}

export async function binanceKlines(symbol, interval, fromYear, fromMonth = 1) {
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

export async function upbitHourly(market, start) {
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

export async function upbitTopMarkets(top = UPBIT_TOP_DEFAULT) {
  const all = (await fetchJson('https://api.upbit.com/v1/market/all?isDetails=false')).map((x) => x.market).filter((m) => m.startsWith('KRW-'));
  const tick = [];
  for (let k = 0; k < all.length; k += 50) { tick.push(...await fetchJson(`https://api.upbit.com/v1/ticker?markets=${all.slice(k, k + 50).join(',')}`)); await sleep(150); }
  return tick.sort((a, b) => Number(b.acc_trade_price_24h) - Number(a.acc_trade_price_24h)).slice(0, top).map((x) => x.market);
}

/** Binance USDⓈ-M monthly funding archive → [{timestamp, rate}] sorted. */
export async function binanceFunding(symbol, fromYear) {
  const dir = await mkdtemp(join(tmpdir(), 'funding-'));
  const rows = [];
  try {
    for (let y = fromYear; y <= 2025; y += 1) {
      for (let m = 1; m <= 12; m += 1) {
        const mm = String(m).padStart(2, '0');
        try {
          const res = await fetch(`https://data.binance.vision/data/futures/um/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${y}-${mm}.zip`, { signal: AbortSignal.timeout(30_000) });
          if (!res.ok) continue;
          const file = join(dir, `${y}${mm}.zip`); await writeFile(file, Buffer.from(await res.arrayBuffer()));
          for (const line of execFileSync('unzip', ['-p', file], { encoding: 'utf8' }).split(/\r?\n/u)) {
            const [t, , rate] = line.split(','); const ts = Number(t); const r = Number(rate);
            if (Number.isSafeInteger(ts) && Number.isFinite(r)) rows.push({ timestamp: ts, rate: r });
          }
        } catch { /* missing month */ }
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
  return rows.sort((x, y) => x.timestamp - y.timestamp);
}
