import type { ScannerEvidence, ScannerPricePlan, ScannerSignalCard } from './scanner-signal.types';

const UPBIT_BASE = 'https://api.upbit.com';
const BITGET_BASE = 'https://api.bitget.com';
const BITGET_PRODUCT_TYPE = 'USDT-FUTURES';
const STRATEGY_ID = 'crypto-williams-atr-v1';
const K = 0.5;
const MA_PERIOD = 5;
const ATR_PERIOD = 14;
const ATR_STOP_MULTIPLIER = 2;
const DAILY_LIMIT = 32;
const FETCH_TIMEOUT_MS = 2_500;
const OVERLAY_CONCURRENCY = 3;

type CryptoWilliamsMarket = 'spot' | 'futures';

export interface CryptoWilliamsDailyCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface CryptoWilliamsEvaluation {
  strategyId: typeof STRATEGY_ID;
  status: 'ENTRY' | 'NO_ENTRY' | 'INSUFFICIENT';
  direction: 'LONG' | 'SHORT' | null;
  previousHigh: number | null;
  previousLow: number | null;
  sessionOpen: number | null;
  movingAverage: number | null;
  atr: number | null;
  longTarget: number | null;
  shortTarget: number | null;
  stopPrice: number | null;
  latestTimestamp: number | null;
  reasons: string[];
}

export interface CryptoWilliamsOverlayInput {
  market: CryptoWilliamsMarket;
  cards: ScannerSignalCard[];
  signal?: AbortSignal;
}

export interface CryptoWilliamsOverlayResult {
  cards: ScannerSignalCard[];
  matchedCount: number;
  unavailableCount: number;
}

export interface CryptoWilliamsOverlayRunner {
  apply(input: CryptoWilliamsOverlayInput): Promise<CryptoWilliamsOverlayResult>;
}

interface UpbitDailyCandleRow {
  timestamp?: unknown;
  candle_date_time_utc?: unknown;
  opening_price?: unknown;
  high_price?: unknown;
  low_price?: unknown;
  trade_price?: unknown;
}

interface BitgetEnvelope<T> {
  code?: unknown;
  data?: T;
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeDailyCandles(rows: CryptoWilliamsDailyCandle[]): CryptoWilliamsDailyCandle[] {
  const map = new Map<number, CryptoWilliamsDailyCandle>();
  for (const row of rows) {
    if (!Number.isFinite(row.time) || row.time <= 0) continue;
    if (![row.open, row.high, row.low, row.close].every((value) => Number.isFinite(value) && value > 0)) continue;
    map.set(row.time, {
      time: row.time,
      open: row.open,
      high: Math.max(row.high, row.open, row.close),
      low: Math.min(row.low, row.open, row.close),
      close: row.close,
    });
  }
  return [...map.values()].sort((left, right) => left.time - right.time);
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function trueRange(current: CryptoWilliamsDailyCandle, previousClose: number): number {
  return Math.max(
    current.high - current.low,
    Math.abs(current.high - previousClose),
    Math.abs(current.low - previousClose),
  );
}

export function evaluateCryptoWilliamsDailyCandles(input: {
  market: CryptoWilliamsMarket;
  candles: CryptoWilliamsDailyCandle[];
  currentPrice: number;
}): CryptoWilliamsEvaluation {
  const rows = normalizeDailyCandles(input.candles);
  const requiredCompleted = Math.max(MA_PERIOD, ATR_PERIOD + 1);
  if (!Number.isFinite(input.currentPrice) || input.currentPrice <= 0 || rows.length < requiredCompleted + 1) {
    return {
      strategyId: STRATEGY_ID,
      status: 'INSUFFICIENT',
      direction: null,
      previousHigh: null,
      previousLow: null,
      sessionOpen: null,
      movingAverage: null,
      atr: null,
      longTarget: null,
      shortTarget: null,
      stopPrice: null,
      latestTimestamp: rows.at(-1)?.time ?? null,
      reasons: ['daily_history_insufficient'],
    };
  }

  // The public 1D candles start at UTC 00:00, which is KST 09:00. The last row is
  // the still-forming current KST09 session and is excluded from MA/ATR history.
  const current = rows.at(-1)!;
  const completed = rows.slice(0, -1);
  const previous = completed.at(-1)!;
  const maWindow = completed.slice(-MA_PERIOD);
  const trValues: number[] = [];
  for (let index = 1; index < completed.length; index += 1) {
    trValues.push(trueRange(completed[index], completed[index - 1].close));
  }
  const atrWindow = trValues.slice(-ATR_PERIOD);
  const movingAverage = average(maWindow.map((row) => row.close));
  const atr = average(atrWindow);
  if (movingAverage == null || atr == null || !(atr > 0)) {
    return {
      strategyId: STRATEGY_ID,
      status: 'INSUFFICIENT',
      direction: null,
      previousHigh: previous.high,
      previousLow: previous.low,
      sessionOpen: current.open,
      movingAverage,
      atr,
      longTarget: null,
      shortTarget: null,
      stopPrice: null,
      latestTimestamp: current.time,
      reasons: ['indicator_history_insufficient'],
    };
  }

  const previousRange = previous.high - previous.low;
  const longTarget = current.open + previousRange * K;
  const shortTarget = current.open - previousRange * K;
  const longBreakout = input.currentPrice >= longTarget;
  const longTrendPass = current.open > movingAverage;
  const shortBreakout = input.currentPrice <= shortTarget;
  const shortTrendPass = current.open < movingAverage;

  let direction: 'LONG' | 'SHORT' | null = null;
  const reasons: string[] = [];
  if (longBreakout && longTrendPass) {
    direction = 'LONG';
    reasons.push('long_breakout', 'long_trend_filter_pass');
  } else if (input.market === 'futures' && shortBreakout && shortTrendPass) {
    direction = 'SHORT';
    reasons.push('short_breakout', 'short_trend_filter_pass');
  } else {
    if (longBreakout && !longTrendPass) reasons.push('long_trend_filter_rejected');
    if (input.market === 'futures' && shortBreakout && !shortTrendPass) reasons.push('short_trend_filter_rejected');
    if (!longBreakout && !(input.market === 'futures' && shortBreakout)) reasons.push('breakout_not_reached');
    if (input.market === 'spot' && shortBreakout) reasons.push('spot_short_disabled');
  }

  const stopDistance = atr * ATR_STOP_MULTIPLIER;
  const stopPrice = direction === 'LONG'
    ? input.currentPrice - stopDistance
    : direction === 'SHORT'
      ? input.currentPrice + stopDistance
      : null;
  if (stopPrice != null && stopPrice <= 0) {
    return {
      strategyId: STRATEGY_ID,
      status: 'NO_ENTRY',
      direction: null,
      previousHigh: previous.high,
      previousLow: previous.low,
      sessionOpen: current.open,
      movingAverage,
      atr,
      longTarget,
      shortTarget: input.market === 'futures' ? shortTarget : null,
      stopPrice: null,
      latestTimestamp: current.time,
      reasons: [...reasons, 'non_positive_stop_price'],
    };
  }

  return {
    strategyId: STRATEGY_ID,
    status: direction ? 'ENTRY' : 'NO_ENTRY',
    direction,
    previousHigh: round(previous.high),
    previousLow: round(previous.low),
    sessionOpen: round(current.open),
    movingAverage: round(movingAverage),
    atr: round(atr),
    longTarget: round(longTarget),
    shortTarget: input.market === 'futures' ? round(shortTarget) : null,
    stopPrice: stopPrice == null ? null : round(stopPrice),
    latestTimestamp: current.time,
    reasons,
  };
}

async function fetchJson<T>(url: string, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('WILLIAMS_DAILY_TIMEOUT')), FETCH_TIMEOUT_MS);
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'seungjae-williams-scanner/1.0' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
  }
}

async function fetchDailyCandles(
  market: CryptoWilliamsMarket,
  symbol: string,
  signal?: AbortSignal,
): Promise<CryptoWilliamsDailyCandle[]> {
  if (market === 'spot') {
    const rows = await fetchJson<UpbitDailyCandleRow[]>(
      `${UPBIT_BASE}/v1/candles/days?market=${encodeURIComponent(`KRW-${symbol}`)}&count=${DAILY_LIMIT}`,
      signal,
    );
    return normalizeDailyCandles(rows.map((row) => ({
      time: finite(row.timestamp) ?? Date.parse(text(row.candle_date_time_utc)),
      open: finite(row.opening_price) ?? Number.NaN,
      high: finite(row.high_price) ?? Number.NaN,
      low: finite(row.low_price) ?? Number.NaN,
      close: finite(row.trade_price) ?? Number.NaN,
    })));
  }
  const payload = await fetchJson<BitgetEnvelope<unknown[]>>(
    `${BITGET_BASE}/api/v2/mix/market/candles?symbol=${encodeURIComponent(symbol)}&productType=${BITGET_PRODUCT_TYPE}&granularity=1D&limit=${DAILY_LIMIT}`,
    signal,
  );
  if (text(payload.code) !== '00000' || !Array.isArray(payload.data)) throw new Error('BITGET_DAILY_INVALID');
  const rows: CryptoWilliamsDailyCandle[] = [];
  for (const raw of payload.data) {
    if (!Array.isArray(raw)) continue;
    rows.push({
      time: finite(raw[0]) ?? Number.NaN,
      open: finite(raw[1]) ?? Number.NaN,
      high: finite(raw[2]) ?? Number.NaN,
      low: finite(raw[3]) ?? Number.NaN,
      close: finite(raw[4]) ?? Number.NaN,
    });
  }
  return normalizeDailyCandles(rows);
}

function recomputeRiskReward(card: ScannerSignalCard, stopPrice: number): number | null {
  const firstTarget = card.pricePlan.targets[0];
  if (firstTarget == null) return null;
  const risk = card.direction === 'LONG' ? card.price - stopPrice : stopPrice - card.price;
  const reward = card.direction === 'LONG' ? firstTarget - card.price : card.price - firstTarget;
  return risk > 0 && reward > 0 ? round(reward / risk, 2) : null;
}

function overlayCard(
  card: ScannerSignalCard,
  evaluation: CryptoWilliamsEvaluation,
  market: CryptoWilliamsMarket,
): ScannerSignalCard {
  const directionAligned = evaluation.status === 'ENTRY' && evaluation.direction === card.direction;
  const observedAt = evaluation.latestTimestamp == null ? card.observedAt : new Date(evaluation.latestTimestamp).toISOString();
  const evidence: ScannerEvidence = {
    key: STRATEGY_ID,
    label: 'Williams 변동성 돌파 + ATR',
    status: evaluation.status === 'INSUFFICIENT' ? 'unverified' : directionAligned ? 'matched' : 'not_matched',
    source: market === 'spot' ? 'upbit-public-daily-candles' : 'bitget-public-daily-candles',
    observedAt,
    reasons: [
      evaluation.previousHigh == null || evaluation.previousLow == null
        ? '전일 범위 미확인'
        : `전일 H/L ${evaluation.previousHigh}/${evaluation.previousLow}`,
      evaluation.sessionOpen == null ? 'KST 09:00 시가 미확인' : `KST 09:00 시가 ${evaluation.sessionOpen}`,
      evaluation.movingAverage == null ? 'MA5 미확인' : `완료 세션 MA5 ${evaluation.movingAverage}`,
      evaluation.atr == null ? 'ATR14 미확인' : `완료 세션 ATR14 ${evaluation.atr}`,
      evaluation.longTarget == null ? 'LONG 목표가 미확인' : `LONG 돌파선 ${evaluation.longTarget}`,
      ...(market === 'futures' && evaluation.shortTarget != null ? [`SHORT 돌파선 ${evaluation.shortTarget}`] : []),
      ...evaluation.reasons,
      '실거래 주문 없음 · Paper/Shadow 연구 전용',
    ],
  };
  const evidenceList = [...card.evidence.filter((item) => item.key !== STRATEGY_ID), evidence];
  const warnings = [...card.warnings];
  if (market === 'futures') {
    warnings.push('Williams 선물 Shadow 승격에는 사용자 레버리지·청산가 검증이 추가로 필요합니다.');
  }

  let pricePlan: ScannerPricePlan = card.pricePlan;
  if (directionAligned && evaluation.stopPrice != null) {
    const entryTarget = card.direction === 'LONG' ? evaluation.longTarget : evaluation.shortTarget;
    const entryZone = entryTarget == null
      ? card.pricePlan.entryZone
      : card.direction === 'LONG'
        ? { from: Math.min(entryTarget, card.price), to: card.price }
        : { from: card.price, to: Math.max(entryTarget, card.price) };
    pricePlan = {
      ...card.pricePlan,
      entryZone,
      invalidation: evaluation.stopPrice,
      stopLoss: evaluation.stopPrice,
      riskReward: recomputeRiskReward(card, evaluation.stopPrice),
    };
  }

  const demoted = !directionAligned;
  const signalGrade = demoted && (card.signalGrade === 'S' || card.signalGrade === 'A') ? 'B' as const : card.signalGrade;
  return {
    ...card,
    pricePlan,
    strongSignalEligible: card.strongSignalEligible && directionAligned,
    signalGrade,
    signalState: demoted && card.signalState !== 'INVALIDATED' ? 'CANDIDATE' : card.signalState,
    evidence: evidenceList,
    matched: [...new Set(evidenceList.filter((item) => item.status === 'matched').map((item) => item.label))],
    notMatched: [...new Set(evidenceList.filter((item) => item.status === 'not_matched').map((item) => item.label))],
    unverified: [...new Set(evidenceList.filter((item) => item.status === 'unverified').map((item) => item.label))],
    dataSources: [...new Set([...card.dataSources, evidence.source])],
    warnings: [...new Set(warnings)],
  };
}

function unavailableCard(card: ScannerSignalCard, market: CryptoWilliamsMarket, message: string): ScannerSignalCard {
  return overlayCard(card, {
    strategyId: STRATEGY_ID,
    status: 'INSUFFICIENT',
    direction: null,
    previousHigh: null,
    previousLow: null,
    sessionOpen: null,
    movingAverage: null,
    atr: null,
    longTarget: null,
    shortTarget: null,
    stopPrice: null,
    latestTimestamp: null,
    reasons: [`daily_provider_unavailable:${message.slice(0, 80)}`],
  }, market);
}

export const CryptoWilliamsAtrScannerOverlayService: CryptoWilliamsOverlayRunner = {
  async apply(input) {
    const cards = new Array<ScannerSignalCard>(input.cards.length);
    let cursor = 0;
    let matchedCount = 0;
    let unavailableCount = 0;

    const worker = async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= input.cards.length) return;
        const card = input.cards[index];
        try {
          const daily = await fetchDailyCandles(input.market, card.symbol, input.signal);
          const evaluation = evaluateCryptoWilliamsDailyCandles({
            market: input.market,
            candles: daily,
            currentPrice: card.price,
          });
          const next = overlayCard(card, evaluation, input.market);
          if (evaluation.status === 'ENTRY' && evaluation.direction === card.direction) matchedCount += 1;
          if (evaluation.status === 'INSUFFICIENT') unavailableCount += 1;
          cards[index] = next;
        } catch (error) {
          if (input.signal?.aborted) throw input.signal.reason ?? error;
          unavailableCount += 1;
          cards[index] = unavailableCard(card, input.market, error instanceof Error ? error.message : 'unknown');
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(OVERLAY_CONCURRENCY, input.cards.length) }, () => worker()));
    return { cards, matchedCount, unavailableCount };
  },
};
