import type { NormalizedChartCandle } from './chart-candle-normalizer';

export type CandlePatternType =
  | 'hammer'
  | 'shooting-star'
  | 'bullish-engulfing'
  | 'bearish-engulfing'
  | 'morning-star'
  | 'evening-star';

export type CandlePatternBias = 'bullish' | 'bearish';

export type DetectedCandlePattern = {
  id: string;
  type: CandlePatternType;
  label: string;
  bias: CandlePatternBias;
  status: 'confirmed';
  candleTimes: number[];
  detectedAtTime: number;
  reasons: string[];
};

type CandleShape = {
  candle: NormalizedChartCandle;
  body: number;
  range: number;
  upperWick: number;
  lowerWick: number;
  bullish: boolean;
  bearish: boolean;
};

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function toShape(candle: NormalizedChartCandle): CandleShape | null {
  if (!candle.isClosed) return null;
  if (![candle.open, candle.high, candle.low, candle.close].every(isFiniteNumber)) return null;
  if (candle.high <= candle.low) return null;
  if (candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close)) return null;

  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  return {
    candle,
    body,
    range,
    upperWick: candle.high - Math.max(candle.open, candle.close),
    lowerWick: Math.min(candle.open, candle.close) - candle.low,
    bullish: candle.close > candle.open,
    bearish: candle.close < candle.open,
  };
}

function pattern(
  type: CandlePatternType,
  label: string,
  bias: CandlePatternBias,
  shapes: CandleShape[],
  reasons: string[],
): DetectedCandlePattern {
  const candleTimes = shapes.map((shape) => shape.candle.time);
  const detectedAtTime = candleTimes[candleTimes.length - 1];
  return {
    id: `candle-pattern:${type}:${candleTimes.join(':')}`,
    type,
    label,
    bias,
    status: 'confirmed',
    candleTimes,
    detectedAtTime,
    reasons,
  };
}

function detectSingle(shape: CandleShape): DetectedCandlePattern[] {
  const results: DetectedCandlePattern[] = [];
  const meaningfulBody = Math.max(shape.body, shape.range * 0.02);
  const compactBody = shape.body <= shape.range * 0.4;

  if (
    compactBody
    && shape.lowerWick >= meaningfulBody * 2
    && shape.lowerWick >= shape.range * 0.45
    && shape.upperWick <= Math.max(meaningfulBody, shape.range * 0.15)
  ) {
    results.push(pattern('hammer', 'Hammer · 망치형', 'bullish', [shape], [
      '확정봉의 아래꼬리가 실체의 2배 이상',
      '실체가 전체 변동폭의 40% 이하',
      '위꼬리가 제한된 망치형 구조',
    ]));
  }

  if (
    compactBody
    && shape.upperWick >= meaningfulBody * 2
    && shape.upperWick >= shape.range * 0.45
    && shape.lowerWick <= Math.max(meaningfulBody, shape.range * 0.15)
  ) {
    results.push(pattern('shooting-star', 'Shooting Star · 유성형', 'bearish', [shape], [
      '확정봉의 위꼬리가 실체의 2배 이상',
      '실체가 전체 변동폭의 40% 이하',
      '아래꼬리가 제한된 유성형 구조',
    ]));
  }

  return results;
}

function detectEngulfing(previous: CandleShape, current: CandleShape): DetectedCandlePattern[] {
  const results: DetectedCandlePattern[] = [];
  const previousLow = Math.min(previous.candle.open, previous.candle.close);
  const previousHigh = Math.max(previous.candle.open, previous.candle.close);
  const currentLow = Math.min(current.candle.open, current.candle.close);
  const currentHigh = Math.max(current.candle.open, current.candle.close);
  const bodyEngulfs = currentLow <= previousLow && currentHigh >= previousHigh && current.body > previous.body;

  if (previous.bearish && current.bullish && bodyEngulfs) {
    results.push(pattern('bullish-engulfing', 'Bullish Engulfing · 상승 장악형', 'bullish', [previous, current], [
      '직전 확정봉은 음봉, 현재 확정봉은 양봉',
      '현재 실체가 직전 실체 범위를 완전히 포함',
      '현재 실체 크기가 직전 실체보다 큼',
    ]));
  }

  if (previous.bullish && current.bearish && bodyEngulfs) {
    results.push(pattern('bearish-engulfing', 'Bearish Engulfing · 하락 장악형', 'bearish', [previous, current], [
      '직전 확정봉은 양봉, 현재 확정봉은 음봉',
      '현재 실체가 직전 실체 범위를 완전히 포함',
      '현재 실체 크기가 직전 실체보다 큼',
    ]));
  }

  return results;
}

function detectStar(first: CandleShape, middle: CandleShape, third: CandleShape): DetectedCandlePattern[] {
  const results: DetectedCandlePattern[] = [];
  const firstIsDirectional = first.body >= first.range * 0.5;
  const thirdIsDirectional = third.body >= third.range * 0.5;
  const middleIsSmall = middle.body <= first.body * 0.5 && middle.body <= middle.range * 0.4;
  const firstMidpoint = (first.candle.open + first.candle.close) / 2;

  if (
    first.bearish
    && firstIsDirectional
    && middleIsSmall
    && third.bullish
    && thirdIsDirectional
    && third.candle.close >= firstMidpoint
  ) {
    results.push(pattern('morning-star', 'Morning Star · 샛별형', 'bullish', [first, middle, third], [
      '첫 확정봉은 큰 음봉',
      '중간 확정봉의 실체가 첫 봉의 절반 이하',
      '세 번째 확정 양봉이 첫 봉 실체 중간값 이상에서 마감',
    ]));
  }

  if (
    first.bullish
    && firstIsDirectional
    && middleIsSmall
    && third.bearish
    && thirdIsDirectional
    && third.candle.close <= firstMidpoint
  ) {
    results.push(pattern('evening-star', 'Evening Star · 석별형', 'bearish', [first, middle, third], [
      '첫 확정봉은 큰 양봉',
      '중간 확정봉의 실체가 첫 봉의 절반 이하',
      '세 번째 확정 음봉이 첫 봉 실체 중간값 이하에서 마감',
    ]));
  }

  return results;
}

export function detectLatestCandlePatterns(candles: NormalizedChartCandle[]): DetectedCandlePattern[] {
  const closedShapes = candles
    .map(toShape)
    .filter((shape): shape is CandleShape => shape != null);
  if (!closedShapes.length) return [];

  const latest = closedShapes[closedShapes.length - 1];
  const results = detectSingle(latest);

  if (closedShapes.length >= 2) {
    results.push(...detectEngulfing(closedShapes[closedShapes.length - 2], latest));
  }
  if (closedShapes.length >= 3) {
    results.push(...detectStar(
      closedShapes[closedShapes.length - 3],
      closedShapes[closedShapes.length - 2],
      latest,
    ));
  }

  return results;
}
