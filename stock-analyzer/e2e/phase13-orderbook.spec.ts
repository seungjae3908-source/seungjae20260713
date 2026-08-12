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
