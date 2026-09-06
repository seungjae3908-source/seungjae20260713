import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const source = readFileSync(new URL('../src/pages/ai-chart.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const unifiedChartSource = readFileSync(new URL('../src/components/unified-analysis-chart.tsx', import.meta.url), 'utf8');

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
  expect(appSource).toContain("window.matchMedia('(min-width: 1024px)').matches");
  expect(appSource).toContain('const routeSelection = selectionFromSearch(window.location.search);');
  expect(appSource).toContain("window.localStorage.getItem('sa-analysis-selection-v1')");
  expect(appSource).toContain('const prewarmSelection = routeSelection ?? storedSelection;');
  expect(appSource).toContain('if (!prewarmSelection) return null;');
  expect(appSource).toContain("const queryKey = ['unified-chart-data', market, ticker, timeframe] as const;");
  expect(appSource).toContain('staleTime: DIRECT_AI_CHART_PREWARM_STALE_MS');
  expect(appSource).toContain('retryOnMount: false');
  expect(appSource).toContain('queryFn: ({ signal }) => fetchUnifiedChartData({ market, symbol: ticker, timeframe, signal })');
  expect(appSource).toContain('retry: retryUnifiedChartBootstrap');
  expect(appSource).toContain('retryOnMount: true');
  expect(appSource).not.toContain("queryKey: ['unified-chart-data', 'KR', '005930', '5m']");
  expect(appSource).not.toContain('prewarmDefaultAiChartData');
});

test('AI Chart search keeps missing financial evidence distinct from genuine zero', () => {
  expect(unifiedChartSource).toContain('if (value == null) return null;');
  expect(unifiedChartSource).toContain("if (typeof value === 'string' && value.trim() === '') return null;");
  expect(unifiedChartSource).toContain("const parsed = typeof value === 'number' ? value : Number(value);");
  expect(unifiedChartSource).toContain('return Number.isFinite(parsed) ? parsed : null;');
  expect(unifiedChartSource).toContain('price: finite(row.price)');
  expect(unifiedChartSource).toContain('changePercent: finite(row.changePercent)');
  expect(unifiedChartSource).toContain('price: finite(row.markPrice ?? row.price)');
  expect(unifiedChartSource).toContain('changePercent: finite(row.changePercent24h ?? row.changePercent)');
  expect(unifiedChartSource).toContain("if (value == null || !Number.isFinite(value)) return '-';");
});