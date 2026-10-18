// Trend pilot v1 — runtime adapters: public market data, live equity from a
// read-only account snapshot, and the per-member ledger file. No orders here.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CanonicalAccountSnapshot } from '../features/account-readonly/account-readonly.contract';
import { getFuturesContractRules } from './futures-contract-rules.service';
import { getFuturesCandles, getFuturesMarketSnapshot } from './futures-market-data.service';
import {
  TREND_PILOT_V1,
  parseTrendPilotLedger,
  selectClosedBars,
  type TrendPilotCandle,
  type TrendPilotContractRules,
  type TrendPilotLedger,
} from './trend-pilot-v1.core';
import type { TrendPilotAccount, TrendPilotQuote, TrendPilotVenue } from './trend-pilot-v1-lane.service';

const UPBIT_BASE_URL = 'https://api.upbit.com';
const FETCH_TIMEOUT_MS = 8_000;
const BAR_COUNT = 300;
export const TREND_PILOT_DEFAULT_STATE_DIR = '/opt/stock-app-data/trend-pilot-v1';

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function num(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function upbitMarket(symbol: string): string {
  const clean = symbol.trim().toUpperCase().replace(/^KRW-/u, '');
  if (!/^[A-Z0-9]{1,20}$/u.test(clean)) throw new Error('TREND_PILOT_UPBIT_SYMBOL_INVALID');
  return `KRW-${clean}`;
}

async function fetchJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`TREND_PILOT_PUBLIC_HTTP_${response.status}`);
  return response.json();
}

// ---------------------------------------------------------------- Bitget

export async function readBitgetTrendPilotBars(symbol: string, nowMs: number): Promise<TrendPilotCandle[]> {
  const result = await getFuturesCandles({ symbol, timeframe: '4H', limit: BAR_COUNT });
  if (result.status === 'cached' || result.status === 'error' || result.status === 'disconnected') {
    throw new Error('TREND_PILOT_BARS_NOT_LIVE');
  }
  return selectClosedBars(result.data.map((c) => ({ timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })), nowMs);
}

export async function readBitgetTrendPilotQuote(symbol: string, nowMs: number): Promise<TrendPilotQuote> {
  const [snapshot, minutes] = await Promise.all([
    getFuturesMarketSnapshot(symbol),
    getFuturesCandles({ symbol, timeframe: '1m', limit: 3 }),
  ]);
  if (snapshot.isDelayed || !positive(snapshot.bidPrice) || !positive(snapshot.askPrice)) throw new Error('TREND_PILOT_QUOTE_NOT_LIVE');
  const observedAtMs = Date.parse(snapshot.updatedAt);
  const rows = minutes.data.filter((c) => c.timestamp + 60_000 <= nowMs);
  const last = rows.at(-1);
  const prev = rows.at(-2);
  const move = last && prev && prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : null;
  if (move === null) throw new Error('TREND_PILOT_ONE_MINUTE_MOVE_UNAVAILABLE');
  const mid = (snapshot.bidPrice + snapshot.askPrice) / 2;
  return {
    bid: snapshot.bidPrice,
    ask: snapshot.askPrice,
    last: positive(snapshot.price) ? snapshot.price : mid,
    observedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : 0,
    oneMinuteMovePercent: move,
    // Only top-of-book is public here; the spread is the conservative gap proxy.
    orderbookGapPercent: ((snapshot.askPrice - snapshot.bidPrice) / mid) * 100,
    source: `bitget-public:${snapshot.source}`,
  };
}

export async function readBitgetTrendPilotContractRules(symbol: string): Promise<TrendPilotContractRules> {
  const rules = await getFuturesContractRules(symbol);
  if (!positive(rules.quantityStep) || !positive(rules.minimumQuantity) || !positive(rules.priceStep) || !(num(rules.minimumNotional) !== null)) {
    throw new Error('TREND_PILOT_CONTRACT_RULES_INCOMPLETE');
  }
  if (positive(rules.maximumLeverage) && rules.maximumLeverage < TREND_PILOT_V1.leverage) throw new Error('TREND_PILOT_CONTRACT_LEVERAGE_BELOW_5X');
  return { minTradeNum: rules.minimumQuantity, sizeStep: rules.quantityStep, minTradeUsdt: Number(rules.minimumNotional), priceStep: rules.priceStep };
}

// ---------------------------------------------------------------- Upbit

type UpbitCandleRow = { candle_date_time_utc?: string; opening_price?: number; high_price?: number; low_price?: number; trade_price?: number; candle_acc_trade_volume?: number };

function parseUpbitCandles(rows: unknown): TrendPilotCandle[] {
  if (!Array.isArray(rows)) throw new Error('TREND_PILOT_UPBIT_CANDLES_INVALID');
  const out: TrendPilotCandle[] = [];
  for (const row of rows as UpbitCandleRow[]) {
    const ts = Date.parse(`${String(row?.candle_date_time_utc ?? '')}Z`);
    const open = num(row?.opening_price); const high = num(row?.high_price); const low = num(row?.low_price); const close = num(row?.trade_price);
    if (!Number.isFinite(ts) || open === null || high === null || low === null || close === null) continue;
    out.push({ timestamp: ts, open, high, low, close, volume: num(row?.candle_acc_trade_volume) ?? 0 });
  }
  return out;
}

export async function readUpbitTrendPilotBars(symbol: string, nowMs: number, fetchImpl: typeof fetch = fetch): Promise<TrendPilotCandle[]> {
  const market = upbitMarket(symbol);
  const first = parseUpbitCandles(await fetchJson(fetchImpl, `${UPBIT_BASE_URL}/v1/candles/minutes/240?market=${market}&count=200`));
  if (!first.length) throw new Error('TREND_PILOT_UPBIT_CANDLES_EMPTY');
  const oldest = Math.min(...first.map((c) => c.timestamp));
  const to = new Date(oldest).toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const second = parseUpbitCandles(await fetchJson(fetchImpl, `${UPBIT_BASE_URL}/v1/candles/minutes/240?market=${market}&count=200&to=${encodeURIComponent(to)}`));
  return selectClosedBars([...second, ...first], nowMs);
}

export async function readUpbitTrendPilotQuote(symbol: string, nowMs: number, fetchImpl: typeof fetch = fetch): Promise<TrendPilotQuote> {
  const market = upbitMarket(symbol);
  const [book, minutes] = await Promise.all([
    fetchJson(fetchImpl, `${UPBIT_BASE_URL}/v1/orderbook?markets=${market}`),
    fetchJson(fetchImpl, `${UPBIT_BASE_URL}/v1/candles/minutes/1?market=${market}&count=3`),
  ]);
  const entry = Array.isArray(book) ? book[0] as { timestamp?: number; orderbook_units?: Array<{ ask_price?: number; bid_price?: number }> } : null;
  const units = entry?.orderbook_units ?? [];
  const ask = num(units[0]?.ask_price); const bid = num(units[0]?.bid_price);
  const ask2 = num(units[1]?.ask_price); const bid2 = num(units[1]?.bid_price);
  if (!positive(ask) || !positive(bid) || ask < bid) throw new Error('TREND_PILOT_UPBIT_BOOK_INVALID');
  const gap = positive(ask2) && positive(bid2) ? Math.max((ask2 - ask) / ask, (bid - bid2) / bid) * 100 : ((ask - bid) / ((ask + bid) / 2)) * 100;
  const rows = parseUpbitCandles(minutes).filter((c) => c.timestamp + 60_000 <= nowMs).sort((a, b) => a.timestamp - b.timestamp);
  const last = rows.at(-1); const prev = rows.at(-2);
  // Upbit omits minutes without trades; no prior minute means no measurable move.
  const move = last && prev && prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : 0;
  return {
    bid, ask, last: (ask + bid) / 2,
    observedAtMs: positive(entry?.timestamp) ? entry!.timestamp! : 0,
    oneMinuteMovePercent: move,
    orderbookGapPercent: gap,
    source: 'upbit-public-orderbook',
  };
}

// ---------------------------------------------------------------- equity

/**
 * Pure: live equity from a read-only snapshot.
 * Bitget: USDT account equity (balances.total) × fx; available = USDT available × fx.
 * Upbit: KRW total + every coin holding at its mark; a non-dust holding without a
 * mark fails closed (an understated equity would fake a loss and trip the guards).
 */
export function trendPilotAccountFromSnapshot(
  venue: TrendPilotVenue,
  snapshot: CanonicalAccountSnapshot,
  krwPerQuote: number,
  marksKrw: ReadonlyMap<string, number> = new Map(),
): TrendPilotAccount {
  if (!snapshot.connected || snapshot.stale || snapshot.status !== 'CONNECTED') throw new Error('TREND_PILOT_ACCOUNT_NOT_FRESH');
  if (!positive(krwPerQuote)) throw new Error('TREND_PILOT_FX_INVALID');
  const observedAtMs = Date.parse(snapshot.checkedAt);
  if (!Number.isFinite(observedAtMs)) throw new Error('TREND_PILOT_ACCOUNT_TIMESTAMP_INVALID');
  const balances = snapshot.balances ?? [];
  if (venue === 'bitget') {
    const usdt = balances.find((row) => String(row.currency).toUpperCase() === 'USDT');
    if (!usdt || !positive(usdt.total) || usdt.available === null || !(usdt.available >= 0)) throw new Error('TREND_PILOT_BITGET_EQUITY_UNAVAILABLE');
    return { equityKrw: usdt.total * krwPerQuote, availableKrw: usdt.available * krwPerQuote, observedAtMs };
  }
  const krw = balances.find((row) => String(row.currency).toUpperCase() === 'KRW');
  if (!krw || krw.available === null || !(krw.available >= 0)) throw new Error('TREND_PILOT_UPBIT_KRW_UNAVAILABLE');
  let equity = Math.max(0, krw.total ?? krw.available);
  for (const row of balances) {
    const currency = String(row.currency).toUpperCase();
    if (currency === 'KRW') continue;
    const quantity = Number(row.total ?? 0);
    if (!(quantity > 0)) continue;
    const mark = marksKrw.get(currency);
    if (positive(mark)) { equity += quantity * mark; continue; }
    const position = (snapshot.positions ?? []).find((p) => String(p.symbol).toUpperCase().replace(/^KRW-/u, '') === currency);
    if (position && positive(position.marketValue)) { equity += position.marketValue; continue; }
    if (position && positive(position.currentPrice)) { equity += quantity * position.currentPrice; continue; }
    if (position && positive(position.averageEntryPrice) && quantity * position.averageEntryPrice < 5_000) continue; // dust
    throw new Error('TREND_PILOT_UPBIT_HOLDING_UNPRICED');
  }
  return { equityKrw: equity, availableKrw: krw.available, observedAtMs };
}

// ---------------------------------------------------------------- ledger file

export function trendPilotLedgerPath(dir: string, venue: TrendPilotVenue, userId: string): string {
  const id = createHash('sha256').update(userId).digest('hex').slice(0, 24);
  return join(dir, `${venue}-${id}.json`);
}

export function createTrendPilotLedgerStore(dir: string, venue: TrendPilotVenue, userId: string) {
  const path = trendPilotLedgerPath(dir, venue, userId);
  return {
    path,
    async load(): Promise<TrendPilotLedger | null> {
      let text: string;
      try { text = await readFile(path, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        throw new Error('TREND_PILOT_LEDGER_READ_FAILED');
      }
      let raw: unknown;
      try { raw = JSON.parse(text); } catch { raw = { version: 'corrupt' }; }
      return parseTrendPilotLedger(raw, userId);
    },
    async save(ledger: TrendPilotLedger): Promise<void> {
      if (ledger.memberId !== userId) throw new Error('TREND_PILOT_LEDGER_IDENTITY_MISMATCH');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, `${JSON.stringify(ledger)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(tmp, path);
    },
  };
}
