// 공부(learn) 전용 실데이터 신호·패턴 탐지 유틸.
// 실제 캔들 데이터에서만 사례를 찾는다. 억지 매칭·가짜 마커를 금지한다.

export interface StudyRow {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// 실데이터에서 탐지 가능한 신호 종류 (2번/4번 요구)
export type SignalKind =
  | 'bullish'
  | 'bearish'
  | 'doji'
  | 'hammer'
  | 'invertedHammer'
  | 'longBullish'
  | 'longBearish'
  | 'bullishEngulfing'
  | 'bearishEngulfing'
  | 'morningStar'
  | 'eveningStar'
  | 'support'
  | 'resistance'
  | 'trendUp'
  | 'box'
  | 'breakout'
  | 'gap'
  | 'volume'
  | 'goldenCross'
  | 'deadCross'
  | 'rsiOversold'
  | 'rsiOverbought'
  | 'macdBuy'
  | 'macdSell'
  | 'bollingerBreak'
  | 'atrSpike'
  | 'stochOversold'
  | 'obvUp';

// 차트 패턴 종류 (5번/6번 요구)
export type PatternKind =
  | 'doubleBottom'
  | 'doubleTop'
  | 'headShoulders'
  | 'invHeadShoulders'
  | 'ascTriangle'
  | 'descTriangle'
  | 'symTriangle'
  | 'bullFlag'
  | 'bearFlag'
  | 'risingWedge'
  | 'fallingWedge'
  | 'cupHandle'
  | 'box'
  | 'boxBreakUp'
  | 'boxBreakDown'
  | 'roundingBottom'
  | 'vRecovery'
  | 'gapUp'
  | 'gapDown';

export interface StudyOccurrence {
  index: number; // 신호 발생 캔들 인덱스 (신호 마커 위치)
  date: string; // 발생 날짜 표기
  price: number; // 당시 가격(종가)
  direction: 'up' | 'down';
  condition: string; // 판단 조건
  indicatorText: string; // 지표 값 요약
  description: string; // 짧은 설명
}

export interface PatternLine {
  // 캔들에 고정되는 선(추세선/넥라인/지지·저항)
  from: { index: number; price: number };
  to: { index: number; price: number };
  color: string;
  dashed?: boolean;
  label?: string;
}

export interface PatternPriceLine {
  price: number;
  color: string;
  label: string;
}

export interface PatternOccurrence {
  markerIndex: number; // 돌파/완성 지점 (마커)
  startIndex: number; // 패턴 시작
  endIndex: number; // 패턴 끝
  date: string;
  price: number;
  direction: 'up' | 'down';
  condition: string;
  indicatorText: string;
  description: string;
  lines: PatternLine[];
  priceLines: PatternPriceLine[];
}

// ── 공용 계산 ─────────────────────────────────────────
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function toStudyRows(
  candles: { time: string | number; open: number; high: number; low: number; close: number; volume: number }[],
): StudyRow[] {
  return candles
    .map((c) => ({
      time: String(c.time),
      open: num(c.open),
      high: num(c.high),
      low: num(c.low),
      close: num(c.close),
      volume: num(c.volume),
    }))
    .filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite));
}

export function fmtStudyDate(time: string): string {
  if (!time) return '정보 없음';
  const digits = time.replace(/[^0-9]/g, '');
  if (digits.length >= 8) {
    return `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6, 8)}`;
  }
  return time;
}

function smaAt(values: number[], period: number, at: number): number | null {
  if (at < period - 1) return null;
  let sum = 0;
  for (let i = at - period + 1; i <= at; i += 1) sum += values[i];
  return sum / period;
}

export function smaSeries(values: number[], period: number): (number | null)[] {
  return values.map((_, i) => smaAt(values, period, i));
}

export function rsiSeries(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = closes.map(() => null);
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
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i += 1) {
    if (prev == null) {
      if (i >= period - 1) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j += 1) sum += values[j];
        prev = sum / period;
        out[i] = prev;
      }
    } else {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

export interface MacdSeries {
  macd: (number | null)[];
  signal: (number | null)[];
  hist: (number | null)[];
}

export function macdSeries(closes: number[]): MacdSeries {
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const macd = closes.map((_, i) =>
    fast[i] != null && slow[i] != null ? (fast[i] as number) - (slow[i] as number) : null,
  );
  const macdFilled = macd.map((v) => (v == null ? 0 : v));
  const signal = emaSeries(macdFilled, 9);
  const hist = macd.map((v, i) => (v != null && signal[i] != null ? v - (signal[i] as number) : null));
  return { macd, signal, hist };
}

function body(r: StudyRow) {
  return Math.abs(r.close - r.open);
}
function rangeOf(r: StudyRow) {
  return Math.max(r.high - r.low, 1e-9);
}
function isBull(r: StudyRow) {
  return r.close > r.open;
}
function isBear(r: StudyRow) {
  return r.close < r.open;
}
function avgBody(rows: StudyRow[], at: number, period = 20) {
  const from = Math.max(0, at - period);
  const slice = rows.slice(from, at);
  if (!slice.length) return 0;
  return slice.reduce((s, r) => s + body(r), 0) / slice.length;
}

// ── 신호 탐지 ─────────────────────────────────────────
export function detectSignals(kind: SignalKind, rows: StudyRow[]): StudyOccurrence[] {
  const out: StudyOccurrence[] = [];
  const closes = rows.map((r) => r.close);
  const volumes = rows.map((r) => r.volume);
  const n = rows.length;
  const rsi = rsiSeries(closes);
  const macd = macdSeries(closes);

  const push = (
    i: number,
    direction: 'up' | 'down',
    condition: string,
    indicatorText: string,
    description: string,
  ) =>
    out.push({
      index: i,
      date: fmtStudyDate(rows[i].time),
      price: rows[i].close,
      direction,
      condition,
      indicatorText,
      description,
    });

  for (let i = 0; i < n; i += 1) {
    const r = rows[i];
    const prev = i > 0 ? rows[i - 1] : null;
    const priceStr = `종가 ${Math.round(r.close).toLocaleString()}`;
    switch (kind) {
      case 'bullish':
        if (isBull(r) && body(r) >= avgBody(rows, i) * 0.8)
          push(i, 'up', `종가 ${Math.round(r.close).toLocaleString()} > 시가 ${Math.round(r.open).toLocaleString()}`, priceStr, '매수세가 우위였던 상승 마감 캔들입니다.');
        break;
      case 'bearish':
        if (isBear(r) && body(r) >= avgBody(rows, i) * 0.8)
          push(i, 'down', `종가 ${Math.round(r.close).toLocaleString()} < 시가 ${Math.round(r.open).toLocaleString()}`, priceStr, '매도세가 우위였던 하락 마감 캔들입니다.');
        break;
      case 'doji':
        if (body(r) <= rangeOf(r) * 0.1)
          push(i, 'up', '몸통이 고저폭의 10% 이하', priceStr, '매수·매도가 팽팽한 결정 보류 캔들입니다.');
        break;
      case 'hammer': {
        const lower = Math.min(r.open, r.close) - r.low;
        const upper = r.high - Math.max(r.open, r.close);
        if (lower >= body(r) * 2 && upper <= body(r) && body(r) > 0)
          push(i, 'up', '아래꼬리 ≥ 몸통의 2배', priceStr, '저가에서 매수세가 강하게 들어온 반등형입니다.');
        break;
      }
      case 'invertedHammer': {
        const lower = Math.min(r.open, r.close) - r.low;
        const upper = r.high - Math.max(r.open, r.close);
        if (upper >= body(r) * 2 && lower <= body(r) && body(r) > 0)
          push(i, 'up', '위꼬리 ≥ 몸통의 2배', priceStr, '하락권에서 매수 시도가 나온 캔들입니다.');
        break;
      }
      case 'longBullish':
        if (isBull(r) && avgBody(rows, i) > 0 && body(r) >= avgBody(rows, i) * 2)
          push(i, 'up', '몸통이 최근 평균의 2배 이상', priceStr, '강한 매수 에너지가 유입된 장대양봉입니다.');
        break;
      case 'longBearish':
        if (isBear(r) && avgBody(rows, i) > 0 && body(r) >= avgBody(rows, i) * 2)
          push(i, 'down', '몸통이 최근 평균의 2배 이상', priceStr, '강한 매도 압력이 유입된 장대음봉입니다.');
        break;
      case 'bullishEngulfing':
        if (prev && isBear(prev) && isBull(r) && r.close >= prev.open && r.open <= prev.close)
          push(i, 'up', '양봉이 전일 음봉 몸통을 완전히 감쌈', priceStr, '매도세를 매수세가 강하게 역전한 상승 반전형입니다.');
        break;
      case 'bearishEngulfing':
        if (prev && isBull(prev) && isBear(r) && r.open >= prev.close && r.close <= prev.open)
          push(i, 'down', '음봉이 전일 양봉 몸통을 완전히 감쌈', priceStr, '매수세를 매도세가 강하게 역전한 하락 반전형입니다.');
        break;
      case 'morningStar':
        if (i >= 2) {
          const a = rows[i - 2];
          const b = rows[i - 1];
          if (
            isBear(a) && body(a) >= avgBody(rows, i - 2) && body(b) <= rangeOf(b) * 0.4 &&
            isBull(r) && r.close > (a.open + a.close) / 2
          )
            push(i, 'up', '음봉→작은 몸통→양봉 3봉', priceStr, '바닥권 상승 반전(샛별형)입니다.');
        }
        break;
      case 'eveningStar':
        if (i >= 2) {
          const a = rows[i - 2];
          const b = rows[i - 1];
          if (
            isBull(a) && body(a) >= avgBody(rows, i - 2) && body(b) <= rangeOf(b) * 0.4 &&
            isBear(r) && r.close < (a.open + a.close) / 2
          )
            push(i, 'down', '양봉→작은 몸통→음봉 3봉', priceStr, '고점권 하락 반전(석별형)입니다.');
        }
        break;
      case 'gap':
        if (prev && (r.low > prev.high || r.high < prev.low)) {
          const up = r.low > prev.high;
          push(i, up ? 'up' : 'down', up ? '당일 저가 > 전일 고가' : '당일 고가 < 전일 저가', priceStr, up ? '강한 호재성 상승 갭입니다.' : '강한 악재성 하락 갭입니다.');
        }
        break;
      case 'volume': {
        const va = smaAt(volumes, 20, i - 1);
        if (va != null && va > 0 && r.volume >= va * 2.5) {
          const ratio = Math.round((r.volume / va) * 10) / 10;
          push(i, isBull(r) ? 'up' : 'down', '거래량 ≥ 20일 평균의 2.5배', `거래량 ${ratio}배`, '평소보다 관심·수급이 폭증한 구간입니다.');
        }
        break;
      }
      case 'atrSpike': {
        if (i >= 15) {
          const trs: number[] = [];
          for (let j = i - 13; j <= i; j += 1) {
            const p = rows[j - 1];
            trs.push(Math.max(rows[j].high - rows[j].low, p ? Math.abs(rows[j].high - p.close) : 0, p ? Math.abs(rows[j].low - p.close) : 0));
          }
          const atr = trs.reduce((s, v) => s + v, 0) / trs.length;
          const tr = Math.max(r.high - r.low, prev ? Math.abs(r.high - prev.close) : 0, prev ? Math.abs(r.low - prev.close) : 0);
          if (atr > 0 && tr >= atr * 2)
            push(i, isBull(r) ? 'up' : 'down', '당일 진폭 ≥ 14일 ATR의 2배', `ATR 대비 ${Math.round((tr / atr) * 10) / 10}배`, '변동성이 급격히 커진 구간입니다.');
        }
        break;
      }
      case 'rsiOversold': {
        const cur = rsi[i];
        const before = rsi[i - 1];
        if (cur != null && before != null && before < 30 && cur >= 30)
          push(i, 'up', 'RSI 30 미만에서 회복', `RSI ${Math.round(cur)}`, '과매도 구간에서 벗어나는 기술적 반등 후보입니다.');
        break;
      }
      case 'rsiOverbought': {
        const cur = rsi[i];
        const before = rsi[i - 1];
        if (cur != null && before != null && before > 70 && cur <= 70)
          push(i, 'down', 'RSI 70 초과에서 이탈', `RSI ${Math.round(cur)}`, '과열 구간에서 식어가는 조정 위험 신호입니다.');
        break;
      }
      default:
        break;
    }
  }

  if (kind === 'goldenCross' || kind === 'deadCross') {
    for (let i = 1; i < n; i += 1) {
      const sp = smaAt(closes, 5, i - 1);
      const sc = smaAt(closes, 5, i);
      const lp = smaAt(closes, 20, i - 1);
      const lc = smaAt(closes, 20, i);
      if (sp == null || sc == null || lp == null || lc == null) continue;
      if (kind === 'goldenCross' && sp <= lp && sc > lc)
        push(i, 'up', '5일선이 20일선 상향 돌파', `MA5 ${Math.round(sc).toLocaleString()} / MA20 ${Math.round(lc).toLocaleString()}`, '단기 추세가 상승으로 전환되는 골든크로스입니다.');
      if (kind === 'deadCross' && sp >= lp && sc < lc)
        push(i, 'down', '5일선이 20일선 하향 이탈', `MA5 ${Math.round(sc).toLocaleString()} / MA20 ${Math.round(lc).toLocaleString()}`, '단기 추세가 하락으로 전환되는 데드크로스입니다.');
    }
  }

  if (kind === 'macdBuy' || kind === 'macdSell') {
    for (let i = 1; i < n; i += 1) {
      const mp = macd.macd[i - 1];
      const mc = macd.macd[i];
      const sp = macd.signal[i - 1];
      const sc = macd.signal[i];
      if (mp == null || mc == null || sp == null || sc == null) continue;
      if (kind === 'macdBuy' && mp <= sp && mc > sc)
        push(i, 'up', 'MACD선이 시그널선 상향 돌파', `MACD ${(mc).toFixed(1)}`, 'MACD 매수 전환(골든크로스)입니다.');
      if (kind === 'macdSell' && mp >= sp && mc < sc)
        push(i, 'down', 'MACD선이 시그널선 하향 이탈', `MACD ${(mc).toFixed(1)}`, 'MACD 매도 전환(데드크로스)입니다.');
    }
  }

  if (kind === 'bollingerBreak') {
    for (let i = 20; i < n; i += 1) {
      const mid = smaAt(closes, 20, i);
      if (mid == null) continue;
      let variance = 0;
      for (let j = i - 19; j <= i; j += 1) variance += (closes[j] - mid) ** 2;
      const sd = Math.sqrt(variance / 20);
      const upper = mid + sd * 2;
      if (closes[i - 1] <= upper && closes[i] > upper)
        push(i, 'up', '종가가 볼린저 상단 밴드 돌파', `상단 ${Math.round(upper).toLocaleString()}`, '변동성 확대와 함께 상단을 돌파한 구간입니다.');
    }
  }

  if (kind === 'stochOversold') {
    for (let i = 14; i < n; i += 1) {
      const w = rows.slice(i - 13, i + 1);
      const hi = Math.max(...w.map((x) => x.high));
      const lo = Math.min(...w.map((x) => x.low));
      const kCur = hi === lo ? 50 : ((rows[i].close - lo) / (hi - lo)) * 100;
      const wp = rows.slice(i - 14, i);
      const hiP = Math.max(...wp.map((x) => x.high));
      const loP = Math.min(...wp.map((x) => x.low));
      const kPrev = hiP === loP ? 50 : ((rows[i - 1].close - loP) / (hiP - loP)) * 100;
      if (kPrev < 20 && kCur >= 20)
        push(i, 'up', '스토캐스틱 %K 20 미만 회복', `%K ${Math.round(kCur)}`, '단기 과매도에서 벗어나는 반등 후보입니다.');
    }
  }

  if (kind === 'obvUp') {
    const obv: number[] = [0];
    for (let i = 1; i < n; i += 1) {
      const delta = closes[i] > closes[i - 1] ? volumes[i] : closes[i] < closes[i - 1] ? -volumes[i] : 0;
      obv.push(obv[i - 1] + delta);
    }
    for (let i = 10; i < n; i += 1) {
      if (closes[i] <= closes[i - 10] && obv[i] > obv[i - 10])
        push(i, 'up', '주가 횡보·하락 중 OBV 상승', 'OBV 상승 다이버전스', '가격보다 수급이 먼저 개선되는 매집 신호입니다.');
    }
  }

  if (kind === 'support' || kind === 'resistance' || kind === 'breakout' || kind === 'box' || kind === 'trendUp') {
    const lookback = 10;
    for (let i = lookback + 1; i < n; i += 1) {
      const past = rows.slice(Math.max(0, i - 60), i);
      if (past.length < lookback) continue;
      const swingLow = Math.min(...past.map((x) => x.low));
      const swingHigh = Math.max(...past.map((x) => x.high));
      const r = rows[i];
      const prevR = rows[i - 1];
      if (kind === 'support' && Math.abs(r.low - swingLow) <= swingLow * 0.02 && isBull(r))
        push(i, 'up', `최근 저점 ${Math.round(swingLow).toLocaleString()} 부근 반등`, `지지 ${Math.round(swingLow).toLocaleString()}`, '지지선에서 매수세가 들어와 반등한 구간입니다.');
      if (kind === 'resistance' && prevR.close <= swingHigh && r.close > swingHigh)
        push(i, 'up', `최근 고점 ${Math.round(swingHigh).toLocaleString()} 저항 돌파`, `저항 ${Math.round(swingHigh).toLocaleString()}`, '저항선을 종가로 돌파한 구간입니다.');
      if (kind === 'breakout' && prevR.close <= swingHigh && r.close > swingHigh && body(r) >= avgBody(rows, i))
        push(i, 'up', '저항선 종가 돌파(강한 양봉)', `저항 ${Math.round(swingHigh).toLocaleString()}`, '매물대를 소화하고 돌파한 구간입니다.');
      if (kind === 'trendUp' && i >= 20) {
        const maNow = smaAt(closes, 20, i);
        const maPrev = smaAt(closes, 20, i - 1);
        const maPast = smaAt(closes, 20, i - 5);
        if (maNow != null && maPast != null && maPrev != null && maNow > maPast && r.close > maNow && prevR.close <= maPrev)
          push(i, 'up', '상승 추세선(20일선) 지지 후 반등', `MA20 ${Math.round(maNow).toLocaleString()}`, '상승 추세를 유지하며 지지받은 구간입니다.');
      }
    }
    if (kind === 'box') {
      for (let i = n - 1; i >= 40; i -= 1) {
        const w = rows.slice(i - 39, i + 1);
        const hi = Math.max(...w.map((x) => x.high));
        const lo = Math.min(...w.map((x) => x.low));
        if (lo > 0 && (hi - lo) / lo <= 0.12) {
          push(i, 'up', `최근 40봉이 약 ${Math.round(((hi - lo) / lo) * 100)}% 범위 횡보`, `상단 ${Math.round(hi).toLocaleString()} / 하단 ${Math.round(lo).toLocaleString()}`, '방향 결정 전 에너지를 모으는 박스권입니다.');
          break;
        }
      }
    }
  }

  const seen = new Set<number>();
  return out
    .filter((o) => {
      if (seen.has(o.index)) return false;
      seen.add(o.index);
      return true;
    })
    .sort((a, b) => a.index - b.index);
}

// ── 피벗(스윙) 고·저점 ─────────────────────────────────
interface Pivot {
  index: number;
  price: number;
  kind: 'high' | 'low';
}

function findPivots(rows: StudyRow[], span = 3): Pivot[] {
  const out: Pivot[] = [];
  for (let i = span; i < rows.length - span; i += 1) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - span; j <= i + span; j += 1) {
      if (j === i) continue;
      if (rows[j].high >= rows[i].high) isHigh = false;
      if (rows[j].low <= rows[i].low) isLow = false;
    }
    if (isHigh) out.push({ index: i, price: rows[i].high, kind: 'high' });
    if (isLow) out.push({ index: i, price: rows[i].low, kind: 'low' });
  }
  return out.sort((a, b) => a.index - b.index);
}

const pct = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-9);

// ── 패턴 탐지 ─────────────────────────────────────────
export function detectPatterns(kind: PatternKind, rows: StudyRow[]): PatternOccurrence[] {
  const n = rows.length;
  if (n < 15) return [];
  const closes = rows.map((r) => r.close);
  const volumes = rows.map((r) => r.volume);
  const pivots = findPivots(rows, 3);
  const lows = pivots.filter((p) => p.kind === 'low');
  const highs = pivots.filter((p) => p.kind === 'high');
  const out: PatternOccurrence[] = [];

  const dateOf = (i: number) => fmtStudyDate(rows[i].time);
  const volNear = (i: number) => {
    const va = smaAt(volumes, 20, Math.max(0, i - 1));
    return va != null && va > 0 ? Math.round((volumes[i] / va) * 10) / 10 : null;
  };

  // 쌍바닥 / 쌍봉
  if (kind === 'doubleBottom' || kind === 'doubleTop') {
    const set = kind === 'doubleBottom' ? lows : highs;
    for (let a = 0; a < set.length - 1; a += 1) {
      for (let b = a + 1; b < set.length; b += 1) {
        const p1 = set[a];
        const p2 = set[b];
        if (p2.index - p1.index < 5 || p2.index - p1.index > 60) continue;
        if (pct(p1.price, p2.price) > 0.03) continue;
        // 두 저(고)점 사이 반대 극점(넥라인)
        const between = rows.slice(p1.index, p2.index + 1);
        const neck =
          kind === 'doubleBottom'
            ? Math.max(...between.map((r) => r.high))
            : Math.min(...between.map((r) => r.low));
        // 돌파 확인
        let breakIdx = -1;
        for (let i = p2.index + 1; i < Math.min(n, p2.index + 20); i += 1) {
          if (kind === 'doubleBottom' && rows[i].close > neck) { breakIdx = i; break; }
          if (kind === 'doubleTop' && rows[i].close < neck) { breakIdx = i; break; }
        }
        if (breakIdx < 0) continue;
        const dir = kind === 'doubleBottom' ? 'up' : 'down';
        out.push({
          markerIndex: breakIdx,
          startIndex: p1.index,
          endIndex: breakIdx,
          date: dateOf(breakIdx),
          price: rows[breakIdx].close,
          direction: dir,
          condition: kind === 'doubleBottom' ? '두 저점(±3%)+넥라인 상향 돌파' : '두 고점(±3%)+넥라인 하향 이탈',
          indicatorText: `넥라인 ${Math.round(neck).toLocaleString()}${volNear(breakIdx) != null ? ` · 돌파 거래량 ${volNear(breakIdx)}배` : ''}`,
          description: kind === 'doubleBottom' ? '두 번 바닥을 다진 뒤 넥라인을 돌파한 상승 반전형입니다.' : '두 번 고점에 막힌 뒤 넥라인을 이탈한 하락 반전형입니다.',
          lines: [
            { from: { index: p1.index, price: neck }, to: { index: breakIdx, price: neck }, color: '#a855f7', dashed: true, label: '넥라인' },
          ],
          priceLines: [{ price: neck, color: '#a855f7', label: '넥라인' }],
        });
        break;
      }
      if (out.length) break;
    }
  }

  // 머리어깨형 / 역머리어깨형
  if (kind === 'headShoulders' || kind === 'invHeadShoulders') {
    const set = kind === 'headShoulders' ? highs : lows;
    for (let a = 0; a < set.length - 2; a += 1) {
      const s1 = set[a];
      const head = set[a + 1];
      const s2 = set[a + 2];
      if (s2.index - s1.index > 70) continue;
      const headIsExtreme =
        kind === 'headShoulders'
          ? head.price > s1.price && head.price > s2.price
          : head.price < s1.price && head.price < s2.price;
      if (!headIsExtreme) continue;
      if (pct(s1.price, s2.price) > 0.05) continue; // 두 어깨 유사
      // 넥라인: 어깨 사이 반대 극점 두 곳 평균
      const seg1 = rows.slice(s1.index, head.index + 1);
      const seg2 = rows.slice(head.index, s2.index + 1);
      const neck =
        kind === 'headShoulders'
          ? (Math.min(...seg1.map((r) => r.low)) + Math.min(...seg2.map((r) => r.low))) / 2
          : (Math.max(...seg1.map((r) => r.high)) + Math.max(...seg2.map((r) => r.high))) / 2;
      let breakIdx = -1;
      for (let i = s2.index + 1; i < Math.min(n, s2.index + 20); i += 1) {
        if (kind === 'headShoulders' && rows[i].close < neck) { breakIdx = i; break; }
        if (kind === 'invHeadShoulders' && rows[i].close > neck) { breakIdx = i; break; }
      }
      if (breakIdx < 0) continue;
      const dir = kind === 'invHeadShoulders' ? 'up' : 'down';
      out.push({
        markerIndex: breakIdx,
        startIndex: s1.index,
        endIndex: breakIdx,
        date: dateOf(breakIdx),
        price: rows[breakIdx].close,
        direction: dir,
        condition: '왼쪽 어깨·머리·오른쪽 어깨 3피벗 + 넥라인 돌파',
        indicatorText: `넥라인 ${Math.round(neck).toLocaleString()}`,
        description: kind === 'headShoulders' ? '고점권 머리어깨형 완성 후 넥라인 이탈(하락 반전)입니다.' : '바닥권 역머리어깨형 완성 후 넥라인 돌파(상승 반전)입니다.',
        lines: [
          { from: { index: s1.index, price: neck }, to: { index: breakIdx, price: neck }, color: '#a855f7', dashed: true, label: '넥라인' },
        ],
        priceLines: [{ price: neck, color: '#a855f7', label: '넥라인' }],
      });
      break;
    }
  }

  // 삼각형(상승/하락/대칭)
  if (kind === 'ascTriangle' || kind === 'descTriangle' || kind === 'symTriangle') {
    const recentHighs = highs.slice(-4);
    const recentLows = lows.slice(-4);
    if (recentHighs.length >= 2 && recentLows.length >= 2) {
      const h1 = recentHighs[0];
      const h2 = recentHighs[recentHighs.length - 1];
      const l1 = recentLows[0];
      const l2 = recentLows[recentLows.length - 1];
      const highFlat = pct(h1.price, h2.price) <= 0.02;
      const highDown = h2.price < h1.price * 0.985;
      const lowFlat = pct(l1.price, l2.price) <= 0.02;
      const lowUp = l2.price > l1.price * 1.015;
      let match = false;
      let dir: 'up' | 'down' = 'up';
      let cond = '';
      if (kind === 'ascTriangle' && highFlat && lowUp) { match = true; dir = 'up'; cond = '수평 저항 + 저점 상승 추세선 수렴'; }
      if (kind === 'descTriangle' && lowFlat && highDown) { match = true; dir = 'down'; cond = '수평 지지 + 고점 하락 추세선 수렴'; }
      if (kind === 'symTriangle' && highDown && lowUp) { match = true; cond = '고점 하락·저점 상승 추세선 수렴'; }
      if (match) {
        const start = Math.min(h1.index, l1.index);
        const apexRef = Math.max(h2.index, l2.index);
        let breakIdx = -1;
        let breakDir: 'up' | 'down' = dir;
        const resistance = Math.max(h1.price, h2.price);
        const support = Math.min(l1.price, l2.price);
        for (let i = apexRef + 1; i < Math.min(n, apexRef + 15); i += 1) {
          if (rows[i].close > resistance) { breakIdx = i; breakDir = 'up'; break; }
          if (rows[i].close < support) { breakIdx = i; breakDir = 'down'; break; }
        }
        if (breakIdx >= 0) {
          out.push({
            markerIndex: breakIdx,
            startIndex: start,
            endIndex: breakIdx,
            date: dateOf(breakIdx),
            price: rows[breakIdx].close,
            direction: breakDir,
            condition: `${cond} 후 ${breakDir === 'up' ? '상향' : '하향'} 돌파`,
            indicatorText: `저항 ${Math.round(resistance).toLocaleString()} / 지지 ${Math.round(support).toLocaleString()}`,
            description: '수렴하던 삼각형에서 방향이 확정된 돌파 구간입니다.',
            lines: [
              { from: { index: h1.index, price: h1.price }, to: { index: h2.index, price: h2.price }, color: '#ef4444', label: '고점 추세선' },
              { from: { index: l1.index, price: l1.price }, to: { index: l2.index, price: l2.price }, color: '#22c55e', label: '저점 추세선' },
            ],
            priceLines: [],
          });
        }
      }
    }
  }

  // 깃발형(상승/하락)
  if (kind === 'bullFlag' || kind === 'bearFlag') {
    for (let i = 10; i < n - 5; i += 1) {
      const poleFrom = rows[i - 8];
      const pole = rows[i];
      const poleMove = (pole.close - poleFrom.close) / Math.max(poleFrom.close, 1e-9);
      const strongUp = poleMove >= 0.12;
      const strongDown = poleMove <= -0.12;
      if (kind === 'bullFlag' && !strongUp) continue;
      if (kind === 'bearFlag' && !strongDown) continue;
      // 조정 채널: 이후 3~10봉 완만한 반대/횡보
      const chEnd = Math.min(n - 1, i + 10);
      const channel = rows.slice(i + 1, chEnd + 1);
      if (channel.length < 3) continue;
      const chHigh = Math.max(...channel.map((r) => r.high));
      const chLow = Math.min(...channel.map((r) => r.low));
      if ((chHigh - chLow) / Math.max(pole.close, 1e-9) > 0.08) continue; // 조정폭 제한
      let breakIdx = -1;
      for (let j = i + 3; j <= chEnd; j += 1) {
        if (kind === 'bullFlag' && rows[j].close > chHigh) { breakIdx = j; break; }
        if (kind === 'bearFlag' && rows[j].close < chLow) { breakIdx = j; break; }
      }
      if (breakIdx < 0) continue;
      out.push({
        markerIndex: breakIdx,
        startIndex: i - 8,
        endIndex: breakIdx,
        date: dateOf(breakIdx),
        price: rows[breakIdx].close,
        direction: kind === 'bullFlag' ? 'up' : 'down',
        condition: kind === 'bullFlag' ? '급등(깃대) 후 완만한 조정 채널 재돌파' : '급락(깃대) 후 완만한 반등 채널 재이탈',
        indicatorText: `깃대 변동 ${Math.round(poleMove * 100)}%`,
        description: kind === 'bullFlag' ? '급등 후 눌림을 거쳐 재차 상승한 상승 깃발형입니다.' : '급락 후 되돌림을 거쳐 재차 하락한 하락 깃발형입니다.',
        lines: [
          { from: { index: i + 1, price: chHigh }, to: { index: chEnd, price: chHigh }, color: '#ef4444', dashed: true, label: '조정 상단' },
          { from: { index: i + 1, price: chLow }, to: { index: chEnd, price: chLow }, color: '#22c55e', dashed: true, label: '조정 하단' },
        ],
        priceLines: [],
      });
      break;
    }
  }

  // 쐐기형(상승/하락)
  if (kind === 'risingWedge' || kind === 'fallingWedge') {
    const rh = highs.slice(-3);
    const rl = lows.slice(-3);
    if (rh.length >= 2 && rl.length >= 2) {
      const h1 = rh[0];
      const h2 = rh[rh.length - 1];
      const l1 = rl[0];
      const l2 = rl[rl.length - 1];
      const highSlope = (h2.price - h1.price) / Math.max(h2.index - h1.index, 1);
      const lowSlope = (l2.price - l1.price) / Math.max(l2.index - l1.index, 1);
      const rising = highSlope > 0 && lowSlope > 0 && lowSlope > highSlope; // 저점이 더 가파름 → 수렴
      const falling = highSlope < 0 && lowSlope < 0 && highSlope < lowSlope;
      const start = Math.min(h1.index, l1.index);
      const apexRef = Math.max(h2.index, l2.index);
      if (kind === 'risingWedge' && rising) {
        let breakIdx = -1;
        for (let i = apexRef + 1; i < Math.min(n, apexRef + 15); i += 1) {
          if (rows[i].close < l2.price) { breakIdx = i; break; }
        }
        if (breakIdx >= 0)
          out.push({
            markerIndex: breakIdx, startIndex: start, endIndex: breakIdx, date: dateOf(breakIdx),
            price: rows[breakIdx].close, direction: 'down',
            condition: '고점·저점 동반 상승하며 수렴 후 하단 이탈',
            indicatorText: `하단 ${Math.round(l2.price).toLocaleString()}`,
            description: '상승하며 수렴하다 하단을 깬 하락형 상승 쐐기입니다.',
            lines: [
              { from: { index: h1.index, price: h1.price }, to: { index: h2.index, price: h2.price }, color: '#ef4444', label: '고점선' },
              { from: { index: l1.index, price: l1.price }, to: { index: l2.index, price: l2.price }, color: '#22c55e', label: '저점선' },
            ],
            priceLines: [],
          });
      }
      if (kind === 'fallingWedge' && falling) {
        let breakIdx = -1;
        for (let i = apexRef + 1; i < Math.min(n, apexRef + 15); i += 1) {
          if (rows[i].close > h2.price) { breakIdx = i; break; }
        }
        if (breakIdx >= 0)
          out.push({
            markerIndex: breakIdx, startIndex: start, endIndex: breakIdx, date: dateOf(breakIdx),
            price: rows[breakIdx].close, direction: 'up',
            condition: '고점·저점 동반 하락하며 수렴 후 상단 돌파',
            indicatorText: `상단 ${Math.round(h2.price).toLocaleString()}`,
            description: '하락하며 수렴하다 상단을 돌파한 상승형 하락 쐐기입니다.',
            lines: [
              { from: { index: h1.index, price: h1.price }, to: { index: h2.index, price: h2.price }, color: '#ef4444', label: '고점선' },
              { from: { index: l1.index, price: l1.price }, to: { index: l2.index, price: l2.price }, color: '#22c55e', label: '저점선' },
            ],
            priceLines: [],
          });
      }
    }
  }

  // 컵앤핸들
  if (kind === 'cupHandle') {
    for (let a = 0; a < highs.length - 1; a += 1) {
      const left = highs[a];
      for (let b = a + 1; b < highs.length; b += 1) {
        const right = highs[b];
        if (right.index - left.index < 15 || right.index - left.index > 80) continue;
        if (pct(left.price, right.price) > 0.05) continue; // 컵 양 테두리 유사
        const cupSeg = rows.slice(left.index, right.index + 1);
        const bottom = Math.min(...cupSeg.map((r) => r.low));
        const depth = (left.price - bottom) / left.price;
        if (depth < 0.1 || depth > 0.5) continue; // 완만한 U자 깊이
        // 손잡이: 우측 테두리 이후 얕은 조정
        const handleEnd = Math.min(n - 1, right.index + 15);
        const handle = rows.slice(right.index + 1, handleEnd + 1);
        if (handle.length < 2) continue;
        const handleLow = Math.min(...handle.map((r) => r.low));
        if ((right.price - handleLow) / right.price > depth * 0.6) continue; // 손잡이는 얕아야
        let breakIdx = -1;
        for (let i = right.index + 2; i <= handleEnd; i += 1) {
          if (rows[i].close > right.price) { breakIdx = i; break; }
        }
        if (breakIdx < 0) continue;
        out.push({
          markerIndex: breakIdx, startIndex: left.index, endIndex: breakIdx, date: dateOf(breakIdx),
          price: rows[breakIdx].close, direction: 'up',
          condition: '컵(U자)+얕은 손잡이 후 테두리 돌파',
          indicatorText: `컵 깊이 ${Math.round(depth * 100)}% · 테두리 ${Math.round(right.price).toLocaleString()}`,
          description: '완만한 컵과 손잡이를 거쳐 저항을 돌파한 상승 지속형입니다.',
          lines: [
            { from: { index: left.index, price: left.price }, to: { index: breakIdx, price: right.price }, color: '#a855f7', dashed: true, label: '테두리 저항' },
          ],
          priceLines: [{ price: right.price, color: '#a855f7', label: '테두리' }],
        });
        break;
      }
      if (out.length) break;
    }
  }

  // 박스권 / 박스 상단 돌파 / 박스 하단 이탈
  if (kind === 'box' || kind === 'boxBreakUp' || kind === 'boxBreakDown') {
    for (let i = n - 1; i >= 40; i -= 1) {
      const w = rows.slice(i - 39, i + 1);
      const hi = Math.max(...w.map((r) => r.high));
      const lo = Math.min(...w.map((r) => r.low));
      if (lo <= 0 || (hi - lo) / lo > 0.14) continue;
      const start = i - 39;
      if (kind === 'box') {
        out.push({
          markerIndex: i, startIndex: start, endIndex: i, date: dateOf(i), price: rows[i].close, direction: 'up',
          condition: `약 ${Math.round(((hi - lo) / lo) * 100)}% 범위 횡보(박스권)`,
          indicatorText: `상단 ${Math.round(hi).toLocaleString()} / 하단 ${Math.round(lo).toLocaleString()}`,
          description: '상·하단이 뚜렷한 횡보 박스권입니다.',
          lines: [
            { from: { index: start, price: hi }, to: { index: i, price: hi }, color: '#ef4444', dashed: true, label: '상단 저항' },
            { from: { index: start, price: lo }, to: { index: i, price: lo }, color: '#22c55e', dashed: true, label: '하단 지지' },
          ],
          priceLines: [{ price: hi, color: '#ef4444', label: '상단' }, { price: lo, color: '#22c55e', label: '하단' }],
        });
        break;
      }
      // 돌파/이탈 확인 (박스 이후 봉)
      let breakIdx = -1;
      for (let j = i + 1; j < Math.min(n, i + 12); j += 1) {
        if (kind === 'boxBreakUp' && rows[j].close > hi) { breakIdx = j; break; }
        if (kind === 'boxBreakDown' && rows[j].close < lo) { breakIdx = j; break; }
      }
      if (breakIdx < 0) continue;
      out.push({
        markerIndex: breakIdx, startIndex: start, endIndex: breakIdx, date: dateOf(breakIdx),
        price: rows[breakIdx].close, direction: kind === 'boxBreakUp' ? 'up' : 'down',
        condition: kind === 'boxBreakUp' ? '박스 상단 종가 돌파' : '박스 하단 종가 이탈',
        indicatorText: `상단 ${Math.round(hi).toLocaleString()} / 하단 ${Math.round(lo).toLocaleString()}${volNear(breakIdx) != null ? ` · 거래량 ${volNear(breakIdx)}배` : ''}`,
        description: kind === 'boxBreakUp' ? '박스권 상단을 돌파한 상승 전환 구간입니다.' : '박스권 하단을 이탈한 하락 전환 구간입니다.',
        lines: [
          { from: { index: start, price: hi }, to: { index: breakIdx, price: hi }, color: '#ef4444', dashed: true, label: '상단' },
          { from: { index: start, price: lo }, to: { index: breakIdx, price: lo }, color: '#22c55e', dashed: true, label: '하단' },
        ],
        priceLines: [{ price: hi, color: '#ef4444', label: '상단' }, { price: lo, color: '#22c55e', label: '하단' }],
      });
      break;
    }
  }

  // 둥근 바닥
  if (kind === 'roundingBottom') {
    const win = 30;
    for (let i = win; i < n; i += 1) {
      const seg = rows.slice(i - win, i + 1);
      const segCloses = seg.map((r) => r.close);
      const minIdx = segCloses.indexOf(Math.min(...segCloses));
      // 바닥이 중앙 부근, 좌우가 완만히 높음
      if (minIdx < win * 0.3 || minIdx > win * 0.7) continue;
      const leftAvg = segCloses.slice(0, 5).reduce((s, v) => s + v, 0) / 5;
      const rightAvg = segCloses.slice(-5).reduce((s, v) => s + v, 0) / 5;
      const bottom = segCloses[minIdx];
      if (leftAvg <= bottom * 1.05 || rightAvg <= bottom * 1.05) continue;
      if (pct(leftAvg, rightAvg) > 0.08) continue; // 좌우 대칭
      out.push({
        markerIndex: i, startIndex: i - win, endIndex: i, date: dateOf(i), price: rows[i].close, direction: 'up',
        condition: '완만한 U자형 바닥 형성 후 회복',
        indicatorText: `바닥 ${Math.round(bottom).toLocaleString()}`,
        description: '서서히 바닥을 다지고 회복하는 둥근 바닥형입니다.',
        lines: [
          { from: { index: i - win, price: leftAvg }, to: { index: i, price: rightAvg }, color: '#a855f7', dashed: true, label: '회복 흐름' },
        ],
        priceLines: [],
      });
      break;
    }
  }

  // V자 반등
  if (kind === 'vRecovery') {
    for (let i = 6; i < n - 3; i += 1) {
      const dropFrom = rows[i - 6];
      const bottom = rows[i];
      const drop = (bottom.low - dropFrom.close) / Math.max(dropFrom.close, 1e-9);
      if (drop > -0.1) continue; // 급락
      const rise = (rows[Math.min(n - 1, i + 4)].close - bottom.low) / Math.max(bottom.low, 1e-9);
      if (rise < 0.08) continue; // 급반등
      out.push({
        markerIndex: i, startIndex: i - 6, endIndex: Math.min(n - 1, i + 4), date: dateOf(i),
        price: rows[i].close, direction: 'up',
        condition: '급락 직후 곧바로 급반등(V자)',
        indicatorText: `저점 ${Math.round(bottom.low).toLocaleString()}`,
        description: '가파른 하락 뒤 빠르게 되돌린 V자 반등입니다.',
        lines: [
          { from: { index: i - 6, price: dropFrom.close }, to: { index: i, price: bottom.low }, color: '#3b82f6', label: '급락' },
          { from: { index: i, price: bottom.low }, to: { index: Math.min(n - 1, i + 4), price: rows[Math.min(n - 1, i + 4)].close }, color: '#22c55e', label: '급반등' },
        ],
        priceLines: [],
      });
      break;
    }
  }

  // 갭 상승 / 갭 하락
  if (kind === 'gapUp' || kind === 'gapDown') {
    for (let i = 1; i < n; i += 1) {
      const prev = rows[i - 1];
      const r = rows[i];
      if (kind === 'gapUp' && r.low > prev.high) {
        const gap = (r.low - prev.high) / prev.high;
        out.push({
          markerIndex: i, startIndex: i - 1, endIndex: i, date: dateOf(i), price: r.close, direction: 'up',
          condition: '당일 저가 > 전일 고가(상승 갭)',
          indicatorText: `갭 ${Math.round(gap * 1000) / 10}%`,
          description: '전일 고가 위에서 출발한 강세 갭 상승입니다.',
          lines: [], priceLines: [{ price: prev.high, color: '#22c55e', label: '갭 하단' }],
        });
        break;
      }
      if (kind === 'gapDown' && r.high < prev.low) {
        const gap = (prev.low - r.high) / prev.low;
        out.push({
          markerIndex: i, startIndex: i - 1, endIndex: i, date: dateOf(i), price: r.close, direction: 'down',
          condition: '당일 고가 < 전일 저가(하락 갭)',
          indicatorText: `갭 ${Math.round(gap * 1000) / 10}%`,
          description: '전일 저가 아래에서 출발한 약세 갭 하락입니다.',
          lines: [], priceLines: [{ price: prev.low, color: '#ef4444', label: '갭 상단' }],
        });
        break;
      }
    }
  }

  return out.sort((a, b) => a.markerIndex - b.markerIndex);
}
