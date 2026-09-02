import { test, expect, type Page, type Route } from '@playwright/test';

const NOW = '2026-09-02T02:50:00.000Z';
const USER_ID = '99999999-9999-4999-8999-999999999999';
const AUTH_STORAGE_KEY = 'sb-127-auth-token';
const ASSET_MODE_KEY = 'knowledge-info-asset-mode-v1';

type Provider = 'toss' | 'upbit' | 'bitget';
type CoinMarket = 'spot' | 'futures';

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });
}

function snapshot(provider: Provider, overrides: Record<string, unknown> = {}) {
  return {
    provider,
    readOnly: true,
    connected: false,
    status: 'NOT_CONFIGURED',
    accounts: null,
    balances: null,
    positions: null,
    openOrders: null,
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
    ...overrides,
  };
}

async function installRegular(page: Page, coinMarket: CoinMarket) {
  await page.addInitScript(({ authStorageKey, assetModeKey, userId, now, market }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(authStorageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'portfolio-readonly-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'portfolio-readonly@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '포트폴리오 조회 사용자' },
        identities: [],
        created_at: now,
      },
    }));
    window.localStorage.setItem(assetModeKey, JSON.stringify({ asset: 'coin', stockMarket: 'KR', coinMarket: market }));
  }, {
    authStorageKey: AUTH_STORAGE_KEY,
    assetModeKey: ASSET_MODE_KEY,
    userId: USER_ID,
    now: NOW,
    market: coinMarket,
  });

  const diagnostics = {
    consoleErrors: [] as string[],
    pageErrors: [] as string[],
    legacySpotAccounts: 0,
    legacyFuturesAccount: 0,
    legacyFuturesPositions: 0,
    canonical: { toss: 0, upbit: 0, bitget: 0 } as Record<Provider, number>,
    forbiddenMutations: [] as string[],
  };

  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === '/api/crypto/spot/accounts' || path === '/crypto/spot/accounts') diagnostics.legacySpotAccounts += 1;
    if (path === '/api/crypto/futures/account' || path === '/crypto/futures/account') diagnostics.legacyFuturesAccount += 1;
    if (path === '/api/crypto/futures/positions' || path === '/crypto/futures/positions') diagnostics.legacyFuturesPositions += 1;

    for (const provider of ['toss', 'upbit', 'bitget'] as const) {
      if (path === `/api/accounts/read-only/${provider}` && method === 'GET') diagnostics.canonical[provider] += 1;
    }

    if (
      method !== 'GET'
      && /\/(?:order|orders|cancel|amend|transfer|withdraw|withdrawal)(?:\/|$)/i.test(path)
    ) {
      diagnostics.forbiddenMutations.push(`${method} ${path}`);
    }
  });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: USER_ID,
        login_name: 'portfolio-readonly-regular',
        display_name: '포트폴리오 조회 사용자',
        role: 'regular',
        status: 'approved',
        membership_level: 'regular',
        is_active: true,
        permissions_updated_at: NOW,
        updated_at: NOW,
      });
    }
    if (pathname.endsWith('/auth/v1/user')) {
      return fulfill(route, {
        id: USER_ID,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'portfolio-readonly@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '포트폴리오 조회 사용자' },
        identities: [],
        created_at: NOW,
      });
    }
    return fulfill(route, { ok: true });
  });

  return diagnostics;
}

function assertNoLegacyOrMutation(diagnostics: Awaited<ReturnType<typeof installRegular>>) {
  expect(diagnostics.legacySpotAccounts).toBe(0);
  expect(diagnostics.legacyFuturesAccount).toBe(0);
  expect(diagnostics.legacyFuturesPositions).toBe(0);
  expect(diagnostics.forbiddenMutations, diagnostics.forbiddenMutations.join('\n')).toEqual([]);
  expect(diagnostics.consoleErrors, diagnostics.consoleErrors.join('\n')).toEqual([]);
  expect(diagnostics.pageErrors, diagnostics.pageErrors.join('\n')).toEqual([]);
}

test('desktop Portfolio spot uses canonical Toss + Upbit only and preserves stale evidence', async ({ page }) => {
  const diagnostics = await installRegular(page, 'spot');

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/accounts/read-only/toss') {
      return fulfill(route, snapshot('toss', {
        connected: true,
        status: 'CONNECTED',
        errorCode: null,
        accounts: [{ market: 'KR', accountRef: 'TOSS-READONLY', currency: 'KRW', buyingPower: null }],
        balances: [],
        positions: [],
      }));
    }
    if (path === '/api/accounts/read-only/upbit') {
      return fulfill(route, snapshot('upbit', {
        connected: true,
        status: 'STALE',
        stale: true,
        lastGoodAt: NOW,
        errorCode: 'ACCOUNT_LAST_GOOD_STALE',
        accounts: [{ market: 'UPBIT', accountRef: 'UPBIT-READONLY', currency: 'KRW', buyingPower: null }],
        balances: [{ currency: 'KRW', available: 0, locked: 0, total: 0, estimatedKrwValue: 0 }],
        positions: [],
      }));
    }
    if (path === '/api/accounts/read-only/bitget') return fulfill(route, snapshot('bitget'));
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/portfolio');

  await expect(page.getByTestId('portfolio-coin-readonly')).toBeVisible();
  await expect(page.getByTestId('brokerage-account-connections')).toBeVisible();
  await expect(page.getByTestId('connection-toss')).toBeVisible();
  const upbit = page.getByTestId('connection-upbit');
  await expect(upbit).toBeVisible();
  await expect(upbit).toContainText('이전 정상값');
  await expect(upbit).toContainText('보유 자산 오래된 데이터');
  await expect(page.getByTestId('connection-bitget')).toHaveCount(0);

  await expect.poll(() => diagnostics.canonical.toss).toBe(1);
  await expect.poll(() => diagnostics.canonical.upbit).toBe(1);
  expect(diagnostics.canonical.bitget).toBe(0);
  assertNoLegacyOrMutation(diagnostics);

  const body = await page.locator('body').innerText();
  expect(body).not.toContain('clientSecret');
  expect(body).not.toContain('secretKey');
  expect(body).not.toContain('passphrase');
  expect(body).not.toContain('encryptedCredentials');
  expect(body).not.toContain('masterKey');
});

test('mobile Portfolio futures uses one canonical Toss + Bitget snapshot and no legacy futures calls', async ({ page }) => {
  const diagnostics = await installRegular(page, 'futures');

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/accounts/read-only/toss') return fulfill(route, snapshot('toss'));
    if (path === '/api/accounts/read-only/upbit') return fulfill(route, snapshot('upbit'));
    if (path === '/api/accounts/read-only/bitget') {
      return fulfill(route, snapshot('bitget', {
        connected: true,
        status: 'CONNECTED',
        errorCode: null,
        accounts: [{ market: 'BITGET', accountRef: 'BITGET-READONLY', currency: 'USDT', buyingPower: 25 }],
        balances: [{ currency: 'USDT', available: 25, locked: 0, total: 25, estimatedKrwValue: null }],
        positions: [{ market: 'BITGET', symbol: 'BTCUSDT', quantity: 0.01, availableQuantity: 0.01, averageEntryPrice: 100000, currentPrice: 101000, marketValue: 1010, unrealizedPnl: 10, unrealizedPnlPercent: 1, leverage: 2, liquidationPrice: null, marginMode: 'isolated', side: 'long' }],
      }));
    }
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/portfolio');

  await expect(page.getByTestId('portfolio-coin-readonly')).toBeVisible();
  await expect(page.getByTestId('connection-toss')).toBeVisible();
  await expect(page.getByTestId('connection-bitget')).toBeVisible();
  await expect(page.getByTestId('connection-upbit')).toHaveCount(0);
  await expect(page.getByTestId('connection-bitget')).toContainText('BTCUSDT');

  await expect.poll(() => diagnostics.canonical.toss).toBe(1);
  await expect.poll(() => diagnostics.canonical.bitget).toBe(1);
  expect(diagnostics.canonical.upbit).toBe(0);
  assertNoLegacyOrMutation(diagnostics);

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  const body = await page.locator('body').innerText();
  expect(body).not.toContain('clientSecret');
  expect(body).not.toContain('secretKey');
  expect(body).not.toContain('passphrase');
  expect(body).not.toContain('encryptedCredentials');
  expect(body).not.toContain('masterKey');
});
