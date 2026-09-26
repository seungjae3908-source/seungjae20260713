// Bottom-accumulation (바닥권 매집) score + AI chart-signal detection.
//
// Everything here is computed from REAL candle/volume data plus optional
// financial / disclosure / news context. Nothing is randomised. When the input
// data is too short or a required source is missing, the affected factor is
// marked "not applicable" and the confidence is lowered rather than fabricated.
import type { Candle, IndicatorSeries } from './types';
import { sma } from './indicators';

export type SignalCategory =
  | 'accumulation'
  | 'trend'
  | 'momentum'
  | 'volume'
  | 'valuation'
  | 'disclosure'
  | 'supply';

export type DataQuality = 'ok' | 'partial' | 'insufficient';
export type Tone = 'positive' | 'neutral' | 'negative';

export interface AiSignal {
  key: string;
  label: string;
  category: SignalCategory;
  active: boolean;
  score: number; // 0-100 strength
  confidence: number; // 0-100
  tone: Tone;
  reasons: string[]; // 발생/통과 근거
  missing: string[]; // 부족한 조건
  action: string; // 대응법
  dataQuality: DataQuality;
}

export interface AccumulationResult {
  score: number; // 0-100
  stars: number; // 1-5
  label: string;
  confidence: number; // 0-100
  breakoutProbability: number; // 0-100
  expectedPeriod: string;
  passed: string[];
  failed: string[];
  strategy: {
    entry: string[];
    take: string[];
    stop: string[];
    caution: string[];
  };
  dataQuality: DataQuality;
}

export interface SignalReport {
  asOf: string;
  accumulation: AccumulationResult;
  signals: AiSignal[];
  dataQuality: DataQuality;
}

// Normalised context the service builds from financial / risk / news services.
export interface SignalContext {
  financialSource?: 'live' | 'sample';
  financials?: {
    revenueGrowth?: number[]; // recent YoY/QoQ %
    profitGrowth?: number[];
    per?: number;
    pbr?: number;
    roe?: number;
    debtRatio?: number;
    cashBalance?: number;
  } | null;
  negativeEvents?: string[]; // event codes: OFFERING/CB/BW/ATM/관리종목/상장폐지 ...
  positiveEvents?: string[]; // SUPPLY_CONTRACT/DIVIDEND/자사주 ...
  riskDataAvailable?: boolean;
  newsScore?: number | null; // -100..100
  newsPositive?: number; // count
  newsNegative?: number; // count
  currency?: 'USD' | 'KRW';
}

// ---------------------------------------------------------------------------
// Pure indicator helpers (OBV / ATR / MFI / Bollinger) not in indicators.ts.
// ---------------------------------------------------------------------------

function obvSeries(c: Candle[]): number[] {
  const out: number[] = [0];
  for (let i = 1; i < c.length; i++) {
    const d = c[i].close - c[i - 1].close;
    out.push(out[i - 1] + (d > 0 ? c[i].volume : d < 0 ? -c[i].volume : 0));
  }
  return out;
}

function atrSeries(c: Candle[], period = 14): (number | null)[] {
  const tr: number[] = [];
  for (let i = 0; i < c.length; i++) {
    if (i === 0) {
      tr.push(c[i].high - c[i].low);
      continue;
    }
    tr.push(
      Math.max(
        c[i].high - c[i].low,
        Math.abs(c[i].high - c[i - 1].close),
        Math.abs(c[i].low - c[i - 1].close),
      ),
    );
  }
  return sma(tr, period);
}

function mfiSeries(c: Candle[], period = 14): (number | null)[] {
  const tp = c.map((x) => (x.high + x.low + x.close) / 3);
  const out: (number | null)[] = new Array(c.length).fill(null);
  for (let i = period; i < c.length; i++) {
    let pos = 0;
    let neg = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const raw = tp[j] * c[j].volume;
      if (tp[j] > tp[j - 1]) pos += raw;
      else if (tp[j] < tp[j - 1]) neg += raw;
    }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

function bollinger(closes: number[], period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  const width: (number | null)[] = []; // bandwidth as % of mid
  for (let i = 0; i < closes.length; i++) {
    const m = mid[i];
    if (i < period - 1 || m === null) {
      upper.push(null);
      lower.push(null);
      width.push(null);
      continue;
    }
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (closes[j] - m) ** 2;
    const sd = Math.sqrt(s / period);
    upper.push(m + mult * sd);
    lower.push(m - mult * sd);
    width.push(m !== 0 ? ((2 * mult * sd) / m) * 100 : null);
  }
  return { mid, upper, lower, width };
}

function slope(arr: (number | null)[], lookback: number): number | null {
  const n = arr.length;
  const b = arr[n - 1];
  const a = arr[n - 1 - lookback];
  if (a == null || b == null || a === 0) return null;
  return ((b - a) / Math.abs(a)) * 100; // % change over the window
}

function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1];
}

function roundTo(v: number, currency?: 'USD' | 'KRW'): number {
  if (currency === 'KRW') return Math.round(v);
  return Math.round(v * 100) / 100;
}

// A factor's contribution to the accumulation score.
interface Factor {
  strength: number | null; // 0..1, or null when not applicable
  weight: number;
  pass: string; // reason text when strength high
  fail: string; // missing-condition text when strength low
}

// ---------------------------------------------------------------------------
// Accumulation score
// ---------------------------------------------------------------------------

function computeAccumulation(
  candles: Candle[],
  ind: IndicatorSeries,
  ctx: SignalContext,
): AccumulationResult {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const price = closes[n - 1];

  // Look-back windows sized to the daily series (≈1y).
  const boxWin = Math.min(80, n - 1); // ~4 months
  const recentWin = Math.min(20, n - 1);

  const hi = Math.max(...closes);
  const loAll = Math.min(...closes);
  const boxSlice = closes.slice(n - boxWin);
  const boxHi = Math.max(...boxSlice);
  const boxLo = Math.min(...boxSlice);
  const recentLo = Math.min(...closes.slice(n - recentWin));

  const obv = obvSeries(candles);
  const atr = atrSeries(candles, 14);
  const mfi = mfiSeries(candles, 14);
  const bb = bollinger(closes, 20, 2);
  const rsi = ind.rsi;

  const factors: Record<string, Factor> = {};

  // 1) 가격 위치 — 고점 대비 하락 후 저점권, 저점이 더 깨지지 않음.
  {
    const drawdown = hi > 0 ? (hi - price) / hi : 0; // 0..1
    const nearLow = loAll > 0 ? (price - loAll) / loAll : 1; // 0 = at the low
    const notBreaking = price > recentLo * 0.98; // not making fresh lows
    let s = 0;
    if (drawdown >= 0.2) s += 0.4;
    else if (drawdown >= 0.1) s += 0.2;
    if (nearLow <= 0.15) s += 0.35;
    else if (nearLow <= 0.3) s += 0.2;
    if (notBreaking) s += 0.25;
    factors.pricePosition = {
      strength: Math.min(1, s),
      weight: 10,
      pass: `고점 대비 ${(drawdown * 100).toFixed(0)}% 하락한 저점권이며 최근 저점이 유지되고 있습니다.`,
      fail: '아직 저점권이 아니거나 저점이 계속 낮아지고 있습니다.',
    };
  }

  // 2) 박스권 횡보 — 좁은 박스 + ATR 감소 + 저점 상승.
  {
    const boxRange = boxLo > 0 ? (boxHi - boxLo) / boxLo : 1;
    const atrNow = last(atr) ?? null;
    const atrPast = atr[n - 1 - boxWin] ?? null;
    const atrFalling = atrNow != null && atrPast != null && atrNow < atrPast;
    // higher lows: compare min of older half vs newer half of the box
    const half = Math.floor(boxWin / 2);
    const oldLow = Math.min(...closes.slice(n - boxWin, n - half));
    const newLow = Math.min(...closes.slice(n - half));
    const higherLows = newLow >= oldLow * 0.99;
    let s = 0;
    if (boxRange <= 0.15) s += 0.4;
    else if (boxRange <= 0.28) s += 0.22;
    if (atrFalling) s += 0.3;
    if (higherLows) s += 0.3;
    factors.box = {
      strength: Math.min(1, s),
      weight: 12,
      pass: `약 ${boxWin}봉 동안 ${(boxRange * 100).toFixed(0)}% 폭의 박스권에서 변동성이 줄고 저점이 높아지고 있습니다.`,
      fail: '박스권 횡보가 뚜렷하지 않거나 변동성이 여전히 큽니다.',
    };
  }

  // 3) 거래량 매집 — OBV 상승 + 상승일 거래량 우위 + MFI 개선.
  {
    const obvArr = obv.map((v) => v);
    const obvSlope = slope(obvArr, recentWin);
    let upVol = 0;
    let downVol = 0;
    for (let i = n - recentWin; i < n; i++) {
      if (candles[i].close >= candles[i - 1].close) upVol += candles[i].volume;
      else downVol += candles[i].volume;
    }
    const upBias = upVol > downVol * 1.1;
    const mfiNow = last(mfi) ?? null;
    const mfiPast = mfi[n - 1 - recentWin] ?? null;
    const mfiUp = mfiNow != null && mfiPast != null && mfiNow > mfiPast;
    let s = 0;
    if (obvSlope != null && obvSlope > 0) s += 0.4;
    if (upBias) s += 0.35;
    if (mfiUp) s += 0.25;
    factors.volume = {
      strength: Math.min(1, s),
      weight: 16,
      pass: `OBV가 상승하고 상승일 거래량이 하락일보다 커 매집 흔적이 보입니다${mfiUp ? ' (MFI 개선)' : ''}.`,
      fail: '거래량 매집 신호(OBV·상승일 거래량 우위)가 약합니다.',
    };
  }

  // 4) 이동평균선 — MA20 상승 전환, MA60 평탄화, MA20이 MA60에 접근.
  {
    const ma20Slope = slope(ind.ma20, 5);
    const ma60Slope = slope(ind.ma60, 10);
    const ma20 = last(ind.ma20) ?? null;
    const ma60 = last(ind.ma60) ?? null;
    let s = 0;
    if (ma20Slope != null && ma20Slope > 0) s += 0.4;
    if (ma60Slope != null && Math.abs(ma60Slope) < 3) s += 0.3; // flattening
    if (ma20 != null && ma60 != null) {
      const gap = ma60 > 0 ? (ma60 - ma20) / ma60 : 1;
      if (gap > 0 && gap < 0.05) s += 0.3; // approaching from below
      else if (ma20 > ma60) s += 0.2; // already reclaimed
    }
    // Not applicable when neither MA is available (short history).
    const maApplicable = ma20 != null || ma60 != null;
    factors.movingAverage = {
      strength: maApplicable ? Math.min(1, s) : null,
      weight: 12,
      pass: 'MA20가 상승 전환하고 MA60이 평탄해지며 정배열에 근접하고 있습니다.',
      fail: 'MA20 상승 전환·MA60 평탄화가 아직 확인되지 않습니다.',
    };
  }

  // 5) 모멘텀 — RSI 30~55 회복, MACD 히스토그램 개선.
  {
    const r = last(rsi) ?? null;
    const rPast = rsi[n - 1 - recentWin] ?? null;
    const inZone = r != null && r >= 30 && r <= 55;
    const escaping = r != null && rPast != null && rPast < 35 && r > rPast;
    const hist = ind.macd.hist;
    const hNow = last(hist) ?? null;
    const hPast = hist[n - 3] ?? null;
    const histUp = hNow != null && hPast != null && hNow > hPast;
    let s = 0;
    if (inZone) s += 0.4;
    if (escaping) s += 0.3;
    if (histUp) s += 0.3;
    factors.momentum = {
      strength: r == null ? null : Math.min(1, s),
      weight: 12,
      pass: `RSI가 ${r != null ? r.toFixed(0) : '—'}로 매집 구간이며 MACD 히스토그램이 개선되고 있습니다.`,
      fail: '모멘텀(RSI 회복·MACD 개선)이 아직 부족합니다.',
    };
  }

  // 6) 볼린저밴드 — 밴드폭 축소(스퀴즈) + 중심선 회복.
  {
    const wNow = last(bb.width) ?? null;
    const wSlice = bb.width.slice(n - boxWin).filter((v): v is number => v != null);
    const wAvg = wSlice.length ? wSlice.reduce((a, b) => a + b, 0) / wSlice.length : null;
    const squeeze = wNow != null && wAvg != null && wNow < wAvg * 0.85;
    const mid = last(bb.mid) ?? null;
    const midRecover = mid != null && price >= mid;
    let s = 0;
    if (squeeze) s += 0.6;
    if (midRecover) s += 0.4;
    factors.bollinger = {
      strength: Math.min(1, s),
      weight: 8,
      pass: '볼린저밴드가 수축(스퀴즈)하며 중심선을 회복해 변동성 확대 직전입니다.',
      fail: '볼린저밴드 스퀴즈 또는 중심선 회복이 확인되지 않습니다.',
    };
  }

  // 7) 수급 (기관/외국인) — 데이터 미제공: 항상 not-applicable.
  factors.supply = {
    strength: null,
    weight: 10,
    pass: '',
    fail: '기관·외국인 수급 데이터가 제공되지 않아 확인 불가합니다.',
  };

  // 8) 공시 리스크 — 유상증자/CB/BW/ATM/관리·상폐 없음.
  if (ctx.negativeEvents) {
    const hasRisk = ctx.negativeEvents.length > 0;
    factors.disclosureRisk = {
      strength: hasRisk ? 0 : 1,
      weight: 8,
      pass: '유상증자·CB/BW·관리종목 등 매집을 저해하는 공시 리스크가 없습니다.',
      fail: `공시 리스크가 있습니다 (${ctx.negativeEvents.join(', ')}).`,
    };
  } else {
    factors.disclosureRisk = {
      strength: null,
      weight: 8,
      pass: '',
      fail: '공시 데이터가 없어 리스크를 확인하지 못했습니다.',
    };
  }

  // 9) 뉴스/공시 — 악재 감소·호재 증가.
  if (ctx.newsScore != null || ctx.positiveEvents) {
    let s = 0.5;
    if (ctx.newsScore != null) s = Math.max(0, Math.min(1, (ctx.newsScore + 100) / 200));
    if (ctx.positiveEvents && ctx.positiveEvents.length > 0) s = Math.min(1, s + 0.2);
    factors.news = {
      strength: s,
      weight: 8,
      pass: '악재성 뉴스가 줄고 호재성 뉴스·긍정 공시가 늘고 있습니다.',
      fail: '뉴스/공시 흐름이 아직 긍정적으로 돌아서지 않았습니다.',
    };
  } else {
    factors.news = { strength: null, weight: 8, pass: '', fail: '뉴스 데이터가 없습니다.' };
  }

  // 10) 재무 — 실적 개선·현금 증가·부채 감소·ROE 개선.
  if (ctx.financials) {
    const f = ctx.financials;
    let s = 0;
    let cnt = 0;
    const growthUp = (arr?: number[]) => arr && arr.length >= 2 && arr[arr.length - 1] > arr[arr.length - 2];
    if (f.revenueGrowth) {
      cnt++;
      if (growthUp(f.revenueGrowth) || (last(f.revenueGrowth) ?? -1) > 0) s += 1;
    }
    if (f.profitGrowth) {
      cnt++;
      if (growthUp(f.profitGrowth) || (last(f.profitGrowth) ?? -1) > 0) s += 1;
    }
    if (f.roe != null) {
      cnt++;
      if (f.roe > 0) s += 1;
    }
    if (f.debtRatio != null) {
      cnt++;
      if (f.debtRatio < 150) s += 1;
    }
    factors.financials = {
      strength: cnt > 0 ? s / cnt : null,
      weight: 8,
      pass: '실적·수익성·재무 안정성이 개선 흐름을 보이고 있습니다.',
      fail: '재무 개선(실적·현금·부채·ROE) 신호가 부족합니다.',
    };
  } else {
    factors.financials = { strength: null, weight: 8, pass: '', fail: '재무 데이터가 없습니다.' };
  }

  // Aggregate.
  const applicable = Object.values(factors).filter((f) => f.strength != null);
  const totalWeight = Object.values(factors).reduce((a, f) => a + f.weight, 0);
  const applicableWeight = applicable.reduce((a, f) => a + f.weight, 0);
  const weightedStrength = applicable.reduce((a, f) => a + f.weight * (f.strength as number), 0);
  const score = applicableWeight > 0 ? Math.round((weightedStrength / applicableWeight) * 100) : 0;

  const passed: string[] = [];
  const failed: string[] = [];
  for (const f of Object.values(factors)) {
    if (f.strength == null) {
      if (f.fail) failed.push(f.fail);
      continue;
    }
    if (f.strength >= 0.6) passed.push(f.pass);
    else if (f.strength < 0.5) failed.push(f.fail);
  }

  // Confidence: how much of the model is actually backed by data + series length.
  const coverage = applicableWeight / totalWeight;
  const lengthFactor = Math.min(1, n / 180);
  const confidence = Math.round(coverage * lengthFactor * 100);

  const dataQuality: DataQuality =
    n < 40 ? 'insufficient' : coverage < 0.75 ? 'partial' : 'ok';

  // Breakout probability: accumulation + squeeze/volume proximity to resistance.
  const nearResistance = boxHi > 0 ? price / boxHi : 0; // → 1 as price nears box top
  let breakout = score * 0.7;
  if (factors.bollinger.strength && factors.bollinger.strength >= 0.6) breakout += 8;
  if (factors.volume.strength && factors.volume.strength >= 0.6) breakout += 8;
  if (nearResistance >= 0.95) breakout += 6;
  const breakoutProbability = Math.max(0, Math.min(95, Math.round(breakout)));

  const expectedPeriod = score >= 75 ? '1~3주' : score >= 55 ? '2~4주' : '4~8주';
  const stars = Math.max(1, Math.min(5, Math.ceil(score / 20)));
  const label =
    score >= 80
      ? '매집 진행 가능성 매우 높음'
      : score >= 65
        ? '매집 진행 가능성 높음'
        : score >= 50
          ? '매집 관찰 필요'
          : score >= 35
            ? '매집 초기 단계'
            : '매집 신호 약함';

  const cur = ctx.currency;
  const ma20v = last(ind.ma20) ?? price;
  const strategy = {
    entry: [
      `박스권 하단(약 ${roundTo(boxLo, cur)}) 부근에서 분할 진입`,
      `MA20(약 ${roundTo(ma20v, cur)}) 회복 확인 후 1차 진입`,
      `박스권 상단(약 ${roundTo(boxHi, cur)}) 거래량 동반 돌파 시 추가 진입`,
    ],
    take: [
      `박스권 상단(약 ${roundTo(boxHi, cur)}) 1차 익절`,
      '전고점 돌파 시 일부 물량 홀딩',
      '거래량 급감 시 분할 익절',
    ],
    stop: [
      `박스권 하단(약 ${roundTo(boxLo, cur)}) 이탈 시 손절`,
      `직전 저점(약 ${roundTo(recentLo, cur)}) 이탈 시 손절`,
      '악재 공시 또는 거래량 동반 장대음봉 발생 시 손절',
    ],
    caution: [
      '매집 신호는 확정이 아니라 가능성 신호입니다.',
      '돌파 확인 전에는 비중을 작게 잡으세요.',
      '거래량 없는 상승은 신뢰도가 낮습니다.',
    ],
  };

  return {
    score,
    stars,
    label,
    confidence,
    breakoutProbability,
    expectedPeriod,
    passed,
    failed,
    strategy,
    dataQuality,
  };
}

// ---------------------------------------------------------------------------
// AI chart signals
// ---------------------------------------------------------------------------

function mk(
  key: string,
  label: string,
  category: SignalCategory,
  active: boolean,
  score: number,
  confidence: number,
  tone: Tone,
  reasons: string[],
  missing: string[],
  action: string,
  dataQuality: DataQuality = 'ok',
): AiSignal {
  return {
    key,
    label,
    category,
    active,
    score: Math.max(0, Math.min(100, Math.round(score))),
    confidence: Math.max(0, Math.min(100, Math.round(confidence))),
    tone,
    reasons,
    missing,
    action,
    dataQuality,
  };
}

const INSUFFICIENT_ACTION = '데이터 부족으로 신뢰도 낮음';

// Canonical signal set — used to emit a full "insufficient" list when the price
// history is too short to compute anything, so the API/UI always explain why a
// signal is unavailable instead of silently dropping it.
const SIGNAL_META: { key: string; label: string; category: SignalCategory; tone: Tone }[] = [
  { key: 'accumulation', label: '바닥권 매집', category: 'accumulation', tone: 'positive' },
  { key: 'breakout_imminent', label: '돌파 임박', category: 'trend', tone: 'positive' },
  { key: 'trend_start', label: '추세 시작', category: 'trend', tone: 'positive' },
  { key: 'golden_cross', label: '골든크로스', category: 'trend', tone: 'positive' },
  { key: 'dead_cross', label: '데드크로스', category: 'trend', tone: 'negative' },
  { key: 'overheated', label: '과열', category: 'momentum', tone: 'negative' },
  { key: 'trend_break', label: '추세 이탈', category: 'trend', tone: 'negative' },
  { key: 'volume_explosion', label: '거래량 폭발', category: 'volume', tone: 'positive' },
  { key: 'new_high', label: '신고가', category: 'trend', tone: 'positive' },
  { key: 'new_low', label: '신저가', category: 'trend', tone: 'negative' },
  { key: 'pullback', label: '눌림목', category: 'trend', tone: 'positive' },
  { key: 'trend_reversal', label: '추세 전환', category: 'momentum', tone: 'positive' },
  { key: 'undervalued', label: '저평가', category: 'valuation', tone: 'positive' },
  { key: 'overvalued', label: '고평가', category: 'valuation', tone: 'negative' },
  { key: 'positive_disclosure', label: '호재 공시', category: 'disclosure', tone: 'positive' },
  { key: 'negative_disclosure', label: '악재 공시', category: 'disclosure', tone: 'negative' },
];

function insufficientSignals(reason: string): AiSignal[] {
  return SIGNAL_META.map((m) =>
    mk(m.key, m.label, m.category, false, 0, 10, m.tone, [], [reason], INSUFFICIENT_ACTION, 'insufficient'),
  );
}

function naSignal(
  key: string,
  label: string,
  category: SignalCategory,
  tone: Tone,
  missing: string,
): AiSignal {
  return mk(key, label, category, false, 0, 12, tone, [], [missing], INSUFFICIENT_ACTION, 'insufficient');
}

function computeSignals(
  candles: Candle[],
  ind: IndicatorSeries,
  ctx: SignalContext,
  acc: AccumulationResult,
): AiSignal[] {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const price = closes[n - 1];
  const out: AiSignal[] = [];

  const ma20 = last(ind.ma20) ?? null;
  const ma60 = last(ind.ma60) ?? null;
  const ma20Prev = ind.ma20[n - 2] ?? null;
  const ma60Prev = ind.ma60[n - 2] ?? null;
  const rsi = last(ind.rsi) ?? null;
  const rsiPrev = ind.rsi[n - 1 - Math.min(15, n - 1)] ?? null;

  const win = Math.min(20, n - 1);
  const avgVol = candles.slice(n - win - 1, n - 1).reduce((s, c) => s + c.volume, 0) / win;
  const volRatio = avgVol > 0 ? candles[n - 1].volume / avgVol : 0;

  const boxWin = Math.min(80, n - 1);
  const boxHi = Math.max(...closes.slice(n - boxWin));
  const boxLo = Math.min(...closes.slice(n - boxWin));
  const hiAll = Math.max(...closes);
  const loAll = Math.min(...closes);

  const macd = ind.macd;
  const mNow = last(macd.macd) ?? null;
  const mPrev = macd.macd[n - 2] ?? null;
  const sNow = last(macd.signal) ?? null;
  const sPrev = macd.signal[n - 2] ?? null;
  const golden =
    ma20 != null && ma60 != null && ma20Prev != null && ma60Prev != null && ma20Prev <= ma60Prev && ma20 > ma60;
  const dead =
    ma20 != null && ma60 != null && ma20Prev != null && ma60Prev != null && ma20Prev >= ma60Prev && ma20 < ma60;

  // Confidence scales with how much price history backs the technicals.
  const techConf = Math.round(60 + Math.min(1, n / 150) * 30); // 60..90
  // Prerequisite availability for indicator-dependent signals.
  const ma60Ready = ma60 != null && ma60Prev != null;
  const rsiReady = rsi != null;
  const macdReady = mNow != null && sNow != null && mPrev != null && sPrev != null;
  const MA60_MISSING = '중기 이동평균(MA60) 계산에 필요한 데이터가 부족합니다.';
  const RSI_MISSING = 'RSI 계산에 필요한 데이터가 부족합니다.';
  const MACD_MISSING = 'MACD 계산에 필요한 데이터가 부족합니다.';

  // 바닥권 매집
  out.push(
    mk(
      'accumulation',
      '바닥권 매집',
      'accumulation',
      acc.score >= 60,
      acc.score,
      acc.confidence,
      'positive',
      acc.passed.slice(0, 4),
      acc.failed.slice(0, 4),
      '박스권 하단 분할 매수 후 거래량 동반 돌파를 확인하세요.',
      acc.dataQuality,
    ),
  );

  // 돌파 임박 (RSI 필요)
  if (!rsiReady) {
    out.push(naSignal('breakout_imminent', '돌파 임박', 'trend', 'positive', RSI_MISSING));
  } else {
    const nearTop = boxHi > 0 ? price / boxHi : 0;
    const active = nearTop >= 0.96 && volRatio >= 1.3 && rsi >= 50 && rsi < 70;
    out.push(
      mk(
        'breakout_imminent',
        '돌파 임박',
        'trend',
        active,
        active ? 60 + Math.min(35, (volRatio - 1.3) * 30) : nearTop * 60,
        techConf,
        'positive',
        active ? [`박스권 상단(${boxHi.toFixed(2)}) 근접, 거래량 ${volRatio.toFixed(1)}배`] : [],
        active ? [] : ['저항선 근접 또는 거래량 동반이 부족합니다.'],
        '돌파 시 진입, 돌파 실패(윗꼬리+거래량 감소) 시 관망하세요.',
      ),
    );
  }

  // 추세 시작 (MA60 필요)
  if (!ma60Ready) {
    out.push(naSignal('trend_start', '추세 시작', 'trend', 'positive', MA60_MISSING));
  } else {
    const active = ma20 != null && ma20 > ma60 && price > ma20 && (slope(ind.ma20, 5) ?? 0) > 0;
    out.push(
      mk(
        'trend_start',
        '추세 시작',
        'trend',
        active,
        active ? 68 : 30,
        techConf,
        'positive',
        active ? ['가격이 MA20 위, MA20>MA60 정배열 진입'] : [],
        active ? [] : ['정배열 전환이 아직 확인되지 않았습니다.'],
        '초기 눌림에서 분할 매수, MA20 이탈 시 손절하세요.',
      ),
    );
  }

  // 골든크로스 / 데드크로스 (MA60 필요)
  if (!ma60Ready) {
    out.push(naSignal('golden_cross', '골든크로스', 'trend', 'positive', MA60_MISSING));
    out.push(naSignal('dead_cross', '데드크로스', 'trend', 'negative', MA60_MISSING));
  } else {
    out.push(
      mk(
        'golden_cross',
        '골든크로스',
        'trend',
        golden,
        golden ? 70 : 25,
        techConf,
        'positive',
        golden ? ['MA20가 MA60을 상향 돌파'] : [],
        golden ? [] : ['최근 골든크로스가 없습니다.'],
        '거래량 동반 여부를 확인하고 눌림목에서 진입하세요.',
      ),
    );
    out.push(
      mk(
        'dead_cross',
        '데드크로스',
        'trend',
        dead,
        dead ? 70 : 25,
        techConf,
        'negative',
        dead ? ['MA20가 MA60을 하향 돌파'] : [],
        dead ? [] : ['최근 데드크로스가 없습니다.'],
        '보유 시 비중 축소, 반등은 매도 기회로 활용하세요.',
      ),
    );
  }

  // 과열 (RSI 필요)
  if (!rsiReady) {
    out.push(naSignal('overheated', '과열', 'momentum', 'negative', RSI_MISSING));
  } else {
    const aboveMa20 = ma20 != null && ma20 > 0 ? (price - ma20) / ma20 : 0;
    const active = rsi >= 70 && aboveMa20 > 0.1;
    out.push(
      mk(
        'overheated',
        '과열',
        'momentum',
        active,
        active ? 65 : rsi,
        techConf,
        'negative',
        active ? [`RSI ${rsi.toFixed(0)}, MA20 대비 +${(aboveMa20 * 100).toFixed(0)}% 이격`] : [],
        active ? [] : ['과열 구간이 아닙니다.'],
        '신규 진입 자제, 분할 익절로 리스크를 관리하세요.',
      ),
    );
  }

  // 추세 이탈 (MA60 필요)
  if (ma60 == null) {
    out.push(naSignal('trend_break', '추세 이탈', 'trend', 'negative', MA60_MISSING));
  } else {
    const active = price < ma60 && price < boxLo * 1.01;
    out.push(
      mk(
        'trend_break',
        '추세 이탈',
        'trend',
        active,
        active ? 65 : 30,
        techConf,
        'negative',
        active ? ['MA60 및 박스권 하단 이탈'] : [],
        active ? [] : ['추세 이탈이 확인되지 않았습니다.'],
        '손절 기준 준수, 재진입은 지지 회복 확인 후로 미루세요.',
      ),
    );
  }

  // 거래량 폭발
  {
    const active = volRatio >= 3;
    out.push(
      mk(
        'volume_explosion',
        '거래량 폭발',
        'volume',
        active,
        active ? Math.min(95, 60 + (volRatio - 3) * 10) : volRatio * 20,
        75,
        'positive',
        active ? [`거래량이 20봉 평균의 ${volRatio.toFixed(1)}배`] : [],
        active ? [] : ['거래량은 평균 수준입니다.'],
        '방향(양/음봉)과 위치(바닥/고점)를 함께 확인하세요.',
      ),
    );
  }

  // 신고가 / 신저가 (종가만 필요)
  out.push(
    mk(
      'new_high',
      '신고가',
      'trend',
      price >= hiAll * 0.999,
      price >= hiAll * 0.999 ? 70 : (price / hiAll) * 60,
      techConf,
      'positive',
      price >= hiAll * 0.999 ? ['기간 내 최고가 경신'] : [],
      price >= hiAll * 0.999 ? [] : ['신고가가 아닙니다.'],
      '눌림목 분할 진입, 거래량 감소 시 익절하세요.',
    ),
  );
  out.push(
    mk(
      'new_low',
      '신저가',
      'trend',
      price <= loAll * 1.001,
      price <= loAll * 1.001 ? 70 : 30,
      techConf,
      'negative',
      price <= loAll * 1.001 ? ['기간 내 최저가 경신'] : [],
      price <= loAll * 1.001 ? [] : ['신저가가 아닙니다.'],
      '섣부른 저점 매수 자제, 반등·거래량 확인 후 접근하세요.',
    ),
  );

  // 눌림목 (MA60 + RSI 필요)
  if (!ma60Ready || !rsiReady) {
    out.push(naSignal('pullback', '눌림목', 'trend', 'positive', !ma60Ready ? MA60_MISSING : RSI_MISSING));
  } else {
    const uptrend = ma20 != null && ma20 > ma60;
    const nearMa20 = ma20 != null && ma20 > 0 ? Math.abs(price - ma20) / ma20 < 0.03 : false;
    const active = uptrend && nearMa20 && rsi >= 40 && rsi <= 60 && price >= (ma20 ?? 0);
    out.push(
      mk(
        'pullback',
        '눌림목',
        'trend',
        active,
        active ? 66 : 30,
        techConf,
        'positive',
        active ? ['상승추세 중 MA20 지지 부근 조정'] : [],
        active ? [] : ['상승추세 눌림목 조건이 아닙니다.'],
        'MA20 지지 확인 후 분할 진입, 지지 이탈 시 손절하세요.',
      ),
    );
  }

  // 추세 전환 (MACD + MA60 필요)
  if (!macdReady || !ma60Ready) {
    out.push(naSignal('trend_reversal', '추세 전환', 'momentum', 'positive', !macdReady ? MACD_MISSING : MA60_MISSING));
  } else {
    const macdUp = mPrev <= sPrev && mNow > sNow;
    const downFlatten = (slope(ind.ma60, 10) ?? -10) > -2 && (slope(ind.ma60, 20) ?? 0) < 0;
    const active = macdUp && downFlatten;
    out.push(
      mk(
        'trend_reversal',
        '추세 전환',
        'momentum',
        active,
        active ? 64 : 30,
        techConf,
        'positive',
        active ? ['MACD 상향 교차 + 하락추세 둔화'] : [],
        active ? [] : ['추세 전환 신호가 아직 약합니다.'],
        '전환 초기 분할 진입, 직전 저점 이탈 시 손절하세요.',
      ),
    );
  }

  // 저평가 / 고평가 — 재무 필요.
  if (ctx.financials && (ctx.financials.per != null || ctx.financials.pbr != null)) {
    const f = ctx.financials;
    const cheap = (f.per != null && f.per > 0 && f.per < 10) || (f.pbr != null && f.pbr > 0 && f.pbr < 1);
    const rich = (f.per != null && f.per > 40) || (f.pbr != null && f.pbr > 5);
    out.push(
      mk(
        'undervalued',
        '저평가',
        'valuation',
        cheap,
        cheap ? 65 : 35,
        65,
        'positive',
        cheap ? [`PER ${f.per?.toFixed(1) ?? '—'}, PBR ${f.pbr?.toFixed(2) ?? '—'}로 낮은 편`] : [],
        cheap ? [] : ['밸류에이션이 특별히 낮지 않습니다.'],
        '실적 개선이 동반되는지 확인 후 중장기 관점으로 접근하세요.',
      ),
    );
    out.push(
      mk(
        'overvalued',
        '고평가',
        'valuation',
        rich,
        rich ? 65 : 35,
        65,
        'negative',
        rich ? [`PER ${f.per?.toFixed(1) ?? '—'}, PBR ${f.pbr?.toFixed(2) ?? '—'}로 높은 편`] : [],
        rich ? [] : ['밸류에이션이 특별히 높지 않습니다.'],
        '성장성 대비 과도한지 점검하고 추격 매수를 자제하세요.',
      ),
    );
  } else {
    out.push(
      mk('undervalued', '저평가', 'valuation', false, 0, 20, 'neutral', [], ['재무(PER/PBR) 데이터가 부족합니다.'], '데이터 부족으로 신뢰도 낮음', 'insufficient'),
    );
    out.push(
      mk('overvalued', '고평가', 'valuation', false, 0, 20, 'neutral', [], ['재무(PER/PBR) 데이터가 부족합니다.'], '데이터 부족으로 신뢰도 낮음', 'insufficient'),
    );
  }

  // 호재 공시 / 악재 공시
  if (ctx.positiveEvents || ctx.negativeEvents) {
    const pos = ctx.positiveEvents ?? [];
    const neg = ctx.negativeEvents ?? [];
    out.push(
      mk(
        'positive_disclosure',
        '호재 공시',
        'disclosure',
        pos.length > 0,
        pos.length > 0 ? 65 : 30,
        70,
        'positive',
        pos.length > 0 ? [`긍정 공시: ${pos.join(', ')}`] : [],
        pos.length > 0 ? [] : ['최근 호재성 공시가 없습니다.'],
        '공시의 실질적 영향(계약 규모·지속성)을 확인하세요.',
      ),
    );
    out.push(
      mk(
        'negative_disclosure',
        '악재 공시',
        'disclosure',
        neg.length > 0,
        neg.length > 0 ? 65 : 30,
        70,
        'negative',
        neg.length > 0 ? [`위험 공시: ${neg.join(', ')}`] : [],
        neg.length > 0 ? [] : ['최근 악재성 공시가 없습니다.'],
        '유상증자·CB/BW 등 희석 이슈는 비중 축소로 대응하세요.',
      ),
    );
  } else {
    out.push(
      mk('positive_disclosure', '호재 공시', 'disclosure', false, 0, 20, 'neutral', [], ['공시 데이터가 부족합니다.'], '데이터 부족으로 신뢰도 낮음', 'insufficient'),
    );
    out.push(
      mk('negative_disclosure', '악재 공시', 'disclosure', false, 0, 20, 'neutral', [], ['공시 데이터가 부족합니다.'], '데이터 부족으로 신뢰도 낮음', 'insufficient'),
    );
  }

  return out;
}

export function computeSignalReport(
  candles: Candle[],
  ind: IndicatorSeries,
  ctx: SignalContext = {},
  asOf = new Date().toISOString(),
): SignalReport {
  if (!candles || candles.length < 30) {
    const empty: AccumulationResult = {
      score: 0,
      stars: 1,
      label: '데이터 부족으로 신뢰도 낮음',
      confidence: 0,
      breakoutProbability: 0,
      expectedPeriod: '—',
      passed: [],
      failed: ['가격 데이터가 부족합니다 (30봉 미만).'],
      strategy: { entry: [], take: [], stop: [], caution: ['데이터 부족으로 신뢰도 낮음'] },
      dataQuality: 'insufficient',
    };
    const reason = '가격 데이터가 부족합니다 (30봉 미만).';
    return { asOf, accumulation: empty, signals: insufficientSignals(reason), dataQuality: 'insufficient' };
  }
  const accumulation = computeAccumulation(candles, ind, ctx);
  const signals = computeSignals(candles, ind, ctx, accumulation);
  return { asOf, accumulation, signals, dataQuality: accumulation.dataQuality };
}

// ---------------------------------------------------------------------------
// Scanner conditions — the granular candle-only checkboxes the scanner offers.
// `null` means "data not available" (기관/외국인 수급) → never a match, low conf.
// ---------------------------------------------------------------------------

export interface ScanConditions {
  score: number; // accumulation score
  confidence: number;
  accumulation: boolean;
  box_consolidation: boolean;
  obv_rising: boolean;
  volume_accum: boolean;
  bollinger_squeeze: boolean;
  rsi_recovery: boolean;
  macd_turn: boolean;
  inst_accumulation: boolean | null;
  foreign_accumulation: boolean | null;
}

export function computeScanConditions(candles: Candle[], ind: IndicatorSeries): ScanConditions | null {
  if (!candles || candles.length < 30) return null;
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const acc = computeAccumulation(candles, ind, {});

  const recentWin = Math.min(20, n - 1);
  const boxWin = Math.min(80, n - 1);

  // box consolidation
  const boxSlice = closes.slice(n - boxWin);
  const boxRange = Math.min(...boxSlice) > 0 ? (Math.max(...boxSlice) - Math.min(...boxSlice)) / Math.min(...boxSlice) : 1;
  const half = Math.floor(boxWin / 2);
  const oldLow = Math.min(...closes.slice(n - boxWin, n - half));
  const newLow = Math.min(...closes.slice(n - half));
  const box_consolidation = boxRange <= 0.28 && newLow >= oldLow * 0.99;

  // OBV rising
  const obv = obvSeries(candles);
  const obv_rising = (slope(obv, recentWin) ?? 0) > 0;

  // volume accumulation
  let upVol = 0;
  let downVol = 0;
  for (let i = n - recentWin; i < n; i++) {
    if (candles[i].close >= candles[i - 1].close) upVol += candles[i].volume;
    else downVol += candles[i].volume;
  }
  const volume_accum = upVol > downVol * 1.1;

  // bollinger squeeze
  const bb = bollinger(closes, 20, 2);
  const wNow = last(bb.width) ?? null;
  const wSlice = bb.width.slice(n - boxWin).filter((v): v is number => v != null);
  const wAvg = wSlice.length ? wSlice.reduce((a, b) => a + b, 0) / wSlice.length : null;
  const bollinger_squeeze = wNow != null && wAvg != null && wNow < wAvg * 0.85;

  // RSI escaping oversold
  const r = last(ind.rsi) ?? null;
  const rPast = ind.rsi[n - 1 - recentWin] ?? null;
  const rsi_recovery = r != null && rPast != null && rPast < 35 && r > rPast;

  // MACD turning up
  const hist = ind.macd.hist;
  const hNow = last(hist) ?? null;
  const hPast = hist[n - 3] ?? null;
  const mNow = last(ind.macd.macd) ?? null;
  const mPrev = ind.macd.macd[n - 2] ?? null;
  const sNow = last(ind.macd.signal) ?? null;
  const sPrev = ind.macd.signal[n - 2] ?? null;
  const cross = mNow != null && sNow != null && mPrev != null && sPrev != null && mPrev <= sPrev && mNow > sNow;
  const macd_turn = cross || (hNow != null && hPast != null && hNow > hPast && hNow > -Math.abs(hPast));

  return {
    score: acc.score,
    confidence: acc.confidence,
    accumulation: acc.score >= 60,
    box_consolidation,
    obv_rising,
    volume_accum,
    bollinger_squeeze,
    rsi_recovery,
    macd_turn,
    inst_accumulation: null,
    foreign_accumulation: null,
  };
}
