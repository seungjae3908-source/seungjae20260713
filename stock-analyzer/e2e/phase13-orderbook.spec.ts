import { expect, test, type Page, type Request as PlaywrightRequest, type Route } from '@playwright/test';

const receivedAt = '2026-08-05T03:30:10.000Z';

type Fixture = Record<string, unknown>;
type FixtureResponse = { body: Fixture; delayMs?: number; status?: number };
type FixtureFactory = (
  requestCount: number,
  url: URL,
  request: PlaywrightRequest,
) => Fixture | FixtureResponse | Promise<Fixture | FixtureResponse>;

function stockReady(overrides: Fixture = {}): Fixture {
  return {
    ok: true,
    available: true,
    status: 'ready',
    assetClass: 'stock',
    market: 'KR',
    exchange: 'KRX',
    symbol: '005930',
    ticker: '005930',
    currency: 'KRW',
    provider: 'kiwoom',
    source: 'ka10004',
    sourceTimestampRaw: '20260805',
    updatedAt: null,
    receivedAt,
    freshness: 'unknown',
    stale: true,
    asks: [
      { rank: 1, price: 70_100, quantity: 120, cumulativeQuantity: 120 },
      { rank: 2, price: 70_200, quantity: 80, cumulativeQuantity: 200 },
    ],
    bids: [
      { rank: 1, price: 70_000, quantity: 150, cumulativeQuantity: 150 },
      { rank: 2, price: 69_900, quantity: 100, cumulativeQuantity: 250 },
    ],
    bestAsk: 70_100,
    bestBid: 70_000,
    spread: 100,
    spreadPercent: 0.14275517487508923,
    displayedAskQuantity: 200,
    displayedBidQuantity: 250,
    totalAskQuantity: 1_200,
    totalBidQuantity: 1_500,
    imbalance: 0.1111111111111111,
    warnings: [
      '공급자 응답에서 검증 가능한 갱신 시각을 확인할 수 없어 최신성을 보장하지 않습니다.',
    ],
    reason: null,
    orderSubmitted: false,
    exchangeRequestSent: false,
    ...overrides,
  };
}

function spotReady(overrides: Fixture = {}): Fixture {
  return {
    ...stockReady(),
    assetClass: 'crypto_spot',
    market: 'UPBIT',
    exchange: 'UPBIT',
    symbol: 'BTC',
    ticker: 'BTC',
    currency: 'KRW',
    provider: 'upbit',
    source: 'upbit_v1_orderbook',
    sourceTimestampRaw: '1785900605000',
    updatedAt: '2026-08-05T03:30:05.000Z',
    freshness: 'fresh',
    stale: false,
    asks: [
      { rank: 1, price: 150_100_000, quantity: 0.4, cumulativeQuantity: 0.4 },
      { rank: 2, price: 150_200_000, quantity: 0.6, cumulativeQuantity: 1 },
    ],
    bids: [
      { rank: 1, price: 149_900_000, quantity: 0.7, cumulativeQuantity: 0.7 },
      { rank: 2, price: 149_800_000, quantity: 0.8, cumulativeQuantity: 1.5 },
    ],
    bestAsk: 150_100_000,
    bestBid: 149_900_000,
    spread: 200_000,
    spreadPercent: 0.1333333333,
    displayedAskQuantity: 1,
    displayedBidQuantity: 1.5,
    totalAskQuantity: 4.2,
    totalBidQuantity: 5.4,
    imbalance: 0.2,
    warnings: [],
    ...overrides,
  };
}

function futuresReady(overrides: Fixture = {}): Fixture {
  return {
    ...stockReady(),
    assetClass: 'crypto_futures',
    market: 'BITGET',
    exchange: 'BITGET',
    symbol: 'BTCUSDT',
    ticker: 'BTCUSDT',
    currency: 'USDT',
    provider: 'bitget',
    source: 'bitget_v2_mix_market_merge_depth',
    sourceTimestampRaw: '1785900606000',
    updatedAt: '2026-08-05T03:30:06.000Z',
    freshness: 'fresh',
    stale: false,
    asks: [
      { rank: 1, price: 114_000.5, quantity: 0.8, cumulativeQuantity: 0.8 },
      { rank: 2, price: 114_010.5, quantity: 1.2, cumulativeQuantity: 2 },
    ],
    bids: [
      { rank: 1, price: 113_990.5, quantity: 0.9, cumulativeQuantity: 0.9 },
      { rank: 2, price: 113_980.5, quantity: 1.1, cumulativeQuantity: 2 },
    ],
    bestAsk: 114_000.5,
    bestBid: 113_990.5,
    spread: 10,
    spreadPercent: 0.008772,
    displayedAskQuantity: 2,
    displayedBidQuantity: 2,
    totalAskQuantity: null,
    totalBidQuantity: null,
    imbalance: 0,
    warnings: [],
    ...overrides,
  };
}

function providerError(
  assetClass: 'crypto_spot' | 'crypto_futures',
  reason: string,
): Fixture {
  const base = assetClass === 'crypto_spot' ? spotReady() : futuresReady();
  return {
    ...base,
    ok: false,
    available: false,
    status: 'provider_error',
    asks: [],
    bids: [],
    bestAsk: null,
    bestBid: null,
    spread: null,
    spreadPercent: null,
    displayedAskQuantity: 0,
    displayedBidQuantity: 0,
    totalAskQuantity: null,
    totalBidQuantity: null,
    imbalance: null,
    warnings: [],
    reason,
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function captureFailures(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const expectedOrderbookAborts: string[] = [];
  const unexpectedHttpErrors: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    const path = new URL(request.url()).pathname;
    const failure = request.failure()?.errorText ?? '';
    if (path === '/api/orderbook' && /ERR_ABORTED|NS_BINDING_ABORTED|cancel/i.test(failure)) {
      expectedOrderbookAborts.push(`${request.method()} ${path} ${failure}`);
      return;
    }
    requestFailures.push(`${request.method()} ${path} ${failure}`.trim());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      const request = response.request();
      unexpectedHttpErrors.push(
        `${response.status()} ${request.method()} ${new URL(response.url()).pathname}`,
      );
    }
  });

  return {
    consoleErrors,
    pageErrors,
    requestFailures,
    expectedOrderbookAborts,
    unexpectedHttpErrors,
  };
}

function asFixtureResponse(value: Fixture | FixtureResponse): FixtureResponse {
  return 'body' in value ? value : { body: value };
}

async function safeDelayedFulfill(route: Route, response: FixtureResponse) {
  if (response.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs));
  try {
    await fulfillJson(route, response.body, response.status ?? 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/closed|already handled|intercepted request|Target page|Target context/i.test(message)) {
      throw error;
    }
  }
}

async function mockOrderbook(page: Page, fixture: Fixture | FixtureFactory) {
  const requests: string[] = [];
  const mutationRequests: string[] = [];
  const privateRequests: string[] = [];
  let requestCount = 0;

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(`${request.method()} ${url.pathname}${url.search}`);

    if (request.method() !== 'GET') mutationRequests.push(`${request.method()} ${url.pathname}`);

    if (
      /\/(?:account|accounts|balance|balances|positions|orders?|auto)(?:\/|$)/.test(url.pathname)
      || url.pathname.startsWith('/api/kiwoom/')
      || url.pathname.includes('/private/')
    ) {
      privateRequests.push(url.pathname);
      return fulfillJson(route, {
        ok: false,
        error: 'PRIVATE_OR_RAW_PROVIDER_ROUTE_MUST_NOT_BE_CALLED',
      }, 500);
    }

    if (url.pathname === '/api/orderbook') {
      requestCount += 1;
      const value = typeof fixture === 'function'
        ? await fixture(requestCount, url, request)
        : fixture;
      return safeDelayedFulfill(route, asFixtureResponse(value));
    }

    return fulfillJson(route, { ok: false, error: 'UNEXPECTED_ROUTE' }, 404);
  });

  return {
    requests,
    mutationRequests,
    privateRequests,
    get requestCount() { return requestCount; },
  };
}

function expectNoFailures(
  failures: ReturnType<typeof captureFailures>,
  requests: Awaited<ReturnType<typeof mockOrderbook>>,
) {
  expect(requests.mutationRequests).toEqual([]);
  expect(requests.privateRequests).toEqual([]);
  expect(failures.consoleErrors).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
  expect(failures.requestFailures).toEqual([]);
  expect(failures.unexpectedHttpErrors).toEqual([]);
}

async function expectMinimumTouchTarget(locator: ReturnType<Page['getByRole']>) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
}

for (const width of [360, 390, 430]) {
  test(`KR stock orderbook stays usable and read-only on ${width}px mobile`, async ({ page }) => {
    const failures = captureFailures(page);
    const requests = await mockOrderbook(page, stockReady());

    await page.setViewportSize({ width, height: 844 });
    await page.goto('/__phase13-orderbook-e2e?ticker=005930&market=KR&assetClass=stock');

    const dialog = page.getByRole('dialog', { name: /005930 호가창/ });
    const refresh = dialog.getByRole('button', { name: '호가 새로고침' });
    const close = dialog.getByRole('button', { name: '호가창 닫기' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('읽기 전용')).toBeVisible();
    await expect(dialog.getByText('키움 ka10004')).toBeVisible();
    await expect(dialog.getByText('공급자 최신성 확인 불가')).toBeVisible();
    await expect(dialog.getByText('누적잔량')).toBeVisible();
    await expect(dialog.getByRole('list', { name: '매도 호가' })).toBeVisible();
    await expect(dialog.getByRole('list', { name: '매수 호가' })).toBeVisible();
    await expect(dialog.getByTestId('ask-level-1')).toContainText('매도 1호');
    await expect(dialog.getByTestId('ask-level-1')).toContainText('70,100');
    await expect(dialog.getByTestId('ask-level-2')).toContainText('200');
    await expect(dialog.getByTestId('bid-level-1')).toContainText('매수 1호');
    await expect(dialog.getByTestId('bid-level-1')).toContainText('70,000');
    await expect(dialog.getByRole('button', { name: /매수|매도|주문|취소|계좌|잔고|포지션/ })).toHaveCount(0);
    await expect(dialog.getByText(/WebSocket 실시간 스트림이 아니며/)).toBeVisible();
    await expectMinimumTouchTarget(refresh);
    await expectMinimumTouchTarget(close);

    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);

    expect(requests.requests.some((request) =>
      request.includes('GET /api/orderbook?assetClass=stock&market=KR&symbol=005930'),
    )).toBe(true);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    const opener = page.getByRole('button', { name: '읽기 전용 호가창 열기' });
    await expect(opener).toBeFocused();
    await expectMinimumTouchTarget(opener);

    const countAfterClose = requests.requestCount;
    await page.waitForTimeout(3_200);
    expect(requests.requestCount).toBe(countAfterClose);
    expectNoFailures(failures, requests);
  });
}

test('desktop renders one-sided depth only as explicit partial data', async ({ page }) => {
  const failures = captureFailures(page);
  const requests = await mockOrderbook(page, stockReady({
    status: 'partial',
    asks: [],
    bestAsk: null,
    spread: null,
    spreadPercent: null,
    displayedAskQuantity: 0,
    warnings: ['매도 또는 매수 한쪽 호가가 비어 있어 부분 데이터로 표시합니다.'],
  }));

  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/__phase13-orderbook-e2e?ticker=005930&market=KR&assetClass=stock');

  const dialog = page.getByRole('dialog', { name: /005930 호가창/ });
  await expect(dialog.getByText(/부분 데이터로 표시합니다/)).toBeVisible();
  await expect(dialog.getByRole('list', { name: '매도 호가' })).toBeEmpty();
  await expect(dialog.getByRole('list', { name: '매수 호가' })).not.toBeEmpty();
  await expect(dialog.getByTestId('bid-level-1')).toBeVisible();
  expectNoFailures(failures, requests);
});

test('US stock explicitly shows disconnected provider without fake levels or polling', async ({ page }) => {
  const failures = captureFailures(page);
  const requests = await mockOrderbook(page, stockReady({
    ok: false,
    available: false,
    status: 'unavailable',
    market: 'US',
    exchange: 'US',
    symbol: 'AAPL',
    ticker: 'AAPL',
    currency: 'USD',
    provider: null,
    source: null,
    asks: [],
    bids: [],
    bestAsk: null,
    bestBid: null,
    spread: null,
    spreadPercent: null,
    displayedAskQuantity: 0,
    displayedBidQuantity: 0,
    totalAskQuantity: null,
    totalBidQuantity: null,
    imbalance: null,
    warnings: [],
    reason: 'US_ORDERBOOK_PROVIDER_NOT_CONNECTED',
  }));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__phase13-orderbook-e2e?ticker=AAPL&market=US&assetClass=stock');

  const dialog = page.getByRole('dialog', { name: /AAPL 호가창/ });
  await expect(dialog.getByText('호가 제공 불가')).toBeVisible();
  await expect(dialog.getByText(/미국 주식 호가 공급자는 아직 연결되지 않았습니다/)).toBeVisible();
  await expect(dialog.getByTestId(/ask-level|bid-level/)).toHaveCount(0);
  await page.waitForTimeout(3_200);
  expect(requests.requestCount).toBe(1);
  expectNoFailures(failures, requests);
});

test('crossed orderbook is blocked instead of rendered or repaired', async ({ page }) => {
  const failures = captureFailures(page);
  const requests = await mockOrderbook(page, stockReady({
    available: true,
    status: 'ready',
    asks: [{ rank: 1, price: 70_000, quantity: 1, cumulativeQuantity: 1 }],
    bids: [{ rank: 1, price: 70_100, quantity: 1, cumulativeQuantity: 1 }],
    bestAsk: 70_000,
    bestBid: 70_100,
    warnings: [],
  }));

  await page.goto('/__phase13-orderbook-e2e?ticker=005930&market=KR&assetClass=stock');
  const dialog = page.getByRole('dialog', { name: /005930 호가창/ });
  await expect(dialog.getByText(/교차 호가가 감지되어 안전을 위해 표시를 차단했습니다/)).toBeVisible();
  await expect(dialog.getByText(/클라이언트에서도 표시를 차단했습니다/)).toBeVisible();
  await expect(dialog.getByTestId(/ask-level|bid-level/)).toHaveCount(0);
  expectNoFailures(failures, requests);
});

test('Upbit spot uses the shared contract and public provider label', async ({ page }) => {
  const failures = captureFailures(page);
  const requests = await mockOrderbook(page, spotReady());

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__phase13-orderbook-e2e?ticker=BTC&market=UPBIT&assetClass=crypto_spot');

  const dialog = page.getByRole('dialog', { name: /BTC 호가창/ });
  await expect(dialog.getByText('Upbit 공개 REST')).toBeVisible();
  await expect(dialog.getByText(/Upbit 코인 현물 · KRW/)).toBeVisible();
  await expect(dialog.getByText('공급자 시각 기준 최신')).toBeVisible();
  await expect(dialog.getByTestId('ask-level-1')).toContainText('150,100,000');
  await expect(dialog.getByTestId('bid-level-2')).toContainText('1.5');
  expect(requests.requests.some((request) =>
    request.includes('assetClass=crypto_spot&market=UPBIT&symbol=BTC'),
  )).toBe(true);
  expectNoFailures(failures, requests);
});

test('Bitget futures uses shared depth without account or position requests', async ({ page }) => {
  const failures = captureFailures(page);
  const requests = await mockOrderbook(page, futuresReady());

  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/__phase13-orderbook-e2e?ticker=BTCUSDT&market=BITGET&assetClass=crypto_futures');

  const dialog = page.getByRole('dialog', { name: /BTCUSDT 호가창/ });
  await expect(dialog.getByText('Bitget 공개 REST')).toBeVisible();
  await expect(dialog.getByText(/Bitget 코인 선물 · USDT/)).toBeVisible();
  await expect(dialog.getByTestId('ask-level-1')).toContainText('114,000.5');
  await expect(dialog.getByTestId('bid-level-1')).toContainText('113,990.5');
  expect(requests.requests.some((request) =>
    request.includes('assetClass=crypto_futures&market=BITGET&symbol=BTCUSDT'),
  )).toBe(true);
  expectNoFailures(failures, requests);
});

test('provider error keeps only same-target last normal data with its timestamps', async ({ page }) => {
  const failures = captureFailures(page);
  const requests = await mockOrderbook(page, (requestCount) => requestCount === 1
    ? spotReady()
    : providerError('crypto_spot', 'UPBIT_ORDERBOOK_PROVIDER_UNAVAILABLE'));

  await page.goto('/__phase13-orderbook-e2e?ticker=BTC&market=UPBIT&assetClass=crypto_spot');
  const dialog = page.getByRole('dialog', { name: /BTC 호가창/ });
  await expect(dialog.getByTestId('ask-level-1')).toContainText('150,100,000');
  await dialog.getByRole('button', { name: '호가 새로고침' }).click();
  await expect(dialog.getByText('갱신 실패 · 마지막 정상 데이터')).toBeVisible();
  await expect(dialog.getByText(/마지막 정상 데이터의 공급자·서버 기준시각을 유지합니다/)).toBeVisible();
  await expect(dialog.getByText(/공급자 시각 08\. 05\. 12:30:05/)).toBeVisible();
  await expect(dialog.getByTestId('ask-level-1')).toContainText('150,100,000');
  expect(requests.requestCount).toBeGreaterThanOrEqual(2);
  expectNoFailures(failures, requests);
});

test('focus trap, outside click and duplicate opening keep a single dialog', async ({ page }) => {
  const failures = captureFailures(page);
  const requests = await mockOrderbook(page, stockReady());
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/__phase13-orderbook-e2e?ticker=005930&market=KR&assetClass=stock');

  let dialog = page.getByRole('dialog', { name: /005930 호가창/ });
  const refresh = dialog.getByRole('button', { name: '호가 새로고침' });
  const close = dialog.getByRole('button', { name: '호가창 닫기' });
  await close.focus();
  await page.keyboard.press('Tab');
  await expect(refresh).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(close).toBeFocused();

  await page.getByTestId('orderbook-backdrop').click({ position: { x: 4, y: 4 } });
  await expect(dialog).toHaveCount(0);
  const opener = page.getByRole('button', { name: '읽기 전용 호가창 열기' });
  await expect(opener).toBeFocused();

  const beforeReopen = requests.requestCount;
  await opener.evaluate((button) => { button.click(); button.click(); });
  dialog = page.getByRole('dialog');
  await expect(dialog).toHaveCount(1);
  await expect.poll(() => requests.requestCount).toBe(beforeReopen + 1);
  await page.waitForTimeout(250);
  expect(requests.requestCount).toBe(beforeReopen + 1);
  expectNoFailures(failures, requests);
});

test('same-symbol polling is singular and hidden or unmounted views stop requests', async ({ page }) => {
  const failures = captureFailures(page);
  const requests = await mockOrderbook(page, stockReady());
  await page.goto('/__phase13-orderbook-e2e?ticker=005930&market=KR&assetClass=stock');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect.poll(() => requests.requestCount).toBe(1);

  await page.waitForTimeout(3_250);
  expect(requests.requestCount).toBe(2);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hiddenCount = requests.requestCount;
  await page.waitForTimeout(3_250);
  expect(requests.requestCount).toBe(hiddenCount);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => requests.requestCount).toBe(hiddenCount + 1);

  await page.getByTestId('orderbook-unmount').evaluate((button) => button.click());
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const unmountCount = requests.requestCount;
  await page.waitForTimeout(3_250);
  expect(requests.requestCount).toBe(unmountCount);
  expectNoFailures(failures, requests);
});

test('rapid market changes ignore older responses and keep query caches isolated', async ({ page }) => {
  const failures = captureFailures(page);
  const requests = await mockOrderbook(page, (_requestCount, url) => {
    const assetClass = url.searchParams.get('assetClass');
    if (assetClass === 'stock') return { body: stockReady(), delayMs: 700 };
    if (assetClass === 'crypto_spot') return { body: spotReady(), delayMs: 450 };
    return { body: futuresReady(), delayMs: 20 };
  });

  await page.goto('/__phase13-orderbook-e2e?ticker=005930&market=KR&assetClass=stock');
  await page.getByTestId('orderbook-target-spot').evaluate((button) => button.click());
  await page.getByTestId('orderbook-target-futures').evaluate((button) => button.click());

  const dialog = page.getByRole('dialog', { name: /BTCUSDT 호가창/ });
  await expect(dialog.getByText('Bitget 공개 REST')).toBeVisible();
  await expect(dialog.getByTestId('ask-level-1')).toContainText('114,000.5');
  await page.waitForTimeout(900);
  await expect(dialog.getByTestId('ask-level-1')).toContainText('114,000.5');
  await expect(dialog.getByText('150,100,000')).toHaveCount(0);
  await expect(dialog.getByText('70,100')).toHaveCount(0);

  expect(requests.requests.some((request) => request.includes('assetClass=stock&market=KR&symbol=005930'))).toBe(true);
  expect(requests.requests.some((request) => request.includes('assetClass=crypto_spot&market=UPBIT&symbol=BTC'))).toBe(true);
  expect(requests.requests.some((request) => request.includes('assetClass=crypto_futures&market=BITGET&symbol=BTCUSDT'))).toBe(true);
  expectNoFailures(failures, requests);
});

test('last normal data never crosses market boundaries after a target change', async ({ page }) => {
  const failures = captureFailures(page);
  const requests = await mockOrderbook(page, (_requestCount, url) =>
    url.searchParams.get('assetClass') === 'stock'
      ? stockReady()
      : providerError('crypto_spot', 'UPBIT_ORDERBOOK_PROVIDER_UNAVAILABLE'));

  await page.goto('/__phase13-orderbook-e2e?ticker=005930&market=KR&assetClass=stock');
  await expect(page.getByTestId('ask-level-1')).toContainText('70,100');
  await page.getByTestId('orderbook-target-spot').evaluate((button) => button.click());

  const dialog = page.getByRole('dialog', { name: /BTC 호가창/ });
  await expect(dialog.getByText('호가 조회 실패')).toBeVisible();
  await expect(dialog.getByText(/Upbit 공개 호가 공급자를 사용할 수 없습니다/)).toBeVisible();
  await expect(dialog.getByTestId(/ask-level|bid-level/)).toHaveCount(0);
  await expect(dialog.getByText('70,100')).toHaveCount(0);
  expectNoFailures(failures, requests);
});

test('network timeout is explicit and closing during retry stops further polling', async ({ page }) => {
  const failures = captureFailures(page);
  const requests = await mockOrderbook(page, {
    body: stockReady(),
    delayMs: 8_500,
  });

  await page.goto('/__phase13-orderbook-e2e?ticker=005930&market=KR&assetClass=stock');
  const dialog = page.getByRole('dialog', { name: /005930 호가창/ });
  await expect(dialog.getByText('호가 조회 실패')).toBeVisible({ timeout: 12_000 });
  await expect(dialog.getByText(/호가 조회 요청 시간이 초과되었습니다/)).toBeVisible();
  await dialog.getByRole('button', { name: '다시 시도' }).click();
  await dialog.getByRole('button', { name: '호가창 닫기' }).click();
  await expect(dialog).toHaveCount(0);
  const countAfterClose = requests.requestCount;
  await page.waitForTimeout(3_250);
  expect(requests.requestCount).toBe(countAfterClose);
  expectNoFailures(failures, requests);
});
