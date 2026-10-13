import { test, expect } from '@playwright/test';
import { signalIdFromMatchingChartRoute } from '../src/lib/ai-chart-signal-context';
import { readFileSync } from 'node:fs';

const selection = { market: 'US' as const, ticker: 'AAPL', timeframe: '5m' };
const query = '?assetType=stock&market=US&ticker=AAPL&symbol=AAPL&timeframe=5m&signalId=scan%3Aus%3AAAPL';

test('scanner signalId from route belongs only to exact market, symbol and timeframe', () => {
  expect(signalIdFromMatchingChartRoute(selection, query)).toBe('scan:us:AAPL');
  expect(signalIdFromMatchingChartRoute({ ...selection, ticker: 'MSFT' }, query)).toBeNull();
  expect(signalIdFromMatchingChartRoute({ ...selection, market: 'KR' }, query)).toBeNull();
  expect(signalIdFromMatchingChartRoute({ ...selection, timeframe: '1D' }, query)).toBeNull();
  expect(signalIdFromMatchingChartRoute(selection, query + '&signalId=duplicate')).toBeNull();
  expect(signalIdFromMatchingChartRoute(selection, query.replace('symbol=AAPL', 'symbol=MSFT'))).toBeNull();
  expect(signalIdFromMatchingChartRoute(selection, '?signalId=scan:us:AAPL')).toBeNull();
});

test('AI Chart clears scanner identity when the user changes symbol or timeframe', () => {
  const source = readFileSync(new URL('../src/components/unified-analysis-chart.tsx', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../src/components/ai-chart-v2-intelligence-panel.tsx', import.meta.url), 'utf8');
  expect(source).toContain('signalId: sameScannerIdentity ? selection.signalId : undefined');
  expect(panel).toContain('signalIdFromMatchingChartRoute(');
  expect(panel).not.toContain('signalIdFromContext()');
});

test('same-ticker scanner refresh cannot be discarded as unchanged instrument identity', () => {
  const page = readFileSync(new URL('../src/pages/ai-chart.tsx', import.meta.url), 'utf8');
  expect(page).toContain('left.signalId === right.signalId');
  expect(page).toContain('left.searchRunId === right.searchRunId');
  expect(page).toContain('left.selectedAt === right.selectedAt');
});
