import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const chartUrl = '/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m&strategyMode=SCALPING';
async function prime(page: Page) {
  const end = Math.floor(Date.now() / 300_000) * 300 - 300;
  await page.route('**/api/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/stocks/*/candles**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ticker: '005930', timeframe: '5m', provider: 'TEST_ONLY', updatedAt: new Date(end * 1000).toISOString(),
    candles: Array.from({ length: 90 }, (_, i) => ({ time: end - (89 - i) * 300, open: 70000, high: 70500, low: 69500, close: 70000, volume: 1000, isClosed: true })),
  }) }));
}

test('AI Chart keeps three mobile tabs and a shared mounted chart without introducing manual orders', () => {
  const source = fs.readFileSync(path.resolve('src/pages/ai-chart.tsx'), 'utf8');
  expect(source).toContain("type MobileChartTab = 'summary' | 'chart' | 'live';");
  expect(source).toContain("{ value: 'summary', label: '현재 판단' }");
  expect(source).toContain("{ value: 'chart', label: '차트' }");
  expect(source).toContain("{ value: 'live', label: 'AI 생중계' }");
  expect(source).toContain("useState<MobileChartTab>('chart')");
  expect(source).toContain('hidden={mobile && mobileTab');
  expect(source).not.toContain('LazyChartManualOrder');
  expect(source).not.toContain('trade-navigation');
  expect(source).toContain('data-testid="ai-chart-workspace"');
  expect(source).toContain('contextualActionLabel(selection, analysis)');
  expect(source).toContain('읽기 전용');
});

for (const width of [360, 390, 412, 430]) {
  test(`mobile ${width}px opens chart without overflow and all tabs fit`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 }); await prime(page); await page.goto(chartUrl);
    const tabs = page.getByTestId('ai-chart-mobile-tabs');
    await expect(tabs).toBeVisible(); await expect(tabs.getByRole('tab')).toHaveCount(3);
    await expect(tabs.getByRole('tab', { name: '차트', exact: true })).toHaveAttribute('aria-selected', 'true');
    const boxes = await tabs.getByRole('tab').evaluateAll(nodes => nodes.map(node => {
      const r = node.getBoundingClientRect(); return { right: r.right, width: r.width, text: node.textContent };
    }));
    expect(boxes.every(box => box.width >= 60)).toBe(true);
    expect(boxes.at(-1)?.text).toContain('AI 생중계');
    expect(boxes.at(-1)!.right).toBeLessThanOrEqual(width + 1);
    await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();
    const overflow = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, root: document.documentElement.scrollWidth }));
    expect(overflow.body).toBeLessThanOrEqual(overflow.viewport);
    expect(overflow.root).toBeLessThanOrEqual(overflow.viewport);
  });
}

test('mobile tabs keep chart identity while hiding the inactive surface', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await prime(page); await page.goto(chartUrl);
  const chart = page.getByTestId('unified-chart-canvas'); await expect(chart).toBeVisible();
  await chart.evaluate(node => node.setAttribute('data-mounted-identity', 'same-chart'));
  await page.getByRole('tab', { name: '현재 판단', exact: true }).click();
  await expect(page.getByTestId('ai-chart-mobile-judgment')).toBeVisible(); await expect(chart).toBeHidden();
  await expect(chart).toHaveAttribute('data-mounted-identity', 'same-chart');
  await page.getByRole('tab', { name: 'AI 생중계', exact: true }).click();
  await expect(page.getByTestId('ai-chart-live-feed')).toBeVisible();
  await expect(page.getByTestId('ai-chart-mobile-judgment')).toBeHidden();
  await page.getByRole('tab', { name: '차트', exact: true }).click();
  await expect(chart).toBeVisible(); await expect(chart).toHaveAttribute('data-mounted-identity', 'same-chart');
  await expect(page.getByTestId('ai-chart-position-panel')).toContainText('내 포지션 확인');
});

test('desktop keeps chart, judgment and live feed side by side without a new order form', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 }); await prime(page); await page.goto(chartUrl);
  await expect(page.getByTestId('ai-chart-mobile-tabs')).toHaveCount(0);
  await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();
  await expect(page.getByTestId('ai-chart-mobile-judgment')).toBeVisible();
  await expect(page.getByTestId('ai-chart-live-feed')).toBeVisible();
  await expect(page.getByTestId('chart-manual-order')).toHaveCount(0);
  await expect(page.getByTestId('ai-chart-position-panel')).toBeVisible();
});
