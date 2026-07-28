export const CHART_TIMEFRAMES = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1H',
  '4H',
  '8H',
  '12H',
  '1D',
  '3D',
  '5D',
  '15D',
  '1M',
  '3M',
  '6M',
  '1Y',
] as const;

export type VisibleChartTimeframe =
  (typeof CHART_TIMEFRAMES)[number];

export const REALTIME_CHART_TIMEFRAMES = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1H',
  '4H',
  '12H',
  '1D',
  '3D',
  '5D',
  '15D',
  '1W',
  '1M',
  '3M',
  '6M',
  '1Y',
  '3Y',
  '5Y',
  '10Y',
  'ALL',
] as const;

export type RealtimeChartTimeframe =
  (typeof REALTIME_CHART_TIMEFRAMES)[number];

const TIMEFRAME_ALIASES: Record<string, RealtimeChartTimeframe> = {
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '60m': '1H',
  '1h': '1H',
  '4h': '4H',
  '12h': '12H',
  '1d': '1D',
  day: '1D',
  '3d': '3D',
  '5d': '5D',
  '15d': '15D',
  '1w': '1W',
  week: '1W',
  '1mo': '1M',
  '1month': '1M',
  month: '1M',
  '3mo': '3M',
  '3month': '3M',
  '6mo': '6M',
  '6month': '6M',
  '1y': '1Y',
  year: '1Y',
  '3y': '3Y',
  '5y': '5Y',
  '10y': '10Y',
  all: 'ALL',
};

export function normalizeRealtimeTimeframe(
  value: unknown,
): RealtimeChartTimeframe | null {
  const key = String(value ?? '').trim().toLowerCase();
  return TIMEFRAME_ALIASES[key] ?? null;
}

export function toUpbitTimeframe(
  timeframe: RealtimeChartTimeframe,
): { unit?: number; tf?: RealtimeChartTimeframe } | null {
  if (!['1m', '3m', '5m', '15m', '30m', '1H', '4H'].includes(timeframe)) {
    return { tf: timeframe };
  }
  const units: Partial<Record<RealtimeChartTimeframe, number>> = {
    '1m': 1,
    '3m': 3,
    '5m': 5,
    '15m': 15,
    '30m': 30,
    '1H': 60,
    '4H': 240,
  };
  const unit = units[timeframe];
  return unit ? { unit } : null;
}

export function realtimeTimeframeLabel(
  timeframe: RealtimeChartTimeframe,
): string {
  const labels: Record<RealtimeChartTimeframe, string> = {
    '1m': '1분',
    '3m': '3분',
    '5m': '5분',
    '15m': '15분',
    '30m': '30분',
    '1H': '1시간',
    '4H': '4시간',
    '12H': '12시간',
    '1D': '1일',
    '3D': '3일',
    '5D': '5일',
    '15D': '15일',
    '1W': '1주',
    '1M': '1개월',
    '3M': '3개월',
    '6M': '6개월',
    '1Y': '1년',
    '3Y': '3년',
    '5Y': '5년',
    '10Y': '10년',
    'ALL': '전체',
  };
  return labels[timeframe];
}

const STORAGE_KEY = 'visible-chart-timeframes-v1';

export function loadVisibleChartTimeframes(): VisibleChartTimeframe[] {
  if (typeof window === 'undefined') {
    return [...CHART_TIMEFRAMES];
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);

    if (!raw) {
      return [...CHART_TIMEFRAMES];
    }

    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [...CHART_TIMEFRAMES];
    }

    const allowed = new Set<string>(CHART_TIMEFRAMES);

    const valid = parsed.filter(
      (item): item is VisibleChartTimeframe =>
        typeof item === 'string' && allowed.has(item),
    );

    return valid.length > 0 ? valid : [...CHART_TIMEFRAMES];
  } catch {
    return [...CHART_TIMEFRAMES];
  }
}

export function saveVisibleChartTimeframes(
  timeframes: readonly string[],
): VisibleChartTimeframe[] {
  const allowed = new Set<string>(CHART_TIMEFRAMES);

  const valid = timeframes.filter(
    (item): item is VisibleChartTimeframe =>
      typeof item === 'string' && allowed.has(item),
  );

  const saved =
    valid.length > 0 ? valid : [...CHART_TIMEFRAMES];

  if (typeof window !== 'undefined') {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(saved),
    );
  }

  return saved;
}
