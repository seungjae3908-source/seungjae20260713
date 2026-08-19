import type {
  AnalysisMarket,
  AnalysisPricePlan,
  AnalysisTradeAction,
} from './analysis-selection';
import type { ChartAnalysisStatus } from './chart-analysis';
import type {
  UnifiedChartDataStatus,
  UnifiedChartTimeframe,
} from './unified-chart-data';

export type AiChartStrategyMode = 'SCALPING' | 'SWING' | 'MID_LONG';
export type AiChartMarket = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
export type AiChartSignalSide = 'BUY' | 'SELL' | 'LONG' | 'SHORT' | 'NO_TRADE' | 'UNKNOWN' | 'WAIT';
export type AiChartSignalLifecycle = 'ACTIVE' | 'WEAKENED' | 'INVALIDATED' | 'EXPIRED';
export type AiChartDataQuality = 'LIVE' | 'DELAYED' | 'STALE' | 'PARTIAL' | 'UNAVAILABLE';
export type AiChartEvidenceState = 'READY' | 'INSUFFICIENT_DATA';
export type AiChartTrend = 'bullish' | 'bearish' | 'mixed' | 'insufficient';

export type AiChartTechnicalEvidenceInput = {
  market: AnalysisMarket;
  mode: AiChartStrategyMode;
  timeframe: UnifiedChartTimeframe;
  dataStatus: UnifiedChartDataStatus;
  candleCount: number;
  trend: AiChartTrend;
  close: number | null;
  ema12: number | null;
  ema26: number | null;
  vwap: number | null;
  rsi14: number | null;
  macdHistogram: number | null;
  volumeRatio20: number | null;
  atr14: number | null;
  scannerAction?: AnalysisTradeAction;
  scannerConfidence?: number;
  scannerReasons?: string[];
};

export type AiChartTimeframeEvidence = {
  timeframe: UnifiedChartTimeframe;
  state: AiChartEvidenceState;
  side: AiChartSignalSide;
  score: number | null;
  quality: AiChartDataQuality;
  positiveFactors: string[];
  negativeFactors: string[];
  riskFactors: string[];
  reasonCodes: string[];
  source: 'SCANNER' | 'TECHNICAL_EVIDENCE' | 'NONE';
};

export type AiChartPricePlanMapping = {
  entries: [number | null, number | null, number | null];
  stop: number | null;
  invalidation: number | null;
  targets: [number | null, number | null, number | null];
  riskReward: number | null;
};

export type AiChartMultiTimeframeAggregate = {
  mode: AiChartStrategyMode;
  contexts: AiChartTimeframeEvidence[];
  activeDirectionalCount: number;
  alignedDirectionalCount: number;
  higherTimeframeConflict: boolean;
  conflictTimeframes: UnifiedChartTimeframe[];
};

type MarketProfile = {
  minCandles: number;
  relativeVolumeThreshold: number;
  overboughtRsi: number;
  oversoldRsi: number;
  decisionThreshold: number;
};

const MODE_TIMEFRAMES: Record<AiChartStrategyMode, readonly UnifiedChartTimeframe[]> = {
  SCALPING: ['1m', '3m', '5m', '15m'],
  SWING: ['15m', '1H', '4H', '1D'],
  MID_LONG: ['4H', '1D'],
};

const TIMEFRAME_ORDER: readonly UnifiedChartTimeframe[] = [
  '1m', '3m', '5m', '15m', '30m', '1H', '4H', '1D',
];

const MARKET_PROFILES: Record<AnalysisMarket, MarketProfile> = {
  KR: {
    minCandles: 24,
    relativeVolumeThreshold: 1.2,
    overboughtRsi: 70,
    oversoldRsi: 30,
    decisionThreshold: 0.24,
  },
  US: {
    minCandles: 24,
    relativeVolumeThreshold: 1.15,
    overboughtRsi: 70,
    oversoldRsi: 30,
    decisionThreshold: 0.22,
  },
  UPBIT: {
    minCandles: 30,
    relativeVolumeThreshold: 1.25,
    overboughtRsi: 72,
    oversoldRsi: 28,
    decisionThreshold: 0.26,
  },
  BITGET: {
    minCandles: 36,
    relativeVolumeThreshold: 1.3,
    overboughtRsi: 68,
    oversoldRsi: 32,
    decisionThreshold: 0.3,
  },
};

const MODE_WEIGHTS: Record<AiChartStrategyMode, Record<'trend' | 'ema' | 'vwap' | 'macd' | 'rvol', number>> = {
  SCALPING: { trend: 0.2, ema: 0.2, vwap: 0.2, macd: 0.2, rvol: 0.2 },
  SWING: { trend: 0.35, ema: 0.25, vwap: 0.05, macd: 0.2, rvol: 0.15 },
  MID_LONG: { trend: 0.4, ema: 0.3, vwap: 0, macd: 0.2, rvol: 0.1 },
};

function finite(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function normalizeScore(value: number | null | undefined): number | null {
  const parsed = finite(value);
  return parsed == null ? null : Math.round(Math.max(0, Math.min(100, parsed)));
}

function validPositivePrice(value: number | null | undefined): number | null {
  const parsed = finite(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function cashSide(direction: 1 | -1, market: AnalysisMarket): AiChartSignalSide {
  if (market === 'BITGET') return direction > 0 ? 'LONG' : 'SHORT';
  return direction > 0 ? 'BUY' : 'SELL';
}

function actionSide(action: AnalysisTradeAction | undefined, market: AnalysisMarket): AiChartSignalSide | null {
  if (!action || action === 'NONE') return null;
  if (market === 'BITGET') {
    if (action === 'BUY') return 'LONG';
    if (action === 'SELL') return 'SHORT';
  }
  if (market !== 'BITGET') {
    if (action === 'LONG') return 'BUY';
    if (action === 'SHORT') return 'SELL';
  }
  return action;
}

function pushFactor(
  direction: 1 | -1,
  weight: number,
  code: string,
  positiveText: string,
  negativeText: string,
  scoreParts: Array<{ direction: 1 | -1; weight: number }>,
  positiveFactors: string[],
  negativeFactors: string[],
  reasonCodes: string[],
): void {
  if (weight <= 0) return;
  scoreParts.push({ direction, weight });
  reasonCodes.push(code);
  if (direction > 0) positiveFactors.push(positiveText);
  else negativeFactors.push(negativeText);
}

export function marketKind(market: AnalysisMarket): AiChartMarket {
  if (market === 'KR') return 'KR_STOCK';
  if (market === 'US') return 'US_STOCK';
  if (market === 'UPBIT') return 'CRYPTO_SPOT';
  return 'CRYPTO_FUTURES';
}

export function strategyModeTimeframes(mode: AiChartStrategyMode): readonly UnifiedChartTimeframe[] {
  return MODE_TIMEFRAMES[mode];
}

export function normalizeStrategyMode(value: unknown, fallback: AiChartStrategyMode = 'SCALPING'): AiChartStrategyMode {
  const normalized = String(value ?? '').trim().toUpperCase().replace(/[- ]/g, '_');
  if (normalized === 'SCALPING') return 'SCALPING';
  if (normalized === 'SWING') return 'SWING';
  if (normalized === 'MID_LONG' || normalized === 'POSITION') return 'MID_LONG';
  return fallback;
}

export function defaultStrategyMode(timeframe: UnifiedChartTimeframe): AiChartStrategyMode {
  return ['1m', '3m', '5m', '15m'].includes(timeframe) ? 'SCALPING' : 'SWING';
}

export function dataQualityFromStatus(status: UnifiedChartDataStatus): AiChartDataQuality {
  if (status === 'ok') return 'LIVE';
  if (status === 'delayed') return 'DELAYED';
  if (status === 'stale') return 'STALE';
  if (status === 'insufficient') return 'PARTIAL';
  return 'UNAVAILABLE';
}

export function signalLifecycleFromAnalysis(
  status: ChartAnalysisStatus | null | undefined,
): AiChartSignalLifecycle {
  if (status === 'weakened') return 'WEAKENED';
  if (status === 'invalidated') return 'INVALIDATED';
  if (status === 'expired') return 'EXPIRED';
  return 'ACTIVE';
}

export function mapPricePlan(plan: AnalysisPricePlan | null | undefined): AiChartPricePlanMapping {
  if (!plan) {
    return {
      entries: [null, null, null],
      stop: null,
      invalidation: null,
      targets: [null, null, null],
      riskReward: null,
    };
  }

  const from = validPositivePrice(plan.entryZone?.from);
  const to = validPositivePrice(plan.entryZone?.to);
  const entries: [number | null, number | null, number | null] = [
    from,
    to != null && to !== from ? to : null,
    null,
  ];
  const targets: [number | null, number | null, number | null] = [
    validPositivePrice(plan.targets[0]),
    validPositivePrice(plan.targets[1]),
    validPositivePrice(plan.targets[2]),
  ];

  return {
    entries,
    stop: validPositivePrice(plan.stopLoss),
    invalidation: validPositivePrice(plan.invalidation),
    targets,
    riskReward: finite(plan.riskReward),
  };
}

export function buildTechnicalTimeframeEvidence(
  input: AiChartTechnicalEvidenceInput,
): AiChartTimeframeEvidence {
  const quality = dataQualityFromStatus(input.dataStatus);
  const scannerSide = actionSide(input.scannerAction, input.market);
  const scannerScore = normalizeScore(input.scannerConfidence);
  const scannerReasons = (input.scannerReasons ?? []).filter(Boolean).slice(0, 8);

  if (scannerSide && scannerSide !== 'WAIT' && scannerScore != null && quality !== 'UNAVAILABLE') {
    return {
      timeframe: input.timeframe,
      state: 'READY',
      side: quality === 'STALE' ? 'WAIT' : scannerSide,
      score: quality === 'STALE' ? null : scannerScore,
      quality,
      positiveFactors: scannerSide === 'BUY' || scannerSide === 'LONG' ? scannerReasons : [],
      negativeFactors: scannerSide === 'SELL' || scannerSide === 'SHORT' ? scannerReasons : [],
      riskFactors: quality === 'STALE' ? ['오래된 데이터이므로 Scanner 방향을 활성 판단으로 사용하지 않음'] : [],
      reasonCodes: ['SCANNER_CONTEXT'],
      source: 'SCANNER',
    };
  }

  const profile = MARKET_PROFILES[input.market];
  if (
    quality === 'UNAVAILABLE'
    || quality === 'STALE'
    || input.candleCount < profile.minCandles
    || input.trend === 'insufficient'
    || finite(input.close) == null
  ) {
    return {
      timeframe: input.timeframe,
      state: 'INSUFFICIENT_DATA',
      side: 'WAIT',
      score: null,
      quality,
      positiveFactors: [],
      negativeFactors: [],
      riskFactors: [
        quality === 'STALE'
          ? '데이터가 오래되어 신규 방향 판단을 보류'
          : quality === 'UNAVAILABLE'
            ? '시장 데이터 사용 불가'
            : `근거 계산에 필요한 캔들 부족 (${input.candleCount}/${profile.minCandles})`,
      ],
      reasonCodes: ['INSUFFICIENT_DATA'],
      source: 'NONE',
    };
  }

  const weights = MODE_WEIGHTS[input.mode];
  const scoreParts: Array<{ direction: 1 | -1; weight: number }> = [];
  const positiveFactors: string[] = [];
  const negativeFactors: string[] = [];
  const riskFactors: string[] = [];
  const reasonCodes: string[] = [];

  if (input.trend === 'bullish') {
    pushFactor(1, weights.trend, 'TREND_BULLISH', '확정 피벗 구조 상승', '확정 피벗 구조 하락', scoreParts, positiveFactors, negativeFactors, reasonCodes);
  } else if (input.trend === 'bearish') {
    pushFactor(-1, weights.trend, 'TREND_BEARISH', '확정 피벗 구조 상승', '확정 피벗 구조 하락', scoreParts, positiveFactors, negativeFactors, reasonCodes);
  }

  const ema12 = finite(input.ema12);
  const ema26 = finite(input.ema26);
  if (ema12 != null && ema26 != null && ema12 !== ema26) {
    pushFactor(ema12 > ema26 ? 1 : -1, weights.ema, ema12 > ema26 ? 'EMA_BULLISH' : 'EMA_BEARISH', 'EMA12가 EMA26 상단', 'EMA12가 EMA26 하단', scoreParts, positiveFactors, negativeFactors, reasonCodes);
  }

  const close = finite(input.close);
  const vwap = finite(input.vwap);
  if (close != null && vwap != null && close !== vwap && weights.vwap > 0) {
    pushFactor(close > vwap ? 1 : -1, weights.vwap, close > vwap ? 'VWAP_ABOVE' : 'VWAP_BELOW', '가격이 VWAP 상단', '가격이 VWAP 하단', scoreParts, positiveFactors, negativeFactors, reasonCodes);
  }

  const macdHistogram = finite(input.macdHistogram);
  if (macdHistogram != null && macdHistogram !== 0) {
    pushFactor(macdHistogram > 0 ? 1 : -1, weights.macd, macdHistogram > 0 ? 'MACD_POSITIVE' : 'MACD_NEGATIVE', 'MACD 히스토그램 양수', 'MACD 히스토그램 음수', scoreParts, positiveFactors, negativeFactors, reasonCodes);
  }

  const directionalBeforeVolume = scoreParts.reduce((sum, part) => sum + part.direction * part.weight, 0);
  const volumeRatio = finite(input.volumeRatio20);
  if (volumeRatio != null && volumeRatio >= profile.relativeVolumeThreshold && directionalBeforeVolume !== 0) {
    const direction: 1 | -1 = directionalBeforeVolume > 0 ? 1 : -1;
    pushFactor(direction, weights.rvol, 'RVOL_CONFIRM', `상대 거래량 ${volumeRatio.toFixed(2)}배로 상승 근거 확인`, `상대 거래량 ${volumeRatio.toFixed(2)}배로 하락 근거 확인`, scoreParts, positiveFactors, negativeFactors, reasonCodes);
  }

  const rsi = finite(input.rsi14);
  if (rsi != null) {
    if (rsi >= profile.overboughtRsi) riskFactors.push(`RSI ${rsi.toFixed(1)} 과열 구간`);
    if (rsi <= profile.oversoldRsi) riskFactors.push(`RSI ${rsi.toFixed(1)} 과매도 구간`);
  }

  const atr = finite(input.atr14);
  if (atr != null && close != null && close > 0) {
    const atrPercent = (atr / close) * 100;
    if (atrPercent >= (input.market === 'BITGET' ? 2.5 : input.market === 'UPBIT' ? 2 : 1.5)) {
      riskFactors.push(`ATR 변동성 ${atrPercent.toFixed(2)}% 확대`);
    }
  }
  if (quality === 'DELAYED') riskFactors.push('시세 지연 상태');
  if (quality === 'PARTIAL') riskFactors.push('일부 데이터만 사용 가능');

  const availableWeight = scoreParts.reduce((sum, part) => sum + part.weight, 0);
  if (scoreParts.length < 3 || availableWeight <= 0) {
    return {
      timeframe: input.timeframe,
      state: 'INSUFFICIENT_DATA',
      side: 'WAIT',
      score: null,
      quality,
      positiveFactors,
      negativeFactors,
      riskFactors: [...riskFactors, '방향 판단에 필요한 독립 근거가 3개 미만'],
      reasonCodes: [...reasonCodes, 'INSUFFICIENT_EVIDENCE'],
      source: 'NONE',
    };
  }

  const signedStrength = scoreParts.reduce((sum, part) => sum + part.direction * part.weight, 0) / availableWeight;
  const absoluteStrength = Math.abs(signedStrength);
  const score = Math.round(50 + absoluteStrength * 50);
  const side = absoluteStrength >= profile.decisionThreshold && signedStrength !== 0
    ? cashSide(signedStrength > 0 ? 1 : -1, input.market)
    : 'WAIT';

  return {
    timeframe: input.timeframe,
    state: 'READY',
    side,
    score: side === 'WAIT' ? Math.max(50, Math.min(69, score)) : score,
    quality,
    positiveFactors,
    negativeFactors,
    riskFactors,
    reasonCodes,
    source: 'TECHNICAL_EVIDENCE',
  };
}

function sideDirection(side: AiChartSignalSide): 1 | -1 | 0 {
  if (side === 'BUY' || side === 'LONG') return 1;
  if (side === 'SELL' || side === 'SHORT') return -1;
  return 0;
}

export function aggregateMultiTimeframe(
  mode: AiChartStrategyMode,
  contexts: AiChartTimeframeEvidence[],
  focusTimeframe: UnifiedChartTimeframe,
): AiChartMultiTimeframeAggregate {
  const allowed = new Set(strategyModeTimeframes(mode));
  const ordered = contexts
    .filter((context) => allowed.has(context.timeframe))
    .sort((left, right) => TIMEFRAME_ORDER.indexOf(left.timeframe) - TIMEFRAME_ORDER.indexOf(right.timeframe));
  const focus = ordered.find((context) => context.timeframe === focusTimeframe)
    ?? [...ordered].reverse().find((context) => sideDirection(context.side) !== 0)
    ?? null;
  const focusDirection = focus ? sideDirection(focus.side) : 0;
  const focusIndex = focus ? TIMEFRAME_ORDER.indexOf(focus.timeframe) : -1;
  const directional = ordered.filter((context) => sideDirection(context.side) !== 0);
  const conflicts = focusDirection === 0
    ? []
    : ordered.filter((context) => {
        const direction = sideDirection(context.side);
        return TIMEFRAME_ORDER.indexOf(context.timeframe) > focusIndex
          && direction !== 0
          && direction !== focusDirection;
      });

  return {
    mode,
    contexts: ordered,
    activeDirectionalCount: directional.length,
    alignedDirectionalCount: focusDirection === 0
      ? 0
      : directional.filter((context) => sideDirection(context.side) === focusDirection).length,
    higherTimeframeConflict: conflicts.length > 0,
    conflictTimeframes: conflicts.map((context) => context.timeframe),
  };
}
