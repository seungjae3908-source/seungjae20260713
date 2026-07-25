// Technical signal computation from a real daily price/volume series.
import type { DailyBar } from '../providers/alphavantage';

export type SignalTone = 'positive' | 'neutral' | 'negative';

export interface Signal {
  key: string;
  label: string;
  active: boolean;
  tone: SignalTone;
  detail: string;
}

function sma(closes: number[], period: number, endIdx: number): number | null {
  if (endIdx + 1 < period) return null;
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) sum += closes[i];
  return sum / period;
}

function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface SignalResult {
  signals: Signal[];
  rsi: number | null;
  goldenCross: boolean;
  deadCross: boolean;
  volumeSurge: boolean;
}

export function computeSignals(bars: DailyBar[]): SignalResult {
  const closes = bars.map((b) => b.close);
  const last = closes.length - 1;

  const sma20Now = sma(closes, 20, last);
  const sma50Now = sma(closes, 50, last);
  const sma20Prev = sma(closes, 20, last - 1);
  const sma50Prev = sma(closes, 50, last - 1);

  let goldenCross = false;
  let deadCross = false;
  if (
    sma20Now !== null &&
    sma50Now !== null &&
    sma20Prev !== null &&
    sma50Prev !== null
  ) {
    goldenCross = sma20Prev <= sma50Prev && sma20Now > sma50Now;
    deadCross = sma20Prev >= sma50Prev && sma20Now < sma50Now;
  }

  const vols = bars.map((b) => b.volume);
  let volumeSurge = false;
  let volRatio = 0;
  if (vols.length >= 21) {
    const recent = vols[last];
    const avg = vols.slice(last - 20, last).reduce((s, v) => s + v, 0) / 20;
    volRatio = avg > 0 ? recent / avg : 0;
    volumeSurge = volRatio >= 1.5;
  }

  const rsiVal = rsi(closes);
  const overbought = rsiVal !== null && rsiVal >= 70;
  const oversold = rsiVal !== null && rsiVal <= 30;

  const signals: Signal[] = [
    {
      key: 'golden_cross',
      label: '골든크로스',
      active: goldenCross,
      tone: goldenCross ? 'positive' : 'neutral',
      detail: goldenCross
        ? '20일선이 50일선을 상향 돌파했습니다.'
        : '최근 골든크로스는 발생하지 않았습니다.',
    },
    {
      key: 'dead_cross',
      label: '데드크로스',
      active: deadCross,
      tone: deadCross ? 'negative' : 'neutral',
      detail: deadCross
        ? '20일선이 50일선을 하향 돌파했습니다.'
        : '최근 데드크로스는 발생하지 않았습니다.',
    },
    {
      key: 'volume_surge',
      label: '거래량 급증',
      active: volumeSurge,
      tone: volumeSurge ? 'positive' : 'neutral',
      detail: volumeSurge
        ? `최근 거래량이 20일 평균의 ${volRatio.toFixed(1)}배입니다.`
        : '거래량은 평균 수준입니다.',
    },
    {
      key: 'rsi_overbought',
      label: 'RSI 과매수',
      active: overbought,
      tone: 'neutral',
      detail:
        rsiVal === null
          ? 'RSI 데이터가 부족합니다.'
          : overbought
          ? `RSI ${rsiVal.toFixed(0)} — 과매수 구간입니다.`
          : `RSI ${rsiVal.toFixed(0)} — 과매수 아님.`,
    },
    {
      key: 'rsi_oversold',
      label: 'RSI 과매도',
      active: oversold,
      tone: 'neutral',
      detail:
        rsiVal === null
          ? 'RSI 데이터가 부족합니다.'
          : oversold
          ? `RSI ${rsiVal.toFixed(0)} — 과매도 구간입니다.`
          : `RSI ${rsiVal.toFixed(0)} — 과매도 아님.`,
    },
  ];

  return { signals, rsi: rsiVal, goldenCross, deadCross, volumeSurge };
}
