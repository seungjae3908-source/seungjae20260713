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
