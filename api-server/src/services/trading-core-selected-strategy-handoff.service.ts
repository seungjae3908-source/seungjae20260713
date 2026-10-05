import { createHash } from 'node:crypto';
import {
  buildMemberAutoTradingPaperHandoff,
  validateMemberAutoTradingPaperHandoff,
  type MemberAutoTradingPaperHandoff,
} from '../../../market-prediction-lab/src/member-auto-trading-paper-handoff-v1.js';
import type { Candle } from '../sample/types';
import { MarketDataService } from './market-data.service';
import { StockSignalScannerService } from './stock-signal-scanner.service';
import { CryptoSignalScannerService } from './crypto-signal-scanner.service';
import type { ScannerSignalCard } from './scanner-signal.types';
import type { TradingPolicy } from './trade-automation.types';
import { resolveMemberAutoTradingKrwRate } from './member-auto-trading-fx.service';
import {
  isUserSelectedLiveStrategyId,
  type StrategyRulePackId,
} from './evidence-backed-auto-strategy-catalog.service';

type Market = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
type Direction = 'BUY' | 'LONG' | 'SHORT';

type StrategyObservation = Readonly<{
  strategyId: StrategyRulePackId;
  market: Market;
  symbol: string;
  direction: Direction;
  timeframe: string;
  observedAtMs: number;
  referencePrice: number;
  entryPrice: number;
  stopLoss: number;
  targets: readonly number[];
  bid: number;
  ask: number;
  stockExchange: string | null;
  leverage: number | null;
  marginMode: 'ISOLATED' | null;
  ruleEvidence: Readonly<Record<string, boolean | string | number>>;
  provenance: string;
  spreadPercent: number;
  quantityStep?: number | null;
  minQuantity?: number | null;
  maxQuantity?: number | null;
}>;

const MAX_AGE_MS = 30_000;
const COST_POLICY = 'trading-core-user-selected-operational-mirror-v1';
const STRATEGY_VERSION = 'TRADING_CORE_USER_SELECTED_LIVE_V1';
const STOCK_BATCH = 40;
const CRYPTO_BATCH = 24;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}
function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function average(values: readonly number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
function candleMs(value: Candle['time'] | number) {
  if (typeof value === 'number') return value < 10_000_000_000 ? value * 1_000 : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function ema(values: readonly number[], period: number) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let index = period; index < values.length; index += 1) value = values[index]! * k + value * (1 - k);
  return value;
}
function vwap(rows: readonly { high: number; low: number; close: number; volume: number }[]) {
  let numerator = 0;
  let denominator = 0;
  for (const row of rows) {
    if (!positive(row.volume)) continue;
    numerator += ((row.high + row.low + row.close) / 3) * row.volume;
    denominator += row.volume;
  }
  return denominator > 0 ? numerator / denominator : null;
}
function normalizedCandles(rows: readonly Candle[]) {
  return rows
    .map((row) => ({ ...row, at: candleMs(row.time) }))
    .filter((row): row is Candle & { at: number } => finite(row.at))
    .sort((left, right) => left.at - right.at);
}
function wallClock(at: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const by = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${by.year}-${by.month}-${by.day}`,
    minute: Number(by.hour) * 60 + Number(by.minute),
    weekday: String(by.weekday ?? ''),
  };
}
function latestSession(rows: ReturnType<typeof normalizedCandles>, timeZone: string, start: number, end: number) {
  const eligible = rows.filter((row) => {
    const wall = wallClock(row.at, timeZone);
    return wall.minute >= start && wall.minute < end;
  });
  if (!eligible.length) return [];
  const date = wallClock(eligible.at(-1)!.at, timeZone).date;
  return eligible.filter((row) => wallClock(row.at, timeZone).date === date);
}
function marketOpen(card: ScannerSignalCard) {
  return card.dataQuality?.issues?.some((issue) => issue.code === 'MARKET_CLOSED' || issue.code === 'TRADING_HALT') !== true
    && card.dataState === 'complete';
}
function stockTargets(card: ScannerSignalCard) {
  const stop = Number(card.pricePlan.stopLoss);
  const targets = card.pricePlan.targets.filter(positive);
  if (!positive(stop) || targets.length === 0 || !positive(card.price)) return null;
  if (stop >= card.price || targets.some((target) => target <= card.price)) return null;
  return { stop, targets };
}

function evaluateUsOrb(card: ScannerSignalCard, raw: readonly Candle[]): StrategyObservation | null {
  if (!marketOpen(card) || card.direction !== 'LONG' || card.price <= 5) return null;
  const exchange = String(card.exchange ?? '').toUpperCase();
  if (!['NASDAQ', 'NYSE', 'AMEX'].includes(exchange) || card.listingStatus !== 'LISTED') return null;
  const plan = stockTargets(card);
  if (!plan) return null;
  const rows = normalizedCandles(raw);
  const current = latestSession(rows, 'America/New_York', 9 * 60 + 30, 16 * 60);
  if (current.length < 5) return null;
  const first = current[0]!;
  const firstWall = wallClock(first.at, 'America/New_York');
  if (firstWall.minute !== 9 * 60 + 30) return null;

  const firstByDate = new Map<string, number>();
  for (const row of rows) {
    const wall = wallClock(row.at, 'America/New_York');
    if (wall.minute === 9 * 60 + 30 && wall.date !== firstWall.date && positive(row.volume)) {
      firstByDate.set(wall.date, row.volume);
    }
  }
  const baseline = [...firstByDate.values()].slice(-14);
  if (baseline.length < 5) return null;
  const baselineVolume = average(baseline);
  if (!positive(baselineVolume)) return null;
  const first5mRvol = first.volume / baselineVolume;
  const orHigh = first.high;
  const afterOpen = current.slice(1);
  const breakout = afterOpen.some((row) => row.high > orHigh && row.close >= orHigh);
  const currentVwap = vwap(current);
  if (!positive(currentVwap)) return null;
  const recent = current.slice(-4);
  const previous = recent.at(-2);
  const latest = recent.at(-1);
  if (!previous || !latest) return null;
  const anchor = Math.max(orHigh, currentVwap);
  const retest = recent.some((row) => row.low <= anchor * 1.003 && row.low >= anchor * 0.992 && row.close >= Math.min(orHigh, currentVwap));
  const higherLow = latest.low > previous.low;
  const priorVolume = average(current.slice(-7, -1).map((row) => row.volume));
  const volumeReacceleration = positive(priorVolume) && latest.volume > previous.volume && latest.volume > priorVolume;
  const microHigh = Math.max(...current.slice(-4, -1).map((row) => row.high));
  const microBreakout = latest.close > microHigh;
  const quant = card.quantScore;
  const trendReady = (quant?.trend ?? 0) >= 50 && (quant?.technical ?? 0) >= 50;

  const evidence = {
    strategyId: 'US_STOCKS_IN_PLAY_ORB_RETEST_V1',
    dataReady: true,
    formulaReady: trendReady,
    waveStructureReady: higherLow,
    indicatorReady: trendReady,
    entryTriggerReady: breakout && retest && microBreakout,
    liquidityReady: (card.tradingValue ?? 0) > 0,
    costEvidenceReady: true,
    riskReady: (card.riskScore ?? 101) <= 40,
    pitUniverseReady: true,
    first5mRvolReady: first5mRvol >= 1,
    openingRangeReady: breakout,
    retestReady: retest,
    microBreakoutReady: microBreakout && volumeReacceleration,
    first5mRvol,
  } as const;
  if (Object.entries(evidence).some(([key, value]) => key !== 'strategyId' && key !== 'first5mRvol' && value !== true)) return null;
  const observedAtMs = Date.parse(card.observedAt);
  if (!finite(observedAtMs)) return null;
  return {
    strategyId: 'US_STOCKS_IN_PLAY_ORB_RETEST_V1',
    market: 'US_STOCK',
    symbol: card.symbol,
    direction: 'BUY',
    timeframe: '5m',
    observedAtMs,
    referencePrice: card.price,
    entryPrice: card.price,
    stopLoss: plan.stop,
    targets: plan.targets,
    bid: card.price,
    ask: card.price,
    stockExchange: exchange,
    leverage: null,
    marginMode: null,
    ruleEvidence: evidence,
    provenance: 'stock-scanner+5m-session-orb-rvol+live-provider-recheck',
    spreadPercent: 0,
  };
}

function evaluateKrPressure(card: ScannerSignalCard, raw: readonly Candle[]): StrategyObservation | null {
  if (!marketOpen(card) || card.direction !== 'LONG') return null;
  const plan = stockTargets(card);
  if (!plan) return null;
  const rows = latestSession(normalizedCandles(raw), 'Asia/Seoul', 9 * 60, 15 * 60 + 30);
  if (rows.length < 65) return null;
  const latest = rows.at(-1)!;
  const closes = rows.map((row) => row.close);
  const ema20 = ema(closes, 20);
  const ema60 = ema(closes, 60);
  const currentVwap = vwap(rows);
  if (!positive(ema20) || !positive(ema60) || !positive(currentVwap)) return null;
  const prior20 = rows.slice(-21, -1);
  const high20 = Math.max(...prior20.map((row) => row.high));
  const nearHigh = (high20 - latest.close) / Math.max(latest.close, 1) <= 0.015;
  const values = rows.slice(-5).map((row) => row.close * row.volume);
  const valueSlope = values.length >= 4 && values.at(-1)! > values[0]!;
  const lows = rows.slice(-3).map((row) => row.low);
  const higherLows = lows.length === 3 && lows[2]! > lows[1]! && lows[1]! >= lows[0]!;
  const recentRange = average(rows.slice(-3).map((row) => row.high - row.low));
  const priorRange = average(rows.slice(-13, -3).map((row) => row.high - row.low));
  const compression = positive(recentRange) && positive(priorRange) && recentRange < priorRange * 0.8;
  const avgVolume = average(rows.slice(-21, -1).map((row) => row.volume));
  const volumeExpansion = positive(avgVolume) && latest.volume >= avgVolume * 1.3;
  const breakoutLevel = Math.max(...rows.slice(-6, -1).map((row) => row.high));
  const breakout = latest.close > breakoutLevel;
  const pressure = ema20 > ema60 && latest.close > currentVwap && nearHigh && valueSlope && higherLows;

  const evidence = {
    strategyId: 'KR_PRESSURE_BREAKOUT_V1',
    dataReady: true,
    formulaReady: true,
    waveStructureReady: higherLows,
    indicatorReady: ema20 > ema60 && latest.close > currentVwap,
    entryTriggerReady: breakout,
    liquidityReady: (card.tradingValue ?? 0) > 0,
    costEvidenceReady: true,
    riskReady: (card.riskScore ?? 101) <= 40,
    pressureReady: pressure,
    compressionReady: compression,
    volumeExpansionReady: volumeExpansion,
    breakoutReady: breakout,
  } as const;
  if (Object.entries(evidence).some(([key, value]) => key !== 'strategyId' && value !== true)) return null;
  const observedAtMs = Date.parse(card.observedAt);
  if (!finite(observedAtMs)) return null;
  return {
    strategyId: 'KR_PRESSURE_BREAKOUT_V1',
    market: 'KR_STOCK',
    symbol: card.symbol,
    direction: 'BUY',
    timeframe: '5m',
    observedAtMs,
    referencePrice: card.price,
    entryPrice: card.price,
    stopLoss: plan.stop,
    targets: plan.targets,
    bid: card.price,
    ask: card.price,
    stockExchange: null,
    leverage: null,
    marginMode: null,
    ruleEvidence: evidence,
    provenance: 'stock-scanner+5m-pressure-compression+live-provider-recheck',
    spreadPercent: 0,
  };
}

type PublicCandle = { at: number; open: number; high: number; low: number; close: number; volume: number };
async function getJson<T>(url: string, timeoutMs = 3_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('TRADING_CORE_PUBLIC_TIMEOUT')), timeoutMs);
  try {
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'trading-core-selected-live/1.0' }, signal: controller.signal });
    if (!response.ok) throw new Error('TRADING_CORE_PUBLIC_HTTP_' + response.status);
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}
function cryptoVwap(rows: readonly PublicCandle[]) {
  return vwap(rows);
}
function hhHl(rows: readonly PublicCandle[]) {
  const last = rows.slice(-3);
  return last.length === 3 && last[2]!.high > last[1]!.high && last[2]!.low > last[1]!.low;
}
function llLh(rows: readonly PublicCandle[]) {
  const last = rows.slice(-3);
  return last.length === 3 && last[2]!.high < last[1]!.high && last[2]!.low < last[1]!.low;
}
function trendUp(rows: readonly PublicCandle[]) {
  const closes = rows.map((row) => row.close);
  const fast = ema(closes, 20);
  const slow = ema(closes, 60);
  return positive(fast) && positive(slow) && fast > slow;
}
function trendDown(rows: readonly PublicCandle[]) {
  const closes = rows.map((row) => row.close);
  const fast = ema(closes, 20);
  const slow = ema(closes, 60);
  return positive(fast) && positive(slow) && fast < slow;
}
function parseUpbitCandles(rows: any[]): PublicCandle[] {
  return rows.map((row) => ({
    at: Number(row.timestamp),
    open: Number(row.opening_price),
    high: Number(row.high_price),
    low: Number(row.low_price),
    close: Number(row.trade_price),
    volume: Number(row.candle_acc_trade_volume),
  })).filter((row) => [row.at,row.open,row.high,row.low,row.close,row.volume].every(Number.isFinite)).sort((a,b) => a.at-b.at);
}
function parseBitgetCandles(rows: any[]): PublicCandle[] {
  return rows.map((row) => ({
    at: Number(row?.[0]), open: Number(row?.[1]), high: Number(row?.[2]),
    low: Number(row?.[3]), close: Number(row?.[4]), volume: Number(row?.[5]),
  })).filter((row) => [row.at,row.open,row.high,row.low,row.close,row.volume].every(Number.isFinite)).sort((a,b) => a.at-b.at);
}

async function evaluateSpot(card: ScannerSignalCard): Promise<StrategyObservation | null> {
  if (card.direction !== 'LONG' || card.dataState !== 'complete') return null;
  const symbol = card.symbol.toUpperCase().replace(/^KRW-/u, '');
  const market = 'KRW-' + symbol;
  const base = 'https://api.upbit.com';
  const [trades, orderbooks, c5, c15, c60] = await Promise.all([
    getJson<any[]>(`${base}/v1/trades/ticks?market=${encodeURIComponent(market)}&count=200`),
    getJson<any[]>(`${base}/v1/orderbook?markets=${encodeURIComponent(market)}&level=0`),
    getJson<any[]>(`${base}/v1/candles/minutes/5?market=${encodeURIComponent(market)}&count=80`),
    getJson<any[]>(`${base}/v1/candles/minutes/15?market=${encodeURIComponent(market)}&count=80`),
    getJson<any[]>(`${base}/v1/candles/minutes/60?market=${encodeURIComponent(market)}&count=80`),
  ]);
  const book = orderbooks[0];
  const units = Array.isArray(book?.orderbook_units) ? book.orderbook_units : [];
  const first = units[0];
  const bid = Number(first?.bid_price);
  const ask = Number(first?.ask_price);
  const totalBid = Number(book?.total_bid_size ?? units.reduce((sum: number, row: any) => sum + Number(row?.bid_size ?? 0), 0));
  const totalAsk = Number(book?.total_ask_size ?? units.reduce((sum: number, row: any) => sum + Number(row?.ask_size ?? 0), 0));
  if (!positive(bid) || !positive(ask) || ask < bid || !positive(totalBid + totalAsk)) return null;
  let buyVolume = 0;
  let sellVolume = 0;
  let referencePrice = card.price;
  let observedAtMs = Date.parse(card.observedAt);
  for (const row of trades) {
    const volume = Number(row?.trade_volume);
    if (!positive(volume)) continue;
    if (String(row?.ask_bid).toUpperCase() === 'BID') buyVolume += volume;
    else if (String(row?.ask_bid).toUpperCase() === 'ASK') sellVolume += volume;
    const ts = Number(row?.timestamp);
    if (finite(ts) && ts > observedAtMs) observedAtMs = ts;
  }
  if (trades[1] && positive(Number(trades[1].trade_price))) referencePrice = Number(trades[1].trade_price);
  const totalFlow = buyVolume + sellVolume;
  if (!positive(totalFlow)) return null;
  const cvd = buyVolume - sellVolume;
  const takerBuyRatio = buyVolume / totalFlow;
  const imbalance = totalBid / (totalBid + totalAsk);
  const rows5 = parseUpbitCandles(c5);
  const rows15 = parseUpbitCandles(c15);
  const rows60 = parseUpbitCandles(c60);
  const vw = cryptoVwap(rows5.slice(-20));
  const latest5 = rows5.at(-1);
  const prev5 = rows5.at(-2);
  if (!latest5 || !prev5 || !positive(vw)) return null;
  const reclaim = latest5.close > vw && (prev5.close <= vw || latest5.low <= vw);
  const wave = hhHl(rows5);
  const spreadPercent = (ask - bid) / ((ask + bid) / 2) * 100;
  const evidence = {
    strategyId: 'CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1',
    dataReady: Date.now() - observedAtMs <= MAX_AGE_MS,
    formulaReady: true,
    waveStructureReady: wave,
    indicatorReady: trendUp(rows60) && trendUp(rows15),
    entryTriggerReady: reclaim && wave,
    liquidityReady: (card.tradingValue ?? 0) >= 1_000_000_000 && spreadPercent <= 1,
    costEvidenceReady: spreadPercent <= 1,
    riskReady: (card.riskScore ?? 101) <= 45,
    orderFlowReady: true,
    cvdReady: cvd > 0,
    takerBuyReady: takerBuyRatio >= 0.52,
    orderbookImbalanceReady: imbalance >= 0.52,
    cvd,
    takerBuyRatio,
    orderbookImbalance: imbalance,
  } as const;
  if (Object.entries(evidence).some(([key, value]) => !['strategyId','cvd','takerBuyRatio','orderbookImbalance'].includes(key) && value !== true)) return null;
  const stop = Number(card.pricePlan.stopLoss);
  const targets = card.pricePlan.targets.filter(positive);
  if (!positive(stop) || targets.length === 0 || stop >= ask) return null;
  return {
    strategyId: 'CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1',
    market: 'CRYPTO_SPOT', symbol, direction: 'BUY', timeframe: '15m',
    observedAtMs, referencePrice, entryPrice: ask, stopLoss: stop, targets,
    bid, ask, stockExchange: null, leverage: null, marginMode: null,
    ruleEvidence: evidence, provenance: 'upbit-public-trades+orderbook+5m+15m+60m',
    spreadPercent,
  };
}

async function evaluateFutures(card: ScannerSignalCard, policy: TradingPolicy): Promise<StrategyObservation | null> {
  if (!['LONG','SHORT'].includes(card.direction) || card.dataState !== 'complete') return null;
  const symbol = card.symbol.toUpperCase().replace(/[-_/]/gu, '').replace(/USDT$/u, '') + 'USDT';
  const base = 'https://api.bitget.com';
  const common = `symbol=${encodeURIComponent(symbol)}&productType=usdt-futures`;
  const [fillsEnvelope, depthEnvelope, oiEnvelope, fundingEnvelope, c5e, c15e, c60e, contractsEnvelope] = await Promise.all([
    getJson<any>(`${base}/api/v2/mix/market/fills?${common}&limit=100`),
    getJson<any>(`${base}/api/v2/mix/market/merge-depth?${common}&precision=scale0&limit=15`),
    getJson<any>(`${base}/api/v2/mix/market/open-interest?${common}`),
    getJson<any>(`${base}/api/v2/mix/market/current-fund-rate?${common}`),
    getJson<any>(`${base}/api/v2/mix/market/history-candles?${common}&granularity=5m&limit=100`),
    getJson<any>(`${base}/api/v2/mix/market/history-candles?${common}&granularity=15m&limit=100`),
    getJson<any>(`${base}/api/v2/mix/market/history-candles?${common}&granularity=1H&limit=100`),
    getJson<any>(`${base}/api/v2/mix/market/contracts?${common}`),
  ]);
  const fills = Array.isArray(fillsEnvelope?.data) ? fillsEnvelope.data : [];
  let buy = 0;
  let sell = 0;
  let observedAtMs = Date.parse(card.observedAt);
  let referencePrice = card.price;
  for (const row of fills) {
    const size = Number(row?.size);
    if (!positive(size)) continue;
    if (String(row?.side).toLowerCase() === 'buy') buy += size;
    else if (String(row?.side).toLowerCase() === 'sell') sell += size;
    const ts = Number(row?.ts);
    if (finite(ts) && ts > observedAtMs) observedAtMs = ts;
  }
  if (fills[1] && positive(Number(fills[1].price))) referencePrice = Number(fills[1].price);
  const flowTotal = buy + sell;
  if (!positive(flowTotal)) return null;
  const cvd = buy - sell;
  const takerBuyRatio = buy / flowTotal;
  const depth = depthEnvelope?.data ?? {};
  const bids = Array.isArray(depth?.bids) ? depth.bids : [];
  const asks = Array.isArray(depth?.asks) ? depth.asks : [];
  const bid = Number(bids[0]?.[0]);
  const ask = Number(asks[0]?.[0]);
  if (!positive(bid) || !positive(ask) || ask < bid) return null;
  const oiRow = Array.isArray(oiEnvelope?.data?.openInterestList) ? oiEnvelope.data.openInterestList[0] : null;
  const openInterest = Number(oiRow?.size);
  const fundingRow = Array.isArray(fundingEnvelope?.data) ? fundingEnvelope.data[0] : null;
  const funding = Number(fundingRow?.fundingRate);
  if (!positive(openInterest) || !finite(funding)) return null;
  const rows5 = parseBitgetCandles(Array.isArray(c5e?.data) ? c5e.data : []);
  const rows15 = parseBitgetCandles(Array.isArray(c15e?.data) ? c15e.data : []);
  const rows60 = parseBitgetCandles(Array.isArray(c60e?.data) ? c60e.data : []);
  const direction = card.direction as 'LONG'|'SHORT';
  const long = direction === 'LONG';
  const trend = long ? trendUp(rows60) && hhHl(rows15) : trendDown(rows60) && llLh(rows15);
  const wave = long ? hhHl(rows5) : llLh(rows5);
  const flowReady = long ? cvd > 0 && takerBuyRatio >= 0.52 : cvd < 0 && takerBuyRatio <= 0.48;
  const latest = rows5.at(-1);
  const prior = rows5.slice(-4,-1);
  if (!latest || prior.length < 3) return null;
  const rebreak = long
    ? latest.close > Math.max(...prior.map((row) => row.high))
    : latest.close < Math.min(...prior.map((row) => row.low));
  const spreadPercent = (ask - bid) / ((ask + bid) / 2) * 100;
  const evidence = {
    strategyId: 'CRYPTO_FUTURES_FLOW_TREND_WAVE_V1',
    dataReady: Date.now() - observedAtMs <= MAX_AGE_MS,
    formulaReady: true,
    waveStructureReady: wave,
    indicatorReady: trend,
    entryTriggerReady: wave && rebreak,
    liquidityReady: (card.tradingValue ?? 0) >= 5_000_000 && spreadPercent <= 1,
    costEvidenceReady: spreadPercent <= 1,
    riskReady: (card.riskScore ?? 101) <= 45,
    orderFlowReady: true,
    oiReady: openInterest > 0,
    cvdReady: flowReady,
    takerFlowReady: flowReady,
    fundingRiskReady: Math.abs(funding) <= 0.001,
    cvd,
    takerBuyRatio,
    openInterest,
    fundingRate: funding,
  } as const;
  if (Object.entries(evidence).some(([key, value]) => !['strategyId','cvd','takerBuyRatio','openInterest','fundingRate'].includes(key) && value !== true)) return null;
  const stop = Number(card.pricePlan.stopLoss);
  const targets = card.pricePlan.targets.filter(positive);
  if (!positive(stop) || targets.length === 0) return null;
  if (long ? stop >= ask || targets.some((target) => target <= ask) : stop <= bid || targets.some((target) => target >= bid)) return null;
  const contract = Array.isArray(contractsEnvelope?.data) ? contractsEnvelope.data[0] : null;
  const step = Number(contract?.sizeMultiplier);
  const minQty = Number(contract?.minTradeNum);
  const maxQty = Number(contract?.maxMarketOrderQty);
  return {
    strategyId: 'CRYPTO_FUTURES_FLOW_TREND_WAVE_V1',
    market: 'CRYPTO_FUTURES', symbol, direction, timeframe: '5m',
    observedAtMs, referencePrice, entryPrice: long ? ask : bid, stopLoss: stop, targets,
    bid, ask, stockExchange: null, leverage: policy.bitgetLeverage, marginMode: 'ISOLATED',
    ruleEvidence: evidence, provenance: 'bitget-public-fills+depth+oi+funding+5m+15m+1h',
    spreadPercent,
    quantityStep: positive(step) ? step : null,
    minQuantity: positive(minQty) ? minQty : null,
    maxQuantity: positive(maxQty) ? maxQty : null,
  };
}

function quantize(value: number, step?: number | null) {
  if (!positive(value)) return 0;
  if (!positive(step)) return value;
  return Math.floor((value + Number.EPSILON) / step) * step;
}

async function candidateForMember(
  observation: StrategyObservation,
  policy: TradingPolicy,
  nowMs: number,
  researchCodeSha: string,
) {
  const exchange = observation.market === 'KR_STOCK'
    ? policy.stockBrokerByMarket.domestic_stock
    : observation.market === 'US_STOCK'
      ? 'kiwoom'
      : observation.market === 'CRYPTO_SPOT'
        ? 'upbit'
        : 'bitget';
  const fx = await resolveMemberAutoTradingKrwRate(observation.market, { nowMs });
  const stopDistancePercent = Math.abs(observation.entryPrice - observation.stopLoss) / observation.entryPrice * 100;
  if (!(stopDistancePercent > 0)) return null;
  const riskPercent = Math.min(0.5, policy.riskPerTradePercent[exchange]);
  const riskBudgetKrw = Math.max(1, policy.totalCapitalKrw * riskPercent / 100);
  const riskSizedKrw = riskBudgetKrw / (stopDistancePercent / 100);
  const orderKrw = Math.max(0, Math.min(policy.maxOrderKrw, riskSizedKrw, policy.totalCapitalKrw));
  let quantity = orderKrw / (observation.entryPrice * fx.krwPerQuoteCurrency);
  if (observation.market === 'KR_STOCK' || observation.market === 'US_STOCK') quantity = Math.floor(quantity);
  if (observation.market === 'CRYPTO_FUTURES') quantity = quantize(quantity, observation.quantityStep);
  if (positive(observation.minQuantity) && quantity < observation.minQuantity!) return null;
  if (positive(observation.maxQuantity) && quantity > observation.maxQuantity!) quantity = quantize(observation.maxQuantity!, observation.quantityStep);
  if (!positive(quantity)) return null;

  const parameterHash = hash({
    strategyId: observation.strategyId,
    version: STRATEGY_VERSION,
    market: observation.market,
    timeframe: observation.timeframe,
    rules: observation.ruleEvidence,
  });
  const signalId = `trading-core:${observation.market}:${observation.strategyId}:${observation.symbol}:${Math.floor(observation.observedAtMs / 60_000)}`;
  const candidateId = 'trading-core-selected:' + hash({ signalId, parameterHash });
  const direction = observation.direction;
  const dataEvidence: Record<string, unknown> = {
    provider: observation.market === 'KR_STOCK' || observation.market === 'US_STOCK'
      ? 'public-stock-scanner'
      : observation.market === 'CRYPTO_SPOT' ? 'upbit' : 'bitget',
    publicOnly: true,
    dataQuality: 'READY',
    provenance: observation.provenance,
    asOfMs: observation.observedAtMs,
    maxAgeMs: MAX_AGE_MS,
    quoteModel: observation.market === 'KR_STOCK' || observation.market === 'US_STOCK'
      ? 'LAST_TRADE_PROXY_LIVE_PROVIDER_RECHECK_REQUIRED'
      : 'PUBLIC_ORDERBOOK',
  };
  if (observation.market === 'KR_STOCK' || observation.market === 'US_STOCK') {
    dataEvidence.session = { status: 'OPEN', version: 'trading-core-market-session-v1' };
    if (observation.stockExchange) dataEvidence.stockExchange = observation.stockExchange;
  } else if (observation.market === 'CRYPTO_SPOT') {
    dataEvidence.marketStatus = 'TRADABLE';
  } else {
    dataEvidence.contractStatus = 'TRADABLE';
    dataEvidence.leverage = observation.leverage;
    dataEvidence.marginMode = observation.marginMode;
    dataEvidence.liquidationDistancePct = null;
  }

  const strategyIdentity = Object.freeze({
    candidateId,
    strategyFamily: 'USER_SELECTED_TRADING_CORE',
    strategyId: observation.strategyId,
    strategyVersion: STRATEGY_VERSION,
    parameterHash,
    parameterDigest: parameterHash,
    researchCodeSha,
    costPolicyVersion: COST_POLICY,
    accountMode: 'PAPER',
  });
  const learningSnapshot = Object.freeze({
    immutable: true,
    signalId,
    market: observation.market,
    symbol: observation.symbol,
    direction,
    timestamp: new Date(observation.observedAtMs).toISOString(),
    dataTimestamp: new Date(observation.observedAtMs).toISOString(),
    dataProvenance: [observation.provenance],
    strategyProfileVersion: STRATEGY_VERSION,
    strategyHorizon: 'SCALP',
    timeframes: [observation.timeframe],
    referencePrice: observation.referencePrice,
    entryPrice: observation.entryPrice,
    stopLoss: observation.stopLoss,
    target1: observation.targets[0] ?? null,
    target2: observation.targets[1] ?? observation.targets[0] ?? null,
    strategyRulePackEvidence: observation.ruleEvidence,
    executionAuthority: 'NONE',
  });
  return Object.freeze({
    signal: Object.freeze({
      signalId,
      market: observation.market,
      symbol: observation.symbol,
      timestampMs: observation.observedAtMs,
      expiresAtMs: observation.observedAtMs + MAX_AGE_MS,
      ttlMs: MAX_AGE_MS,
      style: 'SCALPING',
      timeframe: observation.timeframe,
      horizon: 1,
      direction,
      signalDirection: direction,
      strategyIdentity,
      learningSnapshot,
    }),
    paperIdentity: Object.freeze({
      signalId,
      candidateId,
      market: observation.market,
      symbol: observation.symbol,
      timeframe: observation.timeframe,
      horizon: 1,
      direction,
      strategyId: observation.strategyId,
      strategyVersion: STRATEGY_VERSION,
      parameterHash,
      researchCodeSha,
      costPolicyVersion: COST_POLICY,
      executionAuthority: 'NONE',
    }),
    profitEvidence: Object.freeze({
      status: 'USER_SELECTED_UNVALIDATED_LIVE_PILOT',
      expectedNetEdge: null,
      expectedNetReturn: null,
      riskRewardRatio: null,
      sampleSize: 0,
      costPolicyId: COST_POLICY,
      executionAuthority: 'NONE',
      profitabilityClaimAllowed: false,
    }),
    riskEvidence: Object.freeze({
      status: 'APPROVED',
      source: 'TRADING_RISK_ENGINE',
      evaluatedAtMs: nowMs,
      simulatedOnly: true,
      allowed: true,
      blockCodes: Object.freeze([]),
      recommendedQuantity: quantity,
      actualRiskPercent: riskPercent,
      riskReward1: null,
      riskReward2: null,
      executionAuthority: 'NONE',
    }),
    execution: Object.freeze({
      marketAdapterIdentity: Object.freeze({ id: 'trading-core-user-selected-live', version: 'v1' }),
      costPolicy: Object.freeze({
        version: COST_POLICY,
        commissionRate: 0.001,
        taxRate: 0,
        spreadRate: observation.spreadPercent / 100,
        slippageRate: 0.0025,
        latencyRate: 0,
        liquidityImpactRate: 0,
        partialFillImpactRate: 0,
        fundingRate: 0,
      }),
      executionPolicy: Object.freeze({
        version: 'trading-core-operational-mirror-v1',
        fillModel: 'LAST_TRADE_OR_PUBLIC_ORDERBOOK_PROXY',
      }),
      dataEvidence: Object.freeze(dataEvidence),
    }),
    order: Object.freeze({ type: 'MARKET', quantity, direction }),
    quote: Object.freeze({
      bid: observation.bid,
      ask: observation.ask,
      last: observation.entryPrice,
      asOfMs: observation.observedAtMs,
      maxAgeMs: MAX_AGE_MS,
    }),
    executionAuthority: 'NONE',
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
}

const cursorByKey = new Map<string, number>();

async function stockObservations(userId: string, market: 'KR'|'US') {
  const key = 'stock:' + market;
  const cursor = cursorByKey.get(key) ?? 0;
  const response = await StockSignalScannerService.scan({
    memberId: userId,
    market,
    indicators: [],
    filters: { timeframe: '5m', maximumRiskScore: 45 },
    cursor,
    batchSize: STOCK_BATCH,
    strategyMode: 'scalping',
  });
  cursorByKey.set(key, response.universe.nextCursor ?? 0);
  const observations: StrategyObservation[] = [];
  for (const card of response.cards.slice(0, 5)) {
    try {
      const candles = await MarketDataService.getCandles(card.symbol, '5m');
      const observation = market === 'US' ? evaluateUsOrb(card, candles) : evaluateKrPressure(card, candles);
      if (observation) observations.push(observation);
    } catch {
      // candidate remains NO_TRADE on missing public evidence
    }
  }
  return observations.sort((a,b) => b.observedAtMs-a.observedAtMs).slice(0,1);
}

async function cryptoObservations(userId: string, market: 'spot'|'futures', policy: TradingPolicy) {
  const key = 'crypto:' + market;
  const cursor = cursorByKey.get(key) ?? 0;
  const response = await CryptoSignalScannerService.scan({
    memberId: userId,
    market,
    timeframe: market === 'spot' ? '15m' : '5m',
    condition: market === 'spot' ? 'trend' : 'breakout',
    cursor,
    batchSize: CRYPTO_BATCH,
    maximumRiskScore: 45,
    strategyMode: 'scalping',
  });
  cursorByKey.set(key, response.universe.nextCursor ?? 0);
  const cards = response.cards
    .filter((card) => card.direction !== 'NEUTRAL' && card.dataState === 'complete')
    .sort((a,b) => b.score-a.score)
    .slice(0,4);
  const observations: StrategyObservation[] = [];
  for (const card of cards) {
    try {
      const observation = market === 'spot' ? await evaluateSpot(card) : await evaluateFutures(card, policy);
      if (observation) observations.push(observation);
    } catch {
      // candidate remains NO_TRADE on missing public evidence
    }
  }
  return observations.sort((a,b) => b.observedAtMs-a.observedAtMs).slice(0,1);
}

export async function buildUserSelectedTradingCoreHandoff(input: {
  userId: string;
  policy: TradingPolicy;
  nowMs?: number;
  researchCodeSha?: string;
}): Promise<MemberAutoTradingPaperHandoff | null> {
  const nowMs = input.nowMs ?? Date.now();
  const researchCodeSha = String(input.researchCodeSha ?? process.env.DEPLOY_SHA ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(researchCodeSha)) return null;

  const enabled = input.policy.enabledStrategies;
  const permits = (strategyId: string) => enabled.length === 0 || enabled.includes(strategyId);
  const observations = (await Promise.all([
    permits('KR_PRESSURE_BREAKOUT_V1') ? stockObservations(input.userId, 'KR') : Promise.resolve([]),
    permits('US_STOCKS_IN_PLAY_ORB_RETEST_V1') ? stockObservations(input.userId, 'US') : Promise.resolve([]),
    permits('CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1') ? cryptoObservations(input.userId, 'spot', input.policy) : Promise.resolve([]),
    permits('CRYPTO_FUTURES_FLOW_TREND_WAVE_V1') ? cryptoObservations(input.userId, 'futures', input.policy) : Promise.resolve([]),
  ])).flat().filter((row) => isUserSelectedLiveStrategyId(row.strategyId));

  if (!observations.length) return null;
  const candidates = (await Promise.all(observations.map((row) => candidateForMember(row, input.policy, nowMs, researchCodeSha))))
    .filter((row): row is NonNullable<typeof row> => row != null);
  if (!candidates.length) return null;

  const lanes = candidates.map((candidate) => Object.freeze({
    market: candidate.signal.market,
    result: Object.freeze({ candidates: Object.freeze([candidate]) }),
  }));
  const handoff = buildMemberAutoTradingPaperHandoff({
    cycleId: 'trading-core-user-selected:' + Math.floor(nowMs / 30_000),
    evaluatedAtMs: nowMs,
    lanes,
  });
  return validateMemberAutoTradingPaperHandoff(handoff, nowMs);
}