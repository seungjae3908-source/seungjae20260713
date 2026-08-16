import { expect, test, type Page, type Route } from '@playwright/test';
import { canonicalMarketAssetRoute } from '../src/lib/asset-navigation';

const emptyAiUsage = {
  used: 0,
  limit: 50,
  remaining: 50,
  status: 'free' as const,
  paidRequestAllowed: false,
  paidRequestCount: 0,
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function installAdminRuntime(page: Page) {
  const unexpected: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') unexpected.push(`console:${message.text()}`);
  });
  page.on('pageerror', (error) => unexpected.push(`page:${error.message}`));
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'unknown';
    if (!failure.includes('ERR_ABORTED')) unexpected.push(`request:${request.method()}:${request.url()}:${failure}`);
  });

  await page.addInitScript(() => {
    window.localStorage.setItem('stock_app_auth_mock', JSON.stringify({
      user: { id: 'responsive-admin', email: 'responsive-admin@example.test' },
      profile: { id: 'responsive-admin', approval_status: 'approved', role: 'admin' },
    }));
    window.localStorage.setItem('stock_app_user', JSON.stringify({
      id: 'responsive-admin', email: 'responsive-admin@example.test', approval_status: 'approved', role: 'admin',
    }));
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (method !== 'GET') return json(route, { ok: false, code: 'READ_ONLY_FIXTURE' }, 403);
    if (path === '/api/health') return json(route, { status: 'ok', ok: true });
    if (path === '/api/ai/usage') return json(route, emptyAiUsage);
    if (path === '/api/backup/latest') return json(route, { backup: null });
    if (path === '/api/watchlist') return json(route, []);
    if (path === '/api/notifications/price-alerts') return json(route, []);
    if (path === '/api/market/scan') return json(route, { ok: true, requestId: 'responsive-fixture', cards: [], alerts: [], failures: [], generatedAt: new Date().toISOString(), dataState: 'complete', outcome: 'NO_SIGNALS', orderSubmitted: false, exchangeRequestSent: false, execution: { requestedCount: 0, startedCount: 0, completedCount: 0, excludedCount: 0, providerErrorCount: 0, timeoutCount: 0, partial: false, timedOut: false, cancelled: false, duplicate: false, elapsedMs: 0, deadlineMs: 12000, itemTimeoutMs: 3500, maxConcurrency: 4, providerAcceptedCount: 0, dataSuccessCount: 0, insufficientDataCount: 0, filteredByStrategyCount: 0, hardFilterRejectedCount: 0, finalDisplayedCount: 0 }, universe: { totalCount: 0, cursor: 0, nextCursor: null, source: 'fixture', partial: false, stale: false, listingStatusCoverage: 'listed-or-unknown' } });
    if (path.startsWith('/api/stocks/') && path.endsWith('/quote')) return json(route, { ticker: '005930', name: '삼성전자', price: 70000, change: 0, changePercent: 0, currency: 'KRW', market: 'KR' });
    if (path.startsWith('/api/stocks/') && path.endsWith('/profile')) return json(route, { ticker: '005930', name: '삼성전자', market: 'KR', exchange: 'KRX', currency: 'KRW' });
    if (path.startsWith('/api/stocks/') && path.endsWith('/financials')) return json(route, { ticker: '005930', items: [] });
    if (path.startsWith('/api/stocks/') && (path.endsWith('/market-flow') || path.endsWith('/short-selling') || path.endsWith('/news') || path.endsWith('/disclosures'))) return json(route, []);
    if (path.startsWith('/api/portfolio/intelligence')) return json(route, { status: 'INSUFFICIENT_DATA', positions: [], summary: {} });
    if (path.startsWith('/api/accounts/read-only')) return json(route, { ok: true, accounts: [], orderSubmitted: false, exchangeRequestSent: false });
    if (path.startsWith('/api/user-integrations')) return json(route, []);
    if (path.startsWith('/api/search')) return json(route, { results: [] });
    if (path.startsWith('/api/market/')) return json(route, {});
    if (path.startsWith('/api/chart')) return json(route, { candles: [] });
    return json(route, {});
  });

  return () => expect(unexpected, unexpected.join('\n')).toEqual([]);
}

async function assertNoHorizontalOverflow(page: Page, label: string) {
  const result = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  expect(result.documentWidth, `${label}: document horizontal overflow`).toBeLessThanOrEqual(result.viewportWidth + 1);
  expect(result.bodyWidth, `${label}: body horizontal overflow`).toBeLessThanOrEqual(result.viewportWidth + 1);
}

const ROUTES = [
  '/home', '/stocks/kr', '/stocks/us', '/coins/spot', '/coins/futures', '/stocks',
  '/stock-info?asset=stock&market=KR&symbol=005930', '/market-overview', '/assets', '/settings',
  '/search', '/market-rankings', '/market-browser', '/scanner', '/ai-chart', '/ai-chat', '/themes',
  '/learn', '/watchlist', '/alerts', '/portfolio', '/account', '/admin', '/more', '/stock/005930',
  '/recommendations', '/backtests', '/paper-trading', '/auto-trading',
] as const;

for (const width of [320, 360, 390, 412, 430, 1023, 1024, 1440]) {
  test(`all primary routes stay inside viewport at ${width}px`, async ({ page }) => {
    const assertClean = await installAdminRuntime(page);
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : width === 320 ? 760 : width === 412 ? 915 : 844 });
    for (const route of ROUTES) {
      await page.goto(route);
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(40);
      await assertNoHorizontalOverflow(page, `${width}px ${route}`);
    }
    assertClean();
  });
}

test('admin account panel shows all four market account surfaces and remains read-only', async ({ page }) => {
  const assertClean = await installAdminRuntime(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/account');
  const panel = page.getByTestId('brokerage-account-connections');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('connection-kiwoom')).toContainText('Kiwoom');
  await expect(page.getByTestId('connection-upbit')).toContainText('Upbit');
  await expect(page.getByTestId('connection-bitget')).toContainText('Bitget');
  await expect(panel).toContainText('READ-ONLY');
  await expect(panel).toContainText('주문/취소/이체 mutation 0건');
  await assertNoHorizontalOverflow(page, 'account panel mobile');
  await page.setViewportSize({ width: 1440, height: 900 });
  await assertNoHorizontalOverflow(page, 'account panel desktop');
  assertClean();
});

// This route map must stay aligned with the canonical market ownership helpers.
test('canonical market routes used by acceptance remain stable', () => {
  expect(canonicalMarketAssetRoute({ assetClass: 'stock', market: 'KR', symbol: '005930' })).toBe('/stock-info?asset=stock&market=KR&symbol=005930');
});
