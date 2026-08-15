import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

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

async function mockPublicApi(page: Parameters<typeof test>[0] extends never ? never : any) {
  await page.route('**/api/**', async (route: any) => {
    const url = new URL(route.request().url());
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
  expect(chartTabSource).not.toContain('PriceChart');
  expect(chartTabSource).not.toContain('RsiChart');
  expect(chartTabSource).not.toContain('MacdChart');
  expect(chartTabSource).not.toContain("@/components/charts");
  expect(canonicalChartSource).toContain('UnifiedAnalysisChart');
  expect(canonicalChartSource).toContain('AI Chart 2.0');
});

test('technical workspace removes the legacy scanner chart and exposes dedicated mobile workspaces', async () => {
  expect(technicalWorkspaceSource).toContain("type MobileWorkspace = 'signal' | 'chart' | 'trade'");
  expect(technicalWorkspaceSource).toContain('ResponsiveTabs');
  expect(technicalWorkspaceSource).toContain('<AiChartPage embedded />');
  expect(technicalWorkspaceSource).not.toContain("@/pages/scanner");
  expect(technicalWorkspaceSource).not.toContain('<ScannerPage');
});

for (const viewport of [
  { width: 320, height: 760 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
] as const) {
  test(`mobile technical tabs fit ${viewport.width}px and open the canonical AI Chart`, async ({ page }) => {
    await mockPublicApi(page);
    await page.setViewportSize(viewport);
    await page.goto('/__phase11-technical-workspace-e2e');

    const tabs = page.getByTestId('technical-mobile-tabs');
    await expect(tabs).toBeVisible();
    await expect(tabs.getByRole('tab')).toHaveCount(3);
    const tabHeights = await tabs.getByRole('tab').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    expect(tabHeights.every((height) => height >= 44)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);

    await tabs.getByRole('tab', { name: 'AI 차트' }).click();
    await expect(tabs.getByRole('tab', { name: 'AI 차트' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'AI 차트 생중계 · AI 차트 2.0' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);

    await tabs.getByRole('tab', { name: '자동매매' }).click();
    await expect(tabs.getByRole('tab', { name: '자동매매' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: '승인형 주문' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });
}
