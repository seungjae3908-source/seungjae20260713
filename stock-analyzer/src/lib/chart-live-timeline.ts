import {
  chartAnalysisTimelineKey,
  shouldAppendTimeline,
  type ChartAnalysis,
} from './chart-analysis';

export type ChartLiveTimelineEvent = {
  id: string;
  scope: string;
  analysis: ChartAnalysis;
  occurredAt: string;
  focusTime: number | null;
};

export function chartTimelineScope(analysis: Pick<ChartAnalysis, 'market' | 'symbol' | 'timeframe'>): string {
  return `${analysis.market}:${analysis.symbol}:${analysis.timeframe}`;
}

function safeOccurredAt(analysis: ChartAnalysis): string {
  const value =
    analysis.invalidatedAt ??
    analysis.expiredAt ??
    analysis.weakenedAt ??
    analysis.confirmedAt ??
    analysis.detectedAt;
  return Number.isFinite(Date.parse(value)) ? value : new Date(0).toISOString();
}

function eventId(analysis: ChartAnalysis, occurredAt: string): string {
  return `${chartAnalysisTimelineKey(analysis)}:${occurredAt}`;
}

export function appendChartTimeline(
  current: ChartLiveTimelineEvent[],
  analysis: ChartAnalysis,
  maximumEvents = 120,
): ChartLiveTimelineEvent[] {
  const scope = chartTimelineScope(analysis);
  const previous = current.find((event) => event.scope === scope)?.analysis ?? null;
  if (!shouldAppendTimeline(previous, analysis)) return current;

  const occurredAt = safeOccurredAt(analysis);
  const id = eventId(analysis, occurredAt);
  if (current.some((event) => event.id === id)) return current;

  const focusTime = analysis.points.find((point) => Number.isFinite(point.time))?.time ?? null;
  const next = [{ id, scope, analysis, occurredAt, focusTime }, ...current];
  return next.slice(0, Math.max(1, Math.trunc(maximumEvents)));
}

export function eventsForChartContext(
  events: ChartLiveTimelineEvent[],
  context: { market: string; symbol: string; timeframe: string },
  maximumEvents = 30,
): ChartLiveTimelineEvent[] {
  const scope = `${context.market}:${context.symbol}:${context.timeframe}`;
  return events.filter((event) => event.scope === scope).slice(0, Math.max(1, Math.trunc(maximumEvents)));
}
