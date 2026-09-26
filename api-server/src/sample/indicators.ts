// Pure technical-analysis math computed from a candle series. Used for the
// chart overlays, the auto-detected signals, and the technical score.
import type { Candle, IndicatorSeries, Signal } from './types';

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

export function rsiSeries(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d >= 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (prev === null) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += values[j];
      prev = sum / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

export function macdSeries(values: number[]) {
  const fast = ema(values, 12);
  const slow = ema(values, 26);
  const macd = values.map((_, i) =>
    fast[i] !== null && slow[i] !== null ? (fast[i] as number) - (slow[i] as number) : null,
  );
  const macdVals = macd.map((v) => (v === null ? 0 : v));
  const firstIdx = macd.findIndex((v) => v !== null);
  const signalRaw = ema(macdVals, 9);
  const signal = signalRaw.map((v, i) => (i >= firstIdx + 8 && v !== null ? v : null));
  const hist = macd.map((v, i) =>
    v !== null && signal[i] !== null ? v - (signal[i] as number) : null,
  );
  return { macd, signal, hist };
}

export function computeIndicators(candles: Candle[]): IndicatorSeries {
  const closes = candles.map((c) => c.close);
  return {
    ma20: sma(closes, 20),
    ma60: sma(closes, 60),
    ma120: sma(closes, 120),
    ma240: sma(closes, 240),
    rsi: rsiSeries(closes, 14),
    macd: macdSeries(closes),
  };
}

function lastTwo(arr: (number | null)[]): [number, number] | null {
  const n = arr.length;
  const a = arr[n - 2];
  const b = arr[n - 1];
  if (a === null || b === null || a === undefined || b === undefined) return null;
  return [a, b];
}

// Auto-detects the signals the spec requires from real indicator series.
export function detectSignals(candles: Candle[], ind: IndicatorSeries): Signal[] {
  const signals: Signal[] = [];
  const n = candles.length;

  // Golden / dead cross: MA20 vs MA60
  const s20 = lastTwo(ind.ma20);
  const s60 = lastTwo(ind.ma60);
  let golden = false;
  let dead = false;
  if (s20 && s60) {
    golden = s20[0] <= s60[0] && s20[1] > s60[1];
    dead = s20[0] >= s60[0] && s20[1] < s60[1];
  }
  signals.push({
    key: 'golden_cross',
    label: '골든크로스',
    active: golden,
    tone: golden ? 'positive' : 'neutral',
    detail: golden
      ? '20일선이 60일선을 상향 돌파했습니다.'
      : '최근 골든크로스는 발생하지 않았습니다.',
  });
  signals.push({
    key: 'dead_cross',
    label: '데드크로스',
    active: dead,
    tone: dead ? 'negative' : 'neutral',
    detail: dead
      ? '20일선이 60일선을 하향 돌파했습니다.'
      : '최근 데드크로스는 발생하지 않았습니다.',
  });

  // Volume surge: last vs 20-bar average
  let volSurge = false;
  let ratio = 0;
  if (n >= 21) {
    const avg = candles.slice(n - 21, n - 1).reduce((s, c) => s + c.volume, 0) / 20;
    ratio = avg > 0 ? candles[n - 1].volume / avg : 0;
    volSurge = ratio >= 1.8;
  }
  signals.push({
    key: 'volume_surge',
    label: '거래량 급증',
    active: volSurge,
    tone: volSurge ? 'positive' : 'neutral',
    detail: volSurge
      ? `최근 거래량이 20봉 평균의 ${ratio.toFixed(1)}배입니다.`
      : '거래량은 평균 수준입니다.',
  });

  // RSI zones
  const rsi = ind.rsi[n - 1];
  const overbought = rsi !== null && rsi !== undefined && rsi >= 70;
  const oversold = rsi !== null && rsi !== undefined && rsi <= 30;
  signals.push({
    key: 'rsi_overbought',
    label: 'RSI 과매수',
    active: overbought,
    tone: 'neutral',
    detail:
      rsi == null ? 'RSI 데이터가 부족합니다.' : `RSI ${rsi.toFixed(0)} — ${overbought ? '과매수 구간' : '과매수 아님'}.`,
  });
  signals.push({
    key: 'rsi_oversold',
    label: 'RSI 과매도',
    active: oversold,
    tone: 'neutral',
    detail:
      rsi == null ? 'RSI 데이터가 부족합니다.' : `RSI ${rsi.toFixed(0)} — ${oversold ? '과매도 구간' : '과매도 아님'}.`,
  });

  // MACD buy / sell (macd vs signal cross)
  const m = lastTwo(ind.macd.macd);
  const sig = lastTwo(ind.macd.signal);
  let macdBuy = false;
  let macdSell = false;
  if (m && sig) {
    macdBuy = m[0] <= sig[0] && m[1] > sig[1];
    macdSell = m[0] >= sig[0] && m[1] < sig[1];
  }
  signals.push({
    key: 'macd_buy',
    label: 'MACD 매수 신호',
    active: macdBuy,
    tone: macdBuy ? 'positive' : 'neutral',
    detail: macdBuy ? 'MACD가 시그널선을 상향 돌파했습니다.' : 'MACD 매수 신호가 없습니다.',
  });
  signals.push({
    key: 'macd_sell',
    label: 'MACD 매도 신호',
    active: macdSell,
    tone: macdSell ? 'negative' : 'neutral',
    detail: macdSell ? 'MACD가 시그널선을 하향 돌파했습니다.' : 'MACD 매도 신호가 없습니다.',
  });

  return signals;
}

// Technical score 0-100 derived from the detected signals + trend + RSI.
export function technicalScore(candles: Candle[], ind: IndicatorSeries, signals: Signal[]): number {
  let score = 50;
  const map = new Map(signals.map((s) => [s.key, s]));
  if (map.get('golden_cross')?.active) score += 12;
  if (map.get('dead_cross')?.active) score -= 12;
  if (map.get('volume_surge')?.active) score += 5;
  if (map.get('macd_buy')?.active) score += 10;
  if (map.get('macd_sell')?.active) score -= 10;

  const n = candles.length;
  const price = candles[n - 1]?.close ?? 0;
  const ma60 = ind.ma60[n - 1];
  if (ma60) score += price > ma60 ? 8 : -8; // trend
  const rsi = ind.rsi[n - 1];
  if (rsi != null) {
    if (rsi >= 70) score -= 6;
    else if (rsi <= 30) score += 6;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}
