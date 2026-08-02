import { expect, test, type Page } from '@playwright/test';

async function monitorPage(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  return { consoleErrors, pageErrors };
}

async function assertNoHorizontalOverflow(page: Page) {
  const sizes = await page.evaluate(() => ({
    viewport: window.innerWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(sizes.html).toBeLessThanOrEqual(sizes.viewport);
  expect(sizes.body).toBeLessThanOrEqual(sizes.viewport);
}

async function openPage(page: Page) {
  await page.goto('/__phase5-backtest-e2e');
  await expect(page.getByTestId('backtest-page')).toBeVisible();
  await expect(page.getByText('과거 데이터 기반 백테스트이며 미래 수익을 보장하지 않습니다.')).toBeVisible();
  await expect(page.getByLabel('초기 자본')).toHaveValue('10000');
  const initialCapitalIsValid = await page.getByLabel('초기 자본').evaluate((element) => (element as HTMLInputElement).checkValidity());
  expect(initialCapitalIsValid).toBe(true);
}

async function runAndWait(page: Page) {
  const button = page.getByTestId('run-backtest');
  await button.click();
  await expect(button).toContainText('백테스트 계산 중');
  await expect(button).toBeDisabled();
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
    await openPage(page);
    await runAndWait(page);
    await expect(page.getByTestId('total-return')).toContainText('1.44');
    await expect(page.getByTestId('total-trades')).toContainText('24');
    await expect(page.getByTestId('equity-chart')).toBeVisible();
    await expect(page.getByTestId('drawdownPercent-chart')).toBeVisible();
    await expect(page.getByTestId('validation-results')).toContainText('training');
    await expect(page.getByTestId('direction-results')).toContainText('롱');
    await expect(page.getByTestId('walk-forward-results')).toBeVisible();
    await expect(page.getByTestId('breakdown-results')).toBeVisible();
    await expect(page.getByTestId('trade-list')).toBeVisible();
    await expect(page.getByTestId('backtest-warnings')).toContainText('손절을 우선');
    await page.getByTestId('trade-list').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await assertNoHorizontalOverflow(page);
    expect(monitored.consoleErrors).toEqual([]);
    expect(monitored.pageErrors).toEqual([]);
  });
}

test('form controls remain usable and accessible by labels and touch', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page);
  await page.getByLabel('종목').fill('ETHUSDT');
  await page.getByLabel('시간봉').selectOption('1H');
  await page.getByLabel('전략').selectOption('vwap_reclaim');
  await page.getByLabel('시작일').fill('2026-01-01');
  await page.getByLabel('종료일').fill('2026-01-30');
  await expect(page.getByTestId('run-backtest')).toBeEnabled();
  await page.getByTestId('run-backtest').tap();
  await expect(page.getByTestId('backtest-results')).toBeVisible();
  await assertNoHorizontalOverflow(page);
});

test('empty result renders explicit empty charts and trade state', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const monitored = await monitorPage(page);
  await openPage(page);
  await page.getByLabel('종목').fill('EMPTYUSDT');
  await runAndWait(page);
  await expect(page.getByTestId('total-trades')).toContainText('0');
  await expect(page.getByTestId('equity-chart')).toContainText('표시할 데이터가 없습니다.');
  await expect(page.getByTestId('drawdownPercent-chart')).toContainText('표시할 데이터가 없습니다.');
  await expect(page.getByTestId('trade-list')).toContainText('조건에 맞는 거래가 없습니다.');
  await expect(page.getByTestId('backtest-warnings')).toContainText('성과 표본이 비어 있습니다.');
  await assertNoHorizontalOverflow(page);
  expect(monitored.consoleErrors).toEqual([]);
  expect(monitored.pageErrors).toEqual([]);
});

test('error result clears previous success and displays a safe alert', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const monitored = await monitorPage(page);
  await openPage(page);
  await page.getByLabel('종목').fill('ERRORUSDT');
  await page.getByTestId('run-backtest').click();
  await expect(page.getByTestId('backtest-error')).toContainText('fixture 백테스트 오류');
  await expect(page.getByTestId('backtest-results')).toHaveCount(0);
  await assertNoHorizontalOverflow(page);
  expect(monitored.consoleErrors).toEqual([]);
  expect(monitored.pageErrors).toEqual([]);
});
