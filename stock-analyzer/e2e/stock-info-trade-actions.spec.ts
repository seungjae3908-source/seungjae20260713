import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isolateTradeChartSelection, tradeActionFromSearch, tradeChartPath, tradeFocusFromSearch } from '../src/lib/trade-navigation';
import { positionOverlayForChart } from '../src/lib/ai-chart-position-overlay-binding';

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
  expect(aiChart).toContain('isolateTradeChartSelection(route, tradeActionRef.current)');
  expect(aiChart).toContain("tradeRouteRequested ? 'position' : 'summary'");
  expect(aiChart).toContain('initialCockpitOpen={tradeRouteRequested}');
  expect(aiChart).toContain("initialCockpitTab={tradeFocusRef.current ?? 'entry'}");

  expect(positionPanel).toContain('setCockpitOpen(initialCockpitOpen)');
  expect(positionPanel).toContain('setCockpitTab(initialCockpitTab)');
  // Unchecked or failed account reads must not be mistaken for an empty position.
  expect(positionPanel).toContain("state.kind !== 'ready' ? (");
  expect(positionPanel).toContain('data-testid="ai-chart-exit-dashboard-unchecked"');
  expect(positionPanel).toContain('아직 실계좌 보유상태를 조회하지 않았습니다');
  expect(positionPanel).toContain('보유 없음으로 간주하지 않으며 종료계획을 차단합니다.');
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

test('combined AI chart history signal identity and trade cockpit never regress each other', async () => {
  const source = await readFile(aiChartPath, 'utf8');
  for (const field of ['signalId', 'searchRunId', 'signalScore', 'action', 'selectedAt']) {
    expect(source).toContain(`&& left.${field} === right.${field}`);
  }
  expect(source).toContain('tradeActionFromSearch(initialSearchRef.current)');
  expect(source).toContain("tradeRouteRequested ? 'position' : 'summary'");
  expect(source.match(/chartPrice=\{typeof analysis\?\.relatedIndicators\.currentPrice === 'number'/g)).toHaveLength(2);
  expect(source).toContain('initialCockpitOpen={tradeRouteRequested}');
  expect(source).toContain("initialCockpitTab={tradeFocusRef.current ?? 'entry'}");
});

test('new trade intent isolates identical stored scanner prices, targets, signal and run identity', async ({ page }) => {
  const privateAccountReads: string[] = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await installApprovedSession(page);
  await page.addInitScript(({ storedAt }) => {
    window.localStorage.setItem('sa-analysis-selection-v1', JSON.stringify({
      assetType: 'stock', market: 'KR', symbol: '005930', ticker: '005930',
      displayName: '삼성전자', timeframe: '5m', selectedAt: storedAt,
      action: 'BUY', searchRunId: 'OLD-SCANNER-RUN', signalId: 'OLD-SCANNER-SIGNAL',
      signalScore: 99, reasons: ['stale prior signal'],
      pricePlan: { entryZone: { from: 73_000, to: 75_000 }, invalidation: 72_000,
        stopLoss: 71_000, targets: [85_000], riskReward: 2 },
    }));
  }, { storedAt: NOW });
  await mockStockTradeSurface(page, privateAccountReads);

  await page.goto('/stock-info?asset=stock&market=KR&ticker=005930');
  await expect(page.getByTestId('stock-info-buy')).toBeVisible();
  await page.getByTestId('stock-info-buy').click();
  await expect(page.getByTestId('ai-chart-mobile-position')).toBeVisible();
  await expect(page.getByTestId('ai-chart-trading-cockpit')).toBeVisible();

  await expect.poll(() => page.evaluate(() => {
    const s = JSON.parse(window.localStorage.getItem('sa-analysis-selection-v1') ?? 'null');
    return {
      assetType: s?.assetType, market: s?.market, symbol: s?.symbol, action: s?.action,
      searchRunId: s?.searchRunId ?? null, signalId: s?.signalId ?? null,
      signalScore: s?.signalScore ?? null, pricePlan: s?.pricePlan ?? null,
      reasons: s?.reasons ?? null,
    };
  })).toEqual({
    assetType: 'stock', market: 'KR', symbol: '005930', action: 'BUY',
    searchRunId: null, signalId: null, signalScore: null, pricePlan: null, reasons: null,
  });
  expect(privateAccountReads).toEqual([]);
});

test('trade route selection keeps only canonical identity and explicit action', () => {
  const selected = isolateTradeChartSelection({
    assetType: 'stock', market: 'US', symbol: 'AAPL', ticker: 'AAPL',
    displayName: 'Apple', timeframe: '5m', selectedAt: NOW,
    signalId: 'unrelated', searchRunId: 'previous', signalScore: 99,
    pricePlan: { entryZone: null, invalidation: 100, stopLoss: 90, targets: [200], riskReward: 2 },
    reasons: ['cached signal'],
  }, 'SELL');
  expect(selected).toEqual({
    assetType: 'stock', market: 'US', symbol: 'AAPL', ticker: 'AAPL',
    displayName: 'Apple', timeframe: '5m', selectedAt: NOW, action: 'SELL',
  });
});


test('manual trade overlays require the exact read-only provider, market, active position and symbol', () => {
  const position = {
    market: 'KR', symbol: '005930', quantity: 20, availableQuantity: 20,
    averageEntryPrice: 70_000, currentPrice: 72_100, marketValue: 1_442_000,
    unrealizedPnl: 42_000, unrealizedPnlPercent: 3,
    leverage: null, liquidationPrice: null, marginMode: null, side: null,
  };
  const overlay = { provider: 'toss' as const, position, stale: false, checkedAt: NOW };
  expect(positionOverlayForChart(overlay, 'KR', '005930')).toBe(overlay);
  expect(positionOverlayForChart(overlay, 'KR', '000660')).toBeNull();
  expect(positionOverlayForChart(overlay, 'US', '005930')).toBeNull();
  expect(positionOverlayForChart({ ...overlay, provider: 'upbit' }, 'KR', '005930')).toBeNull();
  expect(positionOverlayForChart({ ...overlay, position: { ...position, quantity: 0 } }, 'KR', '005930')).toBeNull();
  const spot = { ...overlay, provider: 'upbit' as const, position: { ...position, market: 'UPBIT', symbol: 'KRW-BTC' } };
  expect(positionOverlayForChart(spot, 'UPBIT', 'BTC')).toBe(spot);
  expect(positionOverlayForChart(spot, 'UPBIT', 'ETH')).toBeNull();
  const future = { ...overlay, provider: 'bitget' as const, position: { ...position, market: 'BITGET', symbol: 'BTCUSDT', quantity: -2 } };
  expect(positionOverlayForChart(future, 'BITGET', 'BTCUSDT')).toBe(future);
});

test('manual trade position panel has one read-only owner and forwards verified lines to chart', async () => {
  const [chartPage, unified, canvas] = await Promise.all([
    readFile(aiChartPath, 'utf8'),
    readFile(fileURLToPath(new URL('../src/components/unified-analysis-chart.tsx', import.meta.url)), 'utf8'),
    readFile(fileURLToPath(new URL('../src/components/pattern-aware-unified-chart-canvas.tsx', import.meta.url)), 'utf8'),
  ]);
  expect(chartPage).toContain('onOverlayChange={handleTradePositionOverlayChange}');
  expect(chartPage).toContain('positionOverlay={visibleTradePositionOverlay}');
  expect(chartPage).toContain('externalPositionController={externalPositionController}');
  expect(chartPage).not.toContain('ignorePositionOverlay');
  expect(unified).toContain('externalPositionController={externalPositionController}');
  expect(canvas).toContain('positionOverlayForChart(');
  expect(canvas).toContain('chartSymbol && !externalPositionController');
  expect(canvas).toContain('data-position-average={positionOverlay?.position.averageEntryPrice');
});

test('explicit cockpit read-only lookup draws and hides one average line without private mutations', async ({ page }) => {
  test.setTimeout(90_000);
  const accountReads: string[] = [];
  const mutations: string[] = [];
  await page.setViewportSize({ width: 1440, height: 960 });
  await installApprovedSession(page);
  await mockStockTradeSurface(page, accountReads);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/') && request.method() !== 'GET') mutations.push(request.method() + ' ' + url.pathname);
  });
  await page.route('**/api/stocks/005930/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!/\/(candles|chart)$/.test(path)) return route.fallback();
    const end = Date.now() - 5 * 60_000;
    const candles = Array.from({ length: 90 }, (_, index) => ({
      time: new Date(end - (89 - index) * 5 * 60_000).toISOString(),
      open: 70_000 + index * 20, high: 70_090 + index * 20,
      low: 69_910 + index * 20, close: 70_025 + index * 20,
      volume: 1000 + index * 25, isClosed: true,
    }));
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ticker: '005930', timeframe: '5m', provider: 'MOCK_PUBLIC',
        fetchedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), candles }),
    });
  });
  await page.route('**/api/accounts/read-only/toss', async (route) => {
    accountReads.push('toss');
    expect(route.request().method()).toBe('GET');
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        provider: 'toss', readOnly: true, connected: true, status: 'CONNECTED',
        accounts: [{ market: 'KR', accountRef: '12****34', currency: 'KRW', buyingPower: 500_000 }],
        balances: [], positions: [{
          market: 'KR', symbol: '005930', quantity: 20, availableQuantity: 20,
          averageEntryPrice: 70_000, currentPrice: 72_100, marketValue: 1_442_000,
          unrealizedPnl: 42_000, unrealizedPnlPercent: 3,
          leverage: null, liquidationPrice: null, marginMode: null, side: null,
        }],
        openOrders: [], checkedAt: new Date().toISOString(), lastGoodAt: new Date().toISOString(),
        stale: false, errorCode: null, orderRequests: 0, cancelRequests: 0,
        amendRequests: 0, transferRequests: 0, withdrawalRequests: 0,
        liveTradingEnabled: false, autoTradingEnabled: false,
      }),
    });
  });
  await page.goto('/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=Samsung&timeframe=5m&action=BUY&trade=entry');
  const wrapper = page.getByTestId('unified-chart-wrapper');
  await expect(wrapper).toBeVisible();
  const panel = page.getByTestId('ai-chart-position-panel');
  await expect(panel).toHaveCount(1);
  await expect(panel).toContainText('차트를 열기만 해서는 계좌를 조회하지 않습니다.');
  await expect(wrapper).toHaveAttribute('data-position-average', '');
  expect(accountReads).toEqual([]);
  await panel.getByTestId('ai-chart-load-position').click();
  await expect.poll(() => accountReads.length).toBe(1);
  // Diagnostic remains strict: reveal whether the read was accepted or
  // the subsequent presentation bridge dropped an otherwise verified overlay.
  try {
    await expect(wrapper).toHaveAttribute('data-position-average', '70000');
  } catch (error) {
    const panelText = await panel.innerText().catch(() => '<panel-unavailable>');
    const detail = await page.evaluate(() => {
      const parsed = JSON.parse(window.localStorage.getItem('sa-analysis-selection-v1') ?? 'null') as
        | { assetType?: string; market?: string; ticker?: string; symbol?: string; timeframe?: string; selectedAt?: string }
        | null;
      return {
        route: window.location.pathname + window.location.search,
        selected: parsed && {
          assetType: parsed.assetType, market: parsed.market, ticker: parsed.ticker,
          symbol: parsed.symbol, timeframe: parsed.timeframe, selectedAt: parsed.selectedAt,
        },
      };
    });
    console.log('POSITION_OVERLAY_BRIDGE_DIAGNOSTIC=' + JSON.stringify({
      test: 'manual-cockpit-readonly', panelPreview: panelText.slice(0, 1200),
      accountReads: accountReads.length, route: detail.route, selected: detail.selected,
    }));
    throw error;
  }
  await panel.getByTestId('ai-chart-toggle-position-lines').click();
  await expect(wrapper).toHaveAttribute('data-position-average', '');
  expect(mutations).toEqual([]);
});

