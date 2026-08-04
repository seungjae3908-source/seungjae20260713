import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildChartPath,
  buildExternalChartPath,
  chartSelectionKey,
  createChartWindowMessage,
  externalChartWindowFeatures,
  isDesktopChartViewport,
  isExternalChartSearch,
  parseChartWindowMessage,
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

test('external chart path preserves the validated chart context', () => {
  const path = buildExternalChartPath(selection);
  const query = path.slice(path.indexOf('?'));
  const params = new URLSearchParams(query);

  assert.equal(path.startsWith('/ai-chart?'), true);
  assert.equal(params.get('market'), 'BITGET');
  assert.equal(params.get('ticker'), 'BTCUSDT');
  assert.equal(params.get('timeframe'), '15m');
  assert.equal(params.get('chartWindow'), 'external');
  assert.equal(isExternalChartSearch(query), true);
  assert.equal(buildChartPath(selection, false).includes('chartWindow=external'), false);
});

test('chart selection key changes only when the data context changes', () => {
  assert.equal(chartSelectionKey(selection), 'coin_futures:BITGET:BTCUSDT:15m');
  assert.notEqual(chartSelectionKey(selection), chartSelectionKey({ ...selection, timeframe: '1H' }));
});

test('chart window messages reject malformed or unsupported payloads', () => {
  const valid = createChartWindowMessage('selection', 'source-a', selection);
  assert.deepEqual(parseChartWindowMessage(valid), valid);
  assert.equal(parseChartWindowMessage({ type: 'selection', sourceId: '', sentAt: Date.now(), selection }), null);
  assert.equal(parseChartWindowMessage({ type: 'order', sourceId: 'source-a', sentAt: Date.now() }), null);
  assert.equal(parseChartWindowMessage({ type: 'selection', sourceId: 'source-a', sentAt: Date.now(), selection: { market: 'UNKNOWN' } }), null);
});

test('external chart control remains desktop fine-pointer only', () => {
  assert.equal(isDesktopChartViewport(1440, true), true);
  assert.equal(isDesktopChartViewport(1024, true), true);
  assert.equal(isDesktopChartViewport(1023, true), false);
  assert.equal(isDesktopChartViewport(1440, false), false);
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
