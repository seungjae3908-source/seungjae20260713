import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

async function mockPublicApi(page: import('@playwright/test').Page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path.includes('/api/market/scan')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          market: 'KR',
          strategy: 'scalping',
          timeframe: '5m',
          scannedAt: new Date().toISOString(),
          source: 'fixture',
          provider: 'fixture',
          dataStatus: 'ready',
          candidates: [],
          summary: { totalCandidates: 0 },
        }),
      });
    }

    if (path.includes('/api/market-data/') || path.includes('/api/crypto/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          symbol: '005930',
          market: 'KR',
          timeframe: '5m',
          provider: 'fixture',
          source: 'fixture',
          dataStatus: 'ready',
          candles: [],
        }),
      });
    }

    if (path.includes('/api/trade-automation/status')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          autoMode: false,
          emergencyStopped: false,
          liveTradingEnabled: false,
          realOrderEnabled: false,
          privateTradingApiAllowed: false,
          userApprovalRequired: true,
          riskEngineRequired: true,
        }),
      });
    }

    if (path.includes('/api/trade-automation/approval-queue')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
    }

    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
}

test('market price charts use the canonical AI Chart surface instead of legacy chart primitives', () => {
  const unified = source('src/components/unified-analysis-chart.tsx');
  const canonical = source('src/components/canonical-market-chart.tsx');
  const aiChart = source('src/pages/ai-chart.tsx');

  expect(canonical).toContain('UnifiedAnalysisChart');
  expect(aiChart).toContain('UnifiedAnalysisChart');
  expect(unified).toContain('UnifiedChartCanvas');
  expect(canonical).not.toContain('PriceChart');
  expect(canonical).not.toContain('RSIChart');
  expect(canonical).not.toContain('MACDChart');
});

test('rich stock analysis preserves legacy information tabs but lazy-loads AI Chart 2.0', () => {
  const detail = source('src/pages/detail.tsx');
  expect(detail).toContain("lazy(() => import('@/pages/ai-chart'))");
  expect(detail).toContain("lazy(() => import('@/pages/detail-legacy'))");
  expect(detail).toContain("{ value: 'summary', label: '요약' }");
  expect(detail).toContain("{ value: 'chart', label: 'AI 차트' }");
  expect(detail).toContain("{ value: 'news', label: '뉴스' }");
  expect(detail).toContain("{ value: 'analysis', label: '상세분석' }");
});

test('technical workspace exposes four dedicated lazy workspaces and no legacy scanner chart', () => {
  const technicalWorkspaceSource = source('src/pages/technical-workspace.tsx');
  expect(technicalWorkspaceSource).toContain('ResponsiveTabs');
  expect(technicalWorkspaceSource).toContain("lazy(() => import('@/pages/ai-chart'))");
  expect(technicalWorkspaceSource).toContain("lazy(() => import('@/pages/signal-scanner'))");
  expect(technicalWorkspaceSource).not.toContain("@/pages/scanner");
  expect(technicalWorkspaceSource).not.toContain('<ScannerPage');
});

for (const viewport of [
  { width: 320, height: 760 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
] as const) {
  test(`mobile technical tabs fit ${viewport.width}px and open every canonical workspace`, async ({ page }) => {
    await mockPublicApi(page);
    await page.setViewportSize(viewport);
    await page.goto('/__phase11-technical-workspace-e2e');

    const tabs = page.getByTestId('technical-mobile-tabs');
    await expect(tabs).toBeVisible();
    await expect(tabs.getByRole('tab')).toHaveCount(4);
    const tabHeights = await tabs.getByRole('tab').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    expect(tabHeights.every((height) => height >= 44)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);

    const chartTab = tabs.getByRole('tab', { name: 'AI 차트 분석기' });
    await chartTab.click();
    await expect(chartTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'AI 차트 생중계 · AI 차트 2.0' })).toBeVisible();

    await tabs.getByRole('tab', { name: '백테스트' }).click();
    await expect(page.getByTestId('backtest-form')).toBeVisible();

    await tabs.getByRole('tab', { name: '자동매매' }).click();
    await expect(tabs.getByRole('tab', { name: '자동매매' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: '주문 안전 상태' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });
}