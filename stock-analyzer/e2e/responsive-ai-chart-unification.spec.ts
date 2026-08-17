import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const technicalWorkspaceSource = readFileSync(
  new URL('../src/pages/technical-workspace.tsx', import.meta.url),
  'utf8',
);
const chartTabSource = readFileSync(
  new URL('../src/components/tabs/chart-tab.tsx', import.meta.url),
  'utf8',
);
const canonicalChartSource = readFileSync(
  new URL('../src/components/canonical-market-chart.tsx', import.meta.url),
  'utf8',
);
const richDetailSource = readFileSync(
  new URL('../src/pages/detail.tsx', import.meta.url),
  'utf8',
);

const safeTradeAutomationStatus = {
  policy: {
    mode: 'approval',
    automaticEnabled: false,
    emergencyStopped: false,
    exchangeEnabled: { bitget: false, upbit: false, kiwoom: false },
    enabledAssets: { bitget: [], upbit: [], kiwoom: [] },
    enabledStrategies: [],
    totalCapitalKrw: 1_000_000,
    maxOrderKrw: 1_000_000,
    dailyLossLimitPercent: 5,
    maxAssetPercent: 30,
    maxOpenPositions: 5,
    maxDailyOrders: 10,
    maxConsecutiveLosses: 3,
    bitgetLeverage: 2,
  },
  connections: [],
  emergencyStopped: false,
  credentialVault: { encryptionConfigured: false, keyValueExposed: false },
  lastOrder: null,
};

async function mockPublicApi(page: Page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/trade-automation/status') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(safeTradeAutomationStatus) });
      return;
    }
    if (url.pathname.includes('/market/scan')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          requestId: 'responsive-ai-chart:KR',
          assetClass: 'stock',
          market: 'KR',
          timeframe: '1D',
          cards: [],
          alerts: [],
          failures: [],
          execution: {
            requestedCount: 1,
            startedCount: 1,
            completedCount: 1,
            excludedCount: 1,
            providerErrorCount: 0,
            timeoutCount: 0,
            partial: false,
            timedOut: false,
            cancelled: false,
            duplicate: false,
            elapsedMs: 1,
            deadlineMs: 12000,
            itemTimeoutMs: 3500,
            maxConcurrency: 1,
            providerAcceptedCount: 1,
            dataSuccessCount: 1,
            insufficientDataCount: 0,
            filteredByStrategyCount: 1,
            hardFilterRejectedCount: 0,
            finalDisplayedCount: 0,
          },
          universe: {
            totalCount: 1,
            cursor: 0,
            nextCursor: null,
            source: 'fixture',
            partial: false,
            stale: false,
            listingStatusCoverage: 'listed-or-unknown',
          },
          dataState: 'complete',
          outcome: 'VALID_ZERO_SIGNAL',
          message: '공개 데이터 분석 완료',
          generatedAt: '2026-08-15T01:00:00.000Z',
          orderSubmitted: false,
          exchangeRequestSent: false,
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test('market price charts use the canonical AI Chart surface instead of legacy chart primitives', async () => {
  expect(chartTabSource).toContain('CanonicalMarketChart');
  expect(chartTabSource).not.toMatch(/<PriceChart\b/);
  expect(chartTabSource).not.toMatch(/<RsiChart\b/);
  expect(chartTabSource).not.toMatch(/<MacdChart\b/);
  expect(chartTabSource).not.toContain("from '@/components/charts'");
  expect(canonicalChartSource).toContain('UnifiedAnalysisChart');
  expect(canonicalChartSource).toContain('AI Chart 2.0');
});

test('rich stock analysis preserves legacy information tabs but lazy-loads AI Chart 2.0', async () => {
  expect(richDetailSource).toContain("lazy(() => import('@/pages/detail-legacy'))");
  expect(richDetailSource).toContain("button.textContent?.trim() !== '차트'");
  expect(richDetailSource).toContain('<AiChartPage embedded />');
  expect(richDetailSource).toContain('canonical-rich-detail-chart');
  expect(richDetailSource).not.toContain('createChart(');
  expect(richDetailSource).not.toContain("from 'lightweight-charts'");
});

test('technical workspace exposes four dedicated lazy workspaces and no legacy scanner chart', async () => {
  expect(technicalWorkspaceSource).toContain("type Workspace = 'signal' | 'chart' | 'backtest' | 'trade'");
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
    await expect(page.getByRole('heading', { name: '현재 주문 안전 상태' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });
}
