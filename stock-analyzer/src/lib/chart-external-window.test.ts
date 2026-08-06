import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildChartPath,
  buildExternalChartPath,
  chartExternalWindowChannel,
  chartSelectionKey,
  chartSyncIdFromSearch,
  CHART_WINDOW_MESSAGE_MAX_AGE_MS,
  CHART_WINDOW_MESSAGE_MAX_FUTURE_SKEW_MS,
  createChartWindowMessage,
  externalChartWindowFeatures,
  isChartWindowMessageFresh,
  isDesktopChartViewport,
  isExternalChartSearch,
  mergeChartRouteSelection,
  parseChartWindowMessage,
  shouldAcceptChartWindowMessage,
} from './chart-external-window';
import type { AnalysisSelection } from './analysis-selection';

const selection: AnalysisSelection = {
  assetType: 'coin_futures',
  market: 'BITGET',
  symbol: 'BTCUSDT',
  ticker: 'BTCUSDT',
  displayName: '비트코인 무기한 선물',
  timeframe: '15m',
  selectedAt: '2026-08-05T00:00:00.000Z',
};

test('external chart path preserves the validated chart context and isolated sync id', () => {
  const path = buildExternalChartPath(selection, 'sync-a');
  const query = path.slice(path.indexOf('?'));
  const params = new URLSearchParams(query);

  assert.equal(path.startsWith('/ai-chart?'), true);
  assert.equal(params.get('market'), 'BITGET');
  assert.equal(params.get('ticker'), 'BTCUSDT');
  assert.equal(params.get('timeframe'), '15m');
  assert.equal(params.get('chartWindow'), 'external');
  assert.equal(params.get('chartSync'), 'sync-a');
  assert.equal(isExternalChartSearch(query), true);
  assert.equal(chartSyncIdFromSearch(query), 'sync-a');
  assert.equal(chartSyncIdFromSearch('?chartSync=sync%3Aunsafe'), '');
  assert.equal(chartExternalWindowChannel('sync-a'), 'stock-app-ai-chart-window-v1:sync-a');
  assert.equal(buildChartPath(selection).includes('chartWindow=external'), false);
});

test('route timeframe changes preserve scanner evidence for the same instrument', () => {
  const stored: AnalysisSelection = {
    ...selection,
    timeframe: '5m',
    searchRunId: 'scan-1',
    signalScore: 88,
    signalRank: 1,
    confidence: 82,
    riskLevel: 'LOW',
    matchedSignals: ['거래량 증가'],
    reasons: ['상승 구조'],
  };
  const route: AnalysisSelection = {
    ...selection,
    timeframe: '30m',
    searchRunId: undefined,
    signalScore: undefined,
    confidence: undefined,
  };
  const merged = mergeChartRouteSelection(route, stored);

  assert.equal(merged?.timeframe, '30m');
  assert.equal(merged?.signalScore, 88);
  assert.equal(merged?.confidence, 82);
  assert.equal(merged?.searchRunId, 'scan-1');
  assert.deepEqual(merged?.matchedSignals, ['거래량 증가']);
});

test('route selection does not borrow evidence from another instrument', () => {
  const route: AnalysisSelection = {
    ...selection,
    ticker: 'ETHUSDT',
    symbol: 'ETHUSDT',
    displayName: '이더리움 무기한 선물',
  };
  const merged = mergeChartRouteSelection(route, { ...selection, signalScore: 88 });
  assert.equal(merged?.ticker, 'ETHUSDT');
  assert.equal(merged?.signalScore, undefined);
});

test('chart selection key changes only when the data context changes', () => {
  assert.equal(chartSelectionKey(selection), 'coin_futures:BITGET:BTCUSDT:15m');
  assert.notEqual(chartSelectionKey(selection), chartSelectionKey({ ...selection, timeframe: '1H' }));
});

test('chart window messages reject malformed, stale, future, and unsupported payloads', () => {
  const now = Date.UTC(2026, 7, 6, 7, 0, 0);
  const valid = {
    ...createChartWindowMessage('selection', 'source-a', selection),
    sentAt: now,
  };

  assert.deepEqual(parseChartWindowMessage(valid, now), valid);
  assert.equal(parseChartWindowMessage({ type: 'selection', sourceId: '', sentAt: now, selection }, now), null);
  assert.equal(parseChartWindowMessage({ type: 'selection', sourceId: 'source a', sentAt: now, selection }, now), null);
  assert.equal(parseChartWindowMessage({ type: 'order', sourceId: 'source-a', sentAt: now }, now), null);
  assert.equal(parseChartWindowMessage({ type: 'selection', sourceId: 'source-a', sentAt: now, selection: { market: 'UNKNOWN' } }, now), null);
  assert.equal(parseChartWindowMessage({ ...valid, sentAt: now - CHART_WINDOW_MESSAGE_MAX_AGE_MS - 1 }, now), null);
  assert.equal(parseChartWindowMessage({ ...valid, sentAt: now + CHART_WINDOW_MESSAGE_MAX_FUTURE_SKEW_MS + 1 }, now), null);
});

test('chart window messages only apply in fresh monotonic order', () => {
  const now = Date.UTC(2026, 7, 6, 7, 0, 0);
  const message = {
    ...createChartWindowMessage('selection', 'source-a', selection),
    sentAt: now,
  };

  assert.equal(isChartWindowMessageFresh(now, now), true);
  assert.equal(isChartWindowMessageFresh(now - CHART_WINDOW_MESSAGE_MAX_AGE_MS - 1, now), false);
  assert.equal(isChartWindowMessageFresh(now + CHART_WINDOW_MESSAGE_MAX_FUTURE_SKEW_MS + 1, now), false);
  assert.equal(shouldAcceptChartWindowMessage(message, 0, now), true);
  assert.equal(shouldAcceptChartWindowMessage(message, now - 1, now), true);
  assert.equal(shouldAcceptChartWindowMessage(message, now, now), false);
  assert.equal(shouldAcceptChartWindowMessage({ ...message, sentAt: now - 1 }, now, now), false);
});

test('external chart control remains desktop only without excluding touch-capable PCs', () => {
  assert.equal(isDesktopChartViewport(1440, false), true);
  assert.equal(isDesktopChartViewport(1024, false), true);
  assert.equal(isDesktopChartViewport(1023, false), false);
  assert.equal(isDesktopChartViewport(1440, true), false);
});

test('popup geometry stays inside the available desktop screen', () => {
  const features = externalChartWindowFeatures({
    availWidth: 1920,
    availHeight: 1080,
    availLeft: 0,
    availTop: 0,
  });
  const values = Object.fromEntries(features.split(',').map((part) => {
    const [key, value] = part.split('=');
    return [key, value];
  }));

  assert.equal(values.popup, 'yes');
  assert.equal(values.resizable, 'yes');
  assert.equal(values.scrollbars, 'yes');
  assert.ok(Number(values.width) <= 1920);
  assert.ok(Number(values.height) <= 1080);
  assert.ok(Number(values.left) >= 0);
  assert.ok(Number(values.top) >= 0);
});
