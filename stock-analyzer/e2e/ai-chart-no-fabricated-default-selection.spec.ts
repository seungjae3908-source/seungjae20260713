import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const source = readFileSync(new URL('../src/pages/ai-chart.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

test('AI Chart does not fabricate a Samsung selection when no asset is selected', () => {
  expect(source).toContain('function emptySelection(): AnalysisSelection');
  expect(source).toContain("symbol: ''");
  expect(source).toContain("ticker: ''");
  expect(source).toContain("displayName: '종목 미선택'");
  expect(source).toContain('data-testid="ai-chart-empty-selection"');
  expect(source).toContain('if (invalidRoute || !hasSelection) return;');
  expect(source).not.toContain('function fallbackSelection()');
  expect(source).not.toContain("displayName: '삼성전자'");
  expect(source).not.toContain("symbol: '005930'");
});

test('direct AI Chart cold prewarm reuses only explicit route or stored selection', () => {
  expect(appSource).toContain('const routeSelection = selectionFromSearch(window.location.search);');
  expect(appSource).toContain("window.localStorage.getItem('sa-analysis-selection-v1')");
  expect(appSource).toContain('const prewarmSelection = routeSelection ?? storedSelection;');
  expect(appSource).toContain('if (!prewarmSelection) return null;');
  expect(appSource).toContain("queryKey: ['unified-chart-data', market, ticker, timeframe]");
  expect(appSource).toContain('queryFn: () => fetchUnifiedChartData({ market, symbol: ticker, timeframe })');
  expect(appSource).not.toContain("queryKey: ['unified-chart-data', 'KR', '005930', '5m']");
  expect(appSource).not.toContain('prewarmDefaultAiChartData');
});
