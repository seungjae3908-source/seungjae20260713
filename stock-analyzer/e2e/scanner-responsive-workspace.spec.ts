import { expect, test, type Page, type Route } from '@playwright/test';

const forbiddenRequest = /\/(?:stocks\/auto-trade|trade-automation|paper-trading|crypto\/(?:spot\/accounts|futures\/(?:auto|account|positions))|orders?|cancel)(?:[/?]|$)/i;

function scannerPayload(assetClass: 'stock' | 'coin_spot' | 'coin_futures', market: string) {
  return {
    ok: true,
    requestId: `responsive:${assetClass}:${market}`,
    assetClass,
    market,
    timeframe: '5m',
    cards: [],
    alerts: [],
    failures: [],
    execution: {
      requestedCount: 1,
      startedCount: 1,
      completedCount: 1,
      excludedCount: 1,
      providerErrorCount: 0,
      timeoutCount: 0,
      partial: false,
      timedOut: false,
      cancelled: false,
      duplicate: false,
      elapsedMs: 12,
      deadlineMs: 12_000,
      itemTimeoutMs: 3_500,
      maxConcurrency: 1,
      providerAcceptedCount: 1,
      dataSuccessCount: 1,
      insufficientDataCount: 0,
      filteredByStrategyCount: 1,
      hardFilterRejectedCount: 0,
      finalDisplayedCount: 0,
    },
    universe: {
      totalCount: 1,
      cursor: 0,
      nextCursor: null,
      source: assetClass === 'coin_spot' ? 'upbit-public' : assetClass === 'coin_futures' ? 'bitget-public' : 'fixture-stock',
      partial: false,
      stale: false,
      listingStatusCoverage: 'listed-or-unknown',
    },
    dataState: 'complete',
    outcome: 'VALID_ZERO_SIGNAL',
    message: assetClass === 'coin_spot' ? '업비트 현물 공개 데이터 분석 완료' : '공개 데이터 분석 완료',
    generatedAt: '2026-08-14T09:30:00.000Z',
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

async function fulfill(route: Route, payload: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
}

async function installMocks(page: Page, requests: string[]) {
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes('/api/market/scan') || url.pathname.includes('/api/scanner/crypto/')) {
      requests.push(`${request.method()} ${url.pathname}?${url.searchParams.toString()}`);
    }
    if (request.method() !== 'GET' && forbiddenRequest.test(url.pathname)) {
      requests.push(`FORBIDDEN ${request.method()} ${url.pathname}`);
    }
  });

  await page.route('**/api/**', (route) => fulfill(route, {}));
  await page.route('**/api/market/scan**', (route) => fulfill(route, scannerPayload('stock', 'KR')));
  await page.route('**/api/scanner/crypto/spot**', (route) => fulfill(route, scannerPayload('coin_spot', 'UPBIT_KRW')));
  await page.route('**/api/scanner/crypto/futures**', (route) => fulfill(route, scannerPayload('coin_futures', 'BITGET_USDT_FUTURES')));
}

async function mainNavBox(page: Page) {
  const nav = page.getByRole('navigation', { name: '주요 메뉴' });
  await expect(nav).toBeVisible();
  const box = await nav.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

for (const viewport of [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
] as const) {
  test(`mobile scanner uses canonical four-market workspace and spot at ${viewport.width}px`, async ({ page }) => {
    const requests: string[] = [];
    await installMocks(page, requests);
    await page.setViewportSize(viewport);
    await page.goto('/__phase11-technical-workspace-e2e');

    await expect(page.getByTestId('scanner-workspace-mobile')).toBeVisible();
    await expect(page.getByTestId('scanner-workspace-desktop')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'AI 신호검색기' })).toBeVisible();

    const markets = page.getByRole('region', { name: '검색 시장' });
    const spot = markets.getByRole('button', { name: /^코인 현물/ });
    await spot.click();
    await expect(spot).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('업비트 현물 공개 데이터 분석 완료')).toBeVisible();

    expect(requests.some((item) => item.includes('/api/scanner/crypto/spot'))).toBe(true);
    expect(requests.filter((item) => item.startsWith('FORBIDDEN'))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);

    const navBox = await mainNavBox(page);
    expect(navBox.width).toBeGreaterThanOrEqual(viewport.width - 2);
    expect(Math.abs(navBox.y + navBox.height - viewport.height)).toBeLessThanOrEqual(2);
  });
}

test('desktop scanner uses split workspace, bounded desktop navigation, and keeps coin spot functional', async ({ page }) => {
  const requests: string[] = [];
  await installMocks(page, requests);
  const viewport = { width: 1440, height: 1000 };
  await page.setViewportSize(viewport);
  await page.goto('/__phase11-technical-workspace-e2e');

  await expect(page.getByTestId('scanner-workspace-desktop')).toBeVisible();
  await expect(page.getByTestId('scanner-workspace-mobile')).toHaveCount(0);
  const markets = page.getByRole('region', { name: '검색 시장' });
  const spot = markets.getByRole('button', { name: /^코인 현물/ });
  await spot.click();
  await expect(spot).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('업비트 현물 공개 데이터 분석 완료')).toBeVisible();

  expect(requests.some((item) => item.includes('/api/scanner/crypto/spot'))).toBe(true);
  expect(requests.filter((item) => item.startsWith('FORBIDDEN'))).toEqual([]);

  const navBox = await mainNavBox(page);
  expect(navBox.width).toBeLessThanOrEqual(840);
  expect(navBox.width).toBeGreaterThanOrEqual(700);
  expect(navBox.x).toBeGreaterThan(100);
  expect(viewport.height - (navBox.y + navBox.height)).toBeGreaterThanOrEqual(12);
  expect(viewport.height - (navBox.y + navBox.height)).toBeLessThanOrEqual(20);
});
