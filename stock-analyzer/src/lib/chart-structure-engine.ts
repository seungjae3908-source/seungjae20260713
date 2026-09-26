import type { NormalizedChartCandle } from './chart-candle-normalizer';

export type ChartPivotKind = 'high' | 'low';
export type ChartPivotClassification = 'HH' | 'LH' | 'EH' | 'HL' | 'LL' | 'EL' | 'UNCLASSIFIED';

export type ConfirmedChartPivot = {
  id: string;
  kind: ChartPivotKind;
  candleIndex: number;
  time: number;
  price: number;
  confirmedAtTime: number;
  classification: ChartPivotClassification;
};

export type ChartMarketStructure = {
  pivots: ConfirmedChartPivot[];
  trend: 'bullish' | 'bearish' | 'mixed' | 'insufficient';
  latestHigh: ConfirmedChartPivot | null;
  latestLow: ConfirmedChartPivot | null;
};

export type ChartPatternStatus = 'candidate' | 'confirmed' | 'invalidated' | 'expired';

export type DetectedChartPattern = {
  id: string;
  type: 'double-top' | 'double-bottom';
  label: 'M자 · 이중천장' | 'W자 · 이중바닥';
  bias: 'bearish' | 'bullish';
  status: ChartPatternStatus;
  anchorPivots: [ConfirmedChartPivot, ConfirmedChartPivot];
  neckline: number;
  invalidationLevel: number;
  detectedAtTime: number;
  updatedAtTime: number;
  confirmationTime?: number;
  invalidationTime?: number;
  reasons: string[];
};

export type ChartStructureResult = {
  marketStructure: ChartMarketStructure;
  patterns: DetectedChartPattern[];
};

function relativeDifference(left: number, right: number): number {
  return Math.abs(left - right) / Math.max(Math.abs(left), Math.abs(right), Number.EPSILON);
}

function pivotId(kind: ChartPivotKind, time: number): string {
  return `pivot:${kind}:${Math.trunc(time)}`;
}

function isPivotHigh(candles: NormalizedChartCandle[], index: number, left: number, right: number): boolean {
  const price = candles[index].high;
  for (let offset = 1; offset <= left; offset += 1) {
    if (candles[index - offset].high >= price) return false;
  }
  for (let offset = 1; offset <= right; offset += 1) {
    if (candles[index + offset].high > price) return false;
  }
  return true;
}

function isPivotLow(candles: NormalizedChartCandle[], index: number, left: number, right: number): boolean {
  const price = candles[index].low;
  for (let offset = 1; offset <= left; offset += 1) {
    if (candles[index - offset].low <= price) return false;
  }
  for (let offset = 1; offset <= right; offset += 1) {
    if (candles[index + offset].low < price) return false;
  }
  return true;
}

function classifyPivot(
  pivot: Omit<ConfirmedChartPivot, 'classification'>,
  previousSameKind: ConfirmedChartPivot | null,
  equalityTolerance: number,
): ChartPivotClassification {
  if (!previousSameKind) return 'UNCLASSIFIED';
  const equal = relativeDifference(pivot.price, previousSameKind.price) <= equalityTolerance;
  if (pivot.kind === 'high') {
    if (equal) return 'EH';
    return pivot.price > previousSameKind.price ? 'HH' : 'LH';
  }
  if (equal) return 'EL';
  return pivot.price > previousSameKind.price ? 'HL' : 'LL';
}

export function detectConfirmedPivots(
  candles: NormalizedChartCandle[],
  options: { leftBars?: number; rightBars?: number; equalityTolerance?: number } = {},
): ConfirmedChartPivot[] {
  const leftBars = Math.max(1, Math.trunc(options.leftBars ?? 2));
  const rightBars = Math.max(1, Math.trunc(options.rightBars ?? 2));
  const equalityTolerance = Math.max(0, options.equalityTolerance ?? 0.0015);
  const pivots: ConfirmedChartPivot[] = [];
  let previousHigh: ConfirmedChartPivot | null = null;
  let previousLow: ConfirmedChartPivot | null = null;

  for (let index = leftBars; index < candles.length - rightBars; index += 1) {
    const candidate = candles[index];
    const confirmationCandle = candles[index + rightBars];
    if (!candidate.isClosed || !confirmationCandle.isClosed) continue;

    const high = isPivotHigh(candles, index, leftBars, rightBars);
    const low = isPivotLow(candles, index, leftBars, rightBars);
    if (!high && !low) continue;

    if (high) {
      const base = {
        id: pivotId('high', candidate.time),
        kind: 'high' as const,
        candleIndex: index,
        time: candidate.time,
        price: candidate.high,
        confirmedAtTime: confirmationCandle.time,
      };
      const pivot: ConfirmedChartPivot = {
        ...base,
        classification: classifyPivot(base, previousHigh, equalityTolerance),
      };
      pivots.push(pivot);
      previousHigh = pivot;
    }

    if (low) {
      const base = {
        id: pivotId('low', candidate.time),
        kind: 'low' as const,
        candleIndex: index,
        time: candidate.time,
        price: candidate.low,
        confirmedAtTime: confirmationCandle.time,
      };
      const pivot: ConfirmedChartPivot = {
        ...base,
        classification: classifyPivot(base, previousLow, equalityTolerance),
      };
      pivots.push(pivot);
      previousLow = pivot;
    }
  }

  return pivots.sort((left, right) => left.time - right.time || left.kind.localeCompare(right.kind));
}

function marketTrend(pivots: ConfirmedChartPivot[]): ChartMarketStructure['trend'] {
  const latestHigh = [...pivots].reverse().find((pivot) => pivot.kind === 'high') ?? null;
  const latestLow = [...pivots].reverse().find((pivot) => pivot.kind === 'low') ?? null;
  if (!latestHigh || !latestLow) return 'insufficient';
  const bullishHigh = latestHigh.classification === 'HH' || latestHigh.classification === 'EH';
  const bullishLow = latestLow.classification === 'HL' || latestLow.classification === 'EL';
  const bearishHigh = latestHigh.classification === 'LH' || latestHigh.classification === 'EH';
  const bearishLow = latestLow.classification === 'LL' || latestLow.classification === 'EL';
  if (bullishHigh && bullishLow) return 'bullish';
  if (bearishHigh && bearishLow) return 'bearish';
  return 'mixed';
}

export function buildMarketStructure(pivots: ConfirmedChartPivot[]): ChartMarketStructure {
  return {
    pivots,
    trend: marketTrend(pivots),
    latestHigh: [...pivots].reverse().find((pivot) => pivot.kind === 'high') ?? null,
    latestLow: [...pivots].reverse().find((pivot) => pivot.kind === 'low') ?? null,
  };
}

function patternId(type: DetectedChartPattern['type'], left: ConfirmedChartPivot, right: ConfirmedChartPivot): string {
  return `pattern:${type}:${left.time}:${right.time}`;
}

function latestClosedCandle(candles: NormalizedChartCandle[]): NormalizedChartCandle | null {
  return [...candles].reverse().find((candle) => candle.isClosed) ?? null;
}

function extremeBetween(
  candles: NormalizedChartCandle[],
  leftIndex: number,
  rightIndex: number,
  key: 'high' | 'low',
): number | null {
  const values = candles.slice(leftIndex + 1, rightIndex).map((candle) => candle[key]);
  if (!values.length) return null;
  return key === 'high' ? Math.max(...values) : Math.min(...values);
}

function patternExpired(right: ConfirmedChartPivot, latest: NormalizedChartCandle, maximumBars: number, candles: NormalizedChartCandle[]): boolean {
  const latestIndex = candles.findIndex((candle) => candle.time === latest.time);
  return latestIndex - right.candleIndex > maximumBars;
}

function detectDoubleTop(
  candles: NormalizedChartCandle[],
  highs: ConfirmedChartPivot[],
  tolerance: number,
  minimumSeparationBars: number,
  maximumAgeBars: number,
): DetectedChartPattern | null {
  if (highs.length < 2) return null;
  const [left, right] = highs.slice(-2);
  if (right.candleIndex - left.candleIndex < minimumSeparationBars) return null;
  if (relativeDifference(left.price, right.price) > tolerance) return null;
  const neckline = extremeBetween(candles, left.candleIndex, right.candleIndex, 'low');
  const latest = latestClosedCandle(candles);
  if (neckline == null || !latest) return null;
  const invalidationLevel = Math.max(left.price, right.price) * (1 + tolerance * 0.25);
  const confirmed = latest.close < neckline;
  const invalidated = latest.close > invalidationLevel;
  const expired = !confirmed && !invalidated && patternExpired(right, latest, maximumAgeBars, candles);
  const status: ChartPatternStatus = confirmed ? 'confirmed' : invalidated ? 'invalidated' : expired ? 'expired' : 'candidate';
  return {
    id: patternId('double-top', left, right),
    type: 'double-top',
    label: 'M자 · 이중천장',
    bias: 'bearish',
    status,
    anchorPivots: [left, right],
    neckline,
    invalidationLevel,
    detectedAtTime: right.confirmedAtTime,
    updatedAtTime: latest.time,
    confirmationTime: confirmed ? latest.time : undefined,
    invalidationTime: invalidated ? latest.time : undefined,
    reasons: [
      '두 개의 확정 고점이 허용 오차 안에서 형성됨',
      `넥라인 ${neckline}`,
      confirmed ? '확정봉이 넥라인 아래에서 마감' : invalidated ? '확정봉이 기준 고점 위에서 마감' : '넥라인 이탈 여부 확인 중',
    ],
  };
}

function detectDoubleBottom(
  candles: NormalizedChartCandle[],
  lows: ConfirmedChartPivot[],
  tolerance: number,
  minimumSeparationBars: number,
  maximumAgeBars: number,
): DetectedChartPattern | null {
  if (lows.length < 2) return null;
  const [left, right] = lows.slice(-2);
  if (right.candleIndex - left.candleIndex < minimumSeparationBars) return null;
  if (relativeDifference(left.price, right.price) > tolerance) return null;
  const neckline = extremeBetween(candles, left.candleIndex, right.candleIndex, 'high');
  const latest = latestClosedCandle(candles);
  if (neckline == null || !latest) return null;
  const invalidationLevel = Math.min(left.price, right.price) * (1 - tolerance * 0.25);
  const confirmed = latest.close > neckline;
  const invalidated = latest.close < invalidationLevel;
  const expired = !confirmed && !invalidated && patternExpired(right, latest, maximumAgeBars, candles);
  const status: ChartPatternStatus = confirmed ? 'confirmed' : invalidated ? 'invalidated' : expired ? 'expired' : 'candidate';
  return {
    id: patternId('double-bottom', left, right),
    type: 'double-bottom',
    label: 'W자 · 이중바닥',
    bias: 'bullish',
    status,
    anchorPivots: [left, right],
    neckline,
    invalidationLevel,
    detectedAtTime: right.confirmedAtTime,
    updatedAtTime: latest.time,
    confirmationTime: confirmed ? latest.time : undefined,
    invalidationTime: invalidated ? latest.time : undefined,
    reasons: [
      '두 개의 확정 저점이 허용 오차 안에서 형성됨',
      `넥라인 ${neckline}`,
      confirmed ? '확정봉이 넥라인 위에서 마감' : invalidated ? '확정봉이 기준 저점 아래에서 마감' : '넥라인 돌파 여부 확인 중',
    ],
  };
}

export function analyzeChartStructure(
  candles: NormalizedChartCandle[],
  options: {
    leftBars?: number;
    rightBars?: number;
    equalityTolerance?: number;
    patternTolerance?: number;
    minimumPatternSeparationBars?: number;
    maximumPatternAgeBars?: number;
  } = {},
): ChartStructureResult {
  const pivots = detectConfirmedPivots(candles, options);
  const highs = pivots.filter((pivot) => pivot.kind === 'high');
  const lows = pivots.filter((pivot) => pivot.kind === 'low');
  const tolerance = Math.max(0.001, options.patternTolerance ?? 0.012);
  const minimumSeparationBars = Math.max(2, Math.trunc(options.minimumPatternSeparationBars ?? 4));
  const maximumAgeBars = Math.max(minimumSeparationBars + 1, Math.trunc(options.maximumPatternAgeBars ?? 60));
  const patterns = [
    detectDoubleTop(candles, highs, tolerance, minimumSeparationBars, maximumAgeBars),
    detectDoubleBottom(candles, lows, tolerance, minimumSeparationBars, maximumAgeBars),
  ].filter((pattern): pattern is DetectedChartPattern => pattern != null);

  return { marketStructure: buildMarketStructure(pivots), patterns };
}
