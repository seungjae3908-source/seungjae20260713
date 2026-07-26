// 차트중계 — 실시간 차트 분석 / 실시간 신호 분석 (표시 전용, 자동매매 실행 없음)
// chart-broadcast.tsx 의 lightweight-charts 캔들/거래량 렌더링 방식과 폴링 패턴을 재사용한다.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ChevronDown,
  Loader2,
  Maximize2,
  Minimize2,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  X,
} from 'lucide-react';
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  PriceScaleMode,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LogicalRange,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { apiGet, ApiError } from '@/lib/api';
import { BottomNav } from '@/components/bottom-nav';
import { memberGradeLabel, useMemberPermissions } from '@/lib/permissions';
import { useAuth } from '@/lib/auth';
import { getSupabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { useRealtimeChart } from '@/hooks/use-realtime-chart';
import { FavoriteButton } from '@/components/favorite-button';
import { InstrumentAlertButton } from '@/components/instrument-alert-modal';
import {
  normalizeRealtimeTimeframe,
  REALTIME_CHART_TIMEFRAMES,
  toUpbitTimeframe,
  type RealtimeChartTimeframe,
} from '@/lib/chart-preferences';

type AnyObj = Record<string, any>;

type Asset = 'stockKR' | 'stockUS' | 'coinSpot' | 'coinFutures';
type Tab = 'live' | 'ai';
type AnalysisTab = 'summary' | 'buy' | 'sell' | 'signals';
type ChartSettingsPanel = 'menu' | 'candle' | 'indicator' | 'signal';
type ChartType = 'candles' | 'line';
type PriceScaleType = 'normal' | 'logarithmic' | 'percentage';
type SignalImportance = 'high' | 'medium' | 'low';
type SignalKind = 'chart' | 'candle' | 'volume' | 'indicator';
type PatternKind = Extract<SignalKind, 'chart' | 'candle'>;

type PatternOption = {
  name: string;
  kind: PatternKind;
};

type CandlePoint = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type OverlayShape = {
  type: 'candle' | 'vline' | 'zone' | 'level';
  fromTime?: number | null;
  toTime?: number | null;
  level?: number | null;
  level2?: number | null;
};

type ChartSignal = {
  id: string;
  kind: SignalKind;
  name: string;
  occurredAt: string;
  price: number | null;
  barTime: number | null;
  importance: string;
  meaningGeneral: string;
  meaningHere: string;
  confirmations: string[];
  invalidation: string[];
  risk: string;
  overlay: OverlayShape | null;
  stage: 'START' | 'DEVELOPING' | 'COMPLETED' | 'INVALIDATED';
};

type AiPlan = {
  ok: boolean;
  symbol: string;
  view: '매수' | '매도' | '중립';
  target: number | null;
  stop: number | null;
  buyLevels: (number | null)[];
  sellLevels: (number | null)[];
  basis: string[];
  invalidation: string[];
  risks: string[];
  dataAsOf: string | null;
};

type ChartLevelKind =
  | 'average'
  | 'target'
  | 'stop'
  | 'support'
  | 'resistance'
  | 'buy'
  | 'sell';

type ChartLevelInfo = {
  id: string;
  kind: ChartLevelKind;
  label: string;
  price: number;
  color: string;
  description: string;
  action: string;
};

type SignalZoneRect = {
  id: string;
  signal: ChartSignal;
  label: string;
  left: number;
  top: number;
  width: number;
  height: number;
  color: string;
  dashed: boolean;
  prominent: boolean;
};

type PortfolioChartPosition = {
  quantity: number;
  averagePrice: number;
  totalCost: number;
};

type ChartSettings = {
  liveSignal: boolean;
  chartPattern: boolean;
  candlePattern: boolean;
  volumeSignal: boolean;
  indicatorSignal: boolean;
  target: boolean;
  stop: boolean;
  buyLevels: boolean;
  sellLevels: boolean;
  ai: boolean;
  highlight: boolean;
  ma5: boolean;
  ma20: boolean;
  ma60: boolean;
  ma120: boolean;
  ema9: boolean;
  ema20: boolean;
  ema60: boolean;
  bollinger: boolean;
  vwap: boolean;
  ichimoku: boolean;
  rsi: boolean;
  macd: boolean;
  atr: boolean;
  cci: boolean;
  obv: boolean;
  williamsR: boolean;
  roc: boolean;
  volumeMa20: boolean;
};

type IndicatorPoint = {
  time: UTCTimestamp;
  ma5: number | null;
  ma20: number | null;
  ma60: number | null;
  ma120: number | null;
  ema9: number | null;
  ema20: number | null;
  ema60: number | null;
  bollingerMiddle: number | null;
  bollingerUpper: number | null;
  bollingerLower: number | null;
  vwap: number | null;
  ichimokuConversion: number | null;
  ichimokuBase: number | null;
  ichimokuSpanA: number | null;
  ichimokuSpanB: number | null;
  ichimokuLagging: number | null;
  rsi: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  atr: number | null;
  cci: number | null;
  obv: number | null;
  williamsR: number | null;
  roc: number | null;
  volumeMa20: number | null;
};

type AiPlanChange = {
  id: string;
  changedAt: string;
  previousView: AiPlan['view'];
  nextView: AiPlan['view'];
  previousTarget: number | null;
  nextTarget: number | null;
  previousStop: number | null;
  nextStop: number | null;
};

type TopSignalBanner = {
  id: string;
  title: string;
  direction: string;
  price: number | null;
  occurredAt: string;
  importance: string;
  signal: ChartSignal | null;
};

const SETTINGS_KEY = 'chart-relay-settings-v1';
const PATTERN_FILTER_KEY = 'chart-relay-disabled-patterns-v1';
const CANDLE_CACHE_PREFIX = 'chart-relay-candles-v1';
const CANDLE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_SETTINGS: ChartSettings = {
  liveSignal: true,
  chartPattern: true,
  candlePattern: true,
  volumeSignal: true,
  indicatorSignal: true,
  target: true,
  stop: true,
  buyLevels: true,
  sellLevels: true,
  ai: true,
  highlight: true,
  ma5: false,
  ma20: true,
  ma60: false,
  ma120: false,
  ema9: true,
  ema20: true,
  ema60: false,
  bollinger: true,
  vwap: true,
  ichimoku: false,
  rsi: true,
  macd: false,
  atr: false,
  cci: false,
  obv: false,
  williamsR: false,
  roc: false,
  volumeMa20: false,
};

const SETTING_LABELS: Array<{ key: keyof ChartSettings; label: string }> = [
  { key: 'liveSignal', label: '실시간 신호' },
  { key: 'chartPattern', label: '차트 패턴' },
  { key: 'candlePattern', label: '캔들 패턴' },
  { key: 'volumeSignal', label: '거래량 신호' },
  { key: 'indicatorSignal', label: '기술지표 신호' },
  { key: 'target', label: '목표가' },
  { key: 'stop', label: '손절가' },
  { key: 'buyLevels', label: '분할매수' },
  { key: 'sellLevels', label: '분할매도' },
  { key: 'ai', label: 'AI 분석' },
  { key: 'highlight', label: '신호 강조' },
  { key: 'ma5', label: 'SMA5' },
  { key: 'ma20', label: 'SMA20' },
  { key: 'ma60', label: 'SMA60' },
  { key: 'ma120', label: 'SMA120' },
  { key: 'ema9', label: 'EMA9' },
  { key: 'ema20', label: 'EMA20' },
  { key: 'ema60', label: 'EMA60' },
  { key: 'bollinger', label: '볼린저밴드' },
  { key: 'vwap', label: 'VWAP' },
  { key: 'ichimoku', label: 'Ichimoku' },
  { key: 'rsi', label: 'RSI(14)' },
  { key: 'macd', label: 'MACD' },
  { key: 'atr', label: 'ATR(14)' },
  { key: 'cci', label: 'CCI(20)' },
  { key: 'obv', label: 'OBV' },
  { key: 'williamsR', label: 'Williams %R' },
  { key: 'roc', label: 'ROC(12)' },
  { key: 'volumeMa20', label: '거래량 MA20' },
];

const CHART_TYPE_KEY = 'chart-relay-chart-type-v1';

const PATTERN_STAGE_META = {
  START: { label: '시작', color: '#eab308' },
  DEVELOPING: { label: '진행', color: '#f97316' },
  COMPLETED: { label: '완성', color: '#22c55e' },
  INVALIDATED: { label: '이탈', color: '#ef4444' },
} as const;

function chartSignalStage(row: AnyObj, name: string, importance: string): ChartSignal['stage'] {
  const raw = String(row?.stage ?? row?.status ?? '').toUpperCase();
  if (raw === 'INVALIDATED' || /이탈|실패|무효/.test(name)) return 'INVALIDATED';
  if (raw === 'COMPLETED' || /완성|확정|돌파/.test(name) || signalImportance(importance) === 'high') return 'COMPLETED';
  if (raw === 'DEVELOPING' || /후보|진행|형성/.test(name)) return 'DEVELOPING';
  return 'START';
}

function signalAtCandle(
  signals: ChartSignal[],
  candle: CandlePoint,
  latestCandleTime = Number(candle.time),
) {
  const time = Number(candle.time);
  const priority: Record<ChartSignal['stage'], number> = {
    START: 1,
    DEVELOPING: 2,
    COMPLETED: 3,
    INVALIDATED: 4,
  };
  return signals
    .filter((signal) => {
      if (signal.kind !== 'chart' && signal.kind !== 'candle') return false;
      const range = signalDisplayRange(signal, latestCandleTime);
      return range != null && time >= range.start && time <= range.end;
    })
    .sort((left, right) => priority[right.stage] - priority[left.stage])[0] ?? null;
}

function signalDisplayRange(
  signal: ChartSignal,
  latestCandleTime: number,
): { start: number; end: number } | null {
  const from = toUnixSeconds(signal.overlay?.fromTime ?? signal.barTime);
  const to = toUnixSeconds(signal.overlay?.toTime ?? signal.barTime);
  if (from == null && to == null) return null;
  const start = Math.min(from ?? to!, to ?? from!);
  const detectedEnd = Math.max(from ?? to!, to ?? from!);
  const ongoing = signal.stage === 'START' || signal.stage === 'DEVELOPING';
  return {
    start,
    end: ongoing ? Math.max(detectedEnd, latestCandleTime) : detectedEnd,
  };
}

function signalPrediction(signal: ChartSignal): string {
  if (signal.stage === 'INVALIDATED') {
    return '기존 예측 방향이 무효화된 상태입니다. 새 지지·저항과 다음 신호를 다시 확인해야 합니다.';
  }
  if (/하락|매도|약세|이탈|쌍봉|이중천장|석별|유성/.test(signal.name)) {
    return signal.stage === 'COMPLETED'
      ? '하락 방향이 확인된 상태로 해석하지만 반등과 거래량 변화를 함께 확인해야 합니다.'
      : '하락 전환 또는 약세 지속 가능성을 관찰하는 단계입니다.';
  }
  if (/상승|매수|강세|돌파|쌍바닥|이중바닥|샛별|망치/.test(signal.name)) {
    return signal.stage === 'COMPLETED'
      ? '상승 방향이 확인된 상태로 해석하지만 추격 진입보다 지지 확인이 우선입니다.'
      : '상승 전환 또는 강세 지속 가능성을 관찰하는 단계입니다.';
  }
  return '방향이 아직 확정되지 않았습니다. 다음 봉과 거래량, 지지·저항 반응을 함께 확인해야 합니다.';
}

function normalizeSignalName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

function signalOccurrenceKey(signal: ChartSignal): string {
  const from = toUnixSeconds(signal.overlay?.fromTime ?? signal.barTime) ?? 0;
  const to = toUnixSeconds(signal.overlay?.toTime ?? signal.barTime) ?? from;
  return [
    signal.kind,
    normalizeSignalName(signal.name),
    Math.min(from, to),
    Math.max(from, to),
  ].join(':');
}

function dedupeSignalOccurrences(signals: ChartSignal[]): ChartSignal[] {
  const stageRank: Record<ChartSignal['stage'], number> = {
    START: 1,
    DEVELOPING: 2,
    COMPLETED: 3,
    INVALIDATED: 4,
  };
  const grouped = new Map<string, ChartSignal>();
  for (const signal of signals) {
    const key = signalOccurrenceKey(signal);
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, signal);
      continue;
    }
    const currentTime = toEpochMilliseconds(current.occurredAt) ?? 0;
    const nextTime = toEpochMilliseconds(signal.occurredAt) ?? 0;
    if (
      nextTime > currentTime ||
      (nextTime === currentTime && stageRank[signal.stage] > stageRank[current.stage])
    ) {
      grouped.set(key, signal);
    }
  }
  return [...grouped.values()];
}

function detectLocalPatternSignals(candles: CandlePoint[]): ChartSignal[] {
  if (candles.length < 3) return [];
  const found: ChartSignal[] = [];
  const start = Math.max(1, candles.length - 160);

  const add = (
    name: string,
    fromIndex: number,
    toIndex: number,
    stage: ChartSignal['stage'],
    importance: SignalImportance,
  ) => {
    const from = candles[fromIndex];
    const to = candles[toIndex];
    if (!from || !to) return;
    const region = candles.slice(fromIndex, toIndex + 1);
    const bullish = /상승|망치|쌍바닥/.test(name);
    const bearish = /하락|유성|쌍봉/.test(name);
    let resolvedStage = stage;
    const future = candles.slice(toIndex + 1, Math.min(candles.length, toIndex + 5));
    if (
      (bullish && future.some((row) => row.close < Math.min(...region.map((item) => item.low)))) ||
      (bearish && future.some((row) => row.close > Math.max(...region.map((item) => item.high))))
    ) {
      resolvedStage = 'INVALIDATED';
    }
    found.push({
      id: `local:${name}:${Number(from.time)}:${Number(to.time)}`,
      kind: 'candle',
      name,
      occurredAt: new Date(Number(to.time) * 1000).toISOString(),
      price: to.close,
      barTime: Number(to.time),
      importance,
      meaningGeneral: '캔들의 몸통·꼬리·이전 봉 관계를 현재 차트에서 직접 계산한 패턴입니다.',
      meaningHere: `${fromIndex + 1}번 봉부터 ${toIndex + 1}번 봉까지 ${PATTERN_STAGE_META[resolvedStage].label} 상태입니다.`,
      confirmations: ['거래량 증가 여부', '다음 봉의 방향 유지', '지지·저항 돌파 또는 이탈'],
      invalidation: ['패턴 저점 또는 고점 반대 방향 돌파'],
      risk: '클라이언트 캔들 기반 보완 감지이며 실제 주문 신호가 아닙니다.',
      overlay: {
        type: 'zone',
        fromTime: Number(from.time),
        toTime: Number(to.time),
      },
      stage: resolvedStage,
    });
  };

  for (let index = start; index < candles.length; index += 1) {
    const previous = candles[index - 1]!;
    const current = candles[index]!;
    const body = Math.abs(current.close - current.open);
    const range = Math.max(current.high - current.low, Number.EPSILON);
    const lowerWick = Math.min(current.open, current.close) - current.low;
    const upperWick = current.high - Math.max(current.open, current.close);
    if (
      previous.close < previous.open &&
      current.close > current.open &&
      current.open <= previous.close &&
      current.close >= previous.open
    ) {
      add('상승 장악형', index - 1, index, 'COMPLETED', 'high');
    } else if (
      previous.close > previous.open &&
      current.close < current.open &&
      current.open >= previous.close &&
      current.close <= previous.open
    ) {
      add('하락 장악형', index - 1, index, 'COMPLETED', 'high');
    } else if (body / range < 0.1) {
      add('도지', index, index, 'START', 'low');
    } else if (lowerWick > body * 2 && lowerWick > upperWick * 1.5) {
      add('망치형', index, index, 'START', 'medium');
    } else if (upperWick > body * 2 && upperWick > lowerWick * 1.5) {
      add('유성형', index, index, 'START', 'medium');
    }
  }

  const recentStart = Math.max(1, candles.length - 60);
  const lows = candles
    .slice(recentStart)
    .map((row, offset) => ({ value: row.low, index: recentStart + offset }))
    .filter((row) => {
      const before = candles[row.index - 1];
      const after = candles[row.index + 1];
      return before && after && row.value <= before.low && row.value <= after.low;
    });
  const highs = candles
    .slice(recentStart)
    .map((row, offset) => ({ value: row.high, index: recentStart + offset }))
    .filter((row) => {
      const before = candles[row.index - 1];
      const after = candles[row.index + 1];
      return before && after && row.value >= before.high && row.value >= after.high;
    });
  if (lows.length >= 2) {
    const [left, right] = lows.slice(-2);
    if (right.index - left.index >= 4 && Math.abs(right.value - left.value) / Math.max(left.value, 1) < 0.015) {
      add('쌍바닥 후보', left.index, right.index, 'DEVELOPING', 'medium');
    }
  }
  if (highs.length >= 2) {
    const [left, right] = highs.slice(-2);
    if (right.index - left.index >= 4 && Math.abs(right.value - left.value) / Math.max(left.value, 1) < 0.015) {
      add('쌍봉 후보', left.index, right.index, 'DEVELOPING', 'medium');
    }
  }

  return found.slice(-40);
}

function settingsWithValue(value: boolean): ChartSettings {
  return {
    liveSignal: value,
    chartPattern: value,
    candlePattern: value,
    volumeSignal: value,
    indicatorSignal: value,
    target: value,
    stop: value,
    buyLevels: value,
    sellLevels: value,
    ai: value,
    highlight: value,
    ma5: value,
    ma20: value,
    ma60: value,
    ma120: value,
    ema9: value,
    ema20: value,
    ema60: value,
    bollinger: value,
    vwap: value,
    ichimoku: value,
    rsi: value,
    macd: value,
    atr: value,
    cci: value,
    obv: value,
    williamsR: value,
    roc: value,
    volumeMa20: value,
  };
}

const ASSET_GROUPS = [
  {
    key: 'stock',
    label: '주식',
    items: [
      { key: 'stockKR' as Asset, label: '국내주식' },
      { key: 'stockUS' as Asset, label: '해외주식' },
    ],
  },
  {
    key: 'coin',
    label: '코인',
    items: [
      { key: 'coinSpot' as Asset, label: '현물' },
      { key: 'coinFutures' as Asset, label: '선물', futures: true },
    ],
  },
] as const;


type IntervalItem = { key: RealtimeChartTimeframe; label: string };

function englishTimeframeLabel(key: RealtimeChartTimeframe): string {
  if (key === 'ALL') return 'ALL';
  if (key.endsWith('H')) return `${key.slice(0, -1)}h`;
  if (key.endsWith('D')) return `${key.slice(0, -1)}d`;
  if (key.endsWith('W')) return `${key.slice(0, -1)}w`;
  if (key.endsWith('Y')) return `${key.slice(0, -1)}y`;
  return key;
}

const STANDARD_INTERVALS: IntervalItem[] = REALTIME_CHART_TIMEFRAMES.map(
  (key) => ({ key, label: englishTimeframeLabel(key) }),
);

const CANDLE_INTERVAL_GROUPS: Array<{ label: string; items: IntervalItem[] }> = [
  {
    label: 'Minutes',
    items: STANDARD_INTERVALS.filter((item) => ['1m', '3m', '5m', '15m', '30m'].includes(item.key)),
  },
  {
    label: 'Hours',
    items: STANDARD_INTERVALS.filter((item) => ['1H', '4H', '12H'].includes(item.key)),
  },
  {
    label: 'Days',
    items: STANDARD_INTERVALS.filter((item) => ['1D', '3D', '5D', '15D'].includes(item.key)),
  },
  {
    label: 'Weeks',
    items: STANDARD_INTERVALS.filter((item) => item.key === '1W'),
  },
  {
    label: 'Months',
    items: STANDARD_INTERVALS.filter((item) => ['1M', '3M', '6M'].includes(item.key)),
  },
  {
    label: 'Years',
    items: STANDARD_INTERVALS.filter((item) => ['1Y', '3Y', '5Y', '10Y', 'ALL'].includes(item.key)),
  },
];

const INDICATOR_SETTING_KEYS: Array<{ key: keyof ChartSettings; label: string }> =
  SETTING_LABELS.filter((item) =>
    [
      'ma5', 'ma20', 'ma60', 'ma120', 'ema9', 'ema20', 'ema60',
      'bollinger', 'vwap', 'ichimoku', 'rsi', 'macd', 'atr', 'cci',
      'obv', 'williamsR', 'roc', 'volumeMa20',
    ].includes(item.key),
  );

const ANALYSIS_SIGNAL_SETTING_KEYS: Array<{ key: keyof ChartSettings; label: string }> =
  SETTING_LABELS.filter((item) =>
    [
      'liveSignal', 'volumeSignal', 'indicatorSignal', 'highlight', 'target', 'stop', 'buyLevels',
      'sellLevels', 'ai',
    ].includes(item.key),
  );

const DEFAULT_CANDLE_PATTERN_NAMES = [
  '상승 장악형',
  '하락 장악형',
  '도지',
  '망치형',
  '역망치형',
  '유성형',
  '샛별형',
  '석별형',
];

const DEFAULT_CHART_PATTERN_NAMES = [
  '박스권 상단 돌파',
  '지지선 이탈',
  '삼각수렴',
  '상승 채널',
  '하락 채널',
  '이중바닥',
  '이중천장',
  '쌍바닥 후보',
  '쌍봉 후보',
];

const DEFAULT_PATTERN_OPTIONS: PatternOption[] = [
  ...DEFAULT_CANDLE_PATTERN_NAMES.map((name) => ({ name, kind: 'candle' as const })),
  ...DEFAULT_CHART_PATTERN_NAMES.map((name) => ({ name, kind: 'chart' as const })),
];

const DEFAULT_SYMBOL: Record<Asset, string> = {
  stockKR: '005930',
  stockUS: 'AAPL',
  coinSpot: 'BTC',
  coinFutures: 'BTCUSDT',
};

function finite(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, '').trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseCompactCandleTime(text: string): number | null {
  const digits = text.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 14) return null;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6)) - 1;
  const day = Number(digits.slice(6, 8));
  const hour = digits.length >= 10 ? Number(digits.slice(8, 10)) : 0;
  const minute = digits.length >= 12 ? Number(digits.slice(10, 12)) : 0;
  const second = digits.length >= 14 ? Number(digits.slice(12, 14)) : 0;
  const timestamp = Date.UTC(year, month, day, hour, minute, second);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
}

function toUnixSeconds(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw > 1e12) return Math.floor(raw / 1000);
    if (raw > 1e9) return Math.floor(raw);
  }
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (/^\d{8,14}$/.test(text)) {
    const compact = parseCompactCandleTime(text);
    if (compact != null) return compact;
  }
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 1e9) {
    return Math.floor(numeric > 1e12 ? numeric / 1000 : numeric);
  }
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  return null;
}

function normalizeCandles(rows: AnyObj[]): CandlePoint[] {
  const normalized = rows
    .map((row) => {
      const close = finite(row?.close ?? row?.closePrice ?? row?.trade_price ?? row?.price);
      const open = finite(row?.open ?? row?.openPrice ?? row?.opening_price ?? close);
      const high = finite(row?.high ?? row?.highPrice ?? row?.high_price ?? open ?? close);
      const low = finite(row?.low ?? row?.lowPrice ?? row?.low_price ?? open ?? close);
      const volume = finite(row?.volume ?? row?.tradeVolume ?? 0) ?? 0;
      if (close == null || open == null || high == null || low == null) return null;
      const time = toUnixSeconds(row?.time ?? row?.date ?? row?.datetime ?? row?.timestamp ?? row?.dt);
      if (time == null) return null;
      return {
        time: time as UTCTimestamp,
        open,
        high: Math.max(high, open, close),
        low: Math.min(low, open, close),
        close,
        volume: Math.max(volume, 0),
      } satisfies CandlePoint;
    })
    .filter((row): row is CandlePoint => row != null)
    .sort((a, b) => Number(a.time) - Number(b.time));
  return [...new Map(normalized.map((row) => [Number(row.time), row])).values()];
}

function candleCacheKey(asset: Asset, symbol: string, interval: string): string {
  return `${CANDLE_CACHE_PREFIX}:${asset}:${symbol.trim().toUpperCase()}:${interval}`;
}

function readCachedCandles(asset: Asset, symbol: string, interval: string): AnyObj | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(candleCacheKey(asset, symbol, interval));
    if (!raw) return undefined;
    const cached = JSON.parse(raw) as { savedAt?: number; payload?: AnyObj };
    if (
      !cached.payload ||
      !Number.isFinite(cached.savedAt) ||
      Date.now() - Number(cached.savedAt) > CANDLE_CACHE_MAX_AGE_MS ||
      extractCandleRows(cached.payload).length < 2
    ) {
      window.localStorage.removeItem(candleCacheKey(asset, symbol, interval));
      return undefined;
    }
    return cached.payload;
  } catch {
    return undefined;
  }
}

function writeCachedCandles(asset: Asset, symbol: string, interval: string, payload: AnyObj): void {
  if (typeof window === 'undefined' || extractCandleRows(payload).length < 2) return;
  try {
    window.localStorage.setItem(
      candleCacheKey(asset, symbol, interval),
      JSON.stringify({
        savedAt: Date.now(),
        payload: {
          ok: true,
          provider: payload.provider ?? 'cache',
          fetchedAt: payload.fetchedAt ?? payload.updatedAt ?? new Date().toISOString(),
          candles: extractCandleRows(payload).slice(-240),
          pagination: payload.pagination ?? null,
        },
      }),
    );
  } catch {
    // 저장 공간이 부족해도 실시간 차트 동작은 계속 유지한다.
  }
}

function candleUrl(
  asset: Asset,
  symbol: string,
  interval: string,
  stockPages = 1,
): string {
  const s = encodeURIComponent(symbol);
  if (asset === 'stockKR' || asset === 'stockUS') {
    return `/stocks/${s}/candles?tf=${encodeURIComponent(interval)}&pages=${stockPages}`;
  }
  if (asset === 'coinSpot') {
    const normalized = normalizeRealtimeTimeframe(interval);
    const providerValue = normalized ? toUpbitTimeframe(normalized) : null;
    if (providerValue?.tf) {
      return `/crypto/spot/candles?symbol=${s}&tf=${providerValue.tf}&count=200`;
    }
    if (providerValue?.unit) {
      return `/crypto/spot/candles?symbol=${s}&unit=${providerValue.unit}&count=200`;
    }
    throw new Error(`UNSUPPORTED_UPBIT_INTERVAL:${interval}`);
  }
  return `/crypto/futures/candles?symbol=${s}&granularity=${encodeURIComponent(interval)}&limit=200`;
}

function extractCandleRows(payload: AnyObj): AnyObj[] {
  if (Array.isArray(payload?.candles)) return payload.candles;
  if (Array.isArray(payload?.data?.candles)) return payload.data.candles;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function normalizeAiPlan(raw: Record<string, unknown> | null): AiPlan | null {
  if (!raw || raw.ok === false) return null;
  const view = String(raw.view ?? '중립');
  if (view !== '매수' && view !== '매도' && view !== '중립') return null;
  const levels = (value: unknown): (number | null)[] =>
    Array.isArray(value) ? value.map((item) => finite(item)) : [];
  const rows = (value: unknown): string[] =>
    Array.isArray(value) ? value.map(String).filter(Boolean) : [];

  return {
    ok: true,
    symbol: String(raw.symbol ?? ''),
    view,
    target: finite(raw.target),
    stop: finite(raw.stop),
    buyLevels: levels(raw.buyLevels),
    sellLevels: levels(raw.sellLevels),
    basis: rows(raw.basis),
    invalidation: rows(raw.invalidation),
    risks: rows(raw.risks),
    dataAsOf: raw.dataAsOf == null ? null : String(raw.dataAsOf),
  };
}

function signalContract(asset: Asset): { assetParam: string; coinMarket: string | null } {
  if (asset === 'stockKR' || asset === 'stockUS') return { assetParam: 'stock', coinMarket: null };
  if (asset === 'coinSpot') return { assetParam: 'coin', coinMarket: 'spot' };
  return { assetParam: 'coin', coinMarket: 'futures' };
}

function formatPrice(value: number | null, asset: Asset): string {
  if (value == null || !Number.isFinite(value)) return '산출 불가';
  if (asset === 'stockUS') {
    return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (asset === 'coinSpot' || asset === 'coinFutures') {
    return value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 0 : 4 });
  }
  return `${Math.round(value).toLocaleString()}원`;
}

function buildChartLevels(
  candles: CandlePoint[],
  plan: AiPlan | null,
  position: PortfolioChartPosition | null,
): ChartLevelInfo[] {
  const recent = candles.slice(-60);
  const latest = recent.at(-1)?.close ?? null;
  const support =
    recent.length >= 5 ? Math.min(...recent.map((candle) => candle.low)) : null;
  const resistance =
    recent.length >= 5 ? Math.max(...recent.map((candle) => candle.high)) : null;
  const levels: ChartLevelInfo[] = [];
  const add = (
    id: string,
    kind: ChartLevelKind,
    label: string,
    price: number | null | undefined,
    color: string,
    description: string,
    action: string,
  ) => {
    if (price == null || !Number.isFinite(price) || price <= 0) return;
    levels.push({ id, kind, label, price, color, description, action });
  };

  if (position) {
    const profit =
      latest == null ? null : (latest - position.averagePrice) * position.quantity;
    const returnRate =
      latest == null || position.averagePrice <= 0
        ? null
        : ((latest - position.averagePrice) / position.averagePrice) * 100;
    add(
      'portfolio-average',
      'average',
      '내 평단가',
      position.averagePrice,
      '#a855f7',
      `포트폴리오에 저장된 보유수량 ${position.quantity.toLocaleString()}주와 총매입금액을 기준으로 계산한 가중평균 매입가격입니다.`,
      returnRate == null || profit == null
        ? '현재가를 확인하면 평단가 대비 등락률과 평가손익을 표시합니다.'
        : `평단가 대비 ${returnRate >= 0 ? '+' : ''}${returnRate.toFixed(2)}% · 평가손익 ${profit >= 0 ? '+' : ''}${Math.round(profit).toLocaleString()}`,
    );
  }

  add(
    'support',
    'support',
    '지지선',
    support,
    '#10b981',
    '최근 60개 실제 캔들 중 가장 낮은 저가를 기준으로 산출한 가격 방어 구간입니다.',
    latest != null && support != null && latest < support
      ? '현재가가 지지선 아래에 있어 지지 회복 여부를 확인합니다.'
      : '종가가 지지선을 이탈하면 하락 위험이 커질 수 있습니다.',
  );
  add(
    'resistance',
    'resistance',
    '저항선',
    resistance,
    '#f97316',
    '최근 60개 실제 캔들 중 가장 높은 고가를 기준으로 산출한 상단 저항 구간입니다.',
    latest != null && resistance != null && latest > resistance
      ? '현재가가 저항선을 돌파해 돌파 유지 여부를 확인합니다.'
      : '종가가 저항선을 돌파하고 유지되는지 확인합니다.',
  );

  if (plan) {
    add(
      'target',
      'target',
      '목표가',
      plan.target,
      '#f59e0b',
      '현재 AI 차트 분석이 실제 가격·추세·지표를 바탕으로 제시한 참고 목표 가격입니다.',
      '목표 도달만으로 매도하지 않고 거래량과 추세 유지 여부를 함께 확인합니다.',
    );
    add(
      'stop',
      'stop',
      '손절가',
      plan.stop,
      '#0ea5e9',
      '현재 AI 차트 관점이 무효화될 가능성이 높아지는 위험 관리 가격입니다.',
      '종가 이탈과 분석 무효 조건을 함께 확인합니다.',
    );
    plan.buyLevels.slice(0, 3).forEach((price, index) =>
      add(
        `buy-${index + 1}`,
        'buy',
        `${index + 1}차 매수`,
        price,
        '#ef4444',
        '한 번에 진입하지 않고 가격 구간을 나누어 관찰하기 위한 참고선입니다.',
        '강한 매수 신호와 거래량 확인 없이 가격선만 보고 진입하지 않습니다.',
      ),
    );
    plan.sellLevels.slice(0, 3).forEach((price, index) =>
      add(
        `sell-${index + 1}`,
        'sell',
        `${index + 1}차 매도`,
        price,
        '#3b82f6',
        '목표 구간에서 비중을 나누어 관리하기 위한 참고선입니다.',
        '추세와 목표 도달 여부를 함께 확인합니다.',
      ),
    );
  }

  return levels;
}

function intervalsFor(asset: Asset): IntervalItem[] {
  void asset;
  return STANDARD_INTERVALS;
}

function loadSettings(): ChartSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ChartSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function loadDisabledPatterns(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(PATTERN_FILTER_KEY) ?? '[]');
    return new Set(
      Array.isArray(parsed)
        ? parsed.map((value) => normalizeSignalName(String(value))).filter(Boolean)
        : [],
    );
  } catch {
    return new Set();
  }
}

function loadChartType(): ChartType {
  if (typeof window === 'undefined') return 'candles';
  return window.localStorage.getItem(CHART_TYPE_KEY) === 'line' ? 'line' : 'candles';
}

function simpleMovingAverage(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return result;
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index] ?? 0;
    if (index >= period) sum -= values[index - period] ?? 0;
    if (index >= period - 1) result[index] = sum / period;
  }
  return result;
}

function exponentialMovingAverage(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return result;
  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const multiplier = 2 / (period + 1);
  result[period - 1] = seed;
  let previous = seed;
  for (let index = period; index < values.length; index += 1) {
    previous = (values[index] - previous) * multiplier + previous;
    result[index] = previous;
  }
  return result;
}

function calculateRsi(values: number[], period = 14): Array<number | null> {
  const result: Array<number | null> = new Array(values.length).fill(null);
  if (values.length <= period) return result;
  let gainSum = 0;
  let lossSum = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gainSum += Math.max(change, 0);
    lossSum += Math.max(-change, 0);
  }
  let averageGain = gainSum / period;
  let averageLoss = lossSum / period;
  const valueFor = () => {
    if (averageGain === 0 && averageLoss === 0) return 50;
    if (averageLoss === 0) return 100;
    if (averageGain === 0) return 0;
    return 100 - 100 / (1 + averageGain / averageLoss);
  };
  result[period] = valueFor();
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[index] = valueFor();
  }
  return result;
}

function calculateIndicators(candles: CandlePoint[], interval: string): IndicatorPoint[] {
  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);
  const ma5 = simpleMovingAverage(closes, 5);
  const ma20 = simpleMovingAverage(closes, 20);
  const ma60 = simpleMovingAverage(closes, 60);
  const ma120 = simpleMovingAverage(closes, 120);
  const ema9 = exponentialMovingAverage(closes, 9);
  const ema20 = exponentialMovingAverage(closes, 20);
  const ema60 = exponentialMovingAverage(closes, 60);
  const volumeMa20 = simpleMovingAverage(volumes, 20);
  const rsi = calculateRsi(closes, 14);
  const ema12 = exponentialMovingAverage(closes, 12);
  const ema26 = exponentialMovingAverage(closes, 26);
  const atr: Array<number | null> = new Array(candles.length).fill(null);
  const cci: Array<number | null> = new Array(candles.length).fill(null);
  const obv: Array<number | null> = new Array(candles.length).fill(null);
  const williamsR: Array<number | null> = new Array(candles.length).fill(null);
  const roc: Array<number | null> = new Array(candles.length).fill(null);
  const vwap: Array<number | null> = new Array(candles.length).fill(null);
  const ichimokuConversion: Array<number | null> = new Array(candles.length).fill(null);
  const ichimokuBase: Array<number | null> = new Array(candles.length).fill(null);
  const ichimokuSpanA: Array<number | null> = new Array(candles.length).fill(null);
  const ichimokuSpanB: Array<number | null> = new Array(candles.length).fill(null);
  const ichimokuLagging: Array<number | null> = new Array(candles.length).fill(null);

  let previousAtr = 0;
  let runningObv = 0;
  let cumulativeVolume = 0;
  let cumulativeTypicalVolume = 0;
  let vwapSession = '';
  const intraday = interval.endsWith('m') || interval.endsWith('H');
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]!;
    const typical = (candle.high + candle.low + candle.close) / 3;
    const session = new Date(Number(candle.time) * 1000).toISOString().slice(0, 10);
    if (intraday && session !== vwapSession) {
      cumulativeVolume = 0;
      cumulativeTypicalVolume = 0;
      vwapSession = session;
    }
    cumulativeVolume += candle.volume;
    cumulativeTypicalVolume += typical * candle.volume;
    vwap[index] =
      cumulativeVolume > 0 ? cumulativeTypicalVolume / cumulativeVolume : typical;

    if (index > 0) {
      const previous = candles[index - 1]!;
      const trueRange = Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - previous.close),
        Math.abs(candle.low - previous.close),
      );
      if (index < 14) {
        previousAtr += trueRange;
      } else if (index === 14) {
        previousAtr = (previousAtr + trueRange) / 14;
        atr[index] = previousAtr;
      } else {
        previousAtr = (previousAtr * 13 + trueRange) / 14;
        atr[index] = previousAtr;
      }
      if (candle.close > previous.close) runningObv += candle.volume;
      else if (candle.close < previous.close) runningObv -= candle.volume;
    }
    obv[index] = runningObv;

    if (index >= 19) {
      const window = candles.slice(index - 19, index + 1);
      const typicals = window.map((row) => (row.high + row.low + row.close) / 3);
      const mean = typicals.reduce((sum, value) => sum + value, 0) / 20;
      const meanDeviation =
        typicals.reduce((sum, value) => sum + Math.abs(value - mean), 0) / 20;
      cci[index] = meanDeviation > 0 ? (typical - mean) / (0.015 * meanDeviation) : 0;
    }
    if (index >= 13) {
      const window = candles.slice(index - 13, index + 1);
      const high = Math.max(...window.map((row) => row.high));
      const low = Math.min(...window.map((row) => row.low));
      williamsR[index] = high !== low ? ((high - candle.close) / (high - low)) * -100 : -50;
    }
    if (index >= 12 && closes[index - 12] !== 0) {
      roc[index] = ((candle.close - closes[index - 12]!) / closes[index - 12]!) * 100;
    }
    const rangeMidpoint = (period: number): number | null => {
      if (index < period - 1) return null;
      const window = candles.slice(index - period + 1, index + 1);
      return (
        Math.max(...window.map((row) => row.high)) +
        Math.min(...window.map((row) => row.low))
      ) / 2;
    };
    ichimokuConversion[index] = rangeMidpoint(9);
    ichimokuBase[index] = rangeMidpoint(26);
    const spanSourceIndex = index - 26;
    if (spanSourceIndex >= 0) {
      const conversion = ichimokuConversion[spanSourceIndex];
      const base = ichimokuBase[spanSourceIndex];
      ichimokuSpanA[index] =
        conversion == null || base == null ? null : (conversion + base) / 2;
      const spanWindow = candles.slice(Math.max(0, spanSourceIndex - 51), spanSourceIndex + 1);
      ichimokuSpanB[index] =
        spanWindow.length < 52
          ? null
          : (
              Math.max(...spanWindow.map((row) => row.high)) +
              Math.min(...spanWindow.map((row) => row.low))
            ) / 2;
    }
    if (index + 26 < candles.length) ichimokuLagging[index] = closes[index + 26]!;
  }
  const macd: Array<number | null> = closes.map((_, index) => {
    const fast = ema12[index];
    const slow = ema26[index];
    return fast == null || slow == null ? null : fast - slow;
  });
  const compactMacd = macd.filter((value): value is number => value != null);
  const compactSignal = exponentialMovingAverage(compactMacd, 9);
  const macdSignal: Array<number | null> = new Array(closes.length).fill(null);
  let compactIndex = 0;
  for (let index = 0; index < macd.length; index += 1) {
    if (macd[index] == null) continue;
    macdSignal[index] = compactSignal[compactIndex] ?? null;
    compactIndex += 1;
  }

  return candles.map((candle, index) => {
    let bollingerUpper: number | null = null;
    let bollingerLower: number | null = null;
    if (index >= 19 && ma20[index] != null) {
      const window = closes.slice(index - 19, index + 1);
      const middle = ma20[index]!;
      const variance = window.reduce((sum, value) => sum + (value - middle) ** 2, 0) / 20;
      const deviation = Math.sqrt(variance);
      bollingerUpper = middle + deviation * 2;
      bollingerLower = middle - deviation * 2;
    }
    const signal = macdSignal[index];
    const macdValue = macd[index];
    return {
      time: candle.time,
      ma5: ma5[index],
      ma20: ma20[index],
      ma60: ma60[index],
      ma120: ma120[index],
      ema9: ema9[index],
      ema20: ema20[index],
      ema60: ema60[index],
      bollingerMiddle: ma20[index],
      bollingerUpper,
      bollingerLower,
      vwap: vwap[index],
      ichimokuConversion: ichimokuConversion[index],
      ichimokuBase: ichimokuBase[index],
      ichimokuSpanA: ichimokuSpanA[index],
      ichimokuSpanB: ichimokuSpanB[index],
      ichimokuLagging: ichimokuLagging[index],
      rsi: rsi[index],
      macd: macdValue,
      macdSignal: signal,
      macdHistogram: macdValue == null || signal == null ? null : macdValue - signal,
      atr: atr[index],
      cci: cci[index],
      obv: obv[index],
      williamsR: williamsR[index],
      roc: roc[index],
      volumeMa20: volumeMa20[index],
    };
  });
}

function lineData(
  indicators: IndicatorPoint[],
  select: (point: IndicatorPoint) => number | null,
): Array<{ time: UTCTimestamp; value: number }> {
  return indicators.flatMap((point) => {
    const value = select(point);
    return value == null || !Number.isFinite(value) ? [] : [{ time: point.time, value }];
  });
}

function signalImportance(value: string): SignalImportance {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.includes('높') ||
    normalized.includes('high') ||
    normalized.includes('critical') ||
    normalized.includes('긴급')
  ) {
    return 'high';
  }
  if (normalized.includes('중') || normalized.includes('medium') || normalized.includes('moderate')) {
    return 'medium';
  }
  return 'low';
}

function importanceRank(value: string): number {
  const level = signalImportance(value);
  return level === 'high' ? 3 : level === 'medium' ? 2 : 1;
}

function extractBeforeCursor(payload: AnyObj | undefined): string | null {
  const cursor =
    payload?.pagination?.nextBefore ??
    payload?.pagination?.before ??
    payload?.meta?.nextBefore ??
    payload?.nextBefore ??
    null;
  if (cursor == null || cursor === '') return null;
  return String(cursor);
}

function withBeforeCursor(url: string, cursor: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}before=${encodeURIComponent(cursor)}`;
}

function toEpochMilliseconds(value: string | number | null | undefined): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 1e9) return numeric > 1e12 ? numeric : numeric * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function priceScaleMode(value: PriceScaleType): PriceScaleMode {
  if (value === 'logarithmic') return PriceScaleMode.Logarithmic;
  if (value === 'percentage') return PriceScaleMode.Percentage;
  return PriceScaleMode.Normal;
}

type LowerIndicatorKey = 'rsi' | 'macd' | 'atr' | 'cci' | 'obv' | 'williamsR' | 'roc';

const LOWER_INDICATOR_LABEL: Record<LowerIndicatorKey, string> = {
  rsi: 'RSI',
  macd: 'MACD',
  atr: 'ATR',
  cci: 'CCI',
  obv: 'OBV',
  williamsR: 'W%R',
  roc: 'ROC',
};

const LowerIndicatorPanel = memo(function LowerIndicatorPanel({
  indicators,
  enabled,
  timeVisible,
  sourceKey,
}: {
  indicators: IndicatorPoint[];
  enabled: LowerIndicatorKey[];
  timeVisible: boolean;
  sourceKey: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const valueSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const signalSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const histogramSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const boundarySeriesRef = useRef<Array<{ value: number; series: ISeriesApi<'Line'> }>>([]);
  const firstFitRef = useRef(false);
  const fittedSourceRef = useRef(sourceKey);
  const [active, setActive] = useState<LowerIndicatorKey>(enabled[0] ?? 'rsi');

  useEffect(() => {
    if (enabled.length > 0 && !enabled.includes(active)) setActive(enabled[0]!);
  }, [active, enabled]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || enabled.length === 0) return;
    const dark = document.documentElement.classList.contains('dark');
    const chart = createChart(container, {
      width: Math.max(container.clientWidth, 1),
      height: Math.max(container.clientHeight, 145),
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: dark ? '#94a3b8' : '#64748b',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(100,116,139,0.08)' },
        horzLines: { color: 'rgba(100,116,139,0.08)' },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderVisible: false, timeVisible, secondsVisible: false },
      handleScroll: true,
      handleScale: true,
    });
    chartRef.current = chart;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect?.width && rect.height) {
        chart.applyOptions({ width: Math.max(rect.width, 1), height: Math.max(rect.height, 145) });
      }
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      valueSeriesRef.current = null;
      signalSeriesRef.current = null;
      histogramSeriesRef.current = null;
      boundarySeriesRef.current = [];
    };
  }, [enabled.length]);

  useEffect(() => {
    chartRef.current?.timeScale().applyOptions({ timeVisible, secondsVisible: false });
  }, [timeVisible]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || enabled.length === 0) return;
    if (valueSeriesRef.current) chart.removeSeries(valueSeriesRef.current);
    if (signalSeriesRef.current) chart.removeSeries(signalSeriesRef.current);
    if (histogramSeriesRef.current) chart.removeSeries(histogramSeriesRef.current);
    for (const boundary of boundarySeriesRef.current) {
      chart.removeSeries(boundary.series);
    }
    valueSeriesRef.current = null;
    signalSeriesRef.current = null;
    histogramSeriesRef.current = null;
    boundarySeriesRef.current = [];
    const addBoundary = (value: number, color = '#64748b') => {
      const series = chart.addLineSeries({
        color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      boundarySeriesRef.current.push({ value, series });
    };
    if (active === 'macd') {
      valueSeriesRef.current = chart.addLineSeries({ color: '#8b5cf6', lineWidth: 2, priceLineVisible: false });
      signalSeriesRef.current = chart.addLineSeries({ color: '#f59e0b', lineWidth: 1, priceLineVisible: false });
      histogramSeriesRef.current = chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
      addBoundary(0);
    } else {
      const color =
        active === 'atr'
          ? '#f97316'
          : active === 'obv'
            ? '#06b6d4'
            : active === 'roc'
              ? '#22c55e'
              : active === 'williamsR'
                ? '#eab308'
                : '#8b5cf6';
      valueSeriesRef.current = chart.addLineSeries({
        color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
      });
      if (active === 'rsi') {
        addBoundary(70, '#ef4444');
        addBoundary(30, '#3b82f6');
      } else if (active === 'cci') {
        addBoundary(100, '#ef4444');
        addBoundary(-100, '#3b82f6');
      } else if (active === 'williamsR') {
        addBoundary(-20, '#ef4444');
        addBoundary(-80, '#3b82f6');
      } else if (active === 'roc') {
        addBoundary(0);
      }
    }
    firstFitRef.current = false;
  }, [active, enabled.length]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (active === 'macd') {
      valueSeriesRef.current?.setData(lineData(indicators, (point) => point.macd));
      signalSeriesRef.current?.setData(lineData(indicators, (point) => point.macdSignal));
      histogramSeriesRef.current?.setData(
        indicators.flatMap((point) =>
          point.macdHistogram == null
            ? []
            : [{
                time: point.time,
                value: point.macdHistogram,
                color: point.macdHistogram >= 0 ? 'rgba(239,68,68,0.55)' : 'rgba(59,130,246,0.55)',
              }],
        ),
      );
    } else {
      const field: Exclude<LowerIndicatorKey, 'macd'> = active;
      valueSeriesRef.current?.setData(lineData(indicators, (point) => point[field]));
    }
    for (const boundary of boundarySeriesRef.current) {
      boundary.series.setData(
        indicators.map((point) => ({ time: point.time, value: boundary.value })),
      );
    }
    if (fittedSourceRef.current !== sourceKey) {
      fittedSourceRef.current = sourceKey;
      firstFitRef.current = false;
    }
    if (!firstFitRef.current && indicators.length > 0) {
      chart.timeScale().fitContent();
      firstFitRef.current = true;
    }
  }, [active, indicators, sourceKey]);

  return (
    <div className="border-t border-card-border">
      <div className="flex min-h-[38px] items-center border-b border-card-border px-2 py-1.5">
        <p className="shrink-0 text-[10px] font-black">거래량 아래 보조지표</p>
      </div>
      {enabled.length > 0 ? (
        <>
          <div className="flex min-h-[38px] items-center gap-1 overflow-x-auto px-2 py-1.5">
            {enabled.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setActive(key)}
                className={cn(
                  'shrink-0 rounded-lg border px-2 py-1 text-[10px] font-black',
                  active === key
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-card-border bg-card',
                )}
              >
                {LOWER_INDICATOR_LABEL[key]}
              </button>
            ))}
          </div>
          <div ref={containerRef} className="h-[160px] min-h-[160px] w-full" />
        </>
      ) : (
        <div className="flex h-[96px] w-full items-center justify-center px-4 text-center text-[11px] font-bold text-muted-foreground">
          차트 상단 톱니바퀴에서 표시할 보조지표를 선택하세요.
        </div>
      )}
    </div>
  );
});

// ── 차트 렌더러 (chart-broadcast.tsx 스타일 재사용) ──
const RelayChart = memo(function RelayChart({
  candles,
  timeVisible,
  settings,
  signals,
  activeSignalId,
  plan,
  position,
  asset,
  interval,
  tab,
  sourceKey,
  canLoadOlder,
  isLoadingOlder,
  onLoadOlder,
  onSignalSelect,
  onOpenSettings,
}: {
  candles: CandlePoint[];
  timeVisible: boolean;
  settings: ChartSettings;
  signals: ChartSignal[];
  activeSignalId: string | null;
  plan: AiPlan | null;
  position: PortfolioChartPosition | null;
  asset: Asset;
  interval: string;
  tab: Tab;
  sourceKey: string;
  canLoadOlder: boolean;
  isLoadingOlder: boolean;
  onLoadOlder: () => void;
  onSignalSelect: (signal: ChartSignal) => void;
  onOpenSettings: () => void;
}) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const closeSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const maSeriesRef = useRef<Record<'ma5' | 'ma20' | 'ma60' | 'ma120', ISeriesApi<'Line'> | null>>({
    ma5: null,
    ma20: null,
    ma60: null,
    ma120: null,
  });
  const emaSeriesRef = useRef<Record<'ema9' | 'ema20' | 'ema60', ISeriesApi<'Line'> | null>>({
    ema9: null,
    ema20: null,
    ema60: null,
  });
  const bollingerSeriesRef = useRef<{
    middle: ISeriesApi<'Line'> | null;
    upper: ISeriesApi<'Line'> | null;
    lower: ISeriesApi<'Line'> | null;
  }>({ middle: null, upper: null, lower: null });
  const vwapSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ichimokuSeriesRef = useRef<{
    conversion: ISeriesApi<'Line'> | null;
    base: ISeriesApi<'Line'> | null;
    spanA: ISeriesApi<'Line'> | null;
    spanB: ISeriesApi<'Line'> | null;
    lagging: ISeriesApi<'Line'> | null;
  }>({ conversion: null, base: null, spanA: null, spanB: null, lagging: null });
  const volumeMaSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const patternSeriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const zoneFrameRef = useRef<number | null>(null);
  const savedRangeRef = useRef<LogicalRange | null>(null);
  const firstFitRef = useRef(false);
  const previousCandlesRef = useRef<CandlePoint[]>([]);
  const previousChartTypeRef = useRef<ChartType | null>(null);
  const candlesLengthRef = useRef(candles.length);
  const loadOlderArmedRef = useRef(true);
  const viewingHistoryRef = useRef(false);
  const onLoadOlderRef = useRef(onLoadOlder);
  const onSignalSelectRef = useRef(onSignalSelect);
  const signalsRef = useRef(signals);
  const candlesRef = useRef(candles);
  const canLoadOlderRef = useRef(canLoadOlder);
  const [chartType, setChartType] = useState<ChartType>(() => loadChartType());
  const [scaleType, setScaleType] = useState<PriceScaleType>('normal');
  const [showLatest, setShowLatest] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const fallbackFullscreenRef = useRef(false);
  const fullscreenHistoryRef = useRef(false);
  const indicatorSourceRef = useRef(sourceKey);
  const [indicators, setIndicators] = useState<IndicatorPoint[]>([]);
  const [activeLevel, setActiveLevel] = useState<ChartLevelInfo | null>(null);
  const [focusedSignal, setFocusedSignal] = useState<ChartSignal | null>(null);
  const [signalZones, setSignalZones] = useState<SignalZoneRect[]>([]);
  const [chartViewportVersion, setChartViewportVersion] = useState(0);
  const scheduleZoneLayout = useCallback(() => {
    if (zoneFrameRef.current != null) {
      window.cancelAnimationFrame(zoneFrameRef.current);
    }
    zoneFrameRef.current = window.requestAnimationFrame(() => {
      zoneFrameRef.current = null;
      setChartViewportVersion((value) => value + 1);
    });
  }, []);
  const chartLevels = useMemo(
    () => buildChartLevels(candles, plan, position),
    [candles, plan, position],
  );

  useEffect(() => {
    if (indicatorSourceRef.current !== sourceKey) {
      indicatorSourceRef.current = sourceKey;
      setIndicators([]);
    }
    const timer = window.setTimeout(() => {
      setIndicators(calculateIndicators(candles, interval));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [candles, interval, sourceKey]);
  const detectedChartSignals = useMemo(
    () =>
      dedupeSignalOccurrences(signals)
        .filter(
          (signal) =>
            signal.kind === 'chart' ||
            signal.kind === 'candle' ||
            /골든크로스|데드크로스/.test(signal.name),
        )
        .sort(
          (left, right) =>
            (toEpochMilliseconds(right.occurredAt) ?? 0) -
            (toEpochMilliseconds(left.occurredAt) ?? 0),
        )
        .slice(0, 8),
    [signals],
  );
  const lowerIndicators = useMemo(
    () =>
      ([
        settings.rsi && 'rsi',
        settings.macd && 'macd',
        settings.atr && 'atr',
        settings.cci && 'cci',
        settings.obv && 'obv',
        settings.williamsR && 'williamsR',
        settings.roc && 'roc',
      ].filter(Boolean) as LowerIndicatorKey[]),
    [
      settings.atr,
      settings.cci,
      settings.macd,
      settings.obv,
      settings.roc,
      settings.rsi,
      settings.williamsR,
    ],
  );
  useEffect(() => {
    candlesLengthRef.current = candles.length;
    loadOlderArmedRef.current = true;
  }, [candles.length]);

  useEffect(() => {
    onLoadOlderRef.current = onLoadOlder;
    canLoadOlderRef.current = canLoadOlder;
    onSignalSelectRef.current = onSignalSelect;
  }, [canLoadOlder, onLoadOlder, onSignalSelect]);

  useEffect(() => {
    signalsRef.current = signals;
    candlesRef.current = candles;
  }, [candles, signals]);

  useEffect(() => {
    firstFitRef.current = false;
    savedRangeRef.current = null;
    previousCandlesRef.current = [];
    viewingHistoryRef.current = false;
    setShowLatest(false);
  }, [sourceKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(CHART_TYPE_KEY, chartType);
  }, [chartType]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const dark = document.documentElement.classList.contains('dark');
    const chart = createChart(container, {
      width: Math.max(container.clientWidth, 1),
      height: Math.max(container.clientHeight, 340),
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: dark ? '#94a3b8' : '#64748b',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: dark ? 'rgba(148,163,184,0.08)' : 'rgba(100,116,139,0.10)' },
        horzLines: { color: dark ? 'rgba(148,163,184,0.08)' : 'rgba(100,116,139,0.10)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderVisible: false,
        mode: priceScaleMode('normal'),
        scaleMargins: { top: 0.08, bottom: 0.24 },
      },
      timeScale: { borderVisible: false, timeVisible, secondsVisible: false, rightOffset: 5, barSpacing: 7 },
      handleScroll: true,
      handleScale: true,
    });
    chartRef.current = chart;

    candleSeriesRef.current = chart.addCandlestickSeries({
      upColor: '#ef4444',
      downColor: '#3b82f6',
      wickUpColor: '#ef4444',
      wickDownColor: '#3b82f6',
      borderUpColor: '#ef4444',
      borderDownColor: '#3b82f6',
      priceLineVisible: true,
      lastValueVisible: true,
    });
    closeSeriesRef.current = chart.addLineSeries({
      color: '#8b5cf6',
      lineWidth: 2,
      priceLineVisible: true,
      lastValueVisible: true,
    });

    volumeSeriesRef.current = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volumeSeriesRef.current.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    maSeriesRef.current = {
      ma5: chart.addLineSeries({ color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
      ma20: chart.addLineSeries({ color: '#8b5cf6', lineWidth: 2, priceLineVisible: false, lastValueVisible: false }),
      ma60: chart.addLineSeries({ color: '#10b981', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
      ma120: chart.addLineSeries({ color: '#ec4899', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
    };
    emaSeriesRef.current = {
      ema9: chart.addLineSeries({ color: '#facc15', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
      ema20: chart.addLineSeries({ color: '#fb7185', lineWidth: 2, priceLineVisible: false, lastValueVisible: false }),
      ema60: chart.addLineSeries({ color: '#34d399', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
    };
    bollingerSeriesRef.current = {
      middle: chart.addLineSeries({ color: '#64748b', lineWidth: 1, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false }),
      upper: chart.addLineSeries({ color: '#06b6d4', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
      lower: chart.addLineSeries({ color: '#06b6d4', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
    };
    vwapSeriesRef.current = chart.addLineSeries({
      color: '#f97316',
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    ichimokuSeriesRef.current = {
      conversion: chart.addLineSeries({ color: '#ef4444', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
      base: chart.addLineSeries({ color: '#3b82f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
      spanA: chart.addLineSeries({ color: '#22c55e', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
      spanB: chart.addLineSeries({ color: '#f97316', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
      lagging: chart.addLineSeries({ color: '#a855f7', lineWidth: 1, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false }),
    };
    volumeMaSeriesRef.current = chart.addLineSeries({
      color: '#eab308',
      lineWidth: 1,
      priceScaleId: 'volume',
      priceLineVisible: false,
      lastValueVisible: false,
    });

    const clickHandler = (param: MouseEventParams<Time>) => {
      const clickedPatternKey = [...patternSeriesRef.current.entries()].find(
        ([, series]) => param.seriesData.has(series),
      )?.[0];
      if (clickedPatternKey) {
        const clickedSignal = signalsRef.current.find(
          (signal) => signalOccurrenceKey(signal) === clickedPatternKey,
        );
        if (clickedSignal) {
          onSignalSelectRef.current(clickedSignal);
          return;
        }
      }
      if (typeof param.time !== 'number') return;
      const candle = candlesRef.current.find((item) => Number(item.time) === Number(param.time));
      if (!candle) return;
      const latestCandleTime = Number(candlesRef.current.at(-1)?.time ?? candle.time);
      const signal = signalAtCandle(signalsRef.current, candle, latestCandleTime);
      if (signal) onSignalSelectRef.current(signal);
    };
    chart.subscribeClick(clickHandler);

    const rangeHandler = (range: LogicalRange | null) => {
      if (!range) return;
      savedRangeRef.current = range;
      scheduleZoneLayout();
      const rightEdge = candlesLengthRef.current - 1;
      const viewingHistory = range.to < rightEdge - 1;
      viewingHistoryRef.current = viewingHistory;
      setShowLatest(viewingHistory);
      if (range.from <= 2 && canLoadOlderRef.current && loadOlderArmedRef.current) {
        loadOlderArmedRef.current = false;
        onLoadOlderRef.current();
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(rangeHandler);

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect?.width && rect.height) {
        chart.applyOptions({ width: Math.max(rect.width, 1), height: Math.max(rect.height, 340) });
        scheduleZoneLayout();
      }
    });
    observer.observe(container);
    return () => {
      savedRangeRef.current = chart.timeScale().getVisibleLogicalRange();
      observer.disconnect();
      if (zoneFrameRef.current != null) {
        window.cancelAnimationFrame(zoneFrameRef.current);
        zoneFrameRef.current = null;
      }
      chart.unsubscribeClick(clickHandler);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(rangeHandler);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      closeSeriesRef.current = null;
      volumeSeriesRef.current = null;
      maSeriesRef.current = { ma5: null, ma20: null, ma60: null, ma120: null };
      emaSeriesRef.current = { ema9: null, ema20: null, ema60: null };
      bollingerSeriesRef.current = { middle: null, upper: null, lower: null };
      vwapSeriesRef.current = null;
      ichimokuSeriesRef.current = { conversion: null, base: null, spanA: null, spanB: null, lagging: null };
      volumeMaSeriesRef.current = null;
      patternSeriesRef.current.clear();
      priceLinesRef.current = [];
    };
  }, [scheduleZoneLayout]);

  useEffect(() => {
    chartRef.current?.priceScale('right').applyOptions({
      mode: priceScaleMode(scaleType),
    });
  }, [scaleType]);

  useEffect(() => {
    chartRef.current?.timeScale().applyOptions({
      timeVisible,
      secondsVisible: false,
    });
  }, [timeVisible]);

  useEffect(() => {
    const chart = chartRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!chart || !volumeSeries || candles.length < 2) return;
    const candleData = candles.map((row) => ({
      time: row.time,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
    }));
    const closeData = candles.map((row) => ({ time: row.time, value: row.close }));
    const volumeData = candles.map((row) => ({
      time: row.time,
      value: row.volume,
      color: row.close >= row.open ? 'rgba(239,68,68,0.42)' : 'rgba(59,130,246,0.42)',
    }));
    const previous = previousCandlesRef.current;
    const tailOnly =
      previousChartTypeRef.current === chartType &&
      previous.length > 0 &&
      (candles.length === previous.length || candles.length === previous.length + 1) &&
      previous.slice(0, -1).every((row, index) => Number(row.time) === Number(candles[index]?.time));
    if (tailOnly) {
      const latest = candles.at(-1)!;
      if (chartType === 'candles') {
        candleSeriesRef.current?.update({
          time: latest.time,
          open: latest.open,
          high: latest.high,
          low: latest.low,
          close: latest.close,
        });
      } else {
        closeSeriesRef.current?.update({ time: latest.time, value: latest.close });
      }
      volumeSeries.update({
        time: latest.time,
        value: latest.volume,
        color: latest.close >= latest.open ? 'rgba(239,68,68,0.42)' : 'rgba(59,130,246,0.42)',
      });
    } else {
      candleSeriesRef.current?.setData(chartType === 'candles' ? candleData : []);
      closeSeriesRef.current?.setData(chartType === 'line' ? closeData : []);
      volumeSeries.setData(volumeData);
    }
    previousCandlesRef.current = candles;
    previousChartTypeRef.current = chartType;

    maSeriesRef.current.ma5?.setData(settings.ma5 ? lineData(indicators, (point) => point.ma5) : []);
    maSeriesRef.current.ma20?.setData(settings.ma20 ? lineData(indicators, (point) => point.ma20) : []);
    maSeriesRef.current.ma60?.setData(settings.ma60 ? lineData(indicators, (point) => point.ma60) : []);
    maSeriesRef.current.ma120?.setData(settings.ma120 ? lineData(indicators, (point) => point.ma120) : []);
    emaSeriesRef.current.ema9?.setData(settings.ema9 ? lineData(indicators, (point) => point.ema9) : []);
    emaSeriesRef.current.ema20?.setData(settings.ema20 ? lineData(indicators, (point) => point.ema20) : []);
    emaSeriesRef.current.ema60?.setData(settings.ema60 ? lineData(indicators, (point) => point.ema60) : []);
    bollingerSeriesRef.current.middle?.setData(settings.bollinger ? lineData(indicators, (point) => point.bollingerMiddle) : []);
    bollingerSeriesRef.current.upper?.setData(settings.bollinger ? lineData(indicators, (point) => point.bollingerUpper) : []);
    bollingerSeriesRef.current.lower?.setData(settings.bollinger ? lineData(indicators, (point) => point.bollingerLower) : []);
    vwapSeriesRef.current?.setData(settings.vwap ? lineData(indicators, (point) => point.vwap) : []);
    ichimokuSeriesRef.current.conversion?.setData(settings.ichimoku ? lineData(indicators, (point) => point.ichimokuConversion) : []);
    ichimokuSeriesRef.current.base?.setData(settings.ichimoku ? lineData(indicators, (point) => point.ichimokuBase) : []);
    ichimokuSeriesRef.current.spanA?.setData(settings.ichimoku ? lineData(indicators, (point) => point.ichimokuSpanA) : []);
    ichimokuSeriesRef.current.spanB?.setData(settings.ichimoku ? lineData(indicators, (point) => point.ichimokuSpanB) : []);
    ichimokuSeriesRef.current.lagging?.setData(settings.ichimoku ? lineData(indicators, (point) => point.ichimokuLagging) : []);
    volumeMaSeriesRef.current?.setData(settings.volumeMa20 ? lineData(indicators, (point) => point.volumeMa20) : []);

    if (!firstFitRef.current) {
      const visibleCount = isFullscreen ? 120 : 72;
      if (candles.length <= visibleCount) {
        chart.timeScale().fitContent();
      } else {
        chart.timeScale().setVisibleLogicalRange({
          from: Math.max(0, candles.length - visibleCount),
          to: candles.length - 1 + 4,
        });
      }
      firstFitRef.current = true;
    } else if (viewingHistoryRef.current && savedRangeRef.current) {
      chart.timeScale().setVisibleLogicalRange(savedRangeRef.current);
    } else if (tailOnly) {
      chart.timeScale().scrollToRealTime();
    }
  }, [
    candles,
    chartType,
    indicators,
    isFullscreen,
    settings.bollinger,
    settings.ema20,
    settings.ema60,
    settings.ema9,
    settings.ichimoku,
    settings.ma120,
    settings.ma20,
    settings.ma5,
    settings.ma60,
    settings.vwap,
    settings.volumeMa20,
  ]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const desired = new Set<string>();
    if (tab === 'live' && settings.highlight && candles.length >= 2) {
      const patternSignals = (focusedSignal ? [focusedSignal] : [])
        .filter((signal) => signal.kind === 'chart' || signal.kind === 'candle')
        .sort(
          (left, right) =>
            (toEpochMilliseconds(left.occurredAt) ?? 0) -
            (toEpochMilliseconds(right.occurredAt) ?? 0),
        )
        .slice(-20);
      const chartHigh = Math.max(...candles.map((candle) => candle.high));
      const chartLow = Math.min(...candles.map((candle) => candle.low));
      const chartRange = Math.max(chartHigh - chartLow, Math.abs(chartLow) * 0.01, 1);
      const latestCandleTime = Number(candles.at(-1)!.time);

      patternSignals.forEach((signal, signalIndex) => {
        const range = signalDisplayRange(signal, latestCandleTime);
        if (!range) return;
        const startTime = range.start;
        const endTime = range.end;
        const startIndex = candles.reduce(
          (nearest, candle, index) =>
            Math.abs(Number(candle.time) - startTime) <
            Math.abs(Number(candles[nearest]!.time) - startTime)
              ? index
              : nearest,
          0,
        );
        const endIndex = candles.reduce(
          (nearest, candle, index) =>
            Math.abs(Number(candle.time) - endTime) <
            Math.abs(Number(candles[nearest]!.time) - endTime)
              ? index
              : nearest,
          startIndex,
        );
        let left = Math.min(startIndex, endIndex);
        let right = Math.max(startIndex, endIndex);
        if (left === right) {
          if (right < candles.length - 1) right += 1;
          else left = Math.max(0, left - 1);
        }
        if (left === right) return;
        const key = signalOccurrenceKey(signal);
        desired.add(key);
        const meta = PATTERN_STAGE_META[signal.stage];
        let line = patternSeriesRef.current.get(key);
        if (!line) {
          line = chart.addLineSeries({
            color: meta.color,
            lineWidth: 3,
            lineStyle: signal.stage === 'START' ? LineStyle.Dashed : LineStyle.Solid,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          });
          patternSeriesRef.current.set(key, line);
        } else {
          line.applyOptions({
            color: meta.color,
            lineWidth: 3,
            lineStyle: signal.stage === 'START' ? LineStyle.Dashed : LineStyle.Solid,
          });
        }
        const regionLow = Math.min(...candles.slice(left, right + 1).map((candle) => candle.low));
        const lane = signalIndex % 3;
        const railPrice = regionLow - chartRange * (0.008 + lane * 0.006);
        line.setData([
          { time: candles[left]!.time, value: railPrice },
          { time: candles[right]!.time, value: railPrice },
        ]);
      });
    }

    for (const [key, series] of patternSeriesRef.current) {
      if (desired.has(key)) continue;
      chart.removeSeries(series);
      patternSeriesRef.current.delete(key);
    }
  }, [candles, chartType, focusedSignal, settings.highlight, tab]);

  useEffect(() => {
    const chart = chartRef.current;
    const series =
      chartType === 'candles'
        ? candleSeriesRef.current
        : closeSeriesRef.current;
    const container = containerRef.current;
    if (
      !chart ||
      !series ||
      !container ||
      tab !== 'live' ||
      !settings.highlight ||
      candles.length < 2
    ) {
      setSignalZones([]);
      return;
    }

    const latestCandleTime = Number(candles.at(-1)!.time);
    const candidates = (
      focusedSignal
        ? [focusedSignal].map((signal) => {
        const range = signalDisplayRange(signal, latestCandleTime);
        if (!range) return null;
        const nearestIndex = (target: number) =>
          candles.reduce(
            (nearest, candle, index) =>
              Math.abs(Number(candle.time) - target) <
              Math.abs(Number(candles[nearest]!.time) - target)
                ? index
                : nearest,
            0,
          );
        const startIndex = nearestIndex(range.start);
        const endIndex = nearestIndex(range.end);
        return {
          signal,
          left: Math.min(startIndex, endIndex),
          right: Math.max(startIndex, endIndex),
          bearish: /하락|매도|약세|이탈|쌍봉|이중천장|석별|유성|데드크로스/.test(signal.name),
          name: normalizeSignalName(signal.name),
        };
        }).filter(Boolean)
        : []
    ) as Array<{
        signal: ChartSignal;
        left: number;
        right: number;
        bearish: boolean;
        name: string;
      }>;

    candidates.sort((left, right) => left.left - right.left);
    const merged: typeof candidates = [];
    for (const candidate of candidates) {
      const previous = merged.at(-1);
      if (
        previous &&
        previous.name === candidate.name &&
        previous.bearish === candidate.bearish &&
        candidate.left <= previous.right + 1
      ) {
        previous.right = Math.max(previous.right, candidate.right);
        if (
          (toEpochMilliseconds(candidate.signal.occurredAt) ?? 0) >
          (toEpochMilliseconds(previous.signal.occurredAt) ?? 0)
        ) {
          previous.signal = candidate.signal;
        }
      } else {
        merged.push({ ...candidate });
      }
    }

    const containerTop = container.offsetTop;
    const containerLeft = container.offsetLeft;
    const rects: SignalZoneRect[] = [];
    for (const item of merged.slice(-12)) {
      const rows = candles.slice(item.left, item.right + 1);
      if (rows.length === 0) continue;
      const x1 = chart.timeScale().timeToCoordinate(candles[item.left]!.time);
      const x2 = chart.timeScale().timeToCoordinate(candles[item.right]!.time);
      const high = Math.max(...rows.map((candle) => candle.high));
      const low = Math.min(...rows.map((candle) => candle.low));
      const y1 = series.priceToCoordinate(high);
      const y2 = series.priceToCoordinate(low);
      if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
      const barWidth = Math.max(6, Math.abs(x2 - x1) / Math.max(1, item.right - item.left));
      const left = Math.min(x1, x2) - barWidth / 2 + containerLeft;
      const right = Math.max(x1, x2) + barWidth / 2 + containerLeft;
      const top = Math.min(y1, y2) + containerTop;
      const bottom = Math.max(y1, y2) + containerTop;
      rects.push({
        id: `${signalOccurrenceKey(item.signal)}:${item.left}:${item.right}`,
        signal: item.signal,
        label: item.signal.name,
        left,
        top,
        width: Math.max(8, right - left),
        height: Math.max(12, bottom - top),
        color: item.bearish ? '#3b82f6' : '#ef4444',
        dashed:
          item.signal.stage === 'START' ||
          item.signal.stage === 'DEVELOPING',
        prominent:
          signalImportance(item.signal.importance) === 'high' ||
          /골든크로스|데드크로스|쌍바닥|쌍봉|이중바닥|이중천장/.test(item.signal.name),
      });
    }
    setSignalZones(rects);
  }, [
    candles,
    chartType,
    chartViewportVersion,
    focusedSignal,
    settings.highlight,
    tab,
  ]);

  useEffect(() => {
    const series =
      chartType === 'candles'
        ? candleSeriesRef.current
        : closeSeriesRef.current;
    if (!series) return;
    for (const line of priceLinesRef.current) series.removePriceLine(line);
    priceLinesRef.current = [];
    const markers: SeriesMarker<Time>[] = [];

    if (tab === 'live' && settings.highlight && candles.length > 0) {
      const patternSignals = dedupeSignalOccurrences(signals)
        .filter((signal) => signal.kind === 'chart' || signal.kind === 'candle')
        .sort(
          (left, right) =>
            (toEpochMilliseconds(left.occurredAt) ?? 0) -
            (toEpochMilliseconds(right.occurredAt) ?? 0),
        )
        .slice(-20);
      const nearestTime = (target: number): Time =>
        candles.reduce((nearest, candle) =>
          Math.abs(Number(candle.time) - target) <
          Math.abs(Number(nearest.time) - target)
            ? candle
            : nearest,
        ).time as Time;
      const latestCandleTime = Number(candles.at(-1)!.time);
      for (const signal of patternSignals) {
        const range = signalDisplayRange(signal, latestCandleTime);
        if (!range) continue;
        const start = nearestTime(range.start);
        const end = nearestTime(range.end);
        const meta = PATTERN_STAGE_META[signal.stage];
        markers.push({
          time: start,
          position: 'belowBar',
          color: meta.color,
          shape: 'circle',
          text: `시작 · ${signal.name}`,
        });
        if (Number(start) !== Number(end)) {
          markers.push({
            time: end,
            position: 'belowBar',
            color: meta.color,
            shape: signal.stage === 'INVALIDATED' ? 'arrowDown' : 'square',
            text:
              signal.stage === 'START' || signal.stage === 'DEVELOPING'
                ? `현재 · ${meta.label}`
                : meta.label,
          });
        }
      }
    }

    if (chartLevels.length > 0) {
      const candidates: Array<{ price: number | null; color: string; title: string; on: boolean }> =
        chartLevels.map((level) => ({
          price: level.price,
          color: level.color,
          title: level.label,
          on:
            level.kind === 'support' || level.kind === 'resistance'
              ? settings.highlight
              : level.kind === 'target'
                ? settings.target
                : level.kind === 'stop'
                  ? settings.stop
                  : level.kind === 'buy'
                    ? settings.buyLevels
                    : settings.sellLevels,
        }));
      const grouped = new Map<number, { color: string; titles: string[] }>();
      for (const candidate of candidates) {
        if (!candidate.on || candidate.price == null || !Number.isFinite(candidate.price)) continue;
        const found = grouped.get(candidate.price);
        if (found) found.titles.push(candidate.title);
        else grouped.set(candidate.price, { color: candidate.color, titles: [candidate.title] });
      }
      for (const [price, line] of grouped) {
        priceLinesRef.current.push(
          series.createPriceLine({
            price,
            color: line.color,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: line.titles.join(' · '),
          }),
        );
      }
    }

    if (tab === 'live' && settings.highlight && activeSignalId) {
      const signal = signals.find((item) => item.id === activeSignalId);
      const overlay = signal?.overlay ?? null;
      if (overlay?.level != null && Number.isFinite(overlay.level)) {
        priceLinesRef.current.push(
          series.createPriceLine({
            price: overlay.level,
            color: '#eab308',
            lineWidth: 2,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: signal?.name ?? '신호',
          }),
        );
      }
      if (overlay?.level2 != null && Number.isFinite(overlay.level2)) {
        priceLinesRef.current.push(
          series.createPriceLine({
            price: overlay.level2,
            color: '#eab308',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: '',
          }),
        );
      }
      const rawMarkerTime = toUnixSeconds(overlay?.fromTime ?? signal?.barTime);
      const markerTime =
        rawMarkerTime == null
          ? null
          : candles.reduce<CandlePoint | null>((nearest, candle) => {
              if (!nearest) return candle;
              return Math.abs(Number(candle.time) - rawMarkerTime) <
                Math.abs(Number(nearest.time) - rawMarkerTime)
                ? candle
                : nearest;
            }, null)?.time ?? null;
      if (markerTime != null && signal) {
        markers.push({
          time: markerTime as Time,
          position: overlay?.type === 'candle' ? 'aboveBar' : 'belowBar',
          color: '#eab308',
          shape: overlay?.type === 'candle' ? 'circle' : 'arrowUp',
          text: signal.name,
        });
      }
    }
    series.setMarkers(
      markers.sort((left, right) => Number(left.time) - Number(right.time)),
    );
    const signal = signals.find((item) => item.id === activeSignalId);
    const target = toUnixSeconds(signal?.barTime ?? signal?.overlay?.fromTime);
    if (target == null) return;
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    candles.forEach((candle, index) => {
      const distance = Math.abs(Number(candle.time) - target);
      if (distance < nearestDistance) {
        nearestIndex = index;
        nearestDistance = distance;
      }
    });
    chartRef.current.timeScale().setVisibleLogicalRange({
      from: Math.max(0, nearestIndex - 24),
      to: Math.min(candles.length - 1, nearestIndex + 24),
    });
  }, [
    activeSignalId,
    candles,
    chartLevels,
    chartType,
    settings.buyLevels,
    settings.highlight,
    settings.sellLevels,
    settings.stop,
    settings.target,
    signals,
    tab,
  ]);

  useEffect(() => {
    const fullscreenChange = () => {
      const active = document.fullscreenElement === shellRef.current;
      if (active) setIsFullscreen(true);
      else if (!fallbackFullscreenRef.current) {
        setIsFullscreen(false);
        if (fullscreenHistoryRef.current) {
          fullscreenHistoryRef.current = false;
          window.history.back();
        }
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && fallbackFullscreenRef.current) {
        fallbackFullscreenRef.current = false;
        setIsFullscreen(false);
        if (fullscreenHistoryRef.current) window.history.back();
      }
    };
    const popstate = () => {
      if (document.fullscreenElement === shellRef.current) {
        fullscreenHistoryRef.current = false;
        void document.exitFullscreen();
        setIsFullscreen(false);
        return;
      }
      if (!fallbackFullscreenRef.current) return;
      fallbackFullscreenRef.current = false;
      fullscreenHistoryRef.current = false;
      setIsFullscreen(false);
    };
    document.addEventListener('fullscreenchange', fullscreenChange);
    window.addEventListener('keydown', keydown);
    window.addEventListener('popstate', popstate);
    return () => {
      document.removeEventListener('fullscreenchange', fullscreenChange);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('popstate', popstate);
    };
  }, []);

  const toggleFullscreen = async () => {
    const shell = shellRef.current;
    if (!shell) return;
    if (isFullscreen) {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        fallbackFullscreenRef.current = false;
        setIsFullscreen(false);
        if (fullscreenHistoryRef.current) window.history.back();
      }
      return;
    }
    if (typeof shell.requestFullscreen === 'function') {
      try {
        await shell.requestFullscreen();
        fullscreenHistoryRef.current = true;
        window.history.pushState({ ...(window.history.state ?? {}), chartRelayFullscreen: true }, '');
        setIsFullscreen(true);
        return;
      } catch {
        // 브라우저가 Fullscreen API를 거부하면 아래 앱 내부 오버레이로 전환한다.
      }
    }
    fallbackFullscreenRef.current = true;
    fullscreenHistoryRef.current = true;
    window.history.pushState({ ...(window.history.state ?? {}), chartRelayFullscreen: true }, '');
    setIsFullscreen(true);
  };

  return (
    <div
      ref={shellRef}
      className={cn(
        'relative w-full bg-background',
        isFullscreen &&
          'fixed inset-0 z-[80] overflow-y-auto p-2 [padding-bottom:max(12px,env(safe-area-inset-bottom))]',
      )}
    >
      <div className="flex min-h-[52px] flex-wrap items-center justify-between gap-2 border-b border-card-border px-2 py-2">
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => setChartType('candles')}
            className={cn('rounded-lg border px-2 py-1 text-[10px] font-black', chartType === 'candles' ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border')}
          >
            캔들
          </button>
          <button
            type="button"
            onClick={() => setChartType('line')}
            className={cn('rounded-lg border px-2 py-1 text-[10px] font-black', chartType === 'line' ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border')}
          >
            라인
          </button>
          <select
            value={scaleType}
            onChange={(event) => {
              const value = event.target.value;
              setScaleType(
                value === 'logarithmic' || value === 'percentage' ? value : 'normal',
              );
            }}
            aria-label="가격축 방식"
            className="rounded-lg border border-card-border bg-card px-2 py-1 text-[10px] font-black"
          >
            <option value="normal">일반 가격축</option>
            <option value="logarithmic">로그 가격축</option>
            <option value="percentage">퍼센트 가격축</option>
          </select>
          <span className="inline-flex items-center rounded-lg border border-card-border bg-card px-2 py-1 text-[10px] font-black text-primary">
            {STANDARD_INTERVALS.find((item) => item.key === interval)?.label ?? interval}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="차트 설정"
            title="차트 설정"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-card-border bg-card text-primary"
          >
            <Settings2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => void toggleFullscreen()}
            aria-label={isFullscreen ? '전체화면 종료' : '차트 전체화면'}
            className="flex h-9 items-center gap-1 rounded-lg border border-card-border bg-card px-2 text-[10px] font-black"
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            {isFullscreen ? '종료' : '전체화면'}
          </button>
        </div>
      </div>

      <div className="flex min-h-[38px] flex-wrap content-center gap-2 overflow-hidden border-b border-card-border px-2 py-1.5">
        {Object.entries(PATTERN_STAGE_META).map(([stage, meta]) => (
          <span key={stage} className="flex items-center gap-1 text-[9px] font-black text-muted-foreground">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: meta.color }} />
            {meta.label}
          </span>
        ))}
        <span className="text-[9px] font-bold text-muted-foreground">마커·밑줄 구간을 누르면 신호 상세가 열립니다.</span>
      </div>

      {chartLevels.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto border-b border-card-border px-2 py-2 [scrollbar-width:none]">
          {chartLevels.map((level) => (
            <button
              key={level.id}
              type="button"
              onClick={() => setActiveLevel(level)}
              className="shrink-0 rounded-full border bg-card px-2.5 py-1 text-[10px] font-black"
              style={{ borderColor: level.color, color: level.color }}
            >
              {level.label} · {formatPrice(level.price, asset)}
            </button>
          ))}
        </div>
      )}

      <div
        ref={containerRef}
        className={cn('w-full', isFullscreen ? 'h-[55vh] min-h-[400px]' : 'h-[360px] min-h-[340px]')}
      />
      <div className="pointer-events-none absolute inset-0 z-[2] overflow-hidden">
        {signalZones.map((zone) => (
          <div
            key={zone.id}
            className="absolute overflow-visible rounded-md text-left"
            style={{
              left: zone.left,
              top: zone.top,
              width: zone.width,
              height: zone.height,
              minHeight: 12,
              border: `${zone.prominent ? 3 : 2}px ${zone.dashed ? 'dashed' : 'solid'} ${zone.color}`,
              backgroundColor: `${zone.color}${zone.prominent ? '40' : '2b'}`,
              boxShadow: zone.prominent ? `0 0 0 2px ${zone.color}33, 0 0 16px ${zone.color}66` : 'none',
            }}
            aria-label={`${zone.label} 신호 구간 상세`}
          >
            {(zone.prominent || (zone.width >= 56 && zone.height >= 20)) && (
              <span
                className="absolute left-1 top-1 max-w-[calc(100%-8px)] truncate rounded px-1.5 py-0.5 text-[8px] font-black text-white"
                style={{ backgroundColor: `${zone.color}cc` }}
              >
                {zone.label}
              </span>
            )}
            <button
              type="button"
              onClick={() => onSignalSelect(zone.signal)}
              className="pointer-events-auto absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap rounded-full border-2 bg-background px-2 py-1 text-[10px] font-black shadow-lg"
              style={{ borderColor: zone.color, color: zone.color }}
              aria-label={`${zone.label} 상세 설명 열기`}
            >
              ↑ 여기
            </button>
          </div>
        ))}
      </div>
      {detectedChartSignals.length > 0 && (
        <div className="relative z-[3] border-y border-card-border bg-background/95 px-2 py-2">
          <p className="text-[10px] font-black text-muted-foreground">감지된 차트 신호</p>
          <div className="mt-1.5 flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
            {detectedChartSignals.map((signal) => {
              const bearish = /하락|매도|약세|이탈|쌍봉|이중천장|석별|유성|데드크로스/.test(signal.name);
              const label =
                signal.kind === 'candle'
                  ? `${signal.name} 캔들 감지`
                  : /골든크로스|데드크로스/.test(signal.name)
                    ? `${signal.name} 감지`
                    : `${signal.name} 패턴 감지`;
              return (
                <button
                  key={signal.id}
                  type="button"
                  onClick={() => {
                    setFocusedSignal(signal);
                    const target = toUnixSeconds(signal.overlay?.fromTime ?? signal.barTime);
                    if (target != null) {
                      let nearestIndex = 0;
                      let nearestDistance = Number.POSITIVE_INFINITY;
                      candles.forEach((candle, index) => {
                        const distance = Math.abs(Number(candle.time) - target);
                        if (distance < nearestDistance) {
                          nearestIndex = index;
                          nearestDistance = distance;
                        }
                      });
                      chartRef.current?.timeScale().setVisibleLogicalRange({
                        from: Math.max(0, nearestIndex - 18),
                        to: Math.min(candles.length - 1, nearestIndex + 18),
                      });
                    }
                  }}
                  className="shrink-0 rounded-full border px-3 py-1.5 text-[10px] font-black shadow-sm"
                  style={{
                    borderColor: bearish ? '#3b82f6' : '#ef4444',
                    backgroundColor: bearish ? '#3b82f61f' : '#ef44441f',
                    color: bearish ? '#3b82f6' : '#ef4444',
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-[9px] font-bold text-muted-foreground">
            항목을 누르면 해당 구간과 ‘↑ 여기’ 화살표 하나만 표시됩니다. 화살표를 누르면 설명이 열립니다.
          </p>
        </div>
      )}
      <LowerIndicatorPanel
        indicators={indicators}
        enabled={lowerIndicators}
        timeVisible={timeVisible}
        sourceKey={sourceKey}
      />

      {activeLevel && (
        <ChartLevelModal
          level={activeLevel}
          currentPrice={candles.at(-1)?.close ?? null}
          asset={asset}
          interval={interval}
          onClose={() => setActiveLevel(null)}
        />
      )}

      {(showLatest || isLoadingOlder) && (
        <div className="pointer-events-none sticky bottom-3 flex justify-center px-3">
          {showLatest && (
            <button
              type="button"
              onClick={() => {
                chartRef.current?.timeScale().scrollToRealTime();
                viewingHistoryRef.current = false;
                setShowLatest(false);
              }}
              className="pointer-events-auto rounded-full bg-primary px-4 py-2 text-xs font-black text-primary-foreground shadow-lg"
            >
              최신으로
            </button>
          )}
          {isLoadingOlder && (
            <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-card px-3 py-2 text-[10px] font-bold shadow">
              <Loader2 className="h-3 w-3 animate-spin" /> 과거 데이터 불러오는 중
            </span>
          )}
        </div>
      )}
    </div>
  );
});

export default function ChartRelayPage() {
  const [location, navigate] = useLocation();
  const queryClient = useQueryClient();
  const permissions = useMemberPermissions();
  const auth = useAuth() as AnyObj;
  const canUseFutures = permissions.has('futures');

  const [initialRoute] = useState(() => {
    const queryText =
      typeof window !== 'undefined'
        ? window.location.search.replace(/^\?/, '')
        : location.includes('?')
          ? location.slice(location.indexOf('?') + 1)
          : '';

    const params = new URLSearchParams(queryText);
    const assetParam = params.get('asset');
    const symbolParam = params.get('symbol');
    const intervalParam = params.get('interval');
    const tabParam = params.get('tab');

    const initialAsset: Asset =
      assetParam === 'stockUS' ||
      assetParam === 'coinSpot' ||
      assetParam === 'coinFutures'
        ? assetParam
        : 'stockKR';

    return {
      asset: initialAsset,
      symbol:
        symbolParam?.trim().toUpperCase() ||
        DEFAULT_SYMBOL[initialAsset],
      interval: normalizeRealtimeTimeframe(intervalParam) ?? '5m',
      tab: tabParam === 'ai' ? ('ai' as Tab) : ('live' as Tab),
    };
  });

  const [asset, setAsset] = useState<Asset>(initialRoute.asset);
  const [symbol, setSymbol] = useState<string>(initialRoute.symbol);
  const [symbolInput, setSymbolInput] = useState<string>('');
  const [interval, setIntervalState] = useState<string>(initialRoute.interval);
  const [tab, setTab] = useState<Tab>(initialRoute.tab);
  const [assetMenu, setAssetMenu] =
    useState<'stock' | 'coin' | null>(null);
  const [settingsPanel, setSettingsPanel] = useState<ChartSettingsPanel | null>(null);
  const [settings, setSettings] = useState<ChartSettings>(() => loadSettings());
  const [draftSettings, setDraftSettings] = useState<ChartSettings>(() => loadSettings());
  const [draftInterval, setDraftInterval] = useState<string>(initialRoute.interval);
  const [disabledPatternNames, setDisabledPatternNames] = useState<Set<string>>(
    () => loadDisabledPatterns(),
  );
  const [draftDisabledPatternNames, setDraftDisabledPatternNames] = useState<Set<string>>(
    () => loadDisabledPatterns(),
  );
  const [activeSignalId, setActiveSignalId] = useState<string | null>(null);
  const [modalSignal, setModalSignal] = useState<ChartSignal | null>(null);
  const [olderCandles, setOlderCandles] = useState<CandlePoint[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null | undefined>(undefined);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [aiHistory, setAiHistory] = useState<AiPlanChange[]>([]);
  const [topBanners, setTopBanners] = useState<TopSignalBanner[]>([]);
  const seenSignalIdsRef = useRef<Set<string>>(new Set());
  const bannerSourceRef = useRef<string>('');
  const seenAiChangeIdsRef = useRef<Set<string>>(new Set());

  const futuresLocked = asset === 'coinFutures' && !canUseFutures;
  const sourceKey = `${asset}:${symbol.toUpperCase()}:${interval}`;
  const portfolioPositionQuery = useQuery({
    queryKey: ['chart-relay-portfolio-position', auth.user?.id ?? null, asset, symbol.toUpperCase()],
    enabled:
      Boolean(auth.configured && auth.user?.id && symbol) &&
      (asset === 'stockKR' || asset === 'stockUS'),
    queryFn: async (): Promise<PortfolioChartPosition | null> => {
      const { data, error } = await getSupabase()
        .from('portfolio_holdings')
        .select('ticker,quantity,average_price')
        .eq('user_id', auth.user.id)
        .eq('ticker', symbol.toUpperCase());
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      let quantity = 0;
      let totalCost = 0;
      for (const row of rows) {
        const rowQuantity = Number(row.quantity);
        const rowAverage = Number(row.average_price);
        if (
          !Number.isFinite(rowQuantity) ||
          !Number.isFinite(rowAverage) ||
          rowQuantity <= 0 ||
          rowAverage <= 0
        ) continue;
        quantity += rowQuantity;
        totalCost += rowQuantity * rowAverage;
      }
      if (quantity <= 0 || totalCost <= 0) return null;
      return {
        quantity,
        totalCost,
        averagePrice: totalCost / quantity,
      };
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const portfolioPosition = portfolioPositionQuery.data ?? null;
  const realtime = useRealtimeChart({
    asset,
    symbol,
    interval,
    enabled: Boolean(symbol) && !futuresLocked,
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      PATTERN_FILTER_KEY,
      JSON.stringify([...disabledPatternNames]),
    );
  }, [disabledPatternNames]);

  useEffect(() => {
    setOlderCandles([]);
    setHistoryCursor(undefined);
    setHistoryError(null);
    setAiHistory([]);
    setTopBanners([]);
    seenSignalIdsRef.current = new Set();
    seenAiChangeIdsRef.current = new Set();
    bannerSourceRef.current = '';
  }, [sourceKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    params.set('asset', asset);
    params.set('symbol', symbol);
    params.set('interval', interval);
    params.set('tab', tab);
    const next = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
    window.history.replaceState(window.history.state, '', next);
  }, [asset, interval, symbol, tab]);

  useEffect(() => {
    const applyLocation = () => {
      const params = new URLSearchParams(window.location.search);
      const nextAsset = params.get('asset');
      const nextTab = params.get('tab');
      const nextSymbol = params.get('symbol')?.trim();
      const nextInterval = params.get('interval')?.trim();
      if (
        nextAsset === 'stockKR' ||
        nextAsset === 'stockUS' ||
        nextAsset === 'coinSpot' ||
        nextAsset === 'coinFutures'
      ) {
        if (nextAsset !== 'coinFutures' || canUseFutures) setAsset(nextAsset);
      }
      if (nextSymbol) setSymbol(nextSymbol.toUpperCase());
      const normalizedInterval = normalizeRealtimeTimeframe(nextInterval);
      if (normalizedInterval) setIntervalState(normalizedInterval);
      if (nextTab === 'live' || nextTab === 'ai') setTab(nextTab);
    };
    window.addEventListener('popstate', applyLocation);
    return () => window.removeEventListener('popstate', applyLocation);
  }, [canUseFutures]);

  // 최초 진입에서는 URL로 전달된 종목을 유지하고,
  // 사용자가 자산 종류를 직접 바꿀 때만 기본 종목으로 변경한다.
  const initializedAssetRef = useRef(false);

  useEffect(() => {
    const list = intervalsFor(asset);

    setSymbolInput('');
    setActiveSignalId(null);
    setModalSignal(null);
    setIntervalState((current) =>
      list.some((item) => item.key === current)
        ? current
        : list[3]?.key ?? list[0]?.key ?? '5m',
    );

    if (!initializedAssetRef.current) {
      initializedAssetRef.current = true;
      return;
    }

    setSymbol(DEFAULT_SYMBOL[asset]);
  }, [asset]);

  const contract = signalContract(asset);
  const candleQueryKey = useMemo(
    () => ['chart-relay-candles', asset, symbol, interval] as const,
    [asset, interval, symbol],
  );
  const signalsQueryKey = useMemo(
    () => ['chart-relay-signals', asset, symbol, interval] as const,
    [asset, interval, symbol],
  );
  const planQueryKey = useMemo(
    () => ['chart-relay-ai', asset, symbol, interval] as const,
    [asset, interval, symbol],
  );
  // WebSocket이 실제 스냅샷을 전달하기 전까지 REST 캔들 조회를 유지한다.
  // Replit Preview에서 WebSocket 업그레이드가 지연되거나 실패해도
  // 차트가 무한 로딩 상태에 머물지 않게 한다.
  const hasMatchingRealtimeSnapshot =
    realtime.status === 'live' &&
    realtime.snapshot?.asset === asset &&
    realtime.snapshot.symbol === symbol.trim().toUpperCase() &&
    realtime.snapshot.interval === interval &&
    realtime.snapshot.candles.length >= 2;
  const useRestFallback = !hasMatchingRealtimeSnapshot;

  const candleQuery = useQuery({
    queryKey: candleQueryKey,
    queryFn: async () => {
      const normalizedSymbol = symbol.trim().toUpperCase();
      const payload = await apiGet<AnyObj>(
        candleUrl(asset, normalizedSymbol, interval),
        { timeoutMs: 20_000 },
      );

      if (extractCandleRows(payload).length < 2) {
        throw new Error('EMPTY_CANDLE_DATA');
      }

      return payload;
    },
    enabled: Boolean(symbol.trim()) && !futuresLocked && useRestFallback,
    refetchInterval: useRestFallback ? 20_000 : false,
    refetchIntervalInBackground: true,
    refetchOnMount: 'always',
    refetchOnReconnect: true,
    retry: 0,
    initialData: () => readCachedCandles(asset, symbol, interval),
  });
  const hasInitialCandleData =
    hasMatchingRealtimeSnapshot ||
    extractCandleRows(candleQuery.data ?? {}).length >= 2;

  const signalsQuery = useQuery({
    queryKey: signalsQueryKey,
    queryFn: () =>
      apiGet<AnyObj>(
        `/market/chart-signals?asset=${contract.assetParam}${contract.coinMarket ? `&coinMarket=${contract.coinMarket}` : ''}&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`,
      ),
    enabled:
      Boolean(symbol) &&
      !futuresLocked &&
      settings.liveSignal &&
      useRestFallback &&
      hasInitialCandleData,
    refetchInterval: useRestFallback ? 30_000 : false,
    refetchIntervalInBackground: true,
    retry: 1,
  });

  const planQuery = useQuery({
    queryKey: planQueryKey,
    queryFn: () =>
      apiGet<AiPlan>(
        `/market/ai-chart-plan?asset=${contract.assetParam}${contract.coinMarket ? `&coinMarket=${contract.coinMarket}` : ''}&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`,
      ),
    enabled:
      Boolean(symbol) &&
      !futuresLocked &&
      settings.ai &&
      useRestFallback &&
      hasInitialCandleData,
    refetchInterval: useRestFallback ? 30_000 : false,
    refetchIntervalInBackground: true,
    retry: 1,
  });

  useEffect(() => {
    const snapshot = realtime.snapshot;
    if (
      !snapshot ||
      snapshot.asset !== asset ||
      snapshot.symbol !== symbol.toUpperCase() ||
      snapshot.interval !== interval
    ) {
      return;
    }
    queryClient.setQueryData<AnyObj>(candleQueryKey, {
      ok: true,
      provider: snapshot.provider,
      fetchedAt: snapshot.fetchedAt,
      candles: snapshot.candles,
      count: snapshot.candles.length,
    });
    queryClient.setQueryData<AnyObj>(signalsQueryKey, {
      ok: true,
      symbol: snapshot.symbol,
      interval: snapshot.interval,
      updatedAt: snapshot.fetchedAt,
      signals: snapshot.signals,
    });
    const livePlan = normalizeAiPlan(snapshot.plan);
    if (livePlan) queryClient.setQueryData<AiPlan>(planQueryKey, livePlan);
  }, [
    asset,
    candleQueryKey,
    interval,
    planQueryKey,
    queryClient,
    realtime.snapshot,
    signalsQueryKey,
    symbol,
  ]);

  const currentCandles = useMemo(
    () => normalizeCandles(extractCandleRows(candleQuery.data ?? {})),
    [candleQuery.data],
  );
  const candles = useMemo(
    () => normalizeCandles([...olderCandles, ...currentCandles]),
    [currentCandles, olderCandles],
  );

  useEffect(() => {
    if (!candleQuery.data || currentCandles.length < 2) return;
    writeCachedCandles(asset, symbol, interval, candleQuery.data);
  }, [asset, candleQuery.data, currentCandles.length, interval, symbol]);

  useEffect(() => {
    if (historyCursor !== undefined || !candleQuery.data) return;
    setHistoryCursor(
      asset === 'stockKR' && currentCandles.length >= 2
        ? 'stock-pages:1'
        : extractBeforeCursor(candleQuery.data),
    );
  }, [asset, candleQuery.data, currentCandles.length, historyCursor]);

  const loadOlder = useCallback(async () => {
    if (!historyCursor || isLoadingOlder || futuresLocked) return;
    setIsLoadingOlder(true);
    setHistoryError(null);
    try {
      if (asset === 'stockKR' && historyCursor.startsWith('stock-pages:')) {
        const currentPages = Number(historyCursor.slice('stock-pages:'.length)) || 1;
        const pageSteps = [1, 3, 10, 30, 100, 300];
        const nextPages = pageSteps.find((value) => value > currentPages);
        if (!nextPages) {
          setHistoryCursor(null);
          return;
        }
        const payload = await apiGet<AnyObj>(
          candleUrl(asset, symbol.trim().toUpperCase(), interval, nextPages),
          { timeoutMs: 180_000 },
        );
        const rows = normalizeCandles(extractCandleRows(payload));
        if (rows.length <= candles.length) {
          setHistoryCursor(null);
          return;
        }
        setOlderCandles((current) => normalizeCandles([...rows, ...current]));
        setHistoryCursor(nextPages < 300 ? `stock-pages:${nextPages}` : null);
        return;
      }
      const payload = await apiGet<AnyObj>(
        withBeforeCursor(candleUrl(asset, symbol.trim().toUpperCase(), interval), historyCursor),
      );
      const rows = normalizeCandles(extractCandleRows(payload));
      if (rows.length === 0) {
        setHistoryCursor(null);
        return;
      }
      setOlderCandles((current) => normalizeCandles([...rows, ...current]));
      const nextCursor = extractBeforeCursor(payload);
      setHistoryCursor(nextCursor && nextCursor !== historyCursor ? nextCursor : null);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '과거 데이터를 불러오지 못했습니다.');
    } finally {
      setIsLoadingOlder(false);
    }
  }, [asset, candles.length, futuresLocked, historyCursor, interval, isLoadingOlder, symbol]);

  const signals = useMemo<ChartSignal[]>(() => {
    const raw = Array.isArray(signalsQuery.data?.signals) ? (signalsQuery.data!.signals as AnyObj[]) : [];
    const mapped: ChartSignal[] = [];
    const seen = new Set<string>();
    for (const row of raw) {
      const id = String(row?.id ?? '');
      if (!id || seen.has(id)) continue;
      const signal: ChartSignal = {
        id,
        kind:
          row?.kind === 'candle' || row?.kind === 'volume' || row?.kind === 'indicator'
            ? row.kind
            : 'chart',
        name: String(row?.name ?? '신호'),
        occurredAt: String(row?.occurredAt ?? ''),
        price: finite(row?.price),
        barTime: toUnixSeconds(row?.barTime),
        importance: String(row?.importance ?? ''),
        meaningGeneral: String(row?.meaningGeneral ?? ''),
        meaningHere: String(row?.meaningHere ?? ''),
        confirmations: Array.isArray(row?.confirmations) ? row.confirmations.map(String) : [],
        invalidation: Array.isArray(row?.invalidation) ? row.invalidation.map(String) : [],
        risk: String(row?.risk ?? ''),
        overlay: (row?.overlay as OverlayShape | null) ?? null,
        stage: chartSignalStage(
          row,
          String(row?.name ?? '신호'),
          String(row?.importance ?? ''),
        ),
      };
      // 설정 토글에 따라 종류별 필터
      if (!settings.liveSignal) continue;
      if (signal.kind === 'chart' && !settings.chartPattern) continue;
      if (signal.kind === 'candle' && !settings.candlePattern) continue;
      if (signal.kind === 'volume' && !settings.volumeSignal) continue;
      if (signal.kind === 'indicator' && !settings.indicatorSignal) continue;
      seen.add(id);
      mapped.push(signal);
    }
    if (settings.liveSignal && (settings.chartPattern || settings.candlePattern)) {
      for (const signal of detectLocalPatternSignals(candles)) {
        if (seen.has(signal.id)) continue;
        seen.add(signal.id);
        mapped.push(signal);
      }
    }
    return mapped.filter(
      (signal) =>
        (signal.kind !== 'chart' && signal.kind !== 'candle') ||
        !disabledPatternNames.has(normalizeSignalName(signal.name)),
    );
  }, [candles, disabledPatternNames, signalsQuery.data, settings]);

  useEffect(() => {
    if (!settings.liveSignal) {
      setTopBanners([]);
      return;
    }
    if (bannerSourceRef.current !== sourceKey) {
      bannerSourceRef.current = sourceKey;
      seenSignalIdsRef.current = new Set(signals.map((signal) => signal.id));
      return;
    }
    const fresh = signals.filter(
      (signal) => !seenSignalIdsRef.current.has(signal.id),
    );
    if (fresh.length === 0) return;
    fresh.forEach((signal) => seenSignalIdsRef.current.add(signal.id));
    setTopBanners((current) =>
      [
        ...fresh.map<TopSignalBanner>((signal) => ({
          id: signal.id,
          title: signal.name,
          direction:
            /매도|하락|약세|이탈/.test(signal.name) ? '하락' : '상승/확인',
          price: signal.price,
          occurredAt: signal.occurredAt,
          importance: signal.importance || '산출 불가',
          signal,
        })),
        ...current,
      ].slice(0, 3),
    );
  }, [settings.liveSignal, signals, sourceKey]);

  // 활성 신호가 목록에서 사라지면 강조 해제
  useEffect(() => {
    if (activeSignalId && !signals.some((item) => item.id === activeSignalId)) {
      setActiveSignalId(null);
    }
  }, [signals, activeSignalId]);

  const plan = planQuery.data && planQuery.data.ok ? planQuery.data : null;
  const previousPlanRef = useRef<{ sourceKey: string; plan: AiPlan | null }>({
    sourceKey,
    plan: null,
  });

  useEffect(() => {
    const previous = previousPlanRef.current;
    if (previous.sourceKey !== sourceKey) {
      previousPlanRef.current = { sourceKey, plan };
      return;
    }
    if (!plan) return;
    if (!previous.plan) {
      previousPlanRef.current = { sourceKey, plan };
      return;
    }
    const changed =
      previous.plan.view !== plan.view ||
      previous.plan.target !== plan.target ||
      previous.plan.stop !== plan.stop;
    if (changed) {
      const changedAt = new Date().toISOString();
      setAiHistory((current) =>
        [
          {
            id: `${sourceKey}:${changedAt}`,
            changedAt,
            previousView: previous.plan!.view,
            nextView: plan.view,
            previousTarget: previous.plan!.target,
            nextTarget: plan.target,
            previousStop: previous.plan!.stop,
            nextStop: plan.stop,
          },
          ...current,
        ].slice(0, 20),
      );
    }
    previousPlanRef.current = { sourceKey, plan };
  }, [plan, sourceKey]);

  useEffect(() => {
    const latest = aiHistory[0];
    if (!latest || seenAiChangeIdsRef.current.has(latest.id)) return;
    seenAiChangeIdsRef.current.add(latest.id);
    setTopBanners((current) =>
      [
        {
          id: latest.id,
          title: `AI 관점 ${latest.previousView} → ${latest.nextView}`,
          direction: latest.nextView,
          price: latest.nextTarget,
          occurredAt: latest.changedAt,
          importance: 'AI 변경',
          signal: null,
        },
        ...current,
      ].slice(0, 3),
    );
  }, [aiHistory]);

  useEffect(() => {
    if (topBanners.length === 0) return;
    const timer = window.setTimeout(() => {
      setTopBanners((current) => current.slice(0, -1));
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [topBanners]);

  const timeVisible = /m|H/.test(interval);
  const availablePatternOptions = useMemo(() => {
    const options = new Map(
      DEFAULT_PATTERN_OPTIONS.map((option) => [normalizeSignalName(option.name), option]),
    );
    const raw = Array.isArray(signalsQuery.data?.signals)
      ? (signalsQuery.data!.signals as AnyObj[])
      : [];
    raw.forEach((row) => {
      if (row?.kind !== 'chart' && row?.kind !== 'candle') return;
      const name = String(row?.name ?? '').trim();
      if (name) {
        options.set(normalizeSignalName(name), {
          name,
          kind: row.kind,
        });
      }
    });
    signals.forEach((signal) => {
      if (signal.kind === 'chart' || signal.kind === 'candle') {
        options.set(normalizeSignalName(signal.name), {
          name: signal.name,
          kind: signal.kind,
        });
      }
    });
    return [...options.values()].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'candle' ? -1 : 1;
      return left.name.localeCompare(right.name, 'ko');
    });
  }, [signals, signalsQuery.data]);
  const openSettingsPanel = (panel: ChartSettingsPanel = 'menu') => {
    setDraftSettings(settings);
    setDraftInterval(interval);
    setDraftDisabledPatternNames(new Set(disabledPatternNames));
    setSettingsPanel(panel);
  };
  const isCoin = asset === 'coinSpot' || asset === 'coinFutures';
  const latestCandle = candles[candles.length - 1] ?? null;
  const previousCandle = candles[candles.length - 2] ?? null;
  const latestPrice = latestCandle?.close ?? null;
  const latestBarChangePercent =
    latestCandle && previousCandle && previousCandle.close !== 0
      ? ((latestCandle.close - previousCandle.close) / previousCandle.close) * 100
      : null;
  const watchMarket =
    asset === 'stockUS'
      ? 'US'
      : asset === 'stockKR'
        ? 'KR'
        : asset === 'coinSpot'
          ? 'UPBIT'
          : 'BITGET';
  const watchCurrency =
    asset === 'stockUS'
      ? 'USD'
      : asset === 'coinFutures'
        ? 'USDT'
        : 'KRW';
  const realtimeLabel = realtime.status === 'live'
    ? `연결됨${realtime.provider ? ` · ${realtime.provider}` : ''}`
    : realtime.status === 'connecting'
      ? '연결 중'
      : realtime.status === 'connected'
        ? '구독 중'
        : realtime.status === 'reconnecting'
          ? '재연결 중'
          : realtime.status === 'error'
            ? '연결 오류 · REST 갱신 중'
            : '대기';

  const submitSymbol = () => {
    const next = symbolInput.trim();
    if (!next) return;
    setSymbol(isCoin ? next.toUpperCase() : next);
    setSymbolInput('');
    setActiveSignalId(null);
  };

  const selectAsset = (next: Asset) => {
    setAssetMenu(null);
    setAsset(next);
  };
  const requestLoadOlder = useCallback(() => {
    void loadOlder();
  }, [loadOlder]);
  const selectSignal = useCallback((signal: ChartSignal) => {
    setActiveSignalId(signal.id);
    setModalSignal(signal);
  }, []);

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-background">
      <div className="mx-auto max-w-md px-4 pb-28 pt-4">
        <header className="grid grid-cols-[40px_1fr_40px] items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/')}
            aria-label="뒤로"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="text-center">
            <h1 className="text-lg font-extrabold">차트중계</h1>
            <p className="text-[11px] font-bold text-muted-foreground">실시간 차트·신호 분석 (표시 전용)</p>
          </div>
          <button
            type="button"
            onClick={() => {
              void candleQuery.refetch();
              if (tab === 'live') void signalsQuery.refetch();
              else void planQuery.refetch();
            }}
            aria-label="새로고침"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card"
          >
            <RefreshCw className={cn('h-4 w-4', candleQuery.isFetching && 'animate-spin')} />
          </button>
        </header>

        {topBanners.length > 0 && (
          <div className="mt-3 space-y-2" aria-live="polite">
            {topBanners.map((banner) => (
              <button
                key={banner.id}
                type="button"
                onClick={() => {
                  if (banner.signal) {
                    setActiveSignalId(banner.signal.id);
                    setModalSignal(banner.signal);
                  } else {
                    setTab('ai');
                  }
                }}
                className="flex w-full items-center gap-2 rounded-2xl border border-primary/40 bg-primary/10 p-3 text-left shadow-sm"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-black">
                    {banner.title} · {symbol}
                  </span>
                  <span className="mt-0.5 block text-[10px] font-bold text-muted-foreground">
                    {banner.direction} · {formatPrice(banner.price, asset)} ·{' '}
                    {formatTime(banner.occurredAt)} · {banner.importance}
                  </span>
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  aria-label="알림 닫기"
                  onClick={(event) => {
                    event.stopPropagation();
                    setTopBanners((current) =>
                      current.filter((item) => item.id !== banner.id),
                    );
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      event.stopPropagation();
                      setTopBanners((current) =>
                        current.filter((item) => item.id !== banner.id),
                      );
                    }
                  }}
                  className="rounded-full p-1"
                >
                  <X className="h-4 w-4" />
                </span>
              </button>
            ))}
          </div>
        )}

        {/* 자산 선택 */}
        <div className="relative mt-3 grid grid-cols-2 gap-2">
          {ASSET_GROUPS.map((group) => {
            const selectedGroup =
              group.key === 'stock'
                ? asset === 'stockKR' || asset === 'stockUS'
                : asset === 'coinSpot' || asset === 'coinFutures';

            return (
              <div key={group.key} className="relative">
                <button
                  type="button"
                  onClick={() =>
                    setAssetMenu((current) =>
                      current === group.key ? null : group.key,
                    )
                  }
                  className={cn(
                    'flex w-full items-center justify-center gap-1 rounded-xl border px-2 py-2.5 text-xs font-extrabold',
                    selectedGroup
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-card-border bg-card text-muted-foreground',
                  )}
                >
                  {group.label}
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>

                {assetMenu === group.key && (
                  <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 overflow-hidden rounded-xl border border-card-border bg-card p-1 shadow-xl">
                    {group.items.map((item) => {
                      const locked =
                        'futures' in item &&
                        item.futures &&
                        !canUseFutures;

                      return (
                        <button
                          key={item.key}
                          type="button"
                          onClick={() => {
                            if (!locked) selectAsset(item.key);
                          }}
                          disabled={locked}
                          className={cn(
                            'block w-full rounded-lg px-3 py-2 text-center text-xs font-black disabled:opacity-45',
                            asset === item.key
                              ? 'bg-primary text-primary-foreground'
                              : 'text-foreground hover:bg-secondary',
                          )}
                        >
                          {item.label}
                          {locked ? ' 🔒' : ''}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* 종목 입력 */}
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={symbolInput}
            onChange={(event) => setSymbolInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitSymbol();
            }}
            placeholder={isCoin ? '심볼 입력 (예: BTC)' : '종목 코드 입력'}
            className="h-11 w-full rounded-2xl border border-card-border bg-card pl-10 pr-16 text-sm font-bold outline-none focus:border-primary"
          />
          <button
            type="button"
            onClick={submitSymbol}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-xl bg-primary px-3 py-1.5 text-[11px] font-extrabold text-primary-foreground"
          >
            선택
          </button>
        </div>
        <p className="mt-1.5 text-center text-[11px] font-bold text-muted-foreground">
          현재 종목: <span className="font-black text-foreground">{symbol || '해당 종목 없음'}</span>
          {' · '}실시간: <span title={realtime.error ?? undefined}>{realtimeLabel}</span>
          {latestPrice != null && (
            <>
              {' · '}
              <span className="font-black text-foreground">{formatPrice(latestPrice, asset)}</span>
              {latestBarChangePercent != null
                ? ` · 직전 봉 대비 ${latestBarChangePercent >= 0 ? '+' : ''}${latestBarChangePercent.toFixed(2)}%`
                : ''}
            </>
          )}
        </p>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <FavoriteButton
            symbol={symbol}
            name={symbol}
            assetType={asset}
            market={watchMarket}
            currency={watchCurrency}
            className="flex h-10 items-center justify-center gap-1 rounded-xl border border-card-border bg-card text-xs font-black text-warning"
          />
          <InstrumentAlertButton
            symbol={symbol}
            name={symbol}
            assetType={asset}
            market={watchMarket}
            currency={watchCurrency}
            currentPrice={latestPrice}
            className="flex h-10 items-center justify-center gap-1 rounded-xl border border-card-border bg-card text-xs font-black"
          />
          <button
            type="button"
            onClick={() =>
              navigate(
                `/tech/chart-broadcast?asset=${encodeURIComponent(asset)}&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`,
              )
            }
            className="h-10 rounded-xl border border-card-border bg-card px-2 text-xs font-black"
          >
            분석 화면 보기
          </button>
        </div>

        {/* 탭 */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setTab('live')}
            className={cn(
              'rounded-xl border px-2 py-2.5 text-center text-xs font-extrabold',
              tab === 'live'
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-card-border bg-card text-muted-foreground',
            )}
          >
            실시간 차트 분석
          </button>
          <button
            type="button"
            onClick={() => setTab('ai')}
            className={cn(
              'rounded-xl border px-2 py-2.5 text-center text-xs font-extrabold',
              tab === 'ai'
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-card-border bg-card text-muted-foreground',
            )}
          >
            실시간 신호 분석
          </button>
        </div>

        {/* 본문 */}
        {futuresLocked ? (
          <div className="mt-3">
            <StateBox>
              코인 선물은 정회원 전용입니다. 현재 등급: {memberGradeLabel(auth?.profile ?? null)} · 등급 변경은 관리자에게 문의해 주세요.
            </StateBox>
          </div>
        ) : (
          <>
            {/* 차트 영역 */}
            <section className="mt-3 overflow-hidden rounded-2xl border border-card-border bg-card">
              <div className="min-h-[360px] bg-background/30">
                {candleQuery.isLoading && candles.length < 2 ? (
                  <div className="flex h-[360px] items-center justify-center gap-2 text-sm font-bold text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin" /> 차트 불러오는 중...
                  </div>
                ) : candleQuery.isError && candles.length < 2 ? (
                  <div className="flex h-[360px] flex-col items-center justify-center px-6 text-center">
                    <ShieldAlert className="h-8 w-8 text-warning" />
                    <p className="mt-3 text-sm font-extrabold">차트 데이터를 불러오지 못했습니다.</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      원인: {candleQuery.error instanceof ApiError ? candleQuery.error.code : '네트워크 오류 또는 시간 초과'}
                    </p>
                    <button
                      type="button"
                      onClick={() => void candleQuery.refetch()}
                      disabled={candleQuery.isFetching}
                      className="mt-4 rounded-full bg-primary px-4 py-2 text-xs font-extrabold text-primary-foreground disabled:opacity-60"
                    >
                      {candleQuery.isFetching ? '다시 시도 중...' : '다시 시도'}
                    </button>
                  </div>
                ) : candles.length < 2 ? (
                  <div className="flex h-[360px] flex-col items-center justify-center px-6 text-center">
                    <p className="text-sm font-extrabold">현재 선택한 종목과 시간봉의 차트 데이터가 없습니다.</p>
                    <p className="mt-1 break-keep text-xs leading-relaxed text-muted-foreground">
                      다른 시간봉을 선택하거나 종목을 확인해 주세요.
                    </p>
                    <button
                      type="button"
                      onClick={() => void candleQuery.refetch()}
                      disabled={candleQuery.isFetching}
                      className="mt-4 rounded-full border border-card-border bg-card px-4 py-2 text-xs font-extrabold disabled:opacity-60"
                    >
                      {candleQuery.isFetching ? '새로고침 중...' : '새로고침'}
                    </button>
                  </div>
                ) : (
                  <RelayChart
                    candles={candles}
                    timeVisible={timeVisible}
                    settings={settings}
                    signals={signals}
                    activeSignalId={activeSignalId}
                    plan={plan}
                    position={portfolioPosition}
                    asset={asset}
                    interval={interval}
                    tab={tab}
                    sourceKey={sourceKey}
                    canLoadOlder={Boolean(historyCursor)}
                    isLoadingOlder={isLoadingOlder}
                    onLoadOlder={requestLoadOlder}
                    onSignalSelect={selectSignal}
                    onOpenSettings={() => openSettingsPanel('menu')}
                  />
                )}
              </div>
            </section>
            {historyError && (
              <p className="mt-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-center text-[10px] font-bold text-warning">
                과거 데이터 추가 조회 실패: {historyError}
              </p>
            )}

            <ChartAnalysisTabs
              sourceKey={sourceKey}
              planQuery={planQuery}
              plan={plan}
              asset={asset}
              settings={settings}
              aiHistory={aiHistory}
              signalsQuery={signalsQuery}
              signals={signals}
              activeSignalId={activeSignalId}
              onSignalSelect={selectSignal}
            />
            <p className="mt-3 rounded-2xl border border-warning/40 bg-warning/10 px-3 py-2 text-center text-[10px] font-black text-warning">
              AI 신호와 추천 가격은 참고용이며 실제 주문을 실행하지 않습니다.
            </p>
          </>
        )}
      </div>

      {modalSignal && (
        <SignalModal
          signal={modalSignal}
          asset={asset}
          interval={interval}
          onClose={() => setModalSignal(null)}
        />
      )}
      {settingsPanel && (
        <ChartSettingsModal
          panel={settingsPanel}
          settings={draftSettings}
          interval={draftInterval}
          patternOptions={availablePatternOptions}
          disabledPatternNames={draftDisabledPatternNames}
          onSettingsChange={setDraftSettings}
          onIntervalChange={setDraftInterval}
          onDisabledPatternsChange={setDraftDisabledPatternNames}
          onPanelChange={setSettingsPanel}
          onClose={() => setSettingsPanel(null)}
          onApply={() => {
            setSettings(draftSettings);
            setDisabledPatternNames(new Set(draftDisabledPatternNames));
            if (draftInterval !== interval) {
              setIntervalState(draftInterval);
              setActiveSignalId(null);
            }
            setSettingsPanel(null);
          }}
        />
      )}

      <BottomNav />
    </div>
  );
}

function ChartSettingsModal({
  panel,
  settings,
  interval,
  patternOptions,
  disabledPatternNames,
  onSettingsChange,
  onIntervalChange,
  onDisabledPatternsChange,
  onPanelChange,
  onClose,
  onApply,
}: {
  panel: ChartSettingsPanel;
  settings: ChartSettings;
  interval: string;
  patternOptions: PatternOption[];
  disabledPatternNames: Set<string>;
  onSettingsChange: (settings: ChartSettings) => void;
  onIntervalChange: (interval: string) => void;
  onDisabledPatternsChange: (patterns: Set<string>) => void;
  onPanelChange: (panel: ChartSettingsPanel) => void;
  onClose: () => void;
  onApply: () => void;
}) {
  const [signalSection, setSignalSection] = useState<'analysis' | PatternKind>('candle');
  const title =
    panel === 'menu'
      ? '차트 설정'
      : panel === 'candle'
        ? 'Candle Settings'
        : panel === 'indicator'
          ? '지표 설정'
          : '신호 설정';
  const toggleSetting = (key: keyof ChartSettings) => {
    onSettingsChange({ ...settings, [key]: !settings[key] });
  };
  const togglePattern = (name: string) => {
    const normalized = normalizeSignalName(name);
    const next = new Set(disabledPatternNames);
    if (next.has(normalized)) next.delete(normalized);
    else next.add(normalized);
    onDisabledPatternsChange(next);
  };
  const patternGroups: Array<{ kind: PatternKind; label: string; items: PatternOption[] }> = [
    {
      kind: 'candle',
      label: '캔들형 패턴',
      items: patternOptions.filter((option) => option.kind === 'candle'),
    },
    {
      kind: 'chart',
      label: '차트형 패턴',
      items: patternOptions.filter((option) => option.kind === 'chart'),
    },
  ];

  return (
    <div className="fixed inset-0 z-[95] flex items-end justify-center bg-black/60 p-3" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-card-border bg-background p-4"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            {panel !== 'menu' && (
              <button
                type="button"
                onClick={() => onPanelChange('menu')}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-card-border"
                aria-label="차트 설정 메뉴로 돌아가기"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <h3 className="truncate text-base font-black">{title}</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-full border border-card-border p-2" aria-label="닫기">
            <X className="h-4 w-4" />
          </button>
        </div>

        {panel === 'menu' && (
          <div className="mt-4">
            <p className="mb-3 text-[11px] font-bold text-muted-foreground">
              변경할 차트 항목을 선택하세요.
            </p>
            <div className="grid grid-cols-3 gap-2">
              {[
                {
                  key: 'candle' as const,
                  label: '캔들',
                  description: '봉 주기',
                },
                {
                  key: 'indicator' as const,
                  label: '지표',
                  description: '보조지표',
                },
                {
                  key: 'signal' as const,
                  label: '신호',
                  description: '패턴·분석',
                },
              ].map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => onPanelChange(item.key)}
                  className="rounded-2xl border border-card-border bg-card px-2 py-4 text-center"
                >
                  <span className="block text-sm font-black">{item.label}</span>
                  <span className="mt-1 block text-[9px] font-bold text-muted-foreground">
                    {item.description}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {panel === 'candle' && (
          <div className="mt-3 space-y-4">
            {CANDLE_INTERVAL_GROUPS.map((group) => (
              <div key={group.label}>
                <p className="mb-2 text-[11px] font-black text-muted-foreground">{group.label}</p>
                <div className="grid grid-cols-3 gap-2">
                  {group.items.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => onIntervalChange(item.key)}
                      className={cn(
                        'rounded-xl border px-2 py-2.5 text-[11px] font-black',
                        interval === item.key
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-card-border bg-card',
                      )}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <p className="rounded-xl bg-secondary px-3 py-2 text-[10px] font-bold text-muted-foreground">
              Select one timeframe. Closed-market and no-trade periods do not create artificial candles.
            </p>
          </div>
        )}

        {panel === 'indicator' && (
          <div className="mt-3">
            <p className="mb-2 text-[10px] font-bold text-muted-foreground">
              여러 지표를 동시에 선택할 수 있습니다. 하단 지표는 탭으로 표시됩니다.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {INDICATOR_SETTING_KEYS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => toggleSetting(item.key)}
                  className={cn(
                    'rounded-xl border px-3 py-2.5 text-left text-[11px] font-black',
                    settings[item.key]
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-card-border bg-card text-muted-foreground',
                  )}
                >
                  {settings[item.key] ? '✓ ' : '□ '}{item.label}
                </button>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => {
                  const next = { ...settings };
                  INDICATOR_SETTING_KEYS.forEach((item) => { next[item.key] = true; });
                  onSettingsChange(next);
                }}
                className="rounded-xl border border-card-border py-2 text-[10px] font-black"
              >
                전체 선택
              </button>
              <button
                type="button"
                onClick={() => {
                  const next = { ...settings };
                  INDICATOR_SETTING_KEYS.forEach((item) => { next[item.key] = false; });
                  onSettingsChange(next);
                }}
                className="rounded-xl border border-card-border py-2 text-[10px] font-black"
              >
                전체 해제
              </button>
              <button
                type="button"
                onClick={() => onSettingsChange({ ...settings, ...DEFAULT_SETTINGS })}
                className="rounded-xl border border-card-border py-2 text-[10px] font-black"
              >
                추천 설정
              </button>
            </div>
          </div>
        )}

        {panel === 'signal' && (
          <div className="mt-3 space-y-4">
            <div className="grid grid-cols-3 gap-2">
              {[
                { key: 'candle' as const, label: '캔들형 패턴' },
                { key: 'chart' as const, label: '차트형 패턴' },
                { key: 'analysis' as const, label: '분석 신호' },
              ].map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setSignalSection(item.key)}
                  className={cn(
                    'rounded-xl border px-2 py-3 text-[11px] font-black',
                    signalSection === item.key
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-card-border bg-card text-muted-foreground',
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {signalSection === 'analysis' && (
              <div className="rounded-2xl border border-card-border bg-card/40 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div>
                    <p className="text-[12px] font-black">분석 신호</p>
                    <p className="text-[9px] font-bold text-muted-foreground">
                      거래량·기술지표·AI·목표가·손절가·분할매수·분할매도
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        const next = { ...settings };
                        ANALYSIS_SIGNAL_SETTING_KEYS.forEach((item) => {
                          next[item.key] = true;
                        });
                        onSettingsChange(next);
                      }}
                      className="rounded-lg border border-card-border px-2 py-1 text-[9px] font-black"
                    >
                      전체 선택
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const next = { ...settings };
                        ANALYSIS_SIGNAL_SETTING_KEYS.forEach((item) => {
                          next[item.key] = false;
                        });
                        onSettingsChange(next);
                      }}
                      className="rounded-lg border border-card-border px-2 py-1 text-[9px] font-black"
                    >
                      전체 해제
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {ANALYSIS_SIGNAL_SETTING_KEYS.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => toggleSetting(item.key)}
                      className={cn(
                        'rounded-xl border px-3 py-2.5 text-left text-[11px] font-black',
                        settings[item.key]
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-card-border bg-card text-muted-foreground',
                      )}
                    >
                      {settings[item.key] ? '✓ ' : '□ '}{item.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {signalSection !== 'analysis' &&
              patternGroups
                .filter((group) => group.kind === signalSection)
                .map((group) => {
                  const groupSettingKey: keyof ChartSettings =
                    group.kind === 'candle' ? 'candlePattern' : 'chartPattern';
                  return (
                    <div key={group.kind} className="rounded-2xl border border-card-border bg-card/40 p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div>
                          <p className="text-[12px] font-black">{group.label}</p>
                          <p className="text-[9px] font-bold text-muted-foreground">
                            {group.kind === 'candle'
                              ? '한 개 또는 여러 캔들의 몸통·꼬리 관계'
                              : '여러 봉에 걸친 추세·지지·저항 구조'}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => toggleSetting(groupSettingKey)}
                          className={cn(
                            'shrink-0 rounded-lg border px-2 py-1 text-[9px] font-black',
                            settings[groupSettingKey]
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-card-border bg-card text-muted-foreground',
                          )}
                        >
                          {settings[groupSettingKey] ? '표시 중' : '표시 꺼짐'}
                        </button>
                      </div>
                      <div className="mb-2 flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            const groupNames = new Set(
                              group.items.map((item) => normalizeSignalName(item.name)),
                            );
                            onDisabledPatternsChange(
                              new Set(
                                [...disabledPatternNames].filter(
                                  (name) => !groupNames.has(name),
                                ),
                              ),
                            );
                            onSettingsChange({ ...settings, [groupSettingKey]: true });
                          }}
                          className="rounded-lg border border-card-border px-2 py-1 text-[9px] font-black"
                        >
                          전체 선택
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            onDisabledPatternsChange(
                              new Set([
                                ...disabledPatternNames,
                                ...group.items.map((item) =>
                                  normalizeSignalName(item.name),
                                ),
                              ]),
                            );
                            onSettingsChange({ ...settings, [groupSettingKey]: false });
                          }}
                          className="rounded-lg border border-card-border px-2 py-1 text-[9px] font-black"
                        >
                          전체 해제
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {group.items.map((item) => {
                          const selected = !disabledPatternNames.has(
                            normalizeSignalName(item.name),
                          );
                          return (
                            <button
                              key={`${group.kind}:${item.name}`}
                              type="button"
                              onClick={() => {
                                togglePattern(item.name);
                                if (!selected && !settings[groupSettingKey]) {
                                  onSettingsChange({
                                    ...settings,
                                    [groupSettingKey]: true,
                                  });
                                }
                              }}
                              className={cn(
                                'rounded-xl border px-3 py-2.5 text-left text-[11px] font-black',
                                selected
                                  ? 'border-primary bg-primary/10 text-primary'
                                  : 'border-card-border bg-card text-muted-foreground',
                              )}
                            >
                              {selected ? '✓ ' : '□ '}{item.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
          </div>
        )}

        {panel === 'menu' ? (
          <button
            type="button"
            onClick={onClose}
            className="mt-4 w-full rounded-xl border border-card-border py-3 text-xs font-black"
          >
            닫기
          </button>
        ) : (
          <div className="sticky bottom-0 mt-4 grid grid-cols-2 gap-2 border-t border-card-border bg-background pt-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-card-border py-3 text-xs font-black"
            >
              {panel === 'candle' ? 'Cancel' : '취소'}
            </button>
            <button
              type="button"
              onClick={onApply}
              className="rounded-xl bg-primary py-3 text-xs font-black text-primary-foreground"
            >
              {panel === 'candle' ? 'Apply' : '적용'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function LiveSignalsPanel({
  query,
  signals,
  activeSignalId,
  onSelect,
  enabled,
  embedded = false,
}: {
  query: ReturnType<typeof useQuery<AnyObj>>;
  signals: ChartSignal[];
  activeSignalId: string | null;
  onSelect: (signal: ChartSignal) => void;
  enabled: boolean;
  embedded?: boolean;
}) {
  const [importanceFilter, setImportanceFilter] = useState<'all' | SignalImportance>('all');
  const [kindFilter, setKindFilter] = useState<'all' | SignalKind>('all');
  const [sortMode, setSortMode] = useState<'latest' | 'importance'>('latest');
  const [historyGroupKey, setHistoryGroupKey] = useState<string | null>(null);
  const occurrences = useMemo(() => dedupeSignalOccurrences(signals), [signals]);
  const groups = useMemo(() => {
    const grouped = new Map<string, { key: string; latest: ChartSignal; history: ChartSignal[] }>();
    for (const signal of occurrences) {
      const key = `${signal.kind}:${normalizeSignalName(signal.name)}`;
      const group = grouped.get(key);
      if (!group) {
        grouped.set(key, { key, latest: signal, history: [signal] });
        continue;
      }
      group.history.push(signal);
      if (
        (toEpochMilliseconds(signal.occurredAt) ?? 0) >
        (toEpochMilliseconds(group.latest.occurredAt) ?? 0)
      ) {
        group.latest = signal;
      }
    }
    for (const group of grouped.values()) {
      group.history.sort(
        (left, right) =>
          (toEpochMilliseconds(right.occurredAt) ?? 0) -
          (toEpochMilliseconds(left.occurredAt) ?? 0),
      );
    }
    return [...grouped.values()];
  }, [occurrences]);
  const visibleGroups = useMemo(() => {
    const filtered = groups.filter(({ latest: signal }) => {
      if (importanceFilter !== 'all' && signalImportance(signal.importance) !== importanceFilter) return false;
      if (kindFilter !== 'all' && signal.kind !== kindFilter) return false;
      return true;
    });
    return [...filtered].sort((left, right) => {
      if (sortMode === 'importance') {
        const rank =
          importanceRank(right.latest.importance) -
          importanceRank(left.latest.importance);
        if (rank !== 0) return rank;
      }
      return (
        (toEpochMilliseconds(right.latest.occurredAt) ?? 0) -
        (toEpochMilliseconds(left.latest.occurredAt) ?? 0)
      );
    });
  }, [groups, importanceFilter, kindFilter, sortMode]);
  const historyGroup = groups.find((group) => group.key === historyGroupKey) ?? null;

  return (
    <>
      <section className={embedded ? '' : 'mt-3'}>
        <h2 className="text-sm font-extrabold">{embedded ? '지난 신호 내역' : '실시간 신호'}</h2>
        <p className="mt-0.5 text-[11px] font-bold text-muted-foreground">
          같은 신호는 최신 상태만 표시합니다. 항목을 누르면 지난 내역을 확인할 수 있습니다.
        </p>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <select
            value={importanceFilter}
            onChange={(event) => {
              const value = event.target.value;
              setImportanceFilter(
                value === 'high' || value === 'medium' || value === 'low' ? value : 'all',
              );
            }}
            aria-label="신호 중요도 필터"
            className="min-w-0 rounded-xl border border-card-border bg-card px-2 py-2 text-[10px] font-black"
          >
            <option value="all">중요도 전체</option>
            <option value="high">높음</option>
            <option value="medium">중간</option>
            <option value="low">낮음</option>
          </select>
          <select
            value={kindFilter}
            onChange={(event) => {
              const value = event.target.value;
              setKindFilter(
                value === 'chart' || value === 'candle' || value === 'volume' || value === 'indicator'
                  ? value
                  : 'all',
              );
            }}
            aria-label="신호 종류 필터"
            className="min-w-0 rounded-xl border border-card-border bg-card px-2 py-2 text-[10px] font-black"
          >
            <option value="all">종류 전체</option>
            <option value="chart">차트 패턴</option>
            <option value="candle">캔들 패턴</option>
            <option value="volume">거래량</option>
            <option value="indicator">기술지표</option>
          </select>
          <select
            value={sortMode}
            onChange={(event) => setSortMode(event.target.value === 'importance' ? 'importance' : 'latest')}
            aria-label="신호 정렬"
            className="min-w-0 rounded-xl border border-card-border bg-card px-2 py-2 text-[10px] font-black"
          >
            <option value="latest">최신순</option>
            <option value="importance">중요도순</option>
          </select>
        </div>
        <div className="mt-2 space-y-2">
          {!enabled ? (
            <StateBox>설정에서 실시간 신호가 꺼져 있습니다.</StateBox>
          ) : query.isLoading && occurrences.length === 0 ? (
            <StateBox>신호를 불러오는 중입니다.</StateBox>
          ) : query.isError && occurrences.length === 0 ? (
            <StateBox error>데이터를 불러오지 못했습니다.</StateBox>
          ) : occurrences.length === 0 ? (
            <StateBox>현재 활성화된 신호가 없습니다.</StateBox>
          ) : visibleGroups.length === 0 ? (
            <StateBox>선택한 필터에 맞는 신호가 없습니다.</StateBox>
          ) : (
            <div className="relative ml-2 border-l-2 border-card-border pl-4">
              {visibleGroups.map((group) => {
                const signal = group.latest;
                const importance = signalImportance(signal.importance);
                return (
                  <button
                    key={group.key}
                    type="button"
                    onClick={() => setHistoryGroupKey(group.key)}
                    className={cn(
                      'relative mb-2 flex w-full items-center justify-between gap-3 rounded-2xl border p-3 text-left last:mb-0',
                      activeSignalId === signal.id ? 'border-primary bg-primary/5' : 'border-card-border bg-card',
                    )}
                  >
                    <span
                      className={cn(
                        'absolute -left-[23px] top-4 h-3 w-3 rounded-full border-2 border-background',
                        importance === 'high'
                          ? 'bg-destructive'
                          : importance === 'medium'
                            ? 'bg-warning'
                            : 'bg-muted-foreground',
                      )}
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1">
                        <p className="truncate text-sm font-black">{signal.name}</p>
                        <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[9px] font-black text-muted-foreground">
                          {PATTERN_STAGE_META[signal.stage].label}
                        </span>
                        {group.history.length > 1 && (
                          <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-black text-primary">
                            내역 {group.history.length}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[10px] font-bold text-muted-foreground">
                        {signalKindLabel(signal.kind)}
                        {signal.occurredAt ? ` · ${formatTime(signal.occurredAt)}` : ''}
                      </p>
                      {signal.meaningHere && (
                        <p className="mt-1 line-clamp-2 text-[10px] font-bold leading-4 text-foreground">
                          {signal.meaningHere}
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 text-[10px] font-black text-muted-foreground">지난 내역</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>
      {historyGroup && (
        <SignalHistoryModal
          title={historyGroup.latest.name}
          signals={historyGroup.history}
          onClose={() => setHistoryGroupKey(null)}
          onSelect={(signal) => {
            setHistoryGroupKey(null);
            onSelect(signal);
          }}
        />
      )}
    </>
  );
}

function SignalHistoryModal({
  title,
  signals,
  onClose,
  onSelect,
}: {
  title: string;
  signals: ChartSignal[];
  onClose: () => void;
  onSelect: (signal: ChartSignal) => void;
}) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [page, setPage] = useState(1);
  const filtered = useMemo(() => {
    const startTime = start ? new Date(start).getTime() : Number.NEGATIVE_INFINITY;
    const endTime = end ? new Date(end).getTime() : Number.POSITIVE_INFINITY;
    return signals.filter((signal) => {
      const time = toEpochMilliseconds(signal.occurredAt) ?? 0;
      return time >= startTime && time <= endTime;
    });
  }, [end, signals, start]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 10));
  const currentPage = Math.min(page, pageCount);
  const rows = filtered.slice((currentPage - 1) * 10, currentPage * 10);
  const quickRange = (days: number | null) => {
    if (days == null) {
      setStart('');
      setEnd('');
    } else {
      const now = new Date();
      const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      const localValue = (value: Date) => {
        const offset = value.getTimezoneOffset() * 60_000;
        return new Date(value.getTime() - offset).toISOString().slice(0, 16);
      };
      setStart(localValue(from));
      setEnd(localValue(now));
    }
    setPage(1);
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/60 p-3" onClick={onClose}>
      <div
        className="max-h-[88vh] w-full max-w-md overflow-y-auto rounded-2xl border border-card-border bg-background p-4"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-black">{title}</h3>
            <p className="mt-0.5 text-[10px] font-bold text-muted-foreground">
              지난 내역 {signals.length}건 · 10개씩 표시
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full border border-card-border p-2" aria-label="닫기">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="text-[10px] font-black text-muted-foreground">
            시작 시간
            <input
              type="datetime-local"
              value={start}
              onChange={(event) => {
                setStart(event.target.value);
                setPage(1);
              }}
              className="mt-1 w-full rounded-xl border border-card-border bg-card px-2 py-2 text-[10px] text-foreground"
            />
          </label>
          <label className="text-[10px] font-black text-muted-foreground">
            종료 시간
            <input
              type="datetime-local"
              value={end}
              onChange={(event) => {
                setEnd(event.target.value);
                setPage(1);
              }}
              className="mt-1 w-full rounded-xl border border-card-border bg-card px-2 py-2 text-[10px] text-foreground"
            />
          </label>
        </div>
        <div className="mt-2 grid grid-cols-4 gap-1">
          {[
            { label: '오늘', days: 1 },
            { label: '7일', days: 7 },
            { label: '30일', days: 30 },
            { label: '전체', days: null },
          ].map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => quickRange(item.days)}
              className="rounded-lg border border-card-border bg-card py-1.5 text-[10px] font-black"
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="mt-3 space-y-2">
          {rows.length === 0 ? (
            <StateBox>선택한 시간에 해당하는 내역이 없습니다.</StateBox>
          ) : (
            rows.map((signal) => (
              <button
                key={signal.id}
                type="button"
                onClick={() => onSelect(signal)}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-card-border bg-card p-3 text-left"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-black">
                    {PATTERN_STAGE_META[signal.stage].label} · {formatTime(signal.occurredAt)}
                  </p>
                  <p className="mt-1 line-clamp-2 text-[10px] font-bold text-muted-foreground">
                    {signal.meaningHere || signal.meaningGeneral}
                  </p>
                </div>
                <span className="shrink-0 text-[10px] font-black text-primary">차트 보기</span>
              </button>
            ))
          )}
        </div>
        <div className="mt-3 grid grid-cols-3 items-center gap-2">
          <button
            type="button"
            disabled={currentPage <= 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
            className="rounded-xl border border-card-border py-2 text-[10px] font-black disabled:opacity-40"
          >
            이전
          </button>
          <p className="text-center text-[10px] font-black">{currentPage} / {pageCount}</p>
          <button
            type="button"
            disabled={currentPage >= pageCount}
            onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
            className="rounded-xl border border-card-border py-2 text-[10px] font-black disabled:opacity-40"
          >
            다음
          </button>
        </div>
      </div>
    </div>
  );
}

function ChartAnalysisTabs({
  sourceKey,
  planQuery,
  plan,
  asset,
  settings,
  aiHistory,
  signalsQuery,
  signals,
  activeSignalId,
  onSignalSelect,
}: {
  sourceKey: string;
  planQuery: ReturnType<typeof useQuery<AiPlan>>;
  plan: AiPlan | null;
  asset: Asset;
  settings: ChartSettings;
  aiHistory: AiPlanChange[];
  signalsQuery: ReturnType<typeof useQuery<AnyObj>>;
  signals: ChartSignal[];
  activeSignalId: string | null;
  onSignalSelect: (signal: ChartSignal) => void;
}) {
  const [activeTab, setActiveTab] = useState<AnalysisTab>('summary');

  useEffect(() => {
    setActiveTab('summary');
  }, [sourceKey]);

  const tabs: Array<{ key: AnalysisTab; label: string }> = [
    { key: 'summary', label: '종합 분석' },
    { key: 'buy', label: '매수 의견' },
    { key: 'sell', label: '매도 의견' },
    { key: 'signals', label: '지난 신호' },
  ];
  const loadingState = !settings.ai ? (
    <StateBox>설정에서 AI 분석이 꺼져 있습니다.</StateBox>
  ) : planQuery.isLoading && !plan ? (
    <StateBox>차트 표시 후 분석 내용을 계산하고 있습니다.</StateBox>
  ) : planQuery.isError && !plan ? (
    <StateBox error>분석 데이터를 불러오지 못했습니다.</StateBox>
  ) : !plan ? (
    <StateBox>현재 종목과 봉 주기에서 산출된 분석 내용이 없습니다.</StateBox>
  ) : null;

  const viewTone =
    plan?.view === '매수'
      ? 'border-destructive/40 bg-destructive/10 text-destructive'
      : plan?.view === '매도'
        ? 'border-blue-500/40 bg-blue-500/10 text-blue-500'
        : 'border-card-border bg-secondary text-muted-foreground';

  return (
    <section className="mt-3 overflow-hidden rounded-2xl border border-card-border bg-card">
      <div className="border-b border-card-border p-3">
        <h2 className="text-sm font-black">차트 분석 의견</h2>
        <p className="mt-0.5 text-[10px] font-bold text-muted-foreground">
          매수·매도 판단 근거와 지난 신호를 탭별로 확인합니다.
        </p>
        <div className="mt-3 grid grid-cols-4 gap-1.5">
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setActiveTab(item.key)}
              className={cn(
                'min-w-0 rounded-xl border px-1 py-2 text-[10px] font-black',
                activeTab === item.key
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-card-border bg-background text-muted-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-3">
        {activeTab === 'signals' ? (
          <LiveSignalsPanel
            query={signalsQuery}
            signals={signals}
            activeSignalId={activeSignalId}
            onSelect={onSignalSelect}
            enabled={settings.liveSignal}
            embedded
          />
        ) : loadingState ? (
          loadingState
        ) : plan ? (
          <div className="space-y-2">
            {activeTab === 'summary' && (
              <>
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-card-border bg-background p-3">
                  <div>
                    <p className="text-[10px] font-bold text-muted-foreground">현재 종합 관점</p>
                    <p className="mt-1 text-xs font-black">
                      {plan.view === '매수'
                        ? '상승 조건 우세 · 매수 관점'
                        : plan.view === '매도'
                          ? '하락 조건 우세 · 매도 관점'
                          : '방향 확인 중 · 중립 관점'}
                    </p>
                  </div>
                  <span className={cn('rounded-full border px-3 py-1 text-xs font-black', viewTone)}>
                    {plan.view}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <PlanCell label="목표가" value={formatPrice(plan.target, asset)} tone="target" />
                  <PlanCell label="손절가" value={formatPrice(plan.stop, asset)} tone="stop" />
                </div>
                <ListCard title="종합 분석 근거" items={plan.basis} empty="분석 근거가 없습니다." />
                <ListCard
                  title="위험·무효 조건"
                  items={[...plan.risks, ...plan.invalidation]}
                  empty="등록된 위험·무효 조건이 없습니다."
                />
                {aiHistory[0] && (
                  <p className="rounded-xl bg-secondary px-3 py-2 text-[10px] font-bold text-muted-foreground">
                    최근 관점 변경: {aiHistory[0].previousView} → {aiHistory[0].nextView} ·{' '}
                    {formatTime(aiHistory[0].changedAt)}
                  </p>
                )}
              </>
            )}

            {activeTab === 'buy' && (
              <>
                <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs font-black text-destructive">
                  {plan.view === '매수'
                    ? '현재 분석은 매수 조건이 상대적으로 우세합니다.'
                    : plan.view === '매도'
                      ? '현재는 매수보다 하락 위험 관리가 우선인 구간입니다.'
                      : '매수 방향이 확정되지 않아 확인 신호를 기다리는 구간입니다.'}
                </p>
                <div className="rounded-2xl border border-card-border bg-background p-3">
                  <p className="mb-2 text-[11px] font-black">분할매수 참고 구간</p>
                  <div className="grid grid-cols-3 gap-2">
                    {[0, 1, 2].map((index) => (
                      <PlanCell
                        key={index}
                        label={`${index + 1}차 매수`}
                        value={formatPrice(plan.buyLevels[index] ?? null, asset)}
                        tone="buy"
                      />
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <PlanCell label="상승 목표" value={formatPrice(plan.target, asset)} tone="target" />
                  <PlanCell label="매수 무효·손절" value={formatPrice(plan.stop, asset)} tone="stop" />
                </div>
                <ListCard title="매수 판단 근거" items={plan.basis} empty="매수 판단 근거가 없습니다." />
              </>
            )}

            {activeTab === 'sell' && (
              <>
                <p className="rounded-xl border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs font-black text-blue-500">
                  {plan.view === '매도'
                    ? '현재 분석은 매도 또는 비중 축소 조건이 상대적으로 우세합니다.'
                    : plan.view === '매수'
                      ? '현재 상승 관점이므로 매도는 목표 도달과 추세 이탈을 함께 확인합니다.'
                      : '매도 방향이 확정되지 않아 지지 이탈 여부를 확인하는 구간입니다.'}
                </p>
                <div className="rounded-2xl border border-card-border bg-background p-3">
                  <p className="mb-2 text-[11px] font-black">분할매도 참고 구간</p>
                  <div className="grid grid-cols-3 gap-2">
                    {[0, 1, 2].map((index) => (
                      <PlanCell
                        key={index}
                        label={`${index + 1}차 매도`}
                        value={formatPrice(plan.sellLevels[index] ?? null, asset)}
                        tone="sell"
                      />
                    ))}
                  </div>
                </div>
                <ListCard title="매도·무효 조건" items={plan.invalidation} empty="매도·무효 조건이 없습니다." />
                <ListCard title="위험 요인" items={plan.risks} empty="등록된 위험 요인이 없습니다." />
              </>
            )}

            {plan.dataAsOf && (
              <p className="text-center text-[10px] font-bold text-muted-foreground">
                분석 기준 {formatTime(plan.dataAsOf)}
              </p>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function AiPlanPanel({
  query,
  plan,
  asset,
  settings,
  history,
}: {
  query: ReturnType<typeof useQuery<AiPlan>>;
  plan: AiPlan | null;
  asset: Asset;
  settings: ChartSettings;
  history: AiPlanChange[];
}) {
  return (
    <section className="mt-3 space-y-2">
      <h2 className="text-sm font-extrabold">실시간 신호 분석</h2>
      <p className="rounded-2xl border border-warning/40 bg-warning/10 px-3 py-2 text-[10px] font-bold text-warning">
        표시 전용입니다. 실제 주문과 연결되지 않습니다.
      </p>
      {!settings.ai ? (
        <StateBox>설정에서 AI 분석이 꺼져 있습니다.</StateBox>
      ) : query.isLoading ? (
        <StateBox>AI 분석을 불러오는 중입니다.</StateBox>
      ) : query.isError ? (
        <StateBox error>데이터를 불러오지 못했습니다.</StateBox>
      ) : !plan ? (
        <StateBox>분석 가능한 데이터가 없습니다.</StateBox>
      ) : (
        <div className="space-y-2">
          <div className="rounded-2xl border border-card-border bg-card p-3 text-center">
            <p className="text-[11px] font-bold text-muted-foreground">현재 관점</p>
            <p
              className={cn(
                'mt-1 text-lg font-black',
                plan.view === '매수' ? 'text-destructive' : plan.view === '매도' ? 'text-blue-500' : 'text-muted-foreground',
              )}
            >
              {plan.view}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <PlanCell label="목표가" value={formatPrice(plan.target, asset)} tone="target" />
            <PlanCell label="손절가" value={formatPrice(plan.stop, asset)} tone="stop" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <PlanCell label="AI 위험도" value="산출 불가" />
            <PlanCell label="AI 신뢰도" value="산출 불가" />
          </div>
          <p className="text-center text-[10px] font-bold text-muted-foreground">
            현재 AI API가 위험도·신뢰도 수치를 제공하지 않아 임의 점수를 만들지 않습니다.
          </p>

          <div className="rounded-2xl border border-card-border bg-card p-3">
            <p className="mb-2 text-[11px] font-black text-destructive">분할매수 (매수 관점)</p>
            <div className="grid grid-cols-3 gap-2">
              {[0, 1, 2].map((idx) => (
                <PlanCell key={idx} label={`${idx + 1}차`} value={formatPrice(plan.buyLevels?.[idx] ?? null, asset)} tone="buy" />
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-card-border bg-card p-3">
            <p className="mb-2 text-[11px] font-black text-blue-500">분할매도 (매도 관점)</p>
            <div className="grid grid-cols-3 gap-2">
              {[0, 1, 2].map((idx) => (
                <PlanCell key={idx} label={`${idx + 1}차`} value={formatPrice(plan.sellLevels?.[idx] ?? null, asset)} tone="sell" />
              ))}
            </div>
          </div>

          <ListCard title="분석 근거" items={plan.basis} empty="분석 근거가 없습니다." />
          <ListCard title="계획 무효 조건" items={plan.invalidation} empty="무효 조건이 없습니다." />
          <ListCard title="위험 요인" items={plan.risks} empty="위험 요인이 없습니다." />

          {plan.dataAsOf && (
            <p className="text-center text-[10px] font-bold text-muted-foreground">기준 시각 {formatTime(plan.dataAsOf)}</p>
          )}

          <div className="rounded-2xl border border-card-border bg-card p-3">
            <p className="text-[11px] font-black text-muted-foreground">현재 화면의 AI 분석 변경 이력</p>
            {history.length === 0 ? (
              <p className="mt-1 text-xs font-bold text-muted-foreground">화면을 연 뒤 실제 변경된 계획이 없습니다.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {history.map((item) => (
                  <li key={item.id} className="rounded-xl border border-card-border bg-background p-2 text-[10px] font-bold leading-5">
                    <p className="font-black">
                      {item.previousView} → {item.nextView} · {formatTime(item.changedAt)}
                    </p>
                    {item.previousTarget !== item.nextTarget && (
                      <p>
                        목표가 {formatPrice(item.previousTarget, asset)} → {formatPrice(item.nextTarget, asset)}
                      </p>
                    )}
                    {item.previousStop !== item.nextStop && (
                      <p>
                        손절가 {formatPrice(item.previousStop, asset)} → {formatPrice(item.nextStop, asset)}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function SignalModal({
  signal,
  asset,
  interval,
  onClose,
}: {
  signal: ChartSignal;
  asset: Asset;
  interval: string;
  onClose: () => void;
}) {
  const intervalLabel = intervalsFor(asset).find((item) => item.key === interval)?.label ?? interval;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-3" onClick={onClose}>
      <div
        className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-2xl border border-card-border bg-card p-4"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-black">{signal.name}</h3>
            <p className="mt-0.5 text-[11px] font-bold text-muted-foreground">
              {signal.occurredAt ? formatTime(signal.occurredAt) : '시각 미상'} · {intervalLabel}봉
              {signal.price != null ? ` · ${formatPrice(signal.price, asset)}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-card-border bg-background"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <span className="rounded-full border border-card-border bg-background px-2.5 py-1 text-[10px] font-black">
            {signal.kind === 'candle'
              ? '캔들형 패턴'
              : signal.kind === 'chart'
                ? '차트형 패턴'
                : signal.kind === 'volume'
                  ? '거래량 신호'
                  : '기술지표 신호'}
          </span>
          <span
            className="rounded-full border px-2.5 py-1 text-[10px] font-black"
            style={{
              borderColor: PATTERN_STAGE_META[signal.stage].color,
              color: PATTERN_STAGE_META[signal.stage].color,
            }}
          >
            현재 단계 · {PATTERN_STAGE_META[signal.stage].label}
          </span>
        </div>

        <div className="mt-3 space-y-3">
          <ModalBlock title="예측 방향" text={signalPrediction(signal)} />
          <ModalBlock title="중요한 이유" text={signal.importance} />
          <ModalBlock title="일반적인 의미" text={signal.meaningGeneral} />
          <ModalBlock title="현재 차트에서의 의미" text={signal.meaningHere} />
          <ModalList title="추가 확인 조건" items={signal.confirmations} />
          <ModalList title="무효화 조건" items={signal.invalidation} />
          <ModalBlock title="위험 안내" text={signal.risk} />
        </div>

        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full rounded-2xl bg-primary py-2.5 text-sm font-extrabold text-primary-foreground"
        >
          닫기
        </button>
      </div>
    </div>
  );
}

function ChartLevelModal({
  level,
  currentPrice,
  asset,
  interval,
  onClose,
}: {
  level: ChartLevelInfo;
  currentPrice: number | null;
  asset: Asset;
  interval: string;
  onClose: () => void;
}) {
  const distance =
    currentPrice != null && currentPrice > 0
      ? ((level.price - currentPrice) / currentPrice) * 100
      : null;
  const intervalLabel =
    intervalsFor(asset).find((item) => item.key === interval)?.label ?? interval;

  return (
    <div className="fixed inset-0 z-[95] flex items-end justify-center bg-black/60 p-3" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-card-border bg-background p-4"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-black text-muted-foreground">{intervalLabel}봉 가격선 설명</p>
            <h3 className="mt-1 text-base font-black" style={{ color: level.color }}>
              {level.label} · {formatPrice(level.price, asset)}
            </h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-full border border-card-border p-2" aria-label="닫기">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-3 space-y-3">
          <ModalBlock title="의미" text={level.description} />
          <ModalBlock title="확인 방법" text={level.action} />
          <ModalBlock
            title="현재가 대비 거리"
            text={
              distance == null
                ? '현재가를 확인할 수 없습니다.'
                : `${distance >= 0 ? '+' : ''}${distance.toFixed(2)}%`
            }
          />
          <ModalBlock
            title="현재가"
            text={currentPrice == null ? '산출 불가' : formatPrice(currentPrice, asset)}
          />
          <ModalBlock
            title="주의"
            text="가격선은 실제 주문을 실행하지 않는 분석 참고선입니다. 다른 신호와 거래량을 함께 확인합니다."
          />
        </div>
        <button type="button" onClick={onClose} className="mt-4 w-full rounded-2xl bg-primary py-2.5 text-sm font-black text-primary-foreground">
          확인
        </button>
      </div>
    </div>
  );
}

function ModalBlock({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <p className="text-[11px] font-black text-muted-foreground">{title}</p>
      <p className="mt-1 break-keep text-xs font-bold leading-6 text-foreground">{text || '설명이 없습니다.'}</p>
    </div>
  );
}

function ModalList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="text-[11px] font-black text-muted-foreground">{title}</p>
      {items.length ? (
        <ul className="mt-1 space-y-1">
          {items.map((item, index) => (
            <li key={index} className="break-keep text-xs font-bold leading-6 text-foreground">
              · {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs font-bold text-muted-foreground">해당 없음</p>
      )}
    </div>
  );
}

function ListCard({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div className="rounded-2xl border border-card-border bg-card p-3">
      <p className="text-[11px] font-black text-muted-foreground">{title}</p>
      {items && items.length ? (
        <ul className="mt-1 space-y-1">
          {items.map((item, index) => (
            <li key={index} className="break-keep text-xs font-bold leading-6 text-foreground">
              · {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs font-bold text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}

function PlanCell({ label, value, tone }: { label: string; value: string; tone?: 'target' | 'stop' | 'buy' | 'sell' }) {
  const toneClass =
    tone === 'target'
      ? 'text-warning'
      : tone === 'stop'
        ? 'text-blue-500'
        : tone === 'buy'
          ? 'text-destructive'
          : tone === 'sell'
            ? 'text-blue-500'
            : 'text-foreground';
  return (
    <div className="rounded-2xl border border-card-border bg-background p-2.5 text-center">
      <p className="text-[10px] font-bold text-muted-foreground">{label}</p>
      <p className={cn('mt-1 text-xs font-black', value === '산출 불가' ? 'text-muted-foreground' : toneClass)}>{value}</p>
    </div>
  );
}

function StateBox({ children, error }: { children: ReactNode; error?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-2xl border p-4 text-center text-xs font-bold',
        error
          ? 'border-destructive/40 bg-destructive/10 text-destructive'
          : 'border-card-border bg-card text-muted-foreground',
      )}
    >
      {children}
    </div>
  );
}

function formatTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(parsed));
}

function formatCandleTime(value: UTCTimestamp): string {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(Number(value) * 1000));
}

function signalKindLabel(kind: SignalKind): string {
  if (kind === 'chart') return '차트 패턴';
  if (kind === 'candle') return '캔들 패턴';
  if (kind === 'volume') return '거래량 신호';
  return '기술지표';
}
