import { test, expect, type Page, type Route } from '@playwright/test';

const now = Date.now();

function spotTickers() {
  return [
    { market: 'KRW-BTC', symbol: 'BTC', price: 100_000_000, change: 'RISE', changeRate: 0.03, changePercent: 3, changePrice: 3_000_000, high24h: 105_000_000, low24h: 95_000_000, volume24h: 10_000, tradingValue24h: 1_000_000_000_000, timestamp: now },
    { market: 'KRW-ETH', symbol: 'ETH', price: 5_000_000, change: 'RISE', changeRate: 0.02, changePercent: 2, changePrice: 100_000, high24h: 5_500_000, low24h: 4_500_000, volume24h: 50_000, tradingValue24h: 300_000_000_000, timestamp: now },
  ];
}

function futuresCandles(direction: 'up' | 'down' = 'up') {
  return Array.from({ length: 35 }, (_, index) => {
    const base = direction === 'up' ? 80 + index * 0.7 : 120 - index * 0.7;
    const counterMove = index < 34 && index % 4 === 3 ? 2.5 : 0;
    const close = direction === 'up' ? base - counterMove : base + counterMove;
    return { time: now - (35 - index) * 60_000, open: close - 0.2, high: close + 0.8, low: close - 0.8, close, volume: index === 34 ? 2_000 : 1_000, quoteVolume: close * 1_000 };
  });
}

function futuresTickers() {
  return [
    { symbol: 'BTCUSDT', price: 103, markPrice: 103, indexPrice: 103, changeRate24h: 0.05, changePercent24h: 5, changePercent: 5, high24h: 110, low24h: 80, volume24h: 1_000_000, tradingValue24h: 100_000_000, fundingRate: 0.0001, fundingRatePercent: 0.01, openInterest: 5_000_000, bidPrice: 102.95, askPrice: 103.05, timestamp: now },
    { symbol: 'ETHUSDT', price: 96, markPrice: 96, indexPrice: 96, changeRate24h: -0.03, changePercent24h: -3, changePercent: -3, high24h: 110, low24h: 90, volume24h: 800_000, tradingValue24h: 70_000_000, fundingRate: -0.0001, fundingRatePercent: -0.01, openInterest: 4_000_000, bidPrice: 95.95, askPrice: 96.05, timestamp: now },
  ];
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockPublicCryptoApis(page: Page, options: { marketFailure?: boolean; ethCandleFailure?: boolean } = {}) {
  const privateRequests: string[] = [];
  const mutationRequests: string[] = [];
  await page.route('**/api/crypto/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') mutationRequests.push(`${request.method()} ${url.pathname}`);
    if (/\/auto(?:\/|$)|\/account(?:\/|$)|\/positions(?:\/|$)|\/orders?(?:\/|$)/.test(url.pathname)) {
      privateRequests.push(url.pathname);
      return fulfillJson(route, { error: 'PRIVATE_ROUTE_MUST_NOT_BE_CALLED' }, 500);
    }
    if (url.pathname.endsWith('/crypto/spot/markets')) {
      return options.marketFailure
        ? fulfillJson(route, { markets: [], error: 'UPBIT_MARKETS_UNAVAILABLE' }, 502)
        : fulfillJson(route, { markets: [
          { market: 'KRW-BTC', symbol: 'BTC', koreanName: '비트코인', englishName: 'Bitcoin', warning: false },
          { market: 'KRW-ETH', symbol: 'ETH', koreanName: '이더리움', englishName: 'Ethereum', warning: false },
        ], updatedAt: new Date(now).toISOString() });
    }
    if (url.pathname.endsWith('/crypto/spot/tickers')) {
      return fulfillJson(route, { tickers: spotTickers(), updatedAt: new Date(now).toISOString() });
    }
    if (url.pathname.endsWith('/crypto/futures/tickers')) {
      return fulfillJson(route, { tickers: futuresTickers(), updatedAt: new Date(now).toISOString() });
    }
    if (url.pathname.endsWith('/crypto/futures/candles')) {
      const symbol = url.searchParams.get('symbol') ?? '';
      if (options.ethCandleFailure && symbol === 'ETHUSDT') {
        return fulfillJson(route, { candles: [], error: 'BITGET_CANDLES_UNAVAILABLE' }, 502);
      }
      return fulfillJson(route, { candles: futuresCandles(symbol === 'ETHUSDT' ? 'down' : 'up') });
    }
    return fulfillJson(route, { error: 'UNEXPECTED_PUBLIC_CRYPTO_ROUTE' }, 404);
  });
  return { privateRequests, mutationRequests };
}

function captureFailures(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  return { consoleErrors, pageErrors };
}

for (const width of [360, 390, 430]) {
  test(`spot and futures scanners stay separated on ${width}px mobile`, async ({ page }) => {
    const failures = captureFailures(page);
    const requests = await mockPublicCryptoApis(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/__phase12-scanner-markets-e2e');

    await expect(page.getByRole('heading', { name: '코인 현물 신호검색기' })).toBeVisible();
    await expect(page.getByText(/비트코인/)).toBeVisible();
    await expect(page.getByText('BTCUSDT', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/공개 현물 시세 검색만 수행/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await page.getByRole('button', { name: '코인 선물', exact: true }).click();
    await expect(page.getByRole('heading', { name: '코인 선물 신호검색기' })).toBeVisible();
    await expect(page.getByText(/위 · BTCUSDT$/)).toBeVisible();
    await expect(page.getByText(/비트코인/)).toHaveCount(0);
    await expect(page.getByText(/비공개 계좌·포지션·주문·자동매매 API를 호출하거나 버튼으로 노출하지 않습니다/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    expect(requests.privateRequests).toEqual([]);
    expect(requests.mutationRequests).toEqual([]);
    expect(failures.consoleErrors).toEqual([]);
    expect(failures.pageErrors).toEqual([]);
  });
}

test('desktop scanner keeps results usable and handles partial providers', async ({ page }) => {
  const failures = captureFailures(page);
  const requests = await mockPublicCryptoApis(page, { marketFailure: true, ethCandleFailure: true });
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/__phase12-scanner-markets-e2e');

  await expect(page.getByRole('heading', { name: '코인 현물 신호검색기' })).toBeVisible();
  await expect(page.getByText(/마켓 이름 공급자 일부 실패/)).toBeVisible();
  await expect(page.getByText('BTC', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '코인 선물', exact: true }).click();
  await expect(page.getByText(/일부 캔들 공급자 실패 1건/)).toBeVisible();
  await expect(page.getByText(/위 · BTCUSDT$/)).toBeVisible();
  await expect(page.getByText(/공급자 기준/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  expect(requests.privateRequests).toEqual([]);
  expect(requests.mutationRequests).toEqual([]);
  expect(failures.consoleErrors).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
});
