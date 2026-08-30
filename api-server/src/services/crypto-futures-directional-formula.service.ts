import type {
  ScannerDataState,
  ScannerEvidence,
  ScannerPricePlan,
} from './scanner-signal.types';

export type FuturesScannerDirection = 'LONG' | 'SHORT';
export type FuturesScannerCondition = 'trend' | 'volume' | 'breakout' | 'pullback';
export type FuturesDirectionalDecision = 'LONG' | 'SHORT' | 'NO_TRADE' | 'SIGNAL_CONFLICT';

export interface FuturesDirectionalCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume?: number | null;
}

export interface FuturesDirectionalFormulaInput {
  direction: FuturesScannerDirection;
  timeframe: string;
  condition: FuturesScannerCondition;
  price: number;
  changePercent: number;
  tradingValue: number;
  fundingRate: number | null;
  openInterest: number | null;
  bid: number | null;
  ask: number | null;
  tickerTimestamp: number | null;
  candles: FuturesDirectionalCandle[];
  now?: number;
}

export interface FuturesDirectionalScoreBreakdown {
  trend: number;
  momentum: number;
  volume: number;
  structure: number;
  derivatives: number;
  liquidity: number;
  riskPenalty: number;
}

export interface FuturesDirectionalFormulaResult {
  direction: FuturesScannerDirection;
  score: number;
  confidence: number;
  riskScore: number;
  dataCompleteness: number;
  dataState: ScannerDataState;
  conditionMatched: boolean;
  strongSignalEligible: boolean;
  scoreBreakdown: FuturesDirectionalScoreBreakdown;
  evidence: ScannerEvidence[];
  reasons: string[];
  warnings: string[];
  pricePlan: ScannerPricePlan;
  volatilityPercent: number | null;
}

export interface FuturesDirectionalPairResult {
  long: FuturesDirectionalFormulaResult;
  short: FuturesDirectionalFormulaResult;
  decision: FuturesDirectionalDecision;
  conflictReasons: string[];
}

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sma(values: number[], period: number): number | null {
  return values.length >= period ? average(values.slice(-period)) : null;
}

function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let index = values.length - period; index < values.length; index += 1) {
    const difference = values[index] - values[index - 1];
    if (difference >= 0) gain += difference;
    else loss += Math.abs(difference);
  }
  if (loss === 0) return 100;
  if (gain === 0) return 0;
  const relativeStrength = gain / loss;
  return 100 - 100 / (1 + relativeStrength);
}

function atr(candles: FuturesDirectionalCandle[], period = 14): number | null {
  if (candles.length < 2) return null;
  const rows = candles.slice(-Math.min(period + 1, candles.length));
  const ranges: number[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const current = rows[index];
    const previous = rows[index - 1];
    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    ));
  }
  return average(ranges);
}

function timeframeMs(timeframe: string): number {
  const normalized = timeframe === '60m' ? '1H' : timeframe;
  const units: Record<string, number> = {
    '1m': 60_000,
    '3m': 3 * 60_000,
    '5m': 5 * 60_000,
    '15m': 15 * 60_000,
    '30m': 30 * 60_000,
    '1H': 60 * 60_000,
    '4H': 4 * 60 * 60_000,
    '6H': 6 * 60 * 60_000,
    '12H': 12 * 60 * 60_000,
    '1D': 24 * 60 * 60_000,
    '1W': 7 * 24 * 60 * 60_000,
  };
  return units[normalized] ?? 15 * 60_000;
}

function isStale(input: FuturesDirectionalFormulaInput, latestTime: number): boolean {
  const now = input.now ?? Date.now();
  const candleStaleAfter = timeframeMs(input.timeframe) * 2.5;
  const tickerStale = input.tickerTimestamp != null && now - input.tickerTimestamp > 10 * 60_000;
  return now - latestTime > candleStaleAfter || tickerStale;
}

function calculateSpreadPercent(bid: number | null, ask: number | null): number | null {
  if (bid == null || ask == null || bid <= 0 || ask < bid) return null;
  const midpoint = (bid + ask) / 2;
  return midpoint > 0 ? ((ask - bid) / midpoint) * 100 : null;
}

function priceDigits(price: number): number {
  if (price >= 1_000) return 2;
  if (price >= 1) return 4;
  return 8;
}

function buildPricePlan(
  input: FuturesDirectionalFormulaInput,
  direction: FuturesScannerDirection,
  currentAtr: number | null,
): ScannerPricePlan {
  const empty: ScannerPricePlan = {
    entryZone: null,
    invalidation: null,
    stopLoss: null,
    targets: [],
    riskReward: null,
  };
  if (currentAtr == null || currentAtr <= 0 || input.price <= 0 || input.candles.length < 20) return empty;
  const recent = input.candles.slice(-20);
  const support = Math.min(...recent.map((row) => row.low));
  const resistance = Math.max(...recent.map((row) => row.high));
  const digits = priceDigits(input.price);
  const format = (value: number) => round(Math.max(0, value), digits);

  if (direction === 'LONG') {
    const stop = Math.min(
      support - currentAtr * 0.1,
      input.price - Math.max(currentAtr * 1.25, input.price * 0.008),
    );
    const risk = input.price - stop;
    if (!(risk > 0)) return empty;
    const target1 = Math.max(resistance, input.price + risk * 1.5);
    return {
      entryZone: {
        from: format(Math.max(support, input.price - currentAtr * 0.35)),
        to: format(input.price),
      },
      invalidation: format(stop),
      stopLoss: format(stop),
      targets: [format(target1), format(input.price + risk * 2.2)],
      riskReward: round((target1 - input.price) / risk),
    };
  }

  const stop = Math.max(
    resistance + currentAtr * 0.1,
    input.price + Math.max(currentAtr * 1.25, input.price * 0.008),
  );
  const risk = stop - input.price;
  if (!(risk > 0)) return empty;
  const target1 = Math.min(support, input.price - risk * 1.5);
  return {
    entryZone: {
      from: format(input.price),
      to: format(Math.min(resistance, input.price + currentAtr * 0.35)),
    },
    invalidation: format(stop),
    stopLoss: format(stop),
    targets: [format(target1), format(Math.max(0, input.price - risk * 2.2))],
    riskReward: round((input.price - target1) / risk),
  };
}

function alignedCandle(direction: FuturesScannerDirection, candle: FuturesDirectionalCandle): boolean {
  return direction === 'LONG' ? candle.close >= candle.open : candle.close <= candle.open;
}

function derivativeScore(
  direction: FuturesScannerDirection,
  fundingRate: number | null,
  openInterest: number | null,
  reasons: string[],
): number {
  let score = 0;
  if (openInterest != null && openInterest > 0) {
    score += 4;
    reasons.push('미결제약정 데이터 확인');
  }
  if (fundingRate == null) return score;

  if (direction === 'LONG') {
    if (fundingRate < -0.0006) {
      score += 8;
      reasons.push('음(-) 펀딩 과열의 반대편 LONG 기회');
    } else if (fundingRate <= 0.0003) {
      score += 4;
      reasons.push('LONG에 과도하지 않은 펀딩');
    } else if (fundingRate > 0.001) {
      score -= 6;
      reasons.push('과도한 양(+) 펀딩 LONG 패널티');
    }
  } else if (fundingRate > 0.0006) {
    score += 8;
    reasons.push('양(+) 펀딩 과열의 반대편 SHORT 기회');
  } else if (fundingRate >= -0.0003) {
    score += 4;
    reasons.push('SHORT에 과도하지 않은 펀딩');
  } else if (fundingRate < -0.001) {
    score -= 6;
    reasons.push('과도한 음(-) 펀딩 SHORT 패널티');
  }
  return score;
}

export function evaluateFuturesDirectionalFormula(
  input: FuturesDirectionalFormulaInput,
): FuturesDirectionalFormulaResult {
  const now = input.now ?? Date.now();
  const rows = input.candles
    .filter((row) => Number.isFinite(row.time)
      && row.time > 0
      && [row.open, row.high, row.low, row.close].every((value) => Number.isFinite(value) && value > 0)
      && Number.isFinite(row.volume)
      && row.volume >= 0)
    .sort((left, right) => left.time - right.time);
  const latest = rows.at(-1);
  const warnings: string[] = [];
  const reasons: string[] = [];

  if (!latest || input.price <= 0) {
    return {
      direction: input.direction,
      score: 0,
      confidence: 0,
      riskScore: 100,
      dataCompleteness: 0,
      dataState: 'insufficient',
      conditionMatched: false,
      strongSignalEligible: false,
      scoreBreakdown: {
        trend: 0,
        momentum: 0,
        volume: 0,
        structure: 0,
        derivatives: 0,
        liquidity: 0,
        riskPenalty: 100,
      },
      evidence: [],
      reasons: [],
      warnings: ['유효한 선물 가격 또는 캔들이 없습니다.'],
      pricePlan: { entryZone: null, invalidation: null, stopLoss: null, targets: [], riskReward: null },
      volatilityPercent: null,
    };
  }

  const closes = rows.map((row) => row.close);
  const ma5 = sma(closes, 5);
  const ma20 = sma(closes, 20);
  const currentRsi = rsi(closes);
  const currentAtr = atr(rows);
  const baselineVolume = average(rows.slice(-21, -1).map((row) => row.volume));
  const volumeRatio = baselineVolume != null && baselineVolume > 0 ? latest.volume / baselineVolume : null;
  const prior = rows.slice(-21, -1);
  const resistance = prior.length ? Math.max(...prior.map((row) => row.high)) : null;
  const support = prior.length ? Math.min(...prior.map((row) => row.low)) : null;
  const spreadPercent = calculateSpreadPercent(input.bid, input.ask);
  const volatilityPercent = currentAtr != null ? (currentAtr / input.price) * 100 : null;
  const stale = isStale({ ...input, candles: rows, now }, latest.time);

  let trend = 0;
  if (ma20 != null) {
    const priceTrendMatched = input.direction === 'LONG' ? input.price > ma20 : input.price < ma20;
    if (priceTrendMatched) {
      trend += 10;
      reasons.push(input.direction === 'LONG' ? '현재가가 20기간 평균 위' : '현재가가 20기간 평균 아래');
    }
  }
  if (ma5 != null && ma20 != null) {
    const averageTrendMatched = input.direction === 'LONG' ? ma5 > ma20 : ma5 < ma20;
    if (averageTrendMatched) {
      trend += 10;
      reasons.push(input.direction === 'LONG' ? '단기 평균이 중기 평균 위' : '단기 평균이 중기 평균 아래');
    }
  }

  let momentum = 0;
  if (currentRsi != null) {
    if (input.direction === 'LONG') {
      if (currentRsi >= 45 && currentRsi <= 68) {
        momentum += 10;
        reasons.push(`RSI ${currentRsi.toFixed(1)} LONG 모멘텀 구간`);
      } else if (currentRsi <= 35) {
        momentum += 5;
        reasons.push(`RSI ${currentRsi.toFixed(1)} 과매도 반등 관찰`);
      }
    } else if (currentRsi >= 32 && currentRsi <= 55) {
      momentum += 10;
      reasons.push(`RSI ${currentRsi.toFixed(1)} SHORT 모멘텀 구간`);
    } else if (currentRsi >= 72) {
      momentum += 5;
      reasons.push(`RSI ${currentRsi.toFixed(1)} 과열 되돌림 관찰`);
    }
  }

  let volume = 0;
  const volumeAligned = volumeRatio != null && volumeRatio >= 1.3 && alignedCandle(input.direction, latest);
  if (volumeAligned) {
    volume += 10;
    reasons.push(`방향 일치 거래량 ${volumeRatio!.toFixed(2)}배`);
  }

  const breakoutLong = resistance != null && input.price >= resistance;
  const breakoutShort = support != null && input.price <= support;
  const pullbackLong = ma20 != null && ma5 != null && ma5 > ma20
    && input.price >= ma20 * 0.98 && input.price <= ma20 * 1.03;
  const pullbackShort = ma20 != null && ma5 != null && ma5 < ma20
    && input.price <= ma20 * 1.02 && input.price >= ma20 * 0.97;
  const structureMatched = input.direction === 'LONG' ? breakoutLong : breakoutShort;
  const pullbackMatched = input.direction === 'LONG' ? pullbackLong : pullbackShort;
  let structure = 0;
  if (structureMatched) {
    structure += 12;
    reasons.push(input.direction === 'LONG' ? '20기간 고가 돌파' : '20기간 저가 이탈');
  }
  if (pullbackMatched) {
    structure += 6;
    reasons.push(input.direction === 'LONG' ? '상승 추세 눌림 구간' : '하락 추세 반등 실패 구간');
  }

  const derivatives = derivativeScore(input.direction, input.fundingRate, input.openInterest, reasons);
  const liquidity = input.tradingValue >= 5_000_000 ? 8 : input.tradingValue > 0 ? 3 : 0;

  const conditionMatched = input.condition === 'trend'
    ? trend >= 20
    : input.condition === 'volume'
      ? volumeAligned
      : input.condition === 'breakout'
        ? structureMatched
        : pullbackMatched;

  let riskScore = 0;
  if (spreadPercent == null) riskScore += 20;
  else if (spreadPercent > 0.6) riskScore += 35;
  else if (spreadPercent > 0.25) riskScore += 18;
  if (volatilityPercent == null) riskScore += 15;
  else if (volatilityPercent > 6) riskScore += 30;
  else if (volatilityPercent > 3) riskScore += 15;
  if (Math.abs(input.changePercent) > 25) riskScore += 30;
  else if (Math.abs(input.changePercent) > 12) riskScore += 15;
  if (stale) riskScore += 30;
  if (input.tradingValue < 5_000_000) riskScore += 20;
  if (input.fundingRate != null && Math.abs(input.fundingRate) > 0.001) riskScore += 15;
  riskScore = Math.round(clamp(riskScore));

  let dataCompleteness = 0;
  dataCompleteness += input.price > 0 ? 10 : 0;
  dataCompleteness += rows.length >= 30 ? 25 : Math.min(18, (rows.length / 30) * 18);
  dataCompleteness += input.tradingValue > 0 ? 10 : 0;
  dataCompleteness += !stale ? 15 : 0;
  dataCompleteness += spreadPercent != null ? 10 : 0;
  dataCompleteness += input.fundingRate != null ? 10 : 0;
  dataCompleteness += input.openInterest != null && input.openInterest > 0 ? 10 : 0;
  dataCompleteness += conditionMatched ? 10 : 0;
  dataCompleteness = Math.round(clamp(dataCompleteness));

  const positiveScore = 30 + trend + momentum + volume + structure + derivatives + liquidity;
  let scoreCap = 100;
  if (dataCompleteness < 50) scoreCap = 49;
  else if (dataCompleteness < 65) scoreCap = 59;
  else if (dataCompleteness < 80) scoreCap = 69;
  if (stale) scoreCap = Math.min(scoreCap, 49);
  if (riskScore > 60) scoreCap = Math.min(scoreCap, 64);
  const score = Math.round(clamp(Math.min(positiveScore - Math.round(riskScore * 0.15), scoreCap)));

  const verifiedInputs = [
    ma5 != null && ma20 != null,
    currentRsi != null,
    volumeRatio != null,
    spreadPercent != null,
    currentAtr != null,
    input.fundingRate != null,
    input.openInterest != null && input.openInterest > 0,
  ].filter(Boolean).length;
  const confidence = Math.round(Math.min(
    dataCompleteness,
    45 + verifiedInputs * 7,
    stale ? 49 : 100,
  ));
  const dataState: ScannerDataState = stale
    ? 'stale'
    : rows.length < 20
      ? 'insufficient'
      : dataCompleteness < 80
        ? 'partial'
        : 'complete';
  const pricePlan = buildPricePlan({ ...input, candles: rows, now }, input.direction, currentAtr);
  const strongSignalEligible = conditionMatched
    && score >= 75
    && confidence >= 70
    && dataCompleteness >= 80
    && riskScore <= 45
    && dataState === 'complete'
    && pricePlan.riskReward != null
    && pricePlan.riskReward >= 1.5;

  if (stale) warnings.push('시세 또는 캔들이 오래됐습니다.');
  if (spreadPercent == null) warnings.push('스프레드 미확인');
  if (input.fundingRate == null) warnings.push('펀딩비 미확인');
  if (input.openInterest == null || input.openInterest <= 0) warnings.push('미결제약정 미확인');
  if (!conditionMatched) warnings.push(`${input.direction} 방향 선택 조건 미충족`);

  const observedAt = new Date(Math.max(latest.time, input.tickerTimestamp ?? 0)).toISOString();
  const evidence: ScannerEvidence[] = [
    {
      key: `${input.direction.toLowerCase()}-${input.condition}`,
      label: `${input.direction} ${input.condition}`,
      status: conditionMatched ? 'matched' : 'not_matched',
      source: 'public-candles',
      observedAt,
      reasons: conditionMatched ? reasons.slice(0, 6) : [`${input.direction} 방향 조건을 충족하지 않았습니다.`],
    },
    {
      key: `${input.direction.toLowerCase()}-derivatives`,
      label: `${input.direction} 펀딩·미결제약정`,
      status: input.fundingRate != null && input.openInterest != null && input.openInterest > 0 ? 'matched' : 'unverified',
      source: 'bitget-public-market-data',
      observedAt,
      reasons: [
        input.fundingRate == null ? '펀딩비 미확인' : `펀딩비 ${(input.fundingRate * 100).toFixed(4)}%`,
        input.openInterest == null ? '미결제약정 미확인' : `미결제약정 ${round(input.openInterest, 2)}`,
      ],
    },
    {
      key: `${input.direction.toLowerCase()}-risk`,
      label: `${input.direction} 위험`,
      status: riskScore <= 45 ? 'matched' : 'not_matched',
      source: 'deterministic-risk-policy',
      observedAt,
      reasons: [
        `위험 점수 ${riskScore}`,
        volatilityPercent == null ? 'ATR 미확인' : `ATR 변동성 ${volatilityPercent.toFixed(2)}%`,
        spreadPercent == null ? '스프레드 미확인' : `스프레드 ${spreadPercent.toFixed(3)}%`,
      ],
    },
  ];

  return {
    direction: input.direction,
    score,
    confidence,
    riskScore,
    dataCompleteness,
    dataState,
    conditionMatched,
    strongSignalEligible,
    scoreBreakdown: {
      trend,
      momentum,
      volume,
      structure,
      derivatives,
      liquidity,
      riskPenalty: Math.round(riskScore * 0.15),
    },
    evidence,
    reasons: reasons.slice(0, 10),
    warnings,
    pricePlan,
    volatilityPercent: volatilityPercent == null ? null : round(volatilityPercent),
  };
}

export function evaluateFuturesDirectionalPair(
  input: Omit<FuturesDirectionalFormulaInput, 'direction'>,
): FuturesDirectionalPairResult {
  const long = evaluateFuturesDirectionalFormula({ ...input, direction: 'LONG' });
  const short = evaluateFuturesDirectionalFormula({ ...input, direction: 'SHORT' });
  const conflictReasons: string[] = [];

  let decision: FuturesDirectionalDecision = 'NO_TRADE';
  if (long.strongSignalEligible && short.strongSignalEligible) {
    decision = 'SIGNAL_CONFLICT';
    conflictReasons.push('LONG과 SHORT가 각각 독립 강한 신호 조건을 동시에 충족했습니다.');
  } else if (long.strongSignalEligible) {
    decision = 'LONG';
  } else if (short.strongSignalEligible) {
    decision = 'SHORT';
  }

  return { long, short, decision, conflictReasons };
}
