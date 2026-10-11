import { expect, test, type Page } from '@playwright/test';

const url = '/ai-chart?assetType=stock&market=US&symbol=AAPL&ticker=AAPL&name=Apple&timeframe=1m';
async function mock(page: Page) {
  const end = Math.floor(Date.now() / 60_000) * 60 - 60;
  await page.route('**/api/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/stocks/*/candles**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticker: 'AAPL', timeframe: '1m', provider: 'TEST_ONLY', updatedAt: new Date(end * 1000).toISOString(), candles: Array.from({ length: 90 }, (_, i) => ({ time: end - (89 - i) * 60, open: 100, high: 101, low: 99, close: 100, volume: 1000, isClosed: true })) }) }));
  await page.route('**/api/market/fx', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ quotes: [{ currency: 'USD', krwRate: 1400, source: 'TEST_ONLY', asOf: new Date().toISOString(), quality: 'DELAYED' }], missing: [], fetchedAt: new Date().toISOString() }) }));
}
for (const width of [360, 390, 430, 768, 820, 1024, 1440]) {
  test(`responsive ${width}: chart, judgment, live feed and dashboard stay unclipped`, async ({ page }) => {
    const errors: string[] = []; const http: string[] = []; const mutations: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', response => { if (response.status() >= 400) http.push(`${response.status()} ${response.url()}`); });
    page.on('request', request => { if (request.method() !== 'GET' && request.url().includes('/api/trade-automation')) mutations.push(request.url()); });
    await page.setViewportSize({ width, height: 1000 }); await mock(page); await page.goto(url);
    const chart = page.getByTestId('unified-chart-canvas');
    await expect(chart).toBeVisible(); await expect(page.getByTestId('ai-chart-trading-dashboard')).toBeVisible();
    const box = await chart.boundingBox(); expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    if (width < 768) {
      const tabs = page.getByTestId('ai-chart-mobile-tabs'); await expect(tabs.getByRole('tab')).toHaveCount(3);
      await tabs.getByRole('tab', { name: '현재 판단', exact: true }).click();
      await expect(page.getByTestId('ai-chart-mobile-judgment')).toBeVisible(); await expect(chart).toHaveCount(1); await expect(chart).toBeHidden();
      await tabs.getByRole('tab', { name: 'AI 생중계', exact: true }).click(); await expect(page.getByTestId('ai-chart-live-feed')).toBeVisible();
      await tabs.getByRole('tab', { name: '차트', exact: true }).click(); await expect(chart).toBeVisible();
    } else { await expect(page.getByTestId('ai-chart-live-feed')).toBeVisible(); }
    await page.getByRole('button', { name: '원화', exact: true }).click();
    await expect(page.getByTestId('chart-crosshair-legend')).toContainText('140,000원');
    await page.getByTestId('chart-currency-switch').getByRole('button', { name: '달러', exact: true }).click();
    await expect(page.getByTestId('chart-crosshair-legend')).toContainText('$100');
    const preview = page.getByTestId('chart-manual-preview');
    await preview.scrollIntoViewIfNeeded();
    const previewBox = await preview.boundingBox();
    expect(previewBox!.y).toBeGreaterThanOrEqual(0);
    expect(previewBox!.y + previewBox!.height).toBeLessThanOrEqual(1000);
    expect(errors).toEqual([]); expect(http).toEqual([]); expect(mutations).toEqual([]);
    await page.screenshot({ path: `test-results/chart-redesign-${width}.png`, fullPage: true });
  });
}
test('KRW inputs explicitly declare currency and never submit on mount', async ({ page }) => {
  await mock(page); await page.goto(url);
  const requests: Record<string, unknown>[] = [];
  await page.route('**/api/trade-automation/chart/manual-plan', async route => {
    requests.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'TEST_ONLY_BLOCKED' }) });
  });
  await expect(page.getByTestId('chart-manual-order')).toBeVisible(); expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: '원화', exact: true }).click();
  await page.getByLabel('주문 수량', { exact: true }).fill('2'); await page.getByLabel('주문 지정가', { exact: true }).fill('140000');
  await page.getByLabel('주문 손절 기준', { exact: true }).fill('133000'); await page.getByLabel('주문 목표 기준', { exact: true }).fill('154000');
  await page.getByLabel('주문 거래소', { exact: true }).selectOption('NASDAQ');
  await page.getByTestId('chart-manual-preview').click();
  await expect(page.getByRole('status').filter({ hasText: 'TEST_ONLY_BLOCKED' })).toBeVisible();
  expect(requests).toHaveLength(1); expect(requests[0].inputCurrency).toBe('KRW'); expect(requests[0].limitPrice).toBe(140000); expect(requests[0].quantity).toBe(2); expect(requests[0]).not.toHaveProperty('marketSnapshot');
});

test('amount/quantity and limit/market controls switch inputs without a margin-input tab', async ({ page }) => {
  await mock(page); await page.goto(url);
  const order = page.getByTestId('chart-manual-order');
  await expect(order).toBeVisible();
  const sizing = order.getByRole('group', { name: '주문 입력 기준' });
  await expect(sizing.getByRole('button')).toHaveCount(2);
  await sizing.getByRole('button', { name: '금액', exact: true }).click();
  await expect(order.getByLabel('주문 수량', { exact: true })).toHaveCount(0);
  await order.getByLabel('주문 금액', { exact: true }).fill('200');
  await order.getByLabel('주문 지정가', { exact: true }).fill('100');
  await order.getByLabel('주문 손절 기준', { exact: true }).fill('95');
  await order.getByLabel('주문 목표 기준', { exact: true }).fill('110');
  await page.getByTestId('chart-currency-switch').getByRole('button', { name: '원화', exact: true }).click();
  await expect(order.getByLabel('주문 금액', { exact: true })).toHaveValue('280000');
  await expect(order.getByLabel('주문 지정가', { exact: true })).toHaveValue('140000');
  await page.getByTestId('chart-currency-switch').getByRole('button', { name: '달러', exact: true }).click();
  await expect(order.getByLabel('주문 금액', { exact: true })).toHaveValue('200');
  await expect(order.getByLabel('주문 지정가', { exact: true })).toHaveValue('100');
  await order.getByRole('group', { name: '주문 유형' }).getByRole('button', { name: '시장가', exact: true }).click();
  await expect(order.getByLabel('주문 지정가', { exact: true })).toHaveCount(0);
  await expect(order).toContainText('시장가 실주문 연결 검증 미완료 · 전송 금지');
  await sizing.getByRole('button', { name: '수량', exact: true }).click();
  await expect(order.getByLabel('주문 수량', { exact: true })).toBeVisible();
  await expect(order.getByLabel('주문 금액', { exact: true })).toHaveCount(0);
});
