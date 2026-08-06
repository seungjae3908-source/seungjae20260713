import {
  normalizeAnalysisSelection,
  selectionQuery,
  type AnalysisSelection,
} from './analysis-selection';

export const CHART_EXTERNAL_WINDOW_CHANNEL = 'stock-app-ai-chart-window-v1';
export const CHART_EXTERNAL_WINDOW_NAME = 'stock-app-ai-chart-external';
export const CHART_EXTERNAL_WINDOW_PARAM = 'chartWindow';
export const CHART_EXTERNAL_WINDOW_VALUE = 'external';
export const CHART_EXTERNAL_WINDOW_SYNC_PARAM = 'chartSync';
export const CHART_WINDOW_MESSAGE_MAX_AGE_MS = 30_000;
export const CHART_WINDOW_MESSAGE_MAX_FUTURE_SKEW_MS = 5_000;

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

function normalizeId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 120 || !/^[a-zA-Z0-9_-]+$/.test(trimmed)) return '';
  return trimmed;
}

export function mergeChartRouteSelection(
  routeSelection: AnalysisSelection | null,
  storedSelection: AnalysisSelection | null,
): AnalysisSelection | null {
  if (!routeSelection) return storedSelection;
  const sameInstrument = Boolean(
    storedSelection
    && storedSelection.assetType === routeSelection.assetType
    && storedSelection.market === routeSelection.market
    && storedSelection.ticker === routeSelection.ticker,
  );
  const previous = sameInstrument ? storedSelection : null;
  return normalizeAnalysisSelection({
    ...(previous ?? {}),
    assetType: routeSelection.assetType,
    market: routeSelection.market,
    symbol: routeSelection.symbol,
    ticker: routeSelection.ticker,
    displayName: routeSelection.displayName || previous?.displayName,
    timeframe: routeSelection.timeframe,
    searchRunId: routeSelection.searchRunId || previous?.searchRunId,
    selectedAt: previous?.selectedAt || routeSelection.selectedAt,
  });
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

export function chartSyncIdFromSearch(search: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return normalizeId(params.get(CHART_EXTERNAL_WINDOW_SYNC_PARAM));
}

export function chartExternalWindowChannel(syncId: string): string {
  const normalized = normalizeId(syncId);
  if (!normalized) throw new Error('Invalid chart synchronization session');
  return `${CHART_EXTERNAL_WINDOW_CHANNEL}:${normalized}`;
}

export function buildExternalChartPath(selection: AnalysisSelection, syncId: string): string {
  const normalizedSyncId = normalizeId(syncId);
  if (!normalizedSyncId) throw new Error('Invalid chart synchronization session');
  const params = new URLSearchParams(selectionQuery(selection));
  params.set(CHART_EXTERNAL_WINDOW_PARAM, CHART_EXTERNAL_WINDOW_VALUE);
  params.set(CHART_EXTERNAL_WINDOW_SYNC_PARAM, normalizedSyncId);
  return `/ai-chart?${params.toString()}`;
}

export function buildChartPath(selection: AnalysisSelection, externalSyncId?: string): string {
  return externalSyncId
    ? buildExternalChartPath(selection, externalSyncId)
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
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const values = crypto.getRandomValues(new Uint32Array(4));
    return `chart-window-${Array.from(values, (value) => value.toString(36)).join('-')}`;
  }
  return `chart-window-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function isChartWindowMessageFresh(sentAt: number, now = Date.now()): boolean {
  return Number.isSafeInteger(sentAt)
    && sentAt > 0
    && Number.isFinite(now)
    && sentAt >= now - CHART_WINDOW_MESSAGE_MAX_AGE_MS
    && sentAt <= now + CHART_WINDOW_MESSAGE_MAX_FUTURE_SKEW_MS;
}

export function shouldAcceptChartWindowMessage(
  message: ChartExternalWindowMessage,
  lastAcceptedSentAt: number,
  now = Date.now(),
): boolean {
  return isChartWindowMessageFresh(message.sentAt, now)
    && message.sentAt > Math.max(0, Number(lastAcceptedSentAt) || 0);
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
  const normalizedSourceId = normalizeId(sourceId);
  if (!normalizedSourceId) throw new Error('Invalid chart window source');
  if (type === 'selection') {
    const normalized = normalizeAnalysisSelection(selection);
    if (!normalized) throw new Error('Invalid chart selection message');
    return { type, sourceId: normalizedSourceId, sentAt: Date.now(), selection: normalized };
  }
  return { type, sourceId: normalizedSourceId, sentAt: Date.now() };
}

export function parseChartWindowMessage(
  value: unknown,
  now = Date.now(),
): ChartExternalWindowMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const type = row.type;
  if (type !== 'ready' && type !== 'closed' && type !== 'selection') return null;
  const sourceId = normalizeId(row.sourceId);
  const sentAt = Number(row.sentAt);
  if (!sourceId || !isChartWindowMessageFresh(sentAt, now)) return null;

  if (type === 'selection') {
    const selection = normalizeAnalysisSelection(row.selection);
    return selection ? { type, sourceId, sentAt, selection } : null;
  }
  return { type, sourceId, sentAt };
}
