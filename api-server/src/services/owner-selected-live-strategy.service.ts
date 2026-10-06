import { createHash } from 'node:crypto';
import type { Candle } from '../sample/types';
import type { ScannerSignalCard } from './scanner-signal.types';

export type OwnerSelectedMarket = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
export type OwnerSelectedDirection = 'BUY' | 'LONG' | 'SHORT';

export const OWNER_SELECTED_LIVE_STRATEGIES = Object.freeze({
  KR_STOCK: 'KR_PRESSURE_BREAKOUT_V1',
  US_STOCK: 'US_STOCKS_IN_PLAY_ORB_RETEST_V1',
  CRYPTO_SPOT: 'CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1',
  CRYPTO_FUTURES: 'CRYPTO_FUTURES_FLOW_TREND_WAVE_V1',
} as const);

export type OwnerSelectedStrategyId =
  (typeof OWNER_SELECTED_LIVE_STRATEGIES)[keyof typeof OWNER_SELECTED_LIVE_STRATEGIES];

export type OwnerSelectedFlowEvidence = Readonly<{
  observedAtMs: number;
  buyVolume: number;
  sellVolume: number;
  cvd: number;
  cvdSlope: number;
  takerBuyRatio: number;
  bidDepth: number;
  askDepth: number;
  orderbookImbalance: number;
  openInterestChangePercent: number | null;
  provenance: string;
}>;

export type OwnerSelectedStrategyEvidence = Readonly<{
  schemaVersion: 'owner-selected-live-strategy-evidence-v1';
  strategyId: OwnerSelectedStrategyId;
  market: OwnerSelectedMarket;
  direction: OwnerSelectedDirection;
  status: 'READY' | 'NO_TRADE';
  parameterHash: string;
  evidenceDigest: string;
  observedAt: string;
  ruleEvidence: Readonly<Record<string, boolean>>;
  metrics: Readonly<Record<string, number | null>>;
  reasons: readonly string[];
  ownerSelected: true;
  profitabilityClaimAllowed: false;
}>;

const EXACT_ALLOWLIST = new Set<OwnerSelectedStrategyId>(Object.values(OWNER_SELECTED_LIVE_STRATEGIES));
const MAX_FLOW_AGE_MS = 30_000;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}
function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
function candleMs(value: Candle['time']): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1_000;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}
function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let index = period; index < values.length; index += 1) {
    current = (values[index] - current) * multiplier + current;
  }
  return current;
}
function vwap(candles: readonly Candle[]): number | null {
  let volume = 0;
  let value = 0;
  for (const candle of candles) {
    if (!positive(candle.volume) || !positive(candle.high) || !positive(candle.low) || !positive(candle.close)) continue;
    const typical = (candle.high + candle.low + candle.close) / 3;
    volume += candle.volume;
    value += typical * candle.volume;
  }
  return volume > 0 ? value / volume : null;
}
function fmtDate(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms));
  const row = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${row.year}-${row.month}-${row.day}`;
}
function sessionMinute(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const row = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(row.hour) * 60 + Number(row.minute);
}
function candlesForDate(candles: readonly Candle[], date: string, timeZone: string) {
  return candles.filter((candle) => {
    const ms = candleMs(candle.time);
    return ms != null && fmtDate(ms, timeZone) === date;
  });
}
function positiveSlope(values: number[]) {
  if (values.length < 3 || values.some((value) => !finite(value))) return false;
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    numerator += (index - meanX) * (values[index] - meanY);
    denominator += (index - meanX) ** 2;
  }
  return denominator > 0 && numerator / denominator > 0;
}
function digest(value: unknown) {
  const stable = (input: unknown): string => {
    if (Array.isArray(input)) return '[' + input.map(stable).join(',') + ']';
    if (input && typeof input === 'object') {
      const row = input as Record<string, unknown>;
      return '{' + Object.keys(row).sort().map((key) => JSON.stringify(key) + ':' + stable(row[key])).join(',') + '}';
    }
    return JSON.stringify(input);
  };
  return createHash('sha256').update(stable(value)).digest('hex');
}
function parameterHash(strategyId: OwnerSelectedStrategyId) {
  return digest({
    schemaVersion: 'owner-selected-live-strategy-parameters-v1',
    strategyId,
    policy: strategyId === OWNER_SELECTED_LIVE_STRATEGIES.US_STOCK
      ? { timeframe: '5m', minimumPrice: 5, rvolSessions: 14, minimumOpeningRvol: 1, retestTolerancePct: 0.5 }
      : strategyId === OWNER_SELECTED_LIVE_STRATEGIES.KR_STOCK
        ? { timeframe: '5m', emaFast: 20, emaSlow: 60, rvolMinimum: 1.3, compressionBars: 3, tradingValueSlopeBars: 5 }
        : strategyId === OWNER_SELECTED_LIVE_STRATEGIES.CRYPTO_SPOT
          ? { timeframe: '5m', context15m: true, context60m: true, minimumTakerBuyRatio: 0.52, minimumImbalance: 0.05 }
          : { timeframe: '5m', context15m: true, context60m: true, minimumFlowShare: 0.52, maximumAbsFundingRate: 0.001 },
  });
}
function buildEvidence(input: {
  strategyId: OwnerSelectedStrategyId;
  market: OwnerSelectedMarket;
  direction: OwnerSelectedDirection;
  observedAt: string;
  ruleEvidence: Record<string, boolean>;
  metrics: Record<string, number | null>;
  reasons: string[];
}): OwnerSelectedStrategyEvidence {
  const ready = Object.values(input.ruleEvidence).every(Boolean);
  const core = {
    schemaVersion: 'owner-selected-live-strategy-evidence-v1' as const,
    strategyId: input.strategyId,
    market: input.market,
    direction: input.direction,
    status: ready ? 'READY' as const : 'NO_TRADE' as const,
    parameterHash: parameterHash(input.strategyId),
    observedAt: input.observedAt,
    ruleEvidence: Object.freeze({ ...input.ruleEvidence }),
    metrics: Object.freeze({ ...input.metrics }),
    reasons: Object.freeze([...input.reasons]),
    ownerSelected: true as const,
    profitabilityClaimAllowed: false as const,
  };
  return Object.freeze({ ...core, evidenceDigest: digest(core) });
}

export function isOwnerSelectedStrategyId(value: unknown): value is OwnerSelectedStrategyId {
  return typeof value === 'string' && EXACT_ALLOWLIST.has(value as OwnerSelectedStrategyId);
}

export function ownerSelectedStrategyIdForMarket(market: OwnerSelectedMarket): OwnerSelectedStrategyId {
  return OWNER_SELECTED_LIVE_STRATEGIES[market];
}

export function ownerSelectedLiveStrategiesRuntimeEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (env.OWNER_SELECTED_LIVE_STRATEGIES_ENABLED !== 'true') return false;
  const configured = new Set(String(env.OWNER_SELECTED_LIVE_STRATEGY_ALLOWLIST ?? '')
    .split(',').map((value) => value.trim()).filter(Boolean));
  return configured.size === EXACT_ALLOWLIST.size
    && [...EXACT_ALLOWLIST].every((strategyId) => configured.has(strategyId));
}

export function ownerSelectedStrategyMarketDirectionAllowed(
  strategyId: OwnerSelectedStrategyId,
  market: OwnerSelectedMarket,
  direction: OwnerSelectedDirection,
) {
  if (OWNER_SELECTED_LIVE_STRATEGIES[market] !== strategyId) return false;
  if (market === 'CRYPTO_FUTURES') return direction === 'LONG' || direction === 'SHORT';
  return direction === 'BUY';
}

export function evaluateOwnerSelectedStockStrategy(input: {
  market: 'KR_STOCK' | 'US_STOCK';
  card: ScannerSignalCard;
  candles: readonly Candle[];
  nowMs?: number;
}): OwnerSelectedStrategyEvidence {
  const nowMs = input.nowMs ?? Date.now();
  const observedMs = Date.parse(input.card.observedAt);
  const observedAt = Number.isFinite(observedMs) ? new Date(observedMs).toISOString() : new Date(nowMs).toISOString();
  const closes = input.candles.map((row) => row.close).filter(finite);
  if (input.market === 'US_STOCK') {
    const strategyId = OWNER_SELECTED_LIVE_STRATEGIES.US_STOCK;
    const timed = input.candles.flatMap((candle) => {
      const ms = candleMs(candle.time);
      return ms == null ? [] : [{ candle, ms }];
    });
    const latestMs = timed.at(-1)?.ms ?? nowMs;
    const latestDate = fmtDate(latestMs, 'America/New_York');
    const regular = timed
      .filter((row) => fmtDate(row.ms, 'America/New_York') === latestDate)
      .filter((row) => {
        const minute = sessionMinute(row.ms, 'America/New_York');
        return minute >= 9 * 60 + 30 && minute < 16 * 60;
      });
    const sessionDates = [...new Set(timed.map((row) => fmtDate(row.ms, 'America/New_York')))]
      .filter((date) => date !== latestDate).slice(-14);
    const firstVolumes = sessionDates.flatMap((date) => {
      const rows = timed
        .filter((row) => fmtDate(row.ms, 'America/New_York') === date)
        .filter((row) => sessionMinute(row.ms, 'America/New_York') >= 9 * 60 + 30)
        .sort((a, b) => a.ms - b.ms);
      return positive(rows[0]?.candle.volume) ? [rows[0]!.candle.volume] : [];
    });
    const first = regular[0]?.candle;
    const current = regular.at(-1)?.candle;
    const openingHigh = first?.high ?? null;
    const baseline = mean(firstVolumes);
    const openingRvol = positive(first?.volume) && positive(baseline) ? first!.volume / baseline! : null;
    let breakoutIndex = -1;
    if (positive(openingHigh)) {
      breakoutIndex = regular.findIndex((row, index) => index > 0 && row.candle.close > openingHigh);
    }
    let retestIndex = -1;
    if (breakoutIndex >= 0 && positive(openingHigh)) {
      retestIndex = regular.findIndex((row, index) => index > breakoutIndex
        && row.candle.low <= openingHigh * 1.005
        && row.candle.low >= openingHigh * 0.995
        && row.candle.close >= openingHigh);
    }
    const retest = retestIndex >= 0 ? regular[retestIndex]?.candle : null;
    const previousHigh = regular.length >= 2 ? regular[regular.length - 2]!.candle.high : null;
    const higherLow = Boolean(retest && current && current.low >= retest.low);
    const microBreakout = Boolean(current && positive(previousHigh) && current.close > previousHigh);
    const rules = {
      priceFloor: input.card.price > 5,
      liquidityReady: positive(input.card.tradingValue) || positive(input.card.liquidity),
      openingRvolReady: openingRvol != null && openingRvol >= 1,
      openingRangeBreakoutReady: breakoutIndex >= 0,
      retestReady: retestIndex >= 0,
      higherLowReady: higherLow,
      volumeReaccelerationReady: Boolean(current && retest && current.volume > retest.volume),
      microBreakoutReady: microBreakout,
      dataReady: input.card.dataState === 'complete' && input.card.riskScore != null && input.card.riskScore <= 45,
    };
    return buildEvidence({
      strategyId,
      market: input.market,
      direction: 'BUY',
      observedAt,
      ruleEvidence: rules,
      metrics: {
        openingRvol,
        openingRangeHigh: openingHigh,
        breakoutIndex,
        retestIndex,
        currentPrice: input.card.price,
      },
      reasons: Object.entries(rules).filter(([, ok]) => !ok).map(([key]) => key),
    });
  }

  const strategyId = OWNER_SELECTED_LIVE_STRATEGIES.KR_STOCK;
  const ema20 = ema(closes, 20);
  const ema60 = ema(closes, 60);
  const timed = input.candles.flatMap((candle) => {
    const ms = candleMs(candle.time);
    return ms == null ? [] : [{ candle, ms }];
  });
  const latestMs = timed.at(-1)?.ms ?? nowMs;
  const latestDate = fmtDate(latestMs, 'Asia/Seoul');
  const session = candlesForDate(input.candles, latestDate, 'Asia/Seoul');
  const current = session.at(-1) ?? input.candles.at(-1);
  const previous = session.at(-2) ?? input.candles.at(-2);
  const sessionVwap = vwap(session);
  const prior = input.candles.slice(-21, -1);
  const priorHigh = prior.length ? Math.max(...prior.map((row) => row.high)) : null;
  const previousClose = previous?.close ?? null;
  const distanceToHighPct = positive(priorHigh) && positive(previousClose)
    ? (priorHigh - previousClose) / priorHigh * 100 : null;
  const values = input.candles.slice(-6, -1).map((row) => row.close * row.volume).filter(finite);
  const lows = input.candles.slice(-4).map((row) => row.low);
  const ranges = input.candles.slice(-13).map((row) => row.high - row.low);
  const baselineRange = mean(ranges.slice(0, Math.max(0, ranges.length - 3)));
  const recentRange = mean(ranges.slice(-3));
  const baselineVolume = mean(input.candles.slice(-21, -1).map((row) => row.volume).filter(finite));
  const rvol = positive(current?.volume) && positive(baselineVolume) ? current!.volume / baselineVolume! : null;
  const breakoutLevel = input.candles.length >= 11
    ? Math.max(...input.candles.slice(-11, -1).map((row) => row.high)) : null;
  const rules = {
    trendReady: positive(ema20) && positive(ema60) && ema20! > ema60!,
    vwapReady: positive(sessionVwap) && positive(current?.close) && current!.close > sessionVwap!,
    nearHighBeforeBreakoutReady: distanceToHighPct != null && distanceToHighPct >= 0 && distanceToHighPct <= 1.5,
    tradingValueAccelerationReady: values.length >= 3 && positiveSlope(values),
    higherLowReady: lows.length >= 3 && lows.slice(-3).every(finite)
      && lows[lows.length - 3]! < lows[lows.length - 2]! && lows[lows.length - 2]! <= lows[lows.length - 1]!,
    compressionReady: positive(baselineRange) && positive(recentRange) && recentRange! <= baselineRange! * 0.85,
    volumeExpansionReady: rvol != null && rvol >= 1.3,
    breakoutReady: positive(breakoutLevel) && positive(current?.close) && current!.close > breakoutLevel!,
    dataReady: input.card.dataState === 'complete' && input.card.riskScore != null && input.card.riskScore <= 45,
  };
  return buildEvidence({
    strategyId,
    market: input.market,
    direction: 'BUY',
    observedAt,
    ruleEvidence: rules,
    metrics: { ema20, ema60, vwap: sessionVwap, distanceToHighPct, rvol, breakoutLevel, currentPrice: input.card.price },
    reasons: Object.entries(rules).filter(([, ok]) => !ok).map(([key]) => key),
  });
}

export function evaluateOwnerSelectedCryptoStrategy(input: {
  market: 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
  card: ScannerSignalCard;
  candles: readonly { time: number; open: number; high: number; low: number; close: number; volume: number; quoteVolume: number | null }[];
  context15m: readonly { close: number; high: number; low: number; volume: number }[];
  context60m: readonly { close: number; high: number; low: number; volume: number }[];
  flow: OwnerSelectedFlowEvidence | null;
  fundingRate: number | null;
  nowMs?: number;
}): OwnerSelectedStrategyEvidence {
  const nowMs = input.nowMs ?? Date.now();
  const observedMs = Date.parse(input.card.observedAt);
  const observedAt = Number.isFinite(observedMs) ? new Date(observedMs).toISOString() : new Date(nowMs).toISOString();
  const closes5 = input.candles.map((row) => row.close);
  const closes15 = input.context15m.map((row) => row.close);
  const closes60 = input.context60m.map((row) => row.close);
  const ema20_60m = ema(closes60, 20);
  const ema60_60m = ema(closes60, 60);
  const ema20_15m = ema(closes15, 20);
  const ema60_15m = ema(closes15, 60);
  const sessionVwap = (() => {
    const rows = input.candles.slice(-48);
    const volume = rows.reduce((sum, row) => sum + Math.max(0, row.volume), 0);
    return volume > 0
      ? rows.reduce((sum, row) => sum + ((row.high + row.low + row.close) / 3) * Math.max(0, row.volume), 0) / volume
      : null;
  })();
  const latest = input.candles.at(-1);
  const previous = input.candles.at(-2);
  const previous2 = input.candles.at(-3);
  const flowFresh = Boolean(input.flow && input.flow.observedAtMs <= nowMs + 5_000
    && nowMs - input.flow.observedAtMs <= MAX_FLOW_AGE_MS);

  if (input.market === 'CRYPTO_SPOT') {
    const strategyId = OWNER_SELECTED_LIVE_STRATEGIES.CRYPTO_SPOT;
    const hhhl = Boolean(latest && previous && previous2
      && latest.high > previous.high && latest.low >= previous.low
      && previous.high >= previous2.high && previous.low >= previous2.low);
    const vwapReclaim = Boolean(positive(sessionVwap) && latest && previous
      && previous.close <= sessionVwap! && latest.close > sessionVwap!);
    const rules = {
      oneHourTrendReady: positive(ema20_60m) && positive(ema60_60m) && ema20_60m! > ema60_60m!,
      fifteenMinuteTrendReady: positive(ema20_15m) && positive(ema60_15m) && ema20_15m! > ema60_15m!,
      cvdReady: flowFresh && (input.flow?.cvd ?? 0) > 0 && (input.flow?.cvdSlope ?? 0) > 0,
      takerBuyReady: flowFresh && (input.flow?.takerBuyRatio ?? 0) >= 0.52,
      orderbookImbalanceReady: flowFresh && (input.flow?.orderbookImbalance ?? 0) >= 0.05
        && (input.flow?.bidDepth ?? 0) > 0 && (input.flow?.askDepth ?? 0) > 0,
      fiveMinuteStructureReady: hhhl,
      vwapReclaimReady: vwapReclaim,
      dataReady: input.card.dataState === 'complete' && input.card.riskScore != null && input.card.riskScore <= 45,
    };
    return buildEvidence({
      strategyId,
      market: input.market,
      direction: 'BUY',
      observedAt,
      ruleEvidence: rules,
      metrics: {
        ema20_60m, ema60_60m, ema20_15m, ema60_15m, vwap: sessionVwap,
        cvd: input.flow?.cvd ?? null, cvdSlope: input.flow?.cvdSlope ?? null,
        takerBuyRatio: input.flow?.takerBuyRatio ?? null,
        orderbookImbalance: input.flow?.orderbookImbalance ?? null,
      },
      reasons: Object.entries(rules).filter(([, ok]) => !ok).map(([key]) => key),
    });
  }

  const strategyId = OWNER_SELECTED_LIVE_STRATEGIES.CRYPTO_FUTURES;
  const longTrend = positive(ema20_60m) && positive(ema60_60m) && ema20_60m! > ema60_60m!;
  const shortTrend = positive(ema20_60m) && positive(ema60_60m) && ema20_60m! < ema60_60m!;
  const longStructure = Boolean(latest && previous && previous2
    && latest.high > previous.high && latest.low >= previous.low
    && previous.high >= previous2.high && previous.low >= previous2.low);
  const shortStructure = Boolean(latest && previous && previous2
    && latest.low < previous.low && latest.high <= previous.high
    && previous.low <= previous2.low && previous.high <= previous2.high);
  const longFlow = flowFresh && (input.flow?.cvdSlope ?? 0) > 0 && (input.flow?.takerBuyRatio ?? 0) >= 0.52;
  const shortFlow = flowFresh && (input.flow?.cvdSlope ?? 0) < 0 && (input.flow?.takerBuyRatio ?? 1) <= 0.48;
  const direction: 'LONG' | 'SHORT' = longTrend && longStructure && longFlow ? 'LONG' : 'SHORT';
  const directional = direction === 'LONG';
  const prior = input.candles.slice(-11, -1);
  const rebreak = latest && prior.length > 0
    ? directional
      ? latest.close > Math.max(...prior.map((row) => row.high))
      : latest.close < Math.min(...prior.map((row) => row.low))
    : false;
  const priceVsVwap = Boolean(positive(sessionVwap) && latest
    && (directional ? latest.close >= sessionVwap! : latest.close <= sessionVwap!));
  const fundingSafe = input.fundingRate != null && Math.abs(input.fundingRate) <= 0.001;
  const oiIncreasing = flowFresh && (input.flow?.openInterestChangePercent ?? 0) > 0;
  const orderbookAligned = flowFresh && (directional
    ? (input.flow?.orderbookImbalance ?? 0) >= 0
    : (input.flow?.orderbookImbalance ?? 0) <= 0);
  const rules = {
    oneHourTrendReady: directional ? longTrend : shortTrend,
    fifteenMinuteStructureReady: directional
      ? positive(ema20_15m) && positive(ema60_15m) && ema20_15m! >= ema60_15m!
      : positive(ema20_15m) && positive(ema60_15m) && ema20_15m! <= ema60_15m!,
    fiveMinuteWaveReady: directional ? longStructure : shortStructure,
    oiReady: oiIncreasing,
    cvdReady: flowFresh && (directional ? (input.flow?.cvdSlope ?? 0) > 0 : (input.flow?.cvdSlope ?? 0) < 0),
    takerFlowReady: directional ? longFlow : shortFlow,
    vwapReady: priceVsVwap,
    rebreakReady: Boolean(rebreak),
    fundingRiskReady: fundingSafe,
    depthReady: orderbookAligned && (input.flow?.bidDepth ?? 0) > 0 && (input.flow?.askDepth ?? 0) > 0,
    dataReady: input.card.dataState === 'complete' && input.card.riskScore != null && input.card.riskScore <= 45,
  };
  return buildEvidence({
    strategyId,
    market: input.market,
    direction,
    observedAt,
    ruleEvidence: rules,
    metrics: {
      ema20_60m, ema60_60m, ema20_15m, ema60_15m, vwap: sessionVwap,
      cvd: input.flow?.cvd ?? null, cvdSlope: input.flow?.cvdSlope ?? null,
      takerBuyRatio: input.flow?.takerBuyRatio ?? null,
      orderbookImbalance: input.flow?.orderbookImbalance ?? null,
      openInterestChangePercent: input.flow?.openInterestChangePercent ?? null,
      fundingRate: input.fundingRate,
    },
    reasons: Object.entries(rules).filter(([, ok]) => !ok).map(([key]) => key),
  });
}

export function ownerSelectedStrategyEvidenceReady(
  value: OwnerSelectedStrategyEvidence | null | undefined,
): value is OwnerSelectedStrategyEvidence {
  return value?.status === 'READY'
    && value.ownerSelected === true
    && value.profitabilityClaimAllowed === false
    && isOwnerSelectedStrategyId(value.strategyId)
    && ownerSelectedStrategyMarketDirectionAllowed(value.strategyId, value.market, value.direction);
}
