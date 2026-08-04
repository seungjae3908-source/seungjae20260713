import {
  normalizeAnalysisSelection,
  selectionQuery,
  type AnalysisSelection,
} from './analysis-selection';

export const CHART_EXTERNAL_WINDOW_CHANNEL = 'stock-app-ai-chart-window-v1';
export const CHART_EXTERNAL_WINDOW_NAME = 'stock-app-ai-chart-external';
export const CHART_EXTERNAL_WINDOW_PARAM = 'chartWindow';
export const CHART_EXTERNAL_WINDOW_VALUE = 'external';

export type ChartExternalWindowMessage =
  | {
      type: 'ready';
      sourceId: string;
      sentAt: number;
    }
  | {
      type: 'closed';
      sourceId: string;
      sentAt: number;
    }
  | {
      type: 'selection';
      sourceId: string;
      sentAt: number;
      selection: AnalysisSelection;
    };

type ScreenBounds = {
  availWidth: number;
  availHeight: number;
  availLeft?: number;
  availTop?: number;
};

function cleanSourceId(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 120) : '';
}

export function chartSelectionKey(selection: AnalysisSelection): string {
  return [
    selection.assetType,
    selection.market,
    selection.ticker,
    selection.timeframe,
  ].join(':');
}

export function isExternalChartSearch(search: string): boolean {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return params.get(CHART_EXTERNAL_WINDOW_PARAM) === CHART_EXTERNAL_WINDOW_VALUE;
}

export function buildExternalChartPath(selection: AnalysisSelection): string {
  const params = new URLSearchParams(selectionQuery(selection));
  params.set(CHART_EXTERNAL_WINDOW_PARAM, CHART_EXTERNAL_WINDOW_VALUE);
  return `/ai-chart?${params.toString()}`;
}

export function buildChartPath(selection: AnalysisSelection, external: boolean): string {
  return external
    ? buildExternalChartPath(selection)
    : `/ai-chart?${selectionQuery(selection)}`;
}

export function isDesktopChartViewport(width: number, mobileUserAgent: boolean): boolean {
  return Number.isFinite(width) && width >= 1024 && !mobileUserAgent;
}

export function externalChartWindowFeatures(screen: ScreenBounds): string {
  const availableWidth = Math.max(320, Number(screen.availWidth) || 1280);
  const availableHeight = Math.max(480, Number(screen.availHeight) || 800);
  const preferredWidth = Math.max(960, Math.floor(availableWidth * 0.86));
  const preferredHeight = Math.max(720, Math.floor(availableHeight * 0.9));
  const width = Math.min(1440, availableWidth, preferredWidth);
  const height = Math.min(1000, availableHeight, preferredHeight);
  const originLeft = Number(screen.availLeft) || 0;
  const originTop = Number(screen.availTop) || 0;
  const left = originLeft + Math.max(0, Math.floor((availableWidth - width) / 2));
  const top = originTop + Math.max(0, Math.floor((availableHeight - height) / 2));

  return [
    'popup=yes',
    'resizable=yes',
    'scrollbars=yes',
    `width=${width}`,
    `height=${height}`,
    `left=${left}`,
    `top=${top}`,
  ].join(',');
}

export function createChartWindowSourceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `chart-window-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createChartWindowMessage(
  type: 'ready' | 'closed',
  sourceId: string,
): ChartExternalWindowMessage;
export function createChartWindowMessage(
  type: 'selection',
  sourceId: string,
  selection: AnalysisSelection,
): ChartExternalWindowMessage;
export function createChartWindowMessage(
  type: ChartExternalWindowMessage['type'],
  sourceId: string,
  selection?: AnalysisSelection,
): ChartExternalWindowMessage {
  if (type === 'selection') {
    const normalized = normalizeAnalysisSelection(selection);
    if (!normalized) throw new Error('Invalid chart selection message');
    return { type, sourceId, sentAt: Date.now(), selection: normalized };
  }
  return { type, sourceId, sentAt: Date.now() };
}

export function parseChartWindowMessage(value: unknown): ChartExternalWindowMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const type = row.type;
  if (type !== 'ready' && type !== 'closed' && type !== 'selection') return null;
  const sourceId = cleanSourceId(row.sourceId);
  const sentAt = Number(row.sentAt);
  if (!sourceId || !Number.isFinite(sentAt) || sentAt <= 0) return null;

  if (type === 'selection') {
    const selection = normalizeAnalysisSelection(row.selection);
    return selection ? { type, sourceId, sentAt, selection } : null;
  }
  return { type, sourceId, sentAt };
}
