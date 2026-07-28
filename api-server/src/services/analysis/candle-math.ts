// 3차 작업 공용 기술적 분석 헬퍼.
// 실제 캔들 값 기반 지표/패턴 계산만 수행한다. 가짜 데이터 생성 금지.
// 신규 파일이며 기존 서비스는 수정하지 않는다.

export interface Bar {
  time: number | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function toBars(rows: Array<Partial<Bar>>): Bar[] {
  const bars: Bar[] = [];
  for (const row of rows) {
    const open = Number(row.open);
    const high = Number(row.high);
    const low = Number(row.low);
    const close = Number(row.close);
    const volume = Number(row.volume ?? 0);
    if (
      row.time == null ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      continue;
    }
    bars.push({
      time: row.time,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? volume : 0,
    });
  }
  return bars;
}

export function avg(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i += 1) {
    if (i + 1 < period) {
      out.push(null);
      continue;
    }
    const slice = values.slice(i + 1 - period, i + 1);
    out.push(slice.reduce((s, v) => s + v, 0) / period);
  }
  return out;
}

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (prev == null) {
      if (i + 1 >= period) {
        prev = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
        out.push(prev);
      } else {
        out.push(null);
      }
      continue;
    }
    prev = value * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    const g = diff >= 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): { macd: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] } {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) => {
    const f = emaFast[i];
    const s = emaSlow[i];
    return f != null && s != null ? f - s : null;
  });
  const macdDefined = macdLine.map((v) => (v == null ? 0 : v));
  const firstDefined = macdLine.findIndex((v) => v != null);
  const signalRaw = ema(macdDefined.slice(firstDefined >= 0 ? firstDefined : 0), signalPeriod);
  const signal: (number | null)[] = new Array(closes.length).fill(null);
  if (firstDefined >= 0) {
    for (let i = 0; i < signalRaw.length; i += 1) {
      signal[firstDefined + i] = signalRaw[i];
    }
  }
  const hist = macdLine.map((v, i) => {
    const s = signal[i];
    return v != null && s != null ? v - s : null;
  });
  return { macd: macdLine, signal, hist };
}

export function atr(bars: Bar[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length <= period) return out;
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i += 1) {
    if (i === 0) {
      trs.push(bars[i].high - bars[i].low);
      continue;
    }
    const prevClose = bars[i - 1].close;
    trs.push(
      Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - prevClose),
        Math.abs(bars[i].low - prevClose),
      ),
    );
  }
  let prev = trs.slice(1, period + 1).reduce((s, v) => s + v, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < bars.length; i += 1) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function bollinger(
  closes: number[],
  period = 20,
  mult = 2,
): { mid: (number | null)[]; upper: (number | null)[]; lower: (number | null)[] } {
  const mid = sma(closes, period);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  for (let i = 0; i < closes.length; i += 1) {
    const m = mid[i];
    if (m == null) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    const slice = closes.slice(i + 1 - period, i + 1);
    const variance = slice.reduce((s, v) => s + (v - m) * (v - m), 0) / period;
    const sd = Math.sqrt(variance);
    upper.push(m + mult * sd);
    lower.push(m - mult * sd);
  }
  return { mid, upper, lower };
}

export function last<T>(arr: T[]): T | null {
  return arr.length ? arr[arr.length - 1] : null;
}

export function lastNonNull(arr: (number | null)[]): number | null {
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (arr[i] != null) return arr[i];
  }
  return null;
}

export function pctChange(from: number, to: number): number {
  if (!from) return 0;
  return ((to - from) / Math.abs(from)) * 100;
}

// 최근 lookback 봉의 저점 클러스터(지지) / 고점 클러스터(저항).
// 단순화된 min/max 기반. 데이터 부족 시 null.
export function supportResistance(
  bars: Bar[],
  lookback = 60,
): { support: number | null; resistance: number | null } {
  const window = bars.slice(-lookback);
  if (window.length < 10) return { support: null, resistance: null };
  const lows = window.map((b) => b.low);
  const highs = window.map((b) => b.high);
  return {
    support: Math.min(...lows),
    resistance: Math.max(...highs),
  };
}

export type TrendState = '상승추세' | '하락추세' | '횡보';

export function trendState(closes: number[]): TrendState {
  if (closes.length < 25) return '횡보';
  const ma20 = avg(closes.slice(-20));
  const ma20Prev = avg(closes.slice(-25, -5));
  const latest = last(closes);
  if (ma20 == null || ma20Prev == null || latest == null) return '횡보';
  const slope = pctChange(ma20Prev, ma20);
  if (latest > ma20 && slope > 0.8) return '상승추세';
  if (latest < ma20 && slope < -0.8) return '하락추세';
  return '횡보';
}

export function volumeState(bars: Bar[]): string {
  if (bars.length < 21) return '거래량 데이터 부족';
  const latest = bars[bars.length - 1].volume;
  const base = avg(bars.slice(-21, -1).map((b) => b.volume));
  if (!base || base <= 0) return '거래량 기준 부족';
  const ratio = latest / base;
  if (ratio >= 2) return `거래량 급증(평균 대비 ${ratio.toFixed(1)}배)`;
  if (ratio >= 1.3) return `거래량 증가(평균 대비 ${ratio.toFixed(1)}배)`;
  if (ratio <= 0.6) return `거래량 감소(평균 대비 ${ratio.toFixed(1)}배)`;
  return '거래량 보통';
}
