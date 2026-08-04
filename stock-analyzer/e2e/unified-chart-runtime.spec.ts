import { test, expect, type Page, type Request } from '@playwright/test';

const FRAME_BASE: Record<string, number> = {
  '1m': 10_000,
  '3m': 20_000,
  '5m': 30_000,
  '15m': 40_000,
  '30m': 50_000,
  '1H': 60_000,
  '4H': 70_000,
  '1D': 80_000,
};

function candles(base: number, stepSeconds = 300) {
  return Array.from({ length: 80 }, (_, index) => ({
    time: 1_775_000_000 + index * stepSeconds,
    open: base + index,
    high: base + index + 4,
    low: base + index - 3,
    close: base + index + 2,
    volume: 1_000 + index * 10,
    isClosed: index < 79,
  }));
}

function timeframeFrom(url: string): string {
  const parsed = new URL(url);
  return parsed.searchParams.get('tf') ?? parsed.searchParams.get('granularity') ?? '5m';
}

function monitorBrowserErrors(page: Page) {
  const consoleErrors: string[] = [];
  const expectedHttpDiagnostics: string[] = [];
  const pageErrors: string[] = [];
  const unhandled: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/^Failed to load resource: the server responded with a status of (404|429|502)/i.test(text)) {
      expectedHttpDiagnostics.push(text);
      return;
    }
    consoleErrors.push(text);
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request: Request) => {
    const text = request.failure()?.errorText ?? '';
    if (!/ERR_ABORTED|NS_BINDING_ABORTED/i.test(text)) unhandled.push(`${request.url()} ${text}`);
  });
  return { consoleErrors, expectedHttpDiagnostics, pageErrors, unhandled };
}

async function mockChartApis(page: Page, options: { rateLimitStockCalls?: number } = {}) {
  let stockCalls = 0;
  await page.route('**/api/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{}',
  }));
  await page.route('**/api/search/quotes**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      results: [
        { ticker: '005930', name: '삼성전자', market: 'KR', currency: 'KRW', price: 80_000, changePercent: 1.2, rating: { rating: 'BUY', confidence: 80, score: 80 } },
        { ticker: 'AAPL', name: 'Apple', market: 'US', currency: 'USD', price: 250, changePercent: -0.4, rating: { rating: 'HOLD', confidence: 70, score: 60 } },
      ],
    }),
  }));
  await page.route('**/api/crypto/spot/markets**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ markets: [{ market: 'KRW-BTC', symbol: 'BTC', koreanName: '비트코인', englishName: 'Bitcoin' }] }),
  }));
  await page.route('**/api/crypto/futures/tickers**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ tickers: [{ symbol: 'BTCUSDT', markPrice: 65_000, changePercent24h: 0.8 }] }),
  }));
  await page.route('**/api/stocks/*/chart**', async (route) => {
    stockCalls += 1;
    const url = route.request().url();
    const frame = timeframeFrom(url);
    const ticker = decodeURIComponent(new URL(url).pathname.split('/').at(-2) ?? '');
    if (options.rateLimitStockCalls && stockCalls <= options.rateLimitStockCalls) {
      await route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ message: 'RATE_LIMITED' }) });
      return;
    }
    if (ticker.includes('BAD') || ticker === '999999') {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'NOT_FOUND' }) });
      return;
    }
    if (frame === '1m') await new Promise((resolve) => setTimeout(resolve, 600));
    const step = frame === '1D' ? 86_400 : frame === '4H' ? 14_400 : frame === '1H' ? 3_600 : Number(frame.replace('m', '')) * 60;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        provider: 'fixture-stock',
        fetchedAt: '2026-08-04T06:30:00.000Z',
        updatedAt: '2026-08-04T06:30:00.000Z',
        candles: candles(FRAME_BASE[frame] ?? 30_000, step),
      }),
    }).catch(() => undefined);
  });
  await page.route('**/api/stocks/*/candles**', (route) => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ message: 'NOT_FOUND' }),
  }));
  await page.route('**/api/crypto/spot/candles**', (route) => {
    const parsed = new URL(route.request().url());
    const frame = parsed.searchParams.get('tf') === '1D' ? '1D' : parsed.searchParams.get('unit') === '240' ? '4H' : parsed.searchParams.get('unit') === '60' ? '1H' : `${parsed.searchParams.get('unit') ?? '15'}m`;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ provider: 'upbit-fixture', fetchedAt: '2026-08-04T06:30:00.000Z', updatedAt: '2026-08-04T06:30:00.000Z', candles: candles((FRAME_BASE[frame] ?? 40_000) + 100_000) }),
    });
  });
  await page.route('**/api/crypto/futures/candles**', (route) => {
    const parsed = new URL(route.request().url());
    const symbol = parsed.searchParams.get('symbol') ?? '';
    if (symbol.includes('BAD') || symbol.includes('EMPTY')) {
      return route.fulfill({ status: symbol.includes('EMPTY') ? 200 : 502, contentType: 'application/json', body: JSON.stringify(symbol.includes('EMPTY') ? { provider: 'bitget-fixture', candles: [] } : { message: 'BITGET_CANDLES_UNAVAILABLE' }) });
    }
    const frame = parsed.searchParams.get('granularity') ?? '15m';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ provider: 'bitget-fixture', fetchedAt: '2026-08-04T06:30:00.000Z', updatedAt: '2026-08-04T06:30:00.000Z', candles: candles((FRAME_BASE[frame] ?? 40_000) + 200_000) }),
    });
  });
}

async function openChart(page: Page) {
  await page.goto('/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m');
  await expect(page.getByRole('heading', { name: 'AI 차트 생중계', level: 1 })).toBeVisible();
  await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();
}

test('desktop chart changes market and timeframe, ignores a late request, persists indicators, and exposes controls', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = monitorBrowserErrors(page);
  await mockChartApis(page);
  await openChart(page);

  await page.getByTestId('timeframe-1m').click();
  await page.getByTestId('timeframe-15m').click();
  await expect(page).toHaveURL(/timeframe=15m/);
  const currentPrice = page.getByText('현재가', { exact: true }).locator('xpath=../..');
  await expect(currentPrice).toContainText('40,081원');
  await page.waitForTimeout(800);
  await expect(currentPrice).toContainText('40,081원');

  for (const [market, expectedProvider] of [['US', 'fixture-stock'], ['UPBIT', 'upbit-fixture'], ['BITGET', 'bitget-fixture']] as const) {
    await page.getByTestId(`market-${market}`).click();
    await expect(page).toHaveURL(new RegExp(`market=${market}`));
    await expect(page.getByText(expectedProvider, { exact: false })).toBeVisible();
    await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();
  }

  await page.getByTestId('chart-fit-content').click();
  await page.getByTestId('chart-latest-candle').click();
  await page.getByTestId('chart-fullscreen').click();
  await page.keyboard.press('Escape');
  await page.getByText('지표 설정 · 브라우저 저장').click();
  await page.getByTestId('overlay-sma20').click();
  await expect(page.getByTestId('overlay-sma20')).toContainText('+ SMA20');
  await page.reload();
  await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();
  await page.getByText('지표 설정 · 브라우저 저장').click();
  await expect(page.getByTestId('overlay-sma20')).toContainText('+ SMA20');

  expect(errors.consoleErrors, `console errors: ${errors.consoleErrors.join('\n')}`).toEqual([]);
  expect(errors.pageErrors, `page errors: ${errors.pageErrors.join('\n')}`).toEqual([]);
  expect(errors.unhandled, `unexpected failed requests: ${errors.unhandled.join('\n')}`).toEqual([]);
});

test('invalid, empty, rate-limited, and recovered chart responses stay explicit', async ({ page }) => {
  const errors = monitorBrowserErrors(page);
  await mockChartApis(page, { rateLimitStockCalls: 2 });
  await page.goto('/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m');
  await expect(page.getByTestId('chart-error-state')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('RATE_LIMITED');
  await page.getByRole('button', { name: '다시 시도' }).click();
  await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();

  await page.getByTestId('market-BITGET').click();
  const symbolInput = page.getByLabel('차트 종목 심볼');
  await symbolInput.fill('EMPTYUSDT');
  await page.getByTestId('apply-chart-symbol').click();
  await expect(page.getByTestId('chart-empty-state')).toBeVisible();
  await symbolInput.fill('BADUSDT');
  await page.getByTestId('apply-chart-symbol').click();
  await expect(page.getByTestId('chart-error-state')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('BITGET_CANDLES_UNAVAILABLE');
  await symbolInput.fill('BTCUSDT');
  await page.getByTestId('apply-chart-symbol').click();
  await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();

  expect(errors.expectedHttpDiagnostics.some((item) => item.includes('429'))).toBe(true);
  expect(errors.expectedHttpDiagnostics.some((item) => item.includes('502'))).toBe(true);
  expect(errors.consoleErrors, `unexpected console errors: ${errors.consoleErrors.join('\n')}`).toEqual([]);
  expect(errors.pageErrors, `page errors: ${errors.pageErrors.join('\n')}`).toEqual([]);
  expect(errors.unhandled, `unexpected failed requests: ${errors.unhandled.join('\n')}`).toEqual([]);
});

test('mobile touch layout and landscape resize keep the chart inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = monitorBrowserErrors(page);
  await mockChartApis(page);
  await openChart(page);
  await page.getByTestId('market-UPBIT').click();
  await page.getByTestId('timeframe-4H').click();
  await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();
  await page.touchscreen.tap(180, 500);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByTestId('unified-chart-wrapper')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  expect(errors.consoleErrors, `console errors: ${errors.consoleErrors.join('\n')}`).toEqual([]);
  expect(errors.pageErrors, `page errors: ${errors.pageErrors.join('\n')}`).toEqual([]);
  expect(errors.unhandled, `unexpected failed requests: ${errors.unhandled.join('\n')}`).toEqual([]);
});
