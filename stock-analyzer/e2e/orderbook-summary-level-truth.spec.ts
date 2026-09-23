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
  providerTimestamp: '2026-09-23T18:40:05.000Z',
  receivedAt: '2026-09-23T18:40:06.000Z',
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

async function serve(page: Page, body: Record<string, unknown>) {
  await page.route('**/api/orderbook**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/__phase13-orderbook-e2e?ticker=005930&market=KR&assetClass=stock');
  return page.getByRole('dialog', { name: /005930 호가창/ });
}

test('fails closed when declared best ask disagrees with the visible ask ladder', async ({ page }) => {
  const dialog = await serve(page, { ...readyFixture, bestAsk: 70200, spread: 200 });

  await expect(dialog.getByText('Invalid', { exact: true })).toBeVisible();
  await expect(dialog.getByText('ORDERBOOK_LEVELS_CORRUPT')).toBeVisible();
  await expect(dialog.getByTestId('ask-levels')).toBeEmpty();
  await expect(dialog.getByTestId('bid-levels')).toBeEmpty();
});

test('fails closed when declared spread disagrees with canonical best ask and bid', async ({ page }) => {
  const dialog = await serve(page, { ...readyFixture, spread: 999 });

  await expect(dialog.getByText('Invalid', { exact: true })).toBeVisible();
  await expect(dialog.getByText('ORDERBOOK_LEVELS_CORRUPT')).toBeVisible();
  await expect(dialog.getByTestId('ask-levels')).toBeEmpty();
  await expect(dialog.getByTestId('bid-levels')).toBeEmpty();
});
