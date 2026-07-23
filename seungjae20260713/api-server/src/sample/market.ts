// Market data sample generator: a deterministic price history per ticker that
// drives the quote, the candlestick charts (all timeframes) and 52-week range.
// API-ready: a real MarketDataService can return the same Quote/Candle shapes.
import { getCatalogEntry, type CatalogEntry } from '../data/catalog';
import { seeded, rangeFloat, qualityScore, anchorDate, ANCHOR_MS, type Rng } from './rng';
import type { Candle, Quote, Timeframe } from './types';

function basePrice(entry: CatalogEntry): number {
  const r = seeded(entry.ticker, 'price');
  if (entry.market === 'KR') return Math.round((rangeFloat(r, 5000, 280000) / 10)) * 10;
  return Math.round(rangeFloat(r, 8, 460) * 100) / 100;
}

function shares(entry: CatalogEntry): number {
  const r = seeded(entry.ticker, 'shares');
  // KR names carry more (won-denominated) shares outstanding.
  return entry.market === 'KR'
    ? Math.round(rangeFloat(r, 1e8, 6e9))
    : Math.round(rangeFloat(r, 4e7, 3e9));
}

function fmtDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function tradingDays(n: number, end: Date): string[] {
  const out: string[] = [];
  const d = new Date(end);
  while (out.length < n) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.unshift(fmtDay(d));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

function walk(rng: Rng, start: number, times: (string | number)[], vol: number, drift: number): Candle[] {
  let price = start;
  const bars: Candle[] = [];
  for (const time of times) {
    const open = price;
    const change = (rng() - 0.5) * 2 * vol + drift;
    let close = open * (1 + change);
    if (close < 0.5) close = 0.5;
    const hi = Math.max(open, close) * (1 + rng() * vol * 0.6);
    const lo = Math.min(open, close) * (1 - rng() * vol * 0.6);
    const volume = Math.round(rangeFloat(rng, 0.4, 2.4) * 1_000_000);
    bars.push({ time, open: r2(open), high: r2(hi), low: r2(lo), close: r2(close), volume });
    price = close;
  }
  return bars;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

const DAILY_COUNT = 400;

export function dailySeries(entry: CatalogEntry): Candle[] {
  const rng = seeded(entry.ticker, 'daily');
  const vol = rangeFloat(rng, 0.012, 0.032);
  const drift = ((qualityScore(entry.ticker) - 50) / 50) * 0.0007;
  const days = tradingDays(DAILY_COUNT, anchorDate());
  // start below current so the series ends near basePrice
  const start = basePrice(entry) / (1 + drift * DAILY_COUNT);
  return walk(rng, Math.max(start, 1), days, vol, drift);
}

function aggregate(daily: Candle[], keyOf: (d: string) => string): Candle[] {
  const groups = new Map<string, Candle[]>();
  const order: string[] = [];
  for (const c of daily) {
    const key = keyOf(String(c.time));
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(c);
  }
  return order.map((key) => {
    const g = groups.get(key)!;
    return {
      time: g[g.length - 1].time,
      open: g[0].open,
      high: Math.max(...g.map((c) => c.high)),
      low: Math.min(...g.map((c) => c.low)),
      close: g[g.length - 1].close,
      volume: g.reduce((s, c) => s + c.volume, 0),
    };
  });
}

function isoWeekKey(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return fmtDay(d);
}

function intradaySeries(entry: CatalogEntry, tf: Timeframe): Candle[] {
  const stepMin: Record<string, number> = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '60m': 60 };
  const step = stepMin[tf] ?? 5;
  const count = 200;
  const rng = seeded(entry.ticker, 'intraday', tf);
  const daily = dailySeries(entry);
  const last = daily[daily.length - 1].close;
  const now = Math.floor(ANCHOR_MS / 1000);
  const stepSec = step * 60;
  const times: number[] = [];
  for (let i = count - 1; i >= 0; i--) times.push(now - i * stepSec);
  const vol = 0.004 + step / 60 * 0.004;
  const start = last * (1 - rangeFloat(rng, -0.01, 0.01));
  return walk(rng, start, times, vol, 0);
}

export function getCandles(ticker: string, tf: Timeframe): Candle[] {
  const entry = getCatalogEntry(ticker);
  if (!entry) return [];
  if (tf === '1D') return dailySeries(entry).slice(-260);
  if (tf === '1W') return aggregate(dailySeries(entry), isoWeekKey).slice(-120);
  if (tf === '1M') return aggregate(dailySeries(entry), (d) => d.slice(0, 7)).slice(-60);
  return intradaySeries(entry, tf);
}

export function getQuote(ticker: string): Quote | null {
  const entry = getCatalogEntry(ticker);
  if (!entry) return null;
  const daily = dailySeries(entry);
  const last = daily[daily.length - 1];
  const prev = daily[daily.length - 2];
  const price = last.close;
  const changeAmount = r2(last.close - prev.close);
  const changePercent = r2((changeAmount / prev.close) * 100);
  const window = daily.slice(-252);
  return {
    price,
    changeAmount,
    changePercent,
    volume: last.volume,
    marketCap: Math.round(price * shares(entry)),
    week52High: r2(Math.max(...window.map((c) => c.high))),
    week52Low: r2(Math.min(...window.map((c) => c.low))),
  };
}

export { basePrice, shares };
