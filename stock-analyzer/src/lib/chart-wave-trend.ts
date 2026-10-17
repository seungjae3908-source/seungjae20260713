import type { NormalizedChartCandle } from './chart-candle-normalizer';
import type { ChartPivotKind, ConfirmedChartPivot } from './chart-structure-engine';

/**
 * 파동(지그재그)·추세선·추세 채널 기하 계산.
 *
 * 모든 계산은 이미 확정된 피벗(오른쪽 확인봉까지 마감된 고점·저점)만 사용하므로
 * 미완성 봉이 들어와도 과거 파동이 다시 그려지지(repaint) 않는다.
 * 추세선 기울기는 시간이 아니라 캔들 인덱스 기준이다. lightweight-charts의 가로축이
 * 봉 단위(주말·장 마감 공백 없음)이므로 화면에 보이는 직선과 계산값이 일치한다.
 */

export const WAVE_UP_COLOR = '#F04452';
export const WAVE_DOWN_COLOR = '#3485FA';
export const WAVE_FLAT_COLOR = '#8B95A1';

export type WaveSwingClassification = 'HH' | 'LH' | 'EH' | 'HL' | 'LL' | 'EL' | 'START';
export type WaveDirection = 'up' | 'down' | 'flat';

export type WaveSwing = {
  id: string;
  kind: ChartPivotKind;
  candleIndex: number;
  time: number;
  price: number;
  confirmedAtTime: number;
  classification: WaveSwingClassification;
  direction: WaveDirection;
  label: string;
};

export type WaveTrend = 'bullish' | 'bearish' | 'mixed' | 'insufficient';

export type WaveStructure = {
  swings: WaveSwing[];
  trend: WaveTrend;
  label: '상승 구조' | '하락 구조' | '혼조' | '판단 보류';
  latestHigh: WaveSwing | null;
  latestLow: WaveSwing | null;
};

export type ChartLinePoint = { candleIndex: number; time: number; value: number };

export type TrendSlope = 'rising' | 'falling' | 'flat';

export type ChartTrendline = {
  id: string;
  role: 'support' | 'resistance';
  slope: TrendSlope;
  anchors: [WaveSwing, WaveSwing];
  slopePerBar: number;
  start: ChartLinePoint;
  end: ChartLinePoint;
  broken: boolean;
  breakTime: number | null;
  label: string;
};

export type ChartTrendChannel = {
  id: string;
  base: 'support' | 'resistance';
  slope: TrendSlope;
  upper: { start: ChartLinePoint; end: ChartLinePoint };
  lower: { start: ChartLinePoint; end: ChartLinePoint };
  width: number;
  position: 'inside' | 'above' | 'below' | 'unknown';
  label: string;
};

export type ChartWaveTrendOverlay = {
  wave: WaveStructure;
  support: ChartTrendline | null;
  resistance: ChartTrendline | null;
  channel: ChartTrendChannel | null;
};

export type WaveTrendOptions = {
  /** 동일 고점·저점으로 보는 상대 오차 (기본 0.15%) */
  equalityTolerance?: number;
  /** 종가가 추세선을 이 비율 이상 넘어 마감해야 이탈로 본다 (기본 0.1%) */
  breakTolerance?: number;
  /** 추세선 앵커를 찾을 때 거슬러 올라가는 최대 스윙 쌍 수 (기본 4) */
  trendlineLookbackPairs?: number;
};

function relativeDifference(left: number, right: number): number {
  return Math.abs(left - right) / Math.max(Math.abs(left), Math.abs(right), Number.EPSILON);
}

function swingLabel(kind: ChartPivotKind, classification: WaveSwingClassification): string {
  switch (classification) {
    case 'HH': return 'HH 고점↑';
    case 'LH': return 'LH 고점↓';
    case 'EH': return 'EH 고점=';
    case 'HL': return 'HL 저점↑';
    case 'LL': return 'LL 저점↓';
    case 'EL': return 'EL 저점=';
    default: return kind === 'high' ? '고점' : '저점';
  }
}

function swingDirection(classification: WaveSwingClassification): WaveDirection {
  if (classification === 'HH' || classification === 'HL') return 'up';
  if (classification === 'LH' || classification === 'LL') return 'down';
  return 'flat';
}

export function waveDirectionColor(direction: WaveDirection): string {
  if (direction === 'up') return WAVE_UP_COLOR;
  if (direction === 'down') return WAVE_DOWN_COLOR;
  return WAVE_FLAT_COLOR;
}

function validPivot(pivot: ConfirmedChartPivot): boolean {
  return Number.isFinite(pivot.price)
    && pivot.price > 0
    && Number.isFinite(pivot.time)
    && Number.isInteger(pivot.candleIndex)
    && pivot.candleIndex >= 0;
}

/**
 * 확정 피벗을 고점·저점이 번갈아 나오는 지그재그 스윙으로 정리한다.
 * 같은 종류가 연속되면 더 극단적인 값(더 높은 고점, 더 낮은 저점) 하나만 남긴다.
 * 고점과 저점이 같은 봉에서 나온 경우(외부봉) 뒤에 온 반대 피벗은 버려
 * 선 시리즈 시간이 항상 엄격히 증가하도록 한다.
 * 분류(HH/LH/HL/LL)는 지그재그상 직전 같은 종류 스윙과 비교해 다시 계산한다.
 */
export function buildWaveSwings(
  pivots: ConfirmedChartPivot[],
  options: Pick<WaveTrendOptions, 'equalityTolerance'> = {},
): WaveSwing[] {
  const equalityTolerance = Math.max(0, options.equalityTolerance ?? 0.0015);
  const ordered = pivots
    .filter(validPivot)
    .slice()
    .sort((left, right) => left.candleIndex - right.candleIndex || left.time - right.time);

  const collapsed: ConfirmedChartPivot[] = [];
  for (const pivot of ordered) {
    const last = collapsed.at(-1);
    if (!last) {
      collapsed.push(pivot);
      continue;
    }
    if (last.kind === pivot.kind) {
      const moreExtreme = pivot.kind === 'high' ? pivot.price > last.price : pivot.price < last.price;
      if (moreExtreme) {
        // 교체 후 직전 반대 스윙과 같은 봉이 되면 시간 순서가 깨지므로 그 경우는 유지한다.
        const beforeLast = collapsed.at(-2);
        if (!beforeLast || beforeLast.candleIndex < pivot.candleIndex) collapsed[collapsed.length - 1] = pivot;
      }
      continue;
    }
    if (pivot.candleIndex <= last.candleIndex) continue;
    collapsed.push(pivot);
  }

  const swings: WaveSwing[] = [];
  let previousHigh: WaveSwing | null = null;
  let previousLow: WaveSwing | null = null;
  for (const pivot of collapsed) {
    const previous = pivot.kind === 'high' ? previousHigh : previousLow;
    let classification: WaveSwingClassification = 'START';
    if (previous) {
      const equal = relativeDifference(pivot.price, previous.price) <= equalityTolerance;
      if (pivot.kind === 'high') classification = equal ? 'EH' : pivot.price > previous.price ? 'HH' : 'LH';
      else classification = equal ? 'EL' : pivot.price > previous.price ? 'HL' : 'LL';
    }
    const swing: WaveSwing = {
      id: `wave:${pivot.kind}:${Math.trunc(pivot.time)}`,
      kind: pivot.kind,
      candleIndex: pivot.candleIndex,
      time: pivot.time,
      price: pivot.price,
      confirmedAtTime: pivot.confirmedAtTime,
      classification,
      direction: swingDirection(classification),
      label: swingLabel(pivot.kind, classification),
    };
    swings.push(swing);
    if (pivot.kind === 'high') previousHigh = swing;
    else previousLow = swing;
  }
  return swings;
}

const WAVE_TREND_LABEL: Record<WaveTrend, WaveStructure['label']> = {
  bullish: '상승 구조',
  bearish: '하락 구조',
  mixed: '혼조',
  insufficient: '판단 보류',
};

export function waveTrendLabel(trend: WaveTrend): WaveStructure['label'] {
  return WAVE_TREND_LABEL[trend];
}

export function classifyWaveStructure(swings: WaveSwing[]): WaveStructure {
  const latestHigh = [...swings].reverse().find((swing) => swing.kind === 'high') ?? null;
  const latestLow = [...swings].reverse().find((swing) => swing.kind === 'low') ?? null;
  let trend: WaveTrend = 'insufficient';
  if (latestHigh && latestLow && latestHigh.classification !== 'START' && latestLow.classification !== 'START') {
    const high = latestHigh.classification;
    const low = latestLow.classification;
    const bullish = (high === 'HH' && (low === 'HL' || low === 'EL')) || (high === 'EH' && low === 'HL');
    const bearish = (low === 'LL' && (high === 'LH' || high === 'EH')) || (low === 'EL' && high === 'LH');
    trend = bullish ? 'bullish' : bearish ? 'bearish' : 'mixed';
  }
  return { swings, trend, label: WAVE_TREND_LABEL[trend], latestHigh, latestLow };
}

export function lineValueAt(left: ChartLinePoint | WaveSwing, right: ChartLinePoint | WaveSwing, candleIndex: number): number {
  const leftValue = 'value' in left ? left.value : left.price;
  const rightValue = 'value' in right ? right.value : right.price;
  const span = right.candleIndex - left.candleIndex;
  if (span === 0) return leftValue;
  return leftValue + ((rightValue - leftValue) / span) * (candleIndex - left.candleIndex);
}

function slopeOf(left: WaveSwing, right: WaveSwing, equalityTolerance: number): TrendSlope {
  if (relativeDifference(left.price, right.price) <= equalityTolerance) return 'flat';
  return right.price > left.price ? 'rising' : 'falling';
}

function closeBeyond(role: ChartTrendline['role'], close: number, lineValue: number, tolerance: number): boolean {
  return role === 'support'
    ? close < lineValue * (1 - tolerance)
    : close > lineValue * (1 + tolerance);
}

function violatedBetween(
  candles: NormalizedChartCandle[],
  role: ChartTrendline['role'],
  left: WaveSwing,
  right: WaveSwing,
  tolerance: number,
): boolean {
  for (let index = left.candleIndex + 1; index < right.candleIndex; index += 1) {
    const candle = candles[index];
    if (!candle || !candle.isClosed) continue;
    if (closeBeyond(role, candle.close, lineValueAt(left, right, index), tolerance)) return true;
  }
  return false;
}

/**
 * 최근 확정 스윙 두 개로 추세선을 만든다.
 * 지지선은 저점이 높아지는 쌍(HL), 저항선은 고점이 낮아지는 쌍(LH)을 우선 찾고,
 * 두 앵커 사이에 종가가 선을 넘은 봉이 있으면 건너뛴다. 조건을 만족하는 쌍이
 * 없으면 가장 최근 두 스윙을 그대로 쓴다. 선은 마지막 봉까지 연장한다.
 * 두 번째 앵커 이후 마감봉 종가가 선을 넘으면 이탈(broken)로 표시한다.
 */
export function buildTrendline(
  candles: NormalizedChartCandle[],
  swings: WaveSwing[],
  role: ChartTrendline['role'],
  options: WaveTrendOptions = {},
): ChartTrendline | null {
  const latestIndex = candles.length - 1;
  if (latestIndex < 1) return null;
  const equalityTolerance = Math.max(0, options.equalityTolerance ?? 0.0015);
  const breakTolerance = Math.max(0, options.breakTolerance ?? 0.001);
  const lookbackPairs = Math.max(1, Math.trunc(options.trendlineLookbackPairs ?? 4));
  const kind: ChartPivotKind = role === 'support' ? 'low' : 'high';
  const sameKind = swings.filter((swing) => swing.kind === kind && swing.candleIndex <= latestIndex);
  if (sameKind.length < 2) return null;

  let anchors: [WaveSwing, WaveSwing] | null = null;
  const earliestPair = Math.max(1, sameKind.length - lookbackPairs);
  for (let index = sameKind.length - 1; index >= earliestPair; index -= 1) {
    const left = sameKind[index - 1];
    const right = sameKind[index];
    const preferred = role === 'support' ? right.price > left.price : right.price < left.price;
    if (preferred && !violatedBetween(candles, role, left, right, breakTolerance)) {
      anchors = [left, right];
      break;
    }
  }
  if (!anchors) anchors = [sameKind.at(-2)!, sameKind.at(-1)!];
  const [left, right] = anchors;
  if (right.candleIndex <= left.candleIndex || right.candleIndex >= latestIndex) return null;

  let breakTime: number | null = null;
  for (let index = right.candleIndex + 1; index <= latestIndex; index += 1) {
    const candle = candles[index];
    if (!candle.isClosed) continue;
    if (closeBeyond(role, candle.close, lineValueAt(left, right, index), breakTolerance)) {
      breakTime = candle.time;
      break;
    }
  }
  const slope = slopeOf(left, right, equalityTolerance);
  const broken = breakTime != null;
  const name = role === 'support'
    ? slope === 'rising' ? '상승 추세선' : slope === 'falling' ? '하락 지지선' : '수평 지지선'
    : slope === 'falling' ? '하락 추세선' : slope === 'rising' ? '상승 저항선' : '수평 저항선';
  return {
    id: `trendline:${role}:${left.time}:${right.time}`,
    role,
    slope,
    anchors,
    slopePerBar: (right.price - left.price) / (right.candleIndex - left.candleIndex),
    start: { candleIndex: left.candleIndex, time: left.time, value: left.price },
    end: { candleIndex: latestIndex, time: candles[latestIndex].time, value: lineValueAt(left, right, latestIndex) },
    broken,
    breakTime,
    label: broken ? `${name} 이탈` : name,
  };
}

function chooseDominantTrendline(
  trend: WaveTrend,
  support: ChartTrendline | null,
  resistance: ChartTrendline | null,
): ChartTrendline | null {
  if (trend === 'bullish' && support) return support;
  if (trend === 'bearish' && resistance) return resistance;
  const candidates = [support, resistance].filter((line): line is ChartTrendline => line != null);
  if (!candidates.length) return null;
  const intact = candidates.filter((line) => !line.broken);
  const pool = intact.length ? intact : candidates;
  return pool.sort((left, right) => right.anchors[1].candleIndex - left.anchors[1].candleIndex)[0];
}

/**
 * 기준 추세선에 평행한 채널을 만든다. 폭은 두 앵커 사이에서 반대편 극값(지지선이면 고가,
 * 저항선이면 저가)이 기준선에서 가장 멀리 떨어진 거리다.
 */
export function buildTrendChannel(
  candles: NormalizedChartCandle[],
  baseLine: ChartTrendline | null,
): ChartTrendChannel | null {
  if (!baseLine) return null;
  const [left, right] = baseLine.anchors;
  const latestIndex = candles.length - 1;
  let width = 0;
  for (let index = left.candleIndex; index <= right.candleIndex; index += 1) {
    const candle = candles[index];
    if (!candle) continue;
    const lineValue = lineValueAt(left, right, index);
    const distance = baseLine.role === 'support' ? candle.high - lineValue : lineValue - candle.low;
    if (Number.isFinite(distance) && distance > width) width = distance;
  }
  if (!(width > 0)) return null;
  const offset = baseLine.role === 'support' ? width : -width;
  const shift = (point: ChartLinePoint): ChartLinePoint => ({ ...point, value: point.value + offset });
  const baseSegment = { start: baseLine.start, end: baseLine.end };
  const parallel = { start: shift(baseLine.start), end: shift(baseLine.end) };
  const upper = baseLine.role === 'support' ? parallel : baseSegment;
  const lower = baseLine.role === 'support' ? baseSegment : parallel;

  let position: ChartTrendChannel['position'] = 'unknown';
  for (let index = latestIndex; index > right.candleIndex; index -= 1) {
    const candle = candles[index];
    if (!candle.isClosed) continue;
    const upperValue = lineValueAt(upper.start, upper.end, index);
    const lowerValue = lineValueAt(lower.start, lower.end, index);
    position = candle.close > upperValue ? 'above' : candle.close < lowerValue ? 'below' : 'inside';
    break;
  }
  const name = baseLine.slope === 'rising' ? '상승 채널' : baseLine.slope === 'falling' ? '하락 채널' : '수평 채널';
  return {
    id: `channel:${baseLine.id}`,
    base: baseLine.role,
    slope: baseLine.slope,
    upper,
    lower,
    width,
    position,
    label: position === 'above' ? `${name} 상단 돌파` : position === 'below' ? `${name} 하단 이탈` : name,
  };
}

export function buildChartWaveTrendOverlay(
  candles: NormalizedChartCandle[],
  pivots: ConfirmedChartPivot[],
  options: WaveTrendOptions = {},
): ChartWaveTrendOverlay {
  const usable = pivots.filter((pivot) => pivot.candleIndex < candles.length && candles[pivot.candleIndex]?.time === pivot.time);
  const wave = classifyWaveStructure(buildWaveSwings(usable, options));
  const support = buildTrendline(candles, wave.swings, 'support', options);
  const resistance = buildTrendline(candles, wave.swings, 'resistance', options);
  const channel = buildTrendChannel(candles, chooseDominantTrendline(wave.trend, support, resistance));
  return { wave, support, resistance, channel };
}

/** 선 시리즈에 넣을 수 있도록 시간 오름차순·중복 제거된 지그재그 좌표 */
export function waveLinePoints(wave: WaveStructure): Array<{ time: number; value: number }> {
  const rows: Array<{ time: number; value: number }> = [];
  for (const swing of wave.swings) {
    const last = rows.at(-1);
    if (last && swing.time <= last.time) continue;
    rows.push({ time: swing.time, value: swing.price });
  }
  return rows;
}

export function segmentLinePoints(segment: { start: ChartLinePoint; end: ChartLinePoint }): Array<{ time: number; value: number }> {
  if (!(segment.end.time > segment.start.time)) return [];
  if (!Number.isFinite(segment.start.value) || !Number.isFinite(segment.end.value)) return [];
  return [
    { time: segment.start.time, value: segment.start.value },
    { time: segment.end.time, value: segment.end.value },
  ];
}
