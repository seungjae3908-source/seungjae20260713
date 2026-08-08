import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const initialUrl = '/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m';

function candleRows(revision: number) {
  const rows = Array.from({ length: 80 + revision }, (_, index) => ({
    time: new Date(Date.UTC(2026, 7, 4, 0, index * 5)).toISOString(),
    open: 70_000 + index * 10,
    high: 70_100 + index * 10,
    low: 69_900 + index * 10,
    close: 70_050 + index * 10,
    volume: 1_000 + index * 20,
    isClosed: index < 79 + revision,
  }));
  const latest = rows.at(-1);
  if (latest) {
    latest.close += revision * 7;
    latest.high = Math.max(latest.high, latest.close + 20);
  }
  return rows;
}

async function installChartMock(context: BrowserContext) {
  let revision = 0;
  let calls = 0;
  await context.route('**/api/stocks/*/chart**', async (route) => {
    calls += 1;
    const current = revision;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ticker: '005930',
        timeframe: new URL(route.request().url()).searchParams.get('tf') ?? '5m',
        provider: `viewport-fixture-${current}`,
        fetchedAt: new Date(Date.UTC(2026, 7, 4, 7, current)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 7, 4, 7, current)).toISOString(),
        candles: candleRows(current),
      }),
    });
  });
  await context.route('**/api/quotes**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ quotes: [{ ticker: '^KS11', changePercent: 0.4 }] }),
  }));
  return {
    get calls() { return calls; },
    advance() { revision += 1; },
  };
}

async function range(page: Page): Promise<[number, number]> {
  const value = await page.getByTestId('unified-chart-wrapper').getAttribute('data-visible-logical-range');
  expect(value).toBeTruthy();
  const [from, to] = String(value).split(':').map(Number);
  expect(Number.isFinite(from)).toBe(true);
  expect(Number.isFinite(to)).toBe(true);
  return [from, to];
}

function expectSameRange(actual: [number, number], expected: [number, number]) {
  expect(Math.abs(actual[0] - expected[0])).toBeLessThan(0.02);
  expect(Math.abs(actual[1] - expected[1])).toBeLessThan(0.02);
}

async function panAndZoomHistorical(page: Page) {
  const canvas = page.getByTestId('unified-chart-canvas');
  await expect(canvas).toBeVisible();
  const initial = await range(page);
  const box = await canvas.boundingBox();
  if (!box) throw new Error('chart canvas has no bounding box');
  const x = box.x + box.width * 0.58;
  const y = box.y + box.height * 0.55;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + Math.min(260, box.width * 0.28), y, { steps: 12 });
  await page.mouse.up();
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, -420);
  await expect.poll(async () => (await range(page)).join(':')).not.toBe(initial.join(':'));
  return range(page);
}

test('same-symbol live refresh, candle rollover, overlay recompute, and focus resume preserve the user viewport', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const mock = await installChartMock(context);
  await page.goto(initialUrl);
  await expect(page.getByRole('heading', { name: 'AI 차트 생중계', level: 1 })).toBeVisible();
  await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();
  const historicalRange = await panAndZoomHistorical(page);

  for (let index = 0; index < 3; index += 1) {
    const beforeCalls = mock.calls;
    mock.advance();
    await page.getByRole('button', { name: '차트 새로고침' }).click();
    await expect.poll(() => mock.calls).toBeGreaterThan(beforeCalls);
    await expect.poll(async () => (await page.getByTestId('chart-data-status').textContent()) ?? '').not.toBe('');
    expectSameRange(await range(page), historicalRange);
  }

  await page.getByRole('button', { name: /지표 설정/ }).click();
  const overlay = page.getByTestId('overlay-sma20');
  await overlay.click();
  await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();
  expectSameRange(await range(page), historicalRange);

  const beforeFocusCalls = mock.calls;
  mock.advance();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => mock.calls).toBeGreaterThan(beforeFocusCalls);
  expectSameRange(await range(page), historicalRange);

  const beforeLatest = await range(page);
  await page.getByTestId('chart-latest-candle').click();
  await expect.poll(async () => (await range(page)).join(':')).not.toBe(beforeLatest.join(':'));
});

test('external chart keeps its own viewport when main-window market data refreshes', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const mock = await installChartMock(context);
  await page.goto(initialUrl);
  const popupPromise = context.waitForEvent('page');
  await page.getByTestId('open-external-ai-chart').click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  await expect(popup.getByText('외부 AI 차트', { exact: true })).toBeVisible();
  const popupRange = await panAndZoomHistorical(popup);

  const beforeMainCalls = mock.calls;
  mock.advance();
  await page.getByRole('button', { name: '차트 새로고침' }).click();
  await expect.poll(() => mock.calls).toBeGreaterThan(beforeMainCalls);
  await page.waitForTimeout(150);
  expectSameRange(await range(popup), popupRange);

  const beforePopupCalls = mock.calls;
  mock.advance();
  await popup.getByRole('button', { name: '차트 새로고침' }).click();
  await expect.poll(() => mock.calls).toBeGreaterThan(beforePopupCalls);
  expectSameRange(await range(popup), popupRange);

  await popup.close();
});
