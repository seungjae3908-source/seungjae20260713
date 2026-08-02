import { expect, test, type Page } from '@playwright/test';

async function monitorPage(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  return { consoleErrors, pageErrors };
}

async function assertNoHorizontalOverflow(page: Page) {
  const sizes = await page.evaluate(() => ({ viewport: window.innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(sizes.html).toBeLessThanOrEqual(sizes.viewport);
  expect(sizes.body).toBeLessThanOrEqual(sizes.viewport);
}

async function openAndRun(page: Page) {
  await page.goto('/__phase5-backtest-e2e');
  await expect(page.getByTestId('backtest-page')).toBeVisible();
  await expect(page.getByText('과거 데이터 기반 백테스트이며 미래 수익을 보장하지 않습니다.')).toBeVisible();
  await page.getByTestId('run-backtest').click();
  await expect(page.getByText('백테스트 계산 중')).toBeVisible();
  await expect(page.getByTestId('backtest-results')).toBeVisible();
}

for (const viewport of [
  { name: 'desktop 1440x900', width: 1440, height: 900 },
  { name: 'mobile 390x844', width: 390, height: 844 },
  { name: 'small mobile 360x740', width: 360, height: 740 },
]) {
  test(`${viewport.name} completes the cost-aware backtest flow`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const monitored = await monitorPage(page);
    await openAndRun(page);
    await expect(page.getByTestId('total-return')).toContainText('1.44');
    await expect(page.getByTestId('total-trades')).toContainText('24');
    await expect(page.getByTestId('equity-chart')).toBeVisible();
    await expect(page.getByTestId('drawdownPercent-chart')).toBeVisible();
    await expect(page.getByTestId('validation-results')).toContainText('training');
    await expect(page.getByTestId('trade-list')).toBeVisible();
    await expect(page.getByTestId('backtest-warnings')).toContainText('손절을 우선');
    await page.getByTestId('trade-list').evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await assertNoHorizontalOverflow(page);
    expect(monitored.consoleErrors).toEqual([]);
    expect(monitored.pageErrors).toEqual([]);
  });
}

test('form controls remain usable and accessible by labels', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__phase5-backtest-e2e');
  await page.locator('#backtest-symbol').fill('ETHUSDT');
  await page.locator('#backtest-timeframe').selectOption('1H');
  await page.locator('#backtest-strategy').selectOption('vwap_reclaim');
  await page.locator('#backtest-start').fill('2026-01-01');
  await page.locator('#backtest-end').fill('2026-01-30');
  await expect(page.getByTestId('run-backtest')).toBeEnabled();
  await page.getByTestId('run-backtest').tap();
  await expect(page.getByTestId('backtest-results')).toBeVisible();
  await assertNoHorizontalOverflow(page);
});
