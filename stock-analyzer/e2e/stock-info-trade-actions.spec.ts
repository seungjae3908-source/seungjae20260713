import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tradeActionFromSearch, tradeChartPath, tradeFocusFromSearch } from '../src/lib/trade-navigation';

const stockInfoPath = fileURLToPath(new URL('../src/pages/stock-info.tsx', import.meta.url));
const aiChartPath = fileURLToPath(new URL('../src/pages/ai-chart.tsx', import.meta.url));
const positionPanelPath = fileURLToPath(new URL('../src/components/ai-chart-position-panel-impl.tsx', import.meta.url));


const E2E_USER_ID = '44444444-4444-4444-8444-444444444444';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';
const NOW = '2026-10-04T00:00:00.000Z';

async function installApprovedSession(page: Page) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'stock-info-trade-actions-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'stock-trade-actions@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Trade Actions Admin' },
        identities: [],
        created_at: now,
      },
    }));
  }, { storageKey: E2E_AUTH_STORAGE_KEY, userId: E2E_USER_ID, now: NOW });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const body = pathname.endsWith('/rest/v1/profiles')
      ? { id: E2E_USER_ID, login_name: 'trade-actions-admin', display_name: 'Trade Actions Admin', role: 'admin', status: 'approved', membership_level: 'admin', is_active: true, permissions_updated_at: NOW, updated_at: NOW }
      : pathname.endsWith('/auth/v1/user')
        ? { id: E2E_USER_ID, aud: 'authenticated', role: 'authenticated', email: 'stock-trade-actions@accounts.invalid', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: 'Trade Actions Admin' }, identities: [], created_at: NOW }
        : pathname.endsWith('/rest/v1/portfolio_holdings')
          ? []
          : { ok: true };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

async function mockStockTradeSurface(page: Page, privateAccountReads: string[]) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/accounts/read-only/')) privateAccountReads.push(url.pathname);

    if (url.pathname === '/api/stocks/005930/quote') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ticker: '005930',
          name: '삼성전자',
          market: 'KR',
          price: 74500,
          changePercent: 1.2,
          currency: 'KRW',
          updatedAt: NOW,
        }),
      });
      return;
    }
    if (url.pathname === '/api/trade-automation/approval-queue') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, items: [], count: 0, updatedAt: NOW, orderSubmitted: false, orderCanceled: false, privateTradingRequestSent: false }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test('stock tab trade navigation preserves market policy and never invents spot or stock short entry', () => {
  const stockBuy = new URL(tradeChartPath({
    assetType: 'stock',
    market: 'KR',
    symbol: '005930',
    displayName: '삼성전자',
    action: 'BUY',
    focus: 'entry',
  }), 'https://app.invalid');
  expect(stockBuy.pathname).toBe('/ai-chart');
  expect(stockBuy.searchParams.get('trade')).toBe('entry');
  expect(stockBuy.searchParams.get('action')).toBe('BUY');
  expect(stockBuy.searchParams.get('source')).toBe('stock-info');
  expect(tradeFocusFromSearch(stockBuy.search)).toBe('entry');
  expect(tradeActionFromSearch(stockBuy.search)).toBe('BUY');

  const stockSell = new URL(tradeChartPath({
    assetType: 'stock',
    market: 'US',
    symbol: 'AAPL',
    displayName: 'Apple',
    action: 'SELL',
    focus: 'exit',
  }), 'https://app.invalid');
  expect(stockSell.searchParams.get('trade')).toBe('exit');
  expect(stockSell.searchParams.get('action')).toBe('SELL');
  expect(tradeFocusFromSearch(stockSell.search)).toBe('exit');
  expect(tradeActionFromSearch(stockSell.search)).toBe('SELL');

  const spotSell = new URL(tradeChartPath({
    assetType: 'coin_spot',
    market: 'UPBIT',
    symbol: 'BTC',
    displayName: '비트코인',
    action: 'SELL',
    focus: 'exit',
  }), 'https://app.invalid');
  expect(spotSell.searchParams.get('trade')).toBe('exit');

  for (const action of ['LONG', 'SHORT'] as const) {
    const futures = new URL(tradeChartPath({
      assetType: 'coin_futures',
      market: 'BITGET',
      symbol: 'BTCUSDT',
      displayName: 'BTCUSDT',
      action,
      focus: 'entry',
      timeframe: '15m',
    }), 'https://app.invalid');
    expect(futures.searchParams.get('trade')).toBe('entry');
    expect(futures.searchParams.get('action')).toBe(action);
    expect(tradeActionFromSearch(futures.search)).toBe(action);
  }

  expect(() => tradeChartPath({
    assetType: 'stock',
    market: 'KR',
    symbol: '005930',
    displayName: '삼성전자',
    action: 'SELL',
    focus: 'entry',
  })).toThrow('TRADE_NAVIGATION_ENTRY_DIRECTION_INVALID');

  expect(() => tradeChartPath({
    assetType: 'coin_spot',
    market: 'UPBIT',
    symbol: 'BTC',
    displayName: '비트코인',
    action: 'SHORT',
    focus: 'entry',
  })).toThrow('TRADE_NAVIGATION_ENTRY_DIRECTION_INVALID');
});

test('stock and coin detail expose trade actions only through the canonical AI chart cockpit', async () => {
  const [stockInfo, aiChart, positionPanel] = await Promise.all([
    readFile(stockInfoPath, 'utf8'),
    readFile(aiChartPath, 'utf8'),
    readFile(positionPanelPath, 'utf8'),
  ]);

  expect(stockInfo).toContain('data-testid="stock-info-buy"');
  expect(stockInfo).toContain('data-testid="stock-info-sell"');
  expect(stockInfo).toContain('data-testid="coin-info-primary-trade-action"');
  expect(stockInfo).toContain('data-testid="coin-info-secondary-trade-action"');
  expect(stockInfo).toContain("focus: action === 'SELL' ? 'exit' : 'entry'");
  expect(stockInfo).toContain("focus: !futures && action === 'SELL' ? 'exit' : 'entry'");
  expect(stockInfo).not.toMatch(/\/api\/trade-automation\/(?:plans|orders)/);

  expect(aiChart).toContain("tradeFocusFromSearch(initialSearchRef.current)");
  expect(aiChart).toContain("tradeActionFromSearch(initialSearchRef.current)");
  expect(aiChart).toContain("{ ...base, action: tradeActionRef.current }");
  expect(aiChart).toContain("tradeRouteRequested ? 'position' : 'summary'");
  expect(aiChart).toContain('initialCockpitOpen={tradeRouteRequested}');
  expect(aiChart).toContain("initialCockpitTab={tradeFocusRef.current ?? 'entry'}");

  expect(positionPanel).toContain('setCockpitOpen(initialCockpitOpen)');
  expect(positionPanel).toContain('setCockpitTab(initialCockpitTab)');
});


test('stock detail buy and sell buttons open the canonical cockpit without implicit private-account reads', async ({ page }) => {
  const privateAccountReads: string[] = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await installApprovedSession(page);
  await mockStockTradeSurface(page, privateAccountReads);

  await page.goto('/stock-info?asset=stock&market=KR&ticker=005930');
  await expect(page.getByTestId('stock-info-buy')).toBeVisible();
  await page.getByTestId('stock-info-buy').click();
  await expect(page).toHaveURL(/\/ai-chart\?.*trade=entry/);
  expect(new URL(page.url()).searchParams.get('action')).toBe('BUY');
  await expect(page.getByTestId('ai-chart-mobile-position')).toBeVisible();
  const entryCockpit = page.getByTestId('ai-chart-trading-cockpit');
  await expect(entryCockpit).toBeVisible();
  expect(await entryCockpit.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(true);
  await expect(entryCockpit.getByRole('tab', { name: '진입', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(privateAccountReads).toEqual([]);

  await page.goto('/stock-info?asset=stock&market=KR&ticker=005930');
  await expect(page.getByTestId('stock-info-sell')).toBeVisible();
  await page.getByTestId('stock-info-sell').click();
  await expect(page).toHaveURL(/\/ai-chart\?.*trade=exit/);
  expect(new URL(page.url()).searchParams.get('action')).toBe('SELL');
  await expect(page.getByTestId('ai-chart-mobile-position')).toBeVisible();
  const exitCockpit = page.getByTestId('ai-chart-trading-cockpit');
  await expect(exitCockpit.getByRole('tab', { name: '종료', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(exitCockpit.getByTestId('ai-chart-exit-dashboard-unchecked')).toContainText('아직 실계좌 보유상태를 조회하지 않았습니다');
  expect(privateAccountReads).toEqual([]);
});
