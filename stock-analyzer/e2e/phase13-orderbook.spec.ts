import { expect, test, type Page } from '@playwright/test';

const readyFixture = {
  ok: true,
  available: true,
  status: 'ready',
  assetClass: 'stock',
  market: 'KR',
  symbol: '005930',
  ticker: '005930',
  currency: 'KRW',
  provider: 'kiwoom',
  providerTimestamp: '2026-08-13T03:20:05.000Z',
  receivedAt: '2026-08-13T03:20:06.000Z',
  freshness: 'fresh',
  asks: [
    { rank: 1, price: 70100, quantity: 120, cumulativeQuantity: 120 },
    { rank: 2, price: 70200, quantity: 80, cumulativeQuantity: 200 },
  ],
  bids: [
    { rank: 1, price: 70000, quantity: 150, cumulativeQuantity: 150 },
    { rank: 2, price: 69900, quantity: 100, cumulativeQuantity: 250 },
  ],
  bestAsk: 70100,
  bestBid: 70000,
  spread: 100,
  spreadPct: 0.142755,
  imbalance: 0.111111,
  warnings: [],
  reason: null,
  orderSubmitted: false,
  exchangeRequestSent: false,
};

function unavailableFixture(
  reason = 'ORDERBOOK_PROVIDER_UNAVAILABLE',
  identity: Partial<typeof readyFixture> = {},
) {
  return {
    ...readyFixture,
    ...identity,
    ok: false,
    available: false,
    status: 'unavailable',
    providerTimestamp: null,
    freshness: 'unknown',
    asks: [],
    bids: [],
    bestAsk: null,
    bestBid: null,
    spread: null,
    spreadPct: null,
    imbalance: null,
    reason,
  };
}

async function mockOrderbook(page: Page, fixture: Record<string, unknown> = readyFixture) {
  const calls: Array<{ method: string; url: string }> = [];
  await page.route('**/api/orderbook**', async (route) => {
    const request = route.request();
    calls.push({ method: request.method(), url: request.url() });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
  });
  return calls;
}

function privateTradingPath(url: string): boolean {
  const path = new URL(url).pathname;
  return /\/(accounts?|balances?|positions?|orders?|cancel|amend|withdraw|transfer|auto)(?:\/|$)/i.test(path);
}

for (const width of [360, 390, 430]) {
  test(`orderbook is a read-only bottom sheet at ${width}px`, async ({ page }) => {
    const calls = await mockOrderbook(page);
    const privateRequests: string[] = [];
    page.on('request', (request) => {
      if (privateTradingPath(request.url())) privateRequests.push(request.url());
    });

    await page.setViewportSize({ width, height: 844 });
    await page.goto('/__phase13-orderbook-e2e?ticker=005930&market=KR&assetClass=stock');

    const dialog = page.getByRole('dialog', { name: /005930 호가창/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('읽기 전용')).toBeVisible();
    await expect(dialog.getByText('Fresh', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Best Ask')).toBeVisible();
    await expect(dialog.getByText('Best Bid')).toBeVisible();
    await expect(dialog.getByText('Spread %')).toBeVisible();
    await expect(dialog.getByText('Cumulative')).toBeVisible();
    await expect(dialog.getByTestId('ask-level-1')).toContainText('70,100');
    await expect(dialog.getByTestId('bid-level-1')).toContainText('70,000');
    await expect(dialog.getByText(/ORDERBOOK_IMBALANCE != TRADE_SIGNAL/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: /매수|매도|주문|취소|정정|잔고|포지션/ })).toHaveCount(0);

    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.abs(((box?.y ?? 0) + (box?.height ?? 0)) - 844)).toBeLessThanOrEqual(2);
    expect((box?.width ?? width)).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    expect(privateRequests).toEqual([]);

    await dialog.getByRole('button', { name: '호가창 닫기' }).click();
    const countAfterClose = calls.length;
    await page.waitForTimeout(3_200);
    expect(calls.length).toBe(countAfterClose);
  });
}

test('desktop displays stale status without promoting depth imbalance to a signal', async ({ page }) => {
  const calls = await mockOrderbook(page, {
    ...readyFixture,
    status: 'stale',
    freshness: 'stale',
    providerTimestamp: '2026-08-13T03:15:00.000Z',
  });

  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/__phase13-orderbook-e2e?ticker=005930&market=KR&assetClass=stock');

  const dialog = page.getByRole('dialog', { name: /005930 호가창/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Stale', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Depth imbalance는 참고용 호가 통계이며 거래 신호가 아닙니다/)).toBeVisible();
  expect(calls.every((call) => call.method === 'GET')).toBe(true);
});

test('crossed book is fail-closed in the browser even if an upstream response regresses', async ({ page }) => {
  await mockOrderbook(page, {
    ...readyFixture,
    bestAsk: 70000,
    bestBid: 70100,
    asks: [{ rank: 1, price: 70000, quantity: 1, cumulativeQuantity: 1 }],
    bids: [{ rank: 1, price: 70100, quantity: 1, cumulativeQuantity: 1 }],
  });

  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/__phase13-orderbook-e2e?ticker=005930&market=KR&assetClass=stock');
  const dialog = page.getByRole('dialog', { name: /005930 호가창/ });
  await expect(dialog.getByText('Invalid')).toBeVisible();
  await expect(dialog.getByText(/교차 호가가 감지되어 클라이언트에서도 표시를 차단했습니다/)).toBeVisible();
  await expect(dialog.getByTestId('ask-levels')).toBeEmpty();
  await expect(dialog.getByTestId('bid-levels')).toBeEmpty();
});

test('dialog owns focus, traps Tab, closes with Escape or outside click, and restores opener focus', async ({ page }) => {
  await mockOrderbook(page);
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/__phase13-orderbook-e2e?ticker=005930&market=KR&assetClass=stock');

  const dialog = page.getByRole('dialog', { name: /005930 호가창/ });
  const closeButton = dialog.getByRole('button', { name: '호가창 닫기' });
  const refreshButton = dialog.getByRole('button', { name: '호가 새로고침' });
  const opener = page.getByRole('button', { name: '읽기 전용 호가창 열기' });
  await expect(closeButton).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(refreshButton).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(closeButton).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  await opener.click();
  await expect(dialog).toBeVisible();
  await page.getByTestId('instrument-orderbook-backdrop').click({ position: { x: 5, y: 5 } });
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test('unsupported or unavailable orderbook displays no fabricated price levels', async ({ page }) => {
  await mockOrderbook(page, unavailableFixture('US_ORDERBOOK_PROVIDER_NOT_CONNECTED', {
    market: 'US',
    symbol: 'AAPL',
    ticker: 'AAPL',
    currency: 'USD',
    provider: null,
  }));
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/__phase13-orderbook-e2e?ticker=AAPL&market=US&assetClass=stock');

  const dialog = page.getByRole('dialog', { name: /AAPL 호가창/ });
  await expect(dialog.getByText('Unavailable', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Provider unavailable')).toBeVisible();
  await expect(dialog.getByText('표시 가능한 실제 호가가 없습니다.')).toBeVisible();
  await expect(dialog.getByTestId('ask-levels')).toBeEmpty();
  await expect(dialog.getByTestId('bid-levels')).toBeEmpty();
  await expect(dialog.getByText('US_ORDERBOOK_PROVIDER_NOT_CONNECTED')).toHaveCount(0);
});

test('same-target provider failure uses only the last fresh book and marks it stale', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/orderbook**', async (route) => {
    calls += 1;
    const body = calls === 1 ? readyFixture : unavailableFixture();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/__phase13-orderbook-e2e?ticker=005930&market=KR&assetClass=stock');

  const dialog = page.getByRole('dialog', { name: /005930 호가창/ });
  await expect(dialog.getByText('Fresh', { exact: true })).toBeVisible();
  await expect.poll(() => calls, { timeout: 4_500 }).toBeGreaterThanOrEqual(2);
  await expect(dialog.getByText('Stale', { exact: true })).toBeVisible();
  await expect(dialog.getByTestId('ask-level-1')).toContainText('70,100');
  await expect(dialog.getByText(/마지막 정상 호가를 stale 상태로 표시합니다/)).toBeVisible();
});

test('wrong response identity is fail-closed and never replaced with prior last-good data', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/orderbook**', async (route) => {
    calls += 1;
    const body = calls === 1 ? readyFixture : {
      ...readyFixture,
      market: 'US',
      symbol: 'AAPL',
      currency: 'USD',
    };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/__phase13-orderbook-e2e?ticker=005930&market=KR&assetClass=stock');
  const dialog = page.getByRole('dialog', { name: /005930 호가창/ });
  await expect(dialog.getByText('Fresh', { exact: true })).toBeVisible();
  await expect.poll(() => calls, { timeout: 4_500 }).toBeGreaterThanOrEqual(2);
  await expect(dialog.getByText('Invalid', { exact: true })).toBeVisible();
  await expect(dialog.getByText('ORDERBOOK_IDENTITY_MISMATCH')).toBeVisible();
  await expect(dialog.getByTestId('ask-levels')).toBeEmpty();
  await expect(dialog.getByTestId('bid-levels')).toBeEmpty();
});

test('late response from the previous symbol is rejected after an in-place symbol switch', async ({ page }) => {
  const seen: string[] = [];
  await page.route('**/api/orderbook**', async (route) => {
    const url = new URL(route.request().url());
    const symbol = url.searchParams.get('symbol') ?? '';
    seen.push(symbol);
    if (symbol === '005930') {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(readyFixture) });
      } catch {
        // The old request is expected to be aborted by the target switch.
      }
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...readyFixture,
        symbol: '000660',
        ticker: '000660',
        asks: [{ rank: 1, price: 120100, quantity: 2, cumulativeQuantity: 2 }],
        bids: [{ rank: 1, price: 120000, quantity: 3, cumulativeQuantity: 3 }],
        bestAsk: 120100,
        bestBid: 120000,
      }),
    });
  });

  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/__phase13-orderbook-e2e?ticker=005930&market=KR&assetClass=stock');
  await page.waitForTimeout(30);
  await page.evaluate(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('ticker', '000660');
    window.history.pushState({}, '', `${url.pathname}${url.search}`);
  });

  const dialog = page.getByRole('dialog', { name: /000660 호가창/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('ask-level-1')).toContainText('120,100');
  await page.waitForTimeout(300);
  await expect(dialog.getByTestId('ask-level-1')).toContainText('120,100');
  expect(seen).toContain('005930');
  expect(seen).toContain('000660');
});

test('query-only market switch aborts the old owner and applies only the new canonical target', async ({ page }) => {
  const seen: string[] = [];
  await page.route('**/api/orderbook**', async (route) => {
    const url = new URL(route.request().url());
    const key = `${url.searchParams.get('assetClass')}:${url.searchParams.get('market')}:${url.searchParams.get('symbol')}`;
    seen.push(key);
    if (key === 'stock:KR:005930') {
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(readyFixture) });
      } catch {
        // Expected if the market switch cancels the old request.
      }
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...readyFixture,
        assetClass: 'crypto_spot',
        market: 'UPBIT',
        symbol: 'BTC',
        ticker: 'BTC',
        currency: 'KRW',
        provider: 'upbit',
        asks: [{ rank: 1, price: 100100000, quantity: 0.2, cumulativeQuantity: 0.2 }],
        bids: [{ rank: 1, price: 100000000, quantity: 0.3, cumulativeQuantity: 0.3 }],
        bestAsk: 100100000,
        bestBid: 100000000,
        spread: 100000,
      }),
    });
  });

  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/__phase13-orderbook-e2e?ticker=005930&market=KR&assetClass=stock');
  await page.waitForTimeout(30);
  await page.evaluate(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('ticker', 'BTC');
    url.searchParams.set('market', 'UPBIT');
    url.searchParams.set('assetClass', 'crypto_spot');
    window.history.pushState({}, '', `${url.pathname}${url.search}`);
  });

  const dialog = page.getByRole('dialog', { name: /BTC 호가창/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Upbit public REST')).toBeVisible();
  await expect(dialog.getByTestId('ask-level-1')).toContainText('100,100,000');
  await page.waitForTimeout(250);
  await expect(dialog.getByTestId('ask-level-1')).toContainText('100,100,000');
  expect(seen).toContain('stock:KR:005930');
  expect(seen).toContain('crypto_spot:UPBIT:BTC');
});

test('single polling owner issues one request per interval for the same key', async ({ page }) => {
  const calls = await mockOrderbook(page);
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/__phase13-orderbook-e2e?ticker=005930&market=KR&assetClass=stock');
  await expect.poll(() => calls.length, { timeout: 4_500 }).toBe(2);
  await page.waitForTimeout(400);
  expect(calls.length).toBe(2);
});
