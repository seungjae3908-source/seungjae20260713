import { expect, test, type Page, type Route } from '@playwright/test';

const USER = '99999999-9999-4999-8999-999999999999';
const AUTH_KEY = 'sb-127-auth-token';
const NOW = '2026-09-06T09:20:00.000Z';

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

async function installRuntime(page: Page, options: { connectedBalances?: boolean; kiwoomSupported?: boolean; fxUnavailable?: boolean } = {}) {
  await page.addInitScript(({ authKey, user, now }) => {
    const encode = (value: Record<string, unknown>) => btoa(JSON.stringify(value))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    localStorage.setItem(authKey, JSON.stringify({
      access_token: `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: user, role: 'authenticated', exp: expiresAt })}.e2e`,
      refresh_token: 'account-professional-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: user,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'account-professional@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '전문 UI 관리자' },
        identities: [],
        created_at: now,
      },
    }));
  }, { authKey: AUTH_KEY, user: USER, now: NOW });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: USER,
        login_name: 'account-professional-admin',
        display_name: '전문 UI 관리자',
        role: 'admin',
        status: 'approved',
        membership_level: 'admin',
        is_active: true,
        permissions_updated_at: NOW,
        updated_at: NOW,
      });
    }
    if (pathname.endsWith('/auth/v1/user')) {
      return fulfill(route, {
        id: USER,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'account-professional@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '전문 UI 관리자' },
        identities: [],
        created_at: NOW,
      });
    }
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/accounts/read-only/credentials/status') {
      return fulfill(route, {
        supportedProviders: options.kiwoomSupported
          ? ['toss', 'kiwoom', 'upbit', 'bitget']
          : ['toss', 'upbit', 'bitget'],
      });
    }
    if (pathname === '/api/accounts/read-only/fx') {
      return fulfill(route, options.fxUnavailable ? {
        ok: true,
        displayCurrencies: ['KRW', 'USD'],
        usdKrw: null,
        usdtKrw: null,
        missing: ['FX:USD_KRW:UNAVAILABLE', 'FX:USDT_KRW:UNAVAILABLE'],
        checkedAt: NOW,
        publicMarketDataOnly: true,
      } : {
        ok: true,
        displayCurrencies: ['KRW', 'USD'],
        usdKrw: { krwRate: 1300, source: 'TEST:USD_KRW', asOf: NOW, quality: 'DELAYED' },
        usdtKrw: { krwRate: 1310, source: 'TEST:USDT_KRW', asOf: NOW, quality: 'DELAYED' },
        missing: [],
        checkedAt: NOW,
        publicMarketDataOnly: true,
      });
    }
    if (pathname.startsWith('/api/accounts/read-only/')) {
      const provider = pathname.split('/').at(-1);
      if (route.request().method() === 'GET') {
        if (options.connectedBalances) {
          const fixtures: Record<string, unknown> = {
            toss: {
              accounts: [
                { market: 'KR', accountRef: '12****78', currency: 'KRW', buyingPower: 5000000 },
                { market: 'US', accountRef: '12****78', currency: 'USD', buyingPower: 3500.5 },
              ],
              balances: [
                { currency: 'KRW', available: 5000000, locked: null, total: null, estimatedKrwValue: 5000000 },
                { currency: 'USD', available: 3500.5, locked: null, total: null, estimatedKrwValue: null },
              ],
              positions: [{
                market: 'US', symbol: 'AAPL', quantity: 2, availableQuantity: 2,
                averageEntryPrice: 180, currentPrice: 200, marketValue: 400,
                unrealizedPnl: 40, unrealizedPnlPercent: 11.11,
                leverage: null, liquidationPrice: null, marginMode: null, side: null,
              }],
              openOrders: [],
            },
            kiwoom: {
              accounts: [{ market: 'KR', accountRef: null, currency: 'KRW', buyingPower: 700000 }],
              balances: [{ currency: 'KRW', available: 800000, locked: null, total: 1000000, estimatedKrwValue: 1000000 }],
              positions: [{
                market: 'US', symbol: 'MSFT', quantity: 1, availableQuantity: 1,
                averageEntryPrice: 550, currentPrice: 600, marketValue: 600,
                unrealizedPnl: 50, unrealizedPnlPercent: 9.09,
                leverage: null, liquidationPrice: null, marginMode: null, side: null,
              }],
              openOrders: [],
            },
            upbit: {
              accounts: [],
              balances: [
                { currency: 'KRW', available: 1200000, locked: 0, total: 1200000, estimatedKrwValue: null },
                { currency: 'BTC', available: 0.01, locked: 0, total: 0.01, estimatedKrwValue: null },
              ],
              positions: [],
              openOrders: [],
            },
            bitget: {
              accounts: [],
              balances: [{ currency: 'USDT', available: 2400, locked: 100, total: 2500, estimatedKrwValue: null }],
              positions: [],
              openOrders: [],
            },
          };
          return fulfill(route, {
            provider,
            readOnly: true,
            connected: true,
            status: 'CONNECTED',
            ...(fixtures[String(provider)] as Record<string, unknown>),
            checkedAt: NOW,
            lastGoodAt: NOW,
            stale: false,
            errorCode: null,
            orderRequests: 0,
            cancelRequests: 0,
            amendRequests: 0,
            transferRequests: 0,
            withdrawalRequests: 0,
            credentialsReturned: false,
            liveTradingEnabled: false,
            autoTradingEnabled: false,
          });
        }
        return fulfill(route, {
          provider,
          readOnly: true,
          connected: false,
          status: 'NOT_CONFIGURED',
          accounts: [],
          balances: [],
          positions: [],
          openOrders: [],
          checkedAt: NOW,
          lastGoodAt: null,
          stale: false,
          errorCode: 'ACCOUNT_NOT_CONFIGURED',
          orderRequests: 0,
          cancelRequests: 0,
          amendRequests: 0,
          transferRequests: 0,
          withdrawalRequests: 0,
          credentialsReturned: false,
          liveTradingEnabled: false,
          autoTradingEnabled: false,
        });
      }
    }
    if (pathname === '/api/user-integrations') {
      return fulfill(route, { brokerConnections: [], telegram: { connected: false, status: 'DISCONNECTED', connectedAt: null }, preferences: {} });
    }
    return fulfill(route, { ok: true, items: [], rows: [], results: [], alerts: [], notifications: [] });
  });
}

for (const width of [320, 390, 768, 1200, 1440]) {
  test(`account professional surface stays bounded at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width >= 1200 ? 900 : 844 });
    await installRuntime(page);
    await page.goto('/account');

    await expect(page.getByRole('heading', { name: '계정', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '실계좌', exact: true })).toBeVisible();
    await expect(page.getByText('조회 전용', { exact: true })).toBeVisible();
    await expect(page.getByText('실주문/취소/이체/출금 0건', { exact: false })).toHaveCount(0);

    const overflow = await page.evaluate(() => Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    ) - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);

    const cards = page.locator('[data-testid^="connection-"]');
    await expect(cards).toHaveCount(3);
    for (const card of await cards.all()) {
      const box = await card.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    }
  });
}

test('account provider cards use one column on mobile, two on tablet, and four on desktop', async ({ page }) => {
  await installRuntime(page, { connectedBalances: true, kiwoomSupported: true });
  await page.goto('/account');
  await expect(page.getByTestId('brokerage-account-connections').locator('[data-testid^="connection-"]')).toHaveCount(4);

  const columnsAt = async (width: number) => {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(50);
    return page.getByTestId('brokerage-account-connections').locator('[data-testid^="connection-"]').evaluateAll((nodes) => {
      const xs = nodes.map((node) => Math.round((node as HTMLElement).getBoundingClientRect().x));
      return new Set(xs).size;
    });
  };

  expect(await columnsAt(390)).toBe(1);
  expect(await columnsAt(768)).toBe(2);
  expect(await columnsAt(1440)).toBe(4);
  await expect(page.getByTestId('account-summary').locator('> div')).toHaveCount(4);
});

test('account shows normalized balances and switches overseas stock plus USDT values between KRW and USD', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await installRuntime(page, { connectedBalances: true, kiwoomSupported: true });
  await page.goto('/account');

  const currency = page.getByTestId('account-display-currency');
  await expect(currency.getByRole('button', { name: 'KRW', exact: true })).toHaveAttribute('aria-pressed', 'true');

  const toss = page.getByTestId('connection-toss');
  await expect(toss).toContainText('AAPL');
  await expect(toss).toContainText('₩520,000');
  await expect(toss).toContainText('₩9,550,650');

  const kiwoom = page.getByTestId('connection-kiwoom');
  await expect(kiwoom).toContainText('MSFT');
  await expect(kiwoom).toContainText('₩780,000');
  await expect(kiwoom).toContainText('₩700,000');

  const upbit = page.getByTestId('connection-upbit');
  await expect(upbit).toContainText('₩1,200,000');

  const bitget = page.getByTestId('connection-bitget');
  await expect(bitget).toContainText('₩3,275,000');
  await expect(bitget).toContainText('₩3,144,000');

  await currency.getByRole('button', { name: 'USD', exact: true }).click();
  await expect(currency.getByRole('button', { name: 'USD', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(toss).toContainText('$400.00');
  await expect(toss).toContainText('$7,346.65');
  await expect(kiwoom).toContainText('$600.00');
  await expect(bitget).toContainText('$2,519.23');
});

test('FX outage never fabricates KRW or USD converted account values', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await installRuntime(page, { connectedBalances: true, kiwoomSupported: true, fxUnavailable: true });
  await page.goto('/account');

  const bitget = page.getByTestId('connection-bitget');
  await expect(bitget.getByText('총금액', { exact: true })).toBeVisible();
  await expect(bitget).toContainText('—');
  await expect(bitget).not.toContainText('₩0');
  await expect(bitget).not.toContainText('$0.00');
  await expect(page.getByText('일부 환율 조회 불가', { exact: true })).toBeVisible();
});

test('account keeps the main surface compact and removes supplementary read-only copy', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installRuntime(page);
  await page.goto('/account');

  await expect(page.getByText('조회 전용', { exact: true })).toBeVisible();
  await expect(page.getByText('보안·권한 상세', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Secret 원문 응답 0건', { exact: false })).toHaveCount(0);
  await expect(page.getByText('잔고·보유·포지션·미체결만 조회합니다.', { exact: true })).toHaveCount(0);
});

test('account connection dialog remains inside a compact mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await installRuntime(page);
  await page.goto('/account');

  await page.getByRole('button', { name: 'Toss 조회 연결 설정', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Toss 조회 연결 설정' });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(321);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(741);
  await expect(page.getByRole('button', { name: '조회 전용 키 저장', exact: true })).toBeVisible();
});
