import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptChartWindowMessage,
  attachChartWindowLifecycleListeners,
  buildChartPath,
  buildExternalChartPath,
  chartExternalWindowChannel,
  chartPairIdFromSearch,
  chartSelectionFromSearch,
  chartSelectionKey,
  chartSyncIdFromSearch,
  chartWindowRouteModeFromSearch,
  chartWindowSelectionSnapshot,
  CHART_WINDOW_MESSAGE_MAX_AGE_MS,
  CHART_WINDOW_MESSAGE_MAX_FUTURE_SKEW_MS,
  compareChartSelectionOrder,
  createChartWindowMessage,
  externalChartWindowFeatures,
  hasChartRouteSelection,
  initialChartWindowPeerState,
  isChartWindowMessageFresh,
  isDesktopChartViewport,
  isExternalChartSearch,
  markChartWindowPeerClosed,
  mergeChartRouteSelection,
  nextChartWindowMessageClock,
  normalizeChartWindowSelection,
  parseChartWindowMessage,
  selectionOrderFromMessage,
  shouldApplyChartSelection,
  startChartPopupClosedPolling,
  type ChartExternalWindowMessage,
  type ChartWindowMessageBoundary,
  type ChartWindowMessageContext,
} from './chart-external-window';
import type { AnalysisSelection } from './analysis-selection';

const now = Date.UTC(2026, 7, 6, 7, 0, 0);
const origin = 'https://stocks.example.test';
const mainContext: ChartWindowMessageContext = {
  sessionId: 'session-a',
  pairId: 'pair-a',
  sourceId: 'main-a',
  sourceRole: 'main',
  origin,
};
const externalContext: ChartWindowMessageContext = {
  sessionId: 'session-a',
  pairId: 'pair-a',
  sourceId: 'external-a',
  sourceRole: 'external',
  origin,
};
const mainBoundary: ChartWindowMessageBoundary = {
  sessionId: 'session-a',
  pairId: 'pair-a',
  localSourceId: 'main-a',
  localRole: 'main',
  origin,
};
const externalBoundary: ChartWindowMessageBoundary = {
  sessionId: 'session-a',
  pairId: 'pair-a',
  localSourceId: 'external-a',
  localRole: 'external',
  origin,
};
const selection: AnalysisSelection = {
  assetType: 'coin_futures',
  market: 'BITGET',
  symbol: 'BTCUSDT',
  ticker: 'BTCUSDT',
  displayName: '비트코인 무기한 선물',
  timeframe: '15m',
  selectedAt: '2026-08-06T06:59:00.000Z',
};

function message(
  type: 'ready' | 'closed',
  context: ChartWindowMessageContext,
  sequence: number,
  sentAt?: number,
): ChartExternalWindowMessage;
function message(
  type: 'selection',
  context: ChartWindowMessageContext,
  sequence: number,
  sentAt: number,
  nextSelection: AnalysisSelection,
): ChartExternalWindowMessage;
function message(
  type: 'ready' | 'closed' | 'selection',
  context: ChartWindowMessageContext,
  sequence: number,
  sentAt = now,
  nextSelection?: AnalysisSelection,
): ChartExternalWindowMessage {
  return type === 'selection'
    ? createChartWindowMessage(type, context, { sequence, sentAt }, nextSelection ?? selection)
    : createChartWindowMessage(type, context, { sequence, sentAt });
}

test('external chart path preserves one validated atomic selection and isolated boundary', () => {
  const path = buildExternalChartPath(selection, 'session-a', 'pair-a');
  const query = path.slice(path.indexOf('?'));
  const params = new URLSearchParams(query);

  assert.equal(path.startsWith('/ai-chart?'), true);
  assert.equal(params.get('market'), 'BITGET');
  assert.equal(params.get('ticker'), 'BTCUSDT');
  assert.equal(params.get('timeframe'), '15m');
  assert.equal(params.get('chartWindow'), 'external');
  assert.equal(params.get('chartSync'), 'session-a');
  assert.equal(params.get('chartPair'), 'pair-a');
  assert.equal(isExternalChartSearch(query), true);
  assert.equal(chartWindowRouteModeFromSearch(query), 'external');
  assert.equal(chartWindowRouteModeFromSearch(''), 'main');
  assert.equal(chartWindowRouteModeFromSearch('?chartWindow=external&chartWindow=external'), 'invalid');
  assert.equal(chartWindowRouteModeFromSearch('?chartWindow=popup'), 'invalid');
  assert.equal(chartSyncIdFromSearch(query), 'session-a');
  assert.equal(chartPairIdFromSearch(query), 'pair-a');
  assert.equal(chartExternalWindowChannel('session-a', 'pair-a'), 'stock-app-ai-chart-window-v2:session-a:pair-a');
  assert.equal(buildChartPath(selection).includes('chartWindow=external'), false);
});

test('route parser rejects duplicates, unknown markets, unsupported frames, and unsafe identifiers', () => {
  const good = '?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m';
  assert.equal(hasChartRouteSelection(good), true);
  assert.equal(chartSelectionFromSearch(good, selection.selectedAt)?.ticker, '005930');
  assert.equal(chartSelectionFromSearch(`${good}&market=US`, selection.selectedAt), null);
  assert.equal(chartSelectionFromSearch(good.replace('market=KR', 'market=UNKNOWN'), selection.selectedAt), null);
  assert.equal(chartSelectionFromSearch(good.replace('timeframe=5m', 'timeframe=2m'), selection.selectedAt), null);
  assert.equal(chartSelectionFromSearch(good.replace('005930', '..%2Fetc%2Fpasswd'), selection.selectedAt), null);
  assert.equal(chartSelectionFromSearch(good.replace('005930', '%3Cscript%3E'), selection.selectedAt), null);
  assert.equal(chartSelectionFromSearch(good.replace('005930', ''), selection.selectedAt), null);
  assert.equal(chartSelectionFromSearch(good.replace('name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90', `name=${'A'.repeat(121)}`), selection.selectedAt), null);
  assert.equal(isExternalChartSearch('?chartWindow=external&chartWindow=external'), false);
  assert.equal(chartSyncIdFromSearch('?chartSync=session-a&chartSync=session-b'), '');
  assert.equal(chartPairIdFromSearch('?chartPair=pair%20a'), '');
});

test('strict selection validation enforces market, asset type, symbol, timeframe, and selectedAt', () => {
  assert.equal(normalizeChartWindowSelection(selection)?.ticker, selection.ticker);
  assert.equal(normalizeChartWindowSelection(selection)?.timeframe, selection.timeframe);
  assert.equal(normalizeChartWindowSelection({ ...selection, assetType: 'stock' }), null);
  assert.equal(normalizeChartWindowSelection({ ...selection, market: 'UNKNOWN' }), null);
  assert.equal(normalizeChartWindowSelection({ ...selection, ticker: 'BTC/USDT' }), null);
  assert.equal(normalizeChartWindowSelection({ ...selection, symbol: ' BTCUSDT' }), null);
  assert.equal(normalizeChartWindowSelection({ ...selection, timeframe: '2m' }), null);
  assert.equal(normalizeChartWindowSelection({ ...selection, selectedAt: 'not-a-date' }), null);
  assert.equal(normalizeChartWindowSelection({ ...selection, displayName: 'bad\u0000name' }), null);
  assert.equal(normalizeChartWindowSelection({ ...selection, displayName: '<script>alert(1)</script>' }), null);
  assert.equal(normalizeChartWindowSelection({ ...selection, ticker: '../BTCUSDT', symbol: '../BTCUSDT' }), null);
  assert.equal(normalizeChartWindowSelection({ ...selection, ticker: 'B'.repeat(33), symbol: 'B'.repeat(33) }), null);
  const snapshot = chartWindowSelectionSnapshot({ ...selection, searchRunId: 'scan-1', signalScore: 99 });
  assert.deepEqual(snapshot, selection);
});

test('route timeframe changes preserve evidence only for the same validated instrument', () => {
  const stored: AnalysisSelection = {
    ...selection,
    timeframe: '5m',
    searchRunId: 'scan-1',
    signalScore: 88,
    confidence: 82,
    matchedSignals: ['거래량 증가'],
  };
  const merged = mergeChartRouteSelection({ ...selection, timeframe: '30m' }, stored);
  assert.equal(merged?.timeframe, '30m');
  assert.equal(merged?.signalScore, 88);
  assert.equal(merged?.searchRunId, 'scan-1');
  assert.equal(mergeChartRouteSelection({ ...selection, ticker: 'ETHUSDT', symbol: 'ETHUSDT' }, stored)?.signalScore, undefined);
  assert.equal(chartSelectionKey(selection), 'coin_futures:BITGET:BTCUSDT:15m');
});

test('message clocks remain strictly increasing even within one millisecond', () => {
  const first = nextChartWindowMessageClock({ sequence: 0, sentAt: 0 }, now);
  const second = nextChartWindowMessageClock(first, now);
  assert.deepEqual(first, { sequence: 1, sentAt: now });
  assert.deepEqual(second, { sequence: 2, sentAt: now + 1 });
  assert.deepEqual(
    nextChartWindowMessageClock({ sequence: 2, sentAt: now + 500 }, now + 10),
    { sequence: 3, sentAt: now + 501 },
  );
});

test('normal messages pass only across the matching main/external boundary', () => {
  const externalReady = message('ready', externalContext, 1);
  const mainSelection = message('selection', mainContext, 2, now + 1, selection);
  assert.deepEqual(parseChartWindowMessage(externalReady, mainBoundary, now), externalReady);
  assert.deepEqual(parseChartWindowMessage(mainSelection, externalBoundary, now + 1), mainSelection);
  assert.equal(parseChartWindowMessage(externalReady, externalBoundary, now), null);
  assert.equal(parseChartWindowMessage(mainSelection, mainBoundary, now + 1), null);
});

test('message parser rejects stale, future, coerced, non-finite, malformed, wrong-session, and wrong-origin payloads', () => {
  const valid = message('selection', externalContext, 1, now, selection);
  const rows: unknown[] = [
    { ...valid, sentAt: now - CHART_WINDOW_MESSAGE_MAX_AGE_MS - 1 },
    { ...valid, sentAt: now + CHART_WINDOW_MESSAGE_MAX_FUTURE_SKEW_MS + 1 },
    { ...valid, sentAt: String(now) },
    { ...valid, sentAt: Number.NaN },
    { ...valid, sentAt: Number.POSITIVE_INFINITY },
    { ...valid, sequence: 0 },
    { ...valid, sequence: '1' },
    { ...valid, sessionId: '' },
    { ...valid, sessionId: 'session a' },
    { ...valid, pairId: 'different-pair' },
    { ...valid, sourceId: 'external:a' },
    { ...valid, type: 'order' },
    { ...valid, origin: 'https://evil.example.test' },
    { ...valid, origin: 'javascript:alert(1)' },
    { ...valid, selection: { ...selection, market: undefined } },
    { type: 'selection' },
    null,
  ];
  for (const row of rows) assert.equal(parseChartWindowMessage(row, mainBoundary, now), null);
  assert.equal(isChartWindowMessageFresh(now, now), true);
  assert.equal(isChartWindowMessageFresh(now - CHART_WINDOW_MESSAGE_MAX_AGE_MS - 1, now), false);
});

test('gate blocks previous market, instrument, timeframe, reverse sequence, closed peer, and replaced peer messages without state mutation', () => {
  const ready = acceptChartWindowMessage(message('ready', externalContext, 1), mainBoundary, initialChartWindowPeerState(), now);
  assert.ok(ready);
  const newestSelection = message('selection', externalContext, 4, now + 3, { ...selection, timeframe: '30m' });
  const accepted = acceptChartWindowMessage(newestSelection, mainBoundary, ready.state, now + 3);
  assert.ok(accepted);

  const blocked = [
    message('selection', externalContext, 2, now + 1, { ...selection, market: 'BITGET' }),
    message('selection', externalContext, 3, now + 2, { ...selection, ticker: 'ETHUSDT', symbol: 'ETHUSDT' }),
    message('selection', externalContext, 3, now + 2, { ...selection, timeframe: '5m' }),
  ];
  for (const candidate of blocked) {
    assert.equal(acceptChartWindowMessage(candidate, mainBoundary, accepted.state, now + 3), null);
  }

  const closed = acceptChartWindowMessage(message('closed', externalContext, 5, now + 4), mainBoundary, accepted.state, now + 4);
  assert.ok(closed?.state.closed);
  assert.equal(acceptChartWindowMessage(message('selection', externalContext, 6, now + 5, selection), mainBoundary, closed.state, now + 5), null);
  const reopenedSameSource = acceptChartWindowMessage(message('ready', externalContext, 6, now + 5), mainBoundary, closed.state, now + 5);
  assert.equal(reopenedSameSource?.state.closed, false);
  assert.deepEqual(markChartWindowPeerClosed(accepted.state), { ...accepted.state, closed: true });

  const replacement = { ...externalContext, sourceId: 'external-b' };
  const replacementReady = acceptChartWindowMessage(message('ready', replacement, 1, now + 6), mainBoundary, closed.state, now + 6);
  assert.equal(replacementReady?.state.peerSourceId, 'external-b');
  assert.equal(acceptChartWindowMessage(message('selection', externalContext, 99, now + 7, selection), mainBoundary, replacementReady!.state, now + 7), null);
  assert.equal(acceptChartWindowMessage(message('ready', externalContext, 100, now + 8), mainBoundary, replacementReady!.state, now + 8), null);
  assert.equal(acceptChartWindowMessage(message('selection', { ...externalContext, sourceId: 'external-c' }, 1, now + 9, selection), mainBoundary, replacementReady!.state, now + 9), null);
  assert.deepEqual(replacementReady!.state.retiredSourceIds, ['external-a']);
});

test('atomic snapshot conflict resolution converges for simultaneous main and external updates', () => {
  const mainUpdate = message('selection', mainContext, 10, now, { ...selection, timeframe: '5m' });
  const externalUpdate = message('selection', externalContext, 7, now, { ...selection, timeframe: '30m' });
  const mainOrder = selectionOrderFromMessage(mainUpdate)!;
  const externalOrder = selectionOrderFromMessage(externalUpdate)!;
  const winner = compareChartSelectionOrder(mainOrder, externalOrder) > 0 ? mainUpdate : externalUpdate;
  const loser = winner === mainUpdate ? externalUpdate : mainUpdate;
  assert.equal(shouldApplyChartSelection(winner, selectionOrderFromMessage(loser)), true);
  assert.equal(shouldApplyChartSelection(loser, selectionOrderFromMessage(winner)), false);
});

test('lifecycle listeners register once and cleanup is idempotent', () => {
  const active = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const target = {
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      const listeners = active.get(type) ?? new Set();
      listeners.add(listener);
      active.set(type, listeners);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      active.get(type)?.delete(listener);
    },
  };
  let unloaded = 0;
  let visible = 0;
  const cleanup = attachChartWindowLifecycleListeners({
    windowTarget: target,
    documentTarget: target,
    onBeforeUnload: () => { unloaded += 1; },
    onVisible: () => { visible += 1; },
  });
  assert.equal(active.get('beforeunload')?.size, 1);
  assert.equal(active.get('visibilitychange')?.size, 1);
  for (const listener of active.get('beforeunload') ?? []) {
    if (typeof listener === 'function') listener(new Event('beforeunload'));
  }
  for (const listener of active.get('visibilitychange') ?? []) {
    if (typeof listener === 'function') listener(new Event('visibilitychange'));
  }
  assert.equal(unloaded, 1);
  assert.equal(visible, 1);
  cleanup();
  cleanup();
  assert.equal(active.get('beforeunload')?.size, 0);
  assert.equal(active.get('visibilitychange')?.size, 0);
});

test('popup polling clears its timer on close and component cleanup', () => {
  let nextHandle = 0;
  const callbacks = new Map<number, () => void>();
  const cleared: number[] = [];
  const scheduler = {
    setInterval(handler: () => void) {
      nextHandle += 1;
      callbacks.set(nextHandle, handler);
      return nextHandle;
    },
    clearInterval(handle: number) {
      cleared.push(handle);
      callbacks.delete(handle);
    },
  };
  const popup = { closed: false };
  let closedCount = 0;
  const cleanup = startChartPopupClosedPolling({ popup, scheduler, onClosed: () => { closedCount += 1; } });
  callbacks.get(1)?.();
  assert.equal(closedCount, 0);
  popup.closed = true;
  callbacks.get(1)?.();
  assert.equal(closedCount, 1);
  assert.deepEqual(cleared, [1]);
  cleanup();
  assert.deepEqual(cleared, [1]);

  const cleanupUnmount = startChartPopupClosedPolling({ popup: { closed: false }, scheduler, onClosed: () => { closedCount += 1; } });
  cleanupUnmount();
  cleanupUnmount();
  assert.deepEqual(cleared, [1, 2]);
});

test('desktop/mobile boundary and multi-monitor popup geometry remain safe', () => {
  assert.equal(isDesktopChartViewport(1440, false), true);
  assert.equal(isDesktopChartViewport(1024, false), true);
  assert.equal(isDesktopChartViewport(1023, false), false);
  assert.equal(isDesktopChartViewport(430, false), false);
  assert.equal(isDesktopChartViewport(1440, true), false);

  const features = externalChartWindowFeatures({ availWidth: 1920, availHeight: 1080, availLeft: -1920, availTop: 0 });
  const values = Object.fromEntries(features.split(',').map((part) => part.split('=')));
  const width = Number(values.width);
  const left = Number(values.left);
  assert.ok(width <= 1920);
  assert.ok(left >= -1920);
  assert.ok(left + width <= 0);
  assert.equal(values.popup, 'yes');
  assert.equal(values.resizable, 'yes');
});
