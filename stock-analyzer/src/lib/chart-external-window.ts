import {
  normalizeAnalysisSelection,
  selectionQuery,
  type AnalysisSelection,
  type AnalysisAssetType,
  type AnalysisMarket,
} from './analysis-selection';
import {
  UNIFIED_CHART_TIMEFRAMES,
  type UnifiedChartTimeframe,
} from './unified-chart-data';

export const CHART_EXTERNAL_WINDOW_CHANNEL = 'stock-app-ai-chart-window-v2';
export const CHART_EXTERNAL_WINDOW_NAME = 'stock-app-ai-chart-external';
export const CHART_EXTERNAL_WINDOW_PARAM = 'chartWindow';
export const CHART_EXTERNAL_WINDOW_VALUE = 'external';
export const CHART_EXTERNAL_WINDOW_SYNC_PARAM = 'chartSync';
export const CHART_EXTERNAL_WINDOW_PAIR_PARAM = 'chartPair';
export const CHART_WINDOW_MESSAGE_VERSION = 2;
export const CHART_WINDOW_MESSAGE_MAX_AGE_MS = 30_000;
export const CHART_WINDOW_MESSAGE_MAX_FUTURE_SKEW_MS = 5_000;
export const CHART_WINDOW_SUPPORTED_TIMEFRAMES: readonly UnifiedChartTimeframe[] = UNIFIED_CHART_TIMEFRAMES.map((item) => item.key);

export type ChartWindowRole = 'main' | 'external';
export type ChartWindowMessageType = 'ready' | 'closed' | 'selection';
export type ChartWindowSupportedTimeframe = UnifiedChartTimeframe;

export type ChartWindowMessageContext = {
  sessionId: string;
  pairId: string;
  sourceId: string;
  sourceRole: ChartWindowRole;
  origin: string;
};

export type ChartWindowMessageClock = {
  sequence: number;
  sentAt: number;
};

type ChartWindowMessageBase = ChartWindowMessageContext & ChartWindowMessageClock & {
  version: typeof CHART_WINDOW_MESSAGE_VERSION;
};

export type ChartExternalWindowMessage =
  | (ChartWindowMessageBase & { type: 'ready' })
  | (ChartWindowMessageBase & { type: 'closed' })
  | (ChartWindowMessageBase & {
      type: 'selection';
      selection: AnalysisSelection;
    });

export type ChartWindowMessageBoundary = {
  sessionId: string;
  pairId: string;
  localSourceId: string;
  localRole: ChartWindowRole;
  origin: string;
};

export type ChartWindowPeerState = {
  peerSourceId: string | null;
  retiredSourceIds: string[];
  lastSequence: number;
  lastSentAt: number;
  closed: boolean;
};

export type ChartSelectionOrder = {
  sourceId: string;
  sequence: number;
  sentAt: number;
};

type ScreenBounds = {
  availWidth: number;
  availHeight: number;
  availLeft?: number;
  availTop?: number;
};

type LifecycleEventTarget = {
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
};

type PopupPollScheduler = {
  setInterval: (handler: () => void, timeout: number) => number;
  clearInterval: (handle: number) => void;
};

const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;
const SCRIPT_LIKE_TEXT = /[<>`]/;
const SUPPORTED_TIMEFRAME_SET = new Set<string>(CHART_WINDOW_SUPPORTED_TIMEFRAMES);
const ROUTE_SELECTION_PARAMS = [
  'assetType',
  'market',
  'symbol',
  'ticker',
  'name',
  'timeframe',
  'searchRunId',
] as const;

function normalizeId(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (!value || value.length > 120 || !/^[a-zA-Z0-9_-]+$/.test(value)) return '';
  return value;
}

function normalizeOrigin(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 240 || CONTROL_CHARACTER.test(value)) return '';
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return '';
    return url.origin === value ? value : '';
  } catch {
    return '';
  }
}

function singleParam(params: URLSearchParams, key: string): string | null {
  const values = params.getAll(key);
  return values.length === 1 ? values[0] : null;
}

function optionalSingleParam(params: URLSearchParams, key: string): string | null | undefined {
  const values = params.getAll(key);
  if (values.length > 1) return null;
  return values[0];
}

function exactText(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || CONTROL_CHARACTER.test(value)) return '';
  if (value !== value.trim()) return '';
  if (!allowEmpty && !value) return '';
  return value;
}

function expectedAssetType(market: AnalysisMarket): AnalysisAssetType {
  if (market === 'UPBIT') return 'coin_spot';
  if (market === 'BITGET') return 'coin_futures';
  return 'stock';
}

function validSymbol(market: AnalysisMarket, value: string): boolean {
  if (market === 'KR') return /^\d{6}$/.test(value);
  if (market === 'US') return /^[A-Z0-9^][A-Z0-9.^-]{0,29}$/.test(value);
  if (market === 'UPBIT') return /^(?:KRW-)?[A-Z0-9]{2,20}$/.test(value);
  return /^[A-Z0-9]{4,30}$/.test(value);
}

export function normalizeChartWindowSelection(value: unknown): AnalysisSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const market = row.market;
  if (market !== 'KR' && market !== 'US' && market !== 'UPBIT' && market !== 'BITGET') return null;
  const assetType = row.assetType;
  if (assetType !== expectedAssetType(market)) return null;
  const timeframe = exactText(row.timeframe, 12);
  if (!SUPPORTED_TIMEFRAME_SET.has(timeframe)) return null;
  const ticker = exactText(row.ticker, 32).toUpperCase();
  const symbol = exactText(row.symbol, 32).toUpperCase();
  if (!ticker || !symbol || !validSymbol(market, ticker) || !validSymbol(market, symbol)) return null;
  const displayName = exactText(row.displayName, 120);
  if (!displayName || SCRIPT_LIKE_TEXT.test(displayName)) return null;
  const selectedAt = exactText(row.selectedAt, 40);
  if (!selectedAt || !Number.isFinite(Date.parse(selectedAt))) return null;

  const normalized = normalizeAnalysisSelection({ ...row, market, assetType, timeframe, ticker, symbol, displayName, selectedAt });
  if (!normalized) return null;
  return normalized;
}

export function chartWindowSelectionSnapshot(value: unknown): AnalysisSelection | null {
  const normalized = normalizeChartWindowSelection(value);
  if (!normalized) return null;
  return {
    assetType: normalized.assetType,
    market: normalized.market,
    symbol: normalized.symbol,
    ticker: normalized.ticker,
    displayName: normalized.displayName,
    timeframe: normalized.timeframe,
    selectedAt: normalized.selectedAt,
  };
}

function chartWindowSelectionQuery(selection: AnalysisSelection): string {
  const snapshot = chartWindowSelectionSnapshot(selection);
  if (!snapshot) throw new Error('Invalid chart selection query');
  return new URLSearchParams({
    assetType: snapshot.assetType,
    market: snapshot.market,
    symbol: snapshot.symbol,
    ticker: snapshot.ticker,
    name: snapshot.displayName,
    timeframe: snapshot.timeframe,
  }).toString();
}

export function hasChartRouteSelection(search: string): boolean {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return ROUTE_SELECTION_PARAMS.some((key) => params.has(key));
}

export function chartSelectionFromSearch(search: string, selectedAt = new Date().toISOString()): AnalysisSelection | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const assetType = singleParam(params, 'assetType');
  const market = singleParam(params, 'market');
  const timeframe = singleParam(params, 'timeframe');
  const tickerParam = optionalSingleParam(params, 'ticker');
  const symbolParam = optionalSingleParam(params, 'symbol');
  const nameParam = optionalSingleParam(params, 'name');
  const searchRunId = optionalSingleParam(params, 'searchRunId');
  if (!assetType || !market || !timeframe || tickerParam === null || symbolParam === null || nameParam === null || searchRunId === null) return null;
  if ((params.has('ticker') && !tickerParam) || (params.has('symbol') && !symbolParam)) return null;
  const ticker = tickerParam || symbolParam;
  const symbol = symbolParam || tickerParam;
  if (!ticker || !symbol) return null;
  return normalizeChartWindowSelection({
    assetType,
    market,
    ticker,
    symbol,
    displayName: nameParam || ticker,
    timeframe,
    searchRunId: searchRunId || undefined,
    selectedAt,
  });
}

export function mergeChartRouteSelection(
  routeSelection: AnalysisSelection | null,
  storedSelection: AnalysisSelection | null,
): AnalysisSelection | null {
  const route = routeSelection ? normalizeChartWindowSelection(routeSelection) : null;
  const stored = storedSelection ? normalizeChartWindowSelection(storedSelection) : null;
  if (!route) return stored;
  const sameInstrument = Boolean(
    stored
    && stored.assetType === route.assetType
    && stored.market === route.market
    && stored.ticker === route.ticker,
  );
  const previous = sameInstrument ? stored : null;
  return normalizeChartWindowSelection({
    ...(previous ?? {}),
    assetType: route.assetType,
    market: route.market,
    symbol: route.symbol,
    ticker: route.ticker,
    displayName: route.displayName || previous?.displayName,
    timeframe: route.timeframe,
    searchRunId: route.searchRunId || previous?.searchRunId,
    selectedAt: previous?.selectedAt || route.selectedAt,
  });
}

export function chartSelectionKey(selection: AnalysisSelection): string {
  const normalized = normalizeChartWindowSelection(selection);
  if (!normalized) return '';
  return [normalized.assetType, normalized.market, normalized.ticker, normalized.timeframe].join(':');
}

export type ChartWindowRouteMode = 'main' | 'external' | 'invalid';

export function chartWindowRouteModeFromSearch(search: string): ChartWindowRouteMode {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (!params.has(CHART_EXTERNAL_WINDOW_PARAM)) return 'main';
  return singleParam(params, CHART_EXTERNAL_WINDOW_PARAM) === CHART_EXTERNAL_WINDOW_VALUE
    ? 'external'
    : 'invalid';
}

export function isExternalChartSearch(search: string): boolean {
  return chartWindowRouteModeFromSearch(search) === 'external';
}

export function chartSyncIdFromSearch(search: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return normalizeId(singleParam(params, CHART_EXTERNAL_WINDOW_SYNC_PARAM));
}

export function chartPairIdFromSearch(search: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return normalizeId(singleParam(params, CHART_EXTERNAL_WINDOW_PAIR_PARAM));
}

export function chartExternalWindowChannel(syncId: string, pairId: string): string {
  const normalizedSyncId = normalizeId(syncId);
  const normalizedPairId = normalizeId(pairId);
  if (!normalizedSyncId || !normalizedPairId) throw new Error('Invalid chart synchronization boundary');
  return `${CHART_EXTERNAL_WINDOW_CHANNEL}:${normalizedSyncId}:${normalizedPairId}`;
}

export function buildExternalChartPath(selection: AnalysisSelection, syncId: string, pairId: string): string {
  const normalized = normalizeChartWindowSelection(selection);
  const normalizedSyncId = normalizeId(syncId);
  const normalizedPairId = normalizeId(pairId);
  if (!normalized || !normalizedSyncId || !normalizedPairId) throw new Error('Invalid external chart route');
  const params = new URLSearchParams(chartWindowSelectionQuery(normalized));
  params.set(CHART_EXTERNAL_WINDOW_PARAM, CHART_EXTERNAL_WINDOW_VALUE);
  params.set(CHART_EXTERNAL_WINDOW_SYNC_PARAM, normalizedSyncId);
  params.set(CHART_EXTERNAL_WINDOW_PAIR_PARAM, normalizedPairId);
  return `/ai-chart?${params.toString()}`;
}

export function buildChartPath(selection: AnalysisSelection, externalBoundary?: { syncId: string; pairId: string }): string {
  const normalized = normalizeChartWindowSelection(selection);
  if (!normalized) throw new Error('Invalid chart route selection');
  return externalBoundary
    ? buildExternalChartPath(normalized, externalBoundary.syncId, externalBoundary.pairId)
    : `/ai-chart?${selectionQuery(normalized)}`;
}

export function isDesktopChartViewport(width: number, mobileUserAgent: boolean): boolean {
  return Number.isFinite(width) && width >= 1024 && !mobileUserAgent;
}

function finiteOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function externalChartWindowFeatures(screen: ScreenBounds): string {
  const availableWidth = Math.max(320, finiteOr(screen.availWidth, 1280));
  const availableHeight = Math.max(480, finiteOr(screen.availHeight, 800));
  const preferredWidth = Math.max(960, Math.floor(availableWidth * 0.86));
  const preferredHeight = Math.max(720, Math.floor(availableHeight * 0.9));
  const width = Math.min(1440, availableWidth, preferredWidth);
  const height = Math.min(1000, availableHeight, preferredHeight);
  const originLeft = finiteOr(screen.availLeft, 0);
  const originTop = finiteOr(screen.availTop, 0);
  const left = originLeft + Math.max(0, Math.floor((availableWidth - width) / 2));
  const top = originTop + Math.max(0, Math.floor((availableHeight - height) / 2));

  return [
    'popup=yes',
    'resizable=yes',
    'scrollbars=yes',
    `width=${Math.floor(width)}`,
    `height=${Math.floor(height)}`,
    `left=${Math.floor(left)}`,
    `top=${Math.floor(top)}`,
  ].join(',');
}

export function createChartWindowSourceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const values = crypto.getRandomValues(new Uint32Array(4));
    return `chart-window-${Array.from(values, (value) => value.toString(36)).join('-')}`;
  }
  return `chart-window-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function nextChartWindowMessageClock(
  previous: ChartWindowMessageClock,
  now = Date.now(),
): ChartWindowMessageClock {
  const safeNow = Number.isSafeInteger(now) && now > 0 ? now : Date.now();
  return {
    sequence: Math.max(0, Number.isSafeInteger(previous.sequence) ? previous.sequence : 0) + 1,
    sentAt: Math.max(safeNow, Math.max(0, Number.isSafeInteger(previous.sentAt) ? previous.sentAt : 0) + 1),
  };
}

export function isChartWindowMessageFresh(sentAt: number, now = Date.now()): boolean {
  return Number.isSafeInteger(sentAt)
    && sentAt > 0
    && Number.isFinite(now)
    && sentAt >= now - CHART_WINDOW_MESSAGE_MAX_AGE_MS
    && sentAt <= now + CHART_WINDOW_MESSAGE_MAX_FUTURE_SKEW_MS;
}

function validMessageContext(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Boolean(
    normalizeId(row.sessionId)
    && normalizeId(row.pairId)
    && normalizeId(row.sourceId)
    && (row.sourceRole === 'main' || row.sourceRole === 'external')
    && normalizeOrigin(row.origin),
  );
}

export function createChartWindowMessage(
  type: 'ready' | 'closed',
  context: ChartWindowMessageContext,
  clock: ChartWindowMessageClock,
): ChartExternalWindowMessage;
export function createChartWindowMessage(
  type: 'selection',
  context: ChartWindowMessageContext,
  clock: ChartWindowMessageClock,
  selection: AnalysisSelection,
): ChartExternalWindowMessage;
export function createChartWindowMessage(
  type: ChartWindowMessageType,
  context: ChartWindowMessageContext,
  clock: ChartWindowMessageClock,
  selection?: AnalysisSelection,
): ChartExternalWindowMessage {
  if (!validMessageContext(context)) throw new Error('Invalid chart window message context');
  if (!Number.isSafeInteger(clock.sequence) || clock.sequence <= 0 || !Number.isSafeInteger(clock.sentAt) || clock.sentAt <= 0) {
    throw new Error('Invalid chart window message clock');
  }
  const base: ChartWindowMessageBase = {
    version: CHART_WINDOW_MESSAGE_VERSION,
    sessionId: context.sessionId,
    pairId: context.pairId,
    sourceId: context.sourceId,
    sourceRole: context.sourceRole,
    origin: context.origin,
    sequence: clock.sequence,
    sentAt: clock.sentAt,
  };
  if (type === 'selection') {
    const snapshot = chartWindowSelectionSnapshot(selection);
    if (!snapshot) throw new Error('Invalid chart selection message');
    return { ...base, type, selection: snapshot };
  }
  return { ...base, type };
}

export function parseChartWindowMessage(
  value: unknown,
  boundary?: ChartWindowMessageBoundary,
  now = Date.now(),
): ChartExternalWindowMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.version !== CHART_WINDOW_MESSAGE_VERSION) return null;
  if (row.type !== 'ready' && row.type !== 'closed' && row.type !== 'selection') return null;
  if (!validMessageContext(row)) return null;
  if (typeof row.sequence !== 'number' || !Number.isSafeInteger(row.sequence) || row.sequence <= 0) return null;
  if (typeof row.sentAt !== 'number' || !isChartWindowMessageFresh(row.sentAt, now)) return null;

  const parsedBase: ChartWindowMessageBase = {
    version: CHART_WINDOW_MESSAGE_VERSION,
    sessionId: row.sessionId as string,
    pairId: row.pairId as string,
    sourceId: row.sourceId as string,
    sourceRole: row.sourceRole as ChartWindowRole,
    origin: row.origin as string,
    sequence: row.sequence,
    sentAt: row.sentAt,
  };
  if (boundary) {
    const boundaryOrigin = normalizeOrigin(boundary.origin);
    if (!boundaryOrigin
      || parsedBase.sessionId !== normalizeId(boundary.sessionId)
      || parsedBase.pairId !== normalizeId(boundary.pairId)
      || parsedBase.origin !== boundaryOrigin
      || parsedBase.sourceId === normalizeId(boundary.localSourceId)
      || parsedBase.sourceRole === boundary.localRole) return null;
  }

  if (row.type === 'selection') {
    const selection = chartWindowSelectionSnapshot(row.selection);
    return selection ? { ...parsedBase, type: 'selection', selection } : null;
  }
  return { ...parsedBase, type: row.type };
}

export function initialChartWindowPeerState(): ChartWindowPeerState {
  return { peerSourceId: null, retiredSourceIds: [], lastSequence: 0, lastSentAt: 0, closed: false };
}

export function acceptChartWindowMessage(
  value: unknown,
  boundary: ChartWindowMessageBoundary,
  state: ChartWindowPeerState,
  now = Date.now(),
): { message: ChartExternalWindowMessage; state: ChartWindowPeerState } | null {
  const message = parseChartWindowMessage(value, boundary, now);
  if (!message) return null;
  const sameSource = state.peerSourceId === message.sourceId;
  if (state.retiredSourceIds.includes(message.sourceId)) return null;

  if (!state.peerSourceId) {
    if (message.type === 'closed') return null;
    return {
      message,
      state: {
        peerSourceId: message.sourceId,
        retiredSourceIds: state.retiredSourceIds,
        lastSequence: message.sequence,
        lastSentAt: message.sentAt,
        closed: false,
      },
    };
  }

  if (!sameSource) {
    if (message.type !== 'ready' || message.sentAt <= state.lastSentAt) return null;
    return {
      message,
      state: {
        peerSourceId: message.sourceId,
        retiredSourceIds: [
          ...state.retiredSourceIds,
          state.peerSourceId,
        ].filter((sourceId, index, rows): sourceId is string => Boolean(sourceId) && rows.indexOf(sourceId) === index).slice(-16),
        lastSequence: message.sequence,
        lastSentAt: message.sentAt,
        closed: false,
      },
    };
  }

  if (message.sequence <= state.lastSequence || message.sentAt < state.lastSentAt) return null;
  if (state.closed && message.type !== 'ready') return null;
  return {
    message,
    state: {
      peerSourceId: message.sourceId,
      retiredSourceIds: state.retiredSourceIds,
      lastSequence: message.sequence,
      lastSentAt: message.sentAt,
      closed: message.type === 'closed',
    },
  };
}

export function markChartWindowPeerClosed(state: ChartWindowPeerState): ChartWindowPeerState {
  return { ...state, closed: true };
}

export function selectionOrderFromMessage(message: ChartExternalWindowMessage): ChartSelectionOrder | null {
  if (message.type !== 'selection') return null;
  return { sourceId: message.sourceId, sequence: message.sequence, sentAt: message.sentAt };
}

export function compareChartSelectionOrder(left: ChartSelectionOrder, right: ChartSelectionOrder): number {
  if (left.sentAt !== right.sentAt) return left.sentAt - right.sentAt;
  const source = left.sourceId.localeCompare(right.sourceId);
  if (source !== 0) return source;
  return left.sequence - right.sequence;
}

export function shouldApplyChartSelection(
  message: ChartExternalWindowMessage,
  current: ChartSelectionOrder | null,
): boolean {
  const incoming = selectionOrderFromMessage(message);
  return Boolean(incoming && (!current || compareChartSelectionOrder(incoming, current) > 0));
}

export function attachChartWindowLifecycleListeners(input: {
  windowTarget: LifecycleEventTarget;
  documentTarget: LifecycleEventTarget;
  onBeforeUnload: () => void;
  onVisible: () => void;
}): () => void {
  let active = true;
  const beforeUnload: EventListener = () => input.onBeforeUnload();
  const visibilityChange: EventListener = () => input.onVisible();
  input.windowTarget.addEventListener('beforeunload', beforeUnload);
  input.documentTarget.addEventListener('visibilitychange', visibilityChange);
  return () => {
    if (!active) return;
    active = false;
    input.windowTarget.removeEventListener('beforeunload', beforeUnload);
    input.documentTarget.removeEventListener('visibilitychange', visibilityChange);
  };
}

export function startChartPopupClosedPolling(input: {
  popup: { closed: boolean };
  scheduler: PopupPollScheduler;
  onClosed: () => void;
  intervalMs?: number;
}): () => void {
  let active = true;
  const handle = input.scheduler.setInterval(() => {
    if (!active || !input.popup.closed) return;
    active = false;
    input.scheduler.clearInterval(handle);
    input.onClosed();
  }, Math.max(250, input.intervalMs ?? 1_000));
  return () => {
    if (!active) return;
    active = false;
    input.scheduler.clearInterval(handle);
  };
}
