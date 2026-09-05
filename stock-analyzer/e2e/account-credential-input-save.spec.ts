import { test, expect, type Page, type Route } from '@playwright/test';

const NOW = '2026-09-04T09:32:00.000Z';
const USER_ID = '77777777-7777-4777-8777-777777777777';
const AUTH_STORAGE_KEY = 'sb-127-auth-token';
const ASSET_MODE_KEY = 'knowledge-info-asset-mode-v1';

type Provider = 'toss' | 'upbit' | 'bitget';

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

async function installAuthenticatedFuturesUser(page: Page) {
  await page.addInitScript(({ authStorageKey, assetModeKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(authStorageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'account-credential-save-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'account-credential-save@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '계좌연동 테스트 사용자' },
        identities: [],
        created_at: now,
      },
    }));
    window.localStorage.setItem(assetModeKey, JSON.stringify({ asset: 'coin', stockMarket: 'KR', coinMarket: 'futures' }));
  }, {
    authStorageKey: AUTH_STORAGE_KEY,
    assetModeKey: ASSET_MODE_KEY,
    userId: USER_ID,
    now: NOW,
  });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: USER_ID,
        login_name: 'account-credential-save-regular',
        display_name: '계좌연동 테스트 사용자',
        role: 'regular',
        status: 'approved',
        membership_level: 'regular',
        is_active: true,
        permissions_updated_at: NOW,
        updated_at: NOW,
      });
    }
    if (pathname.endsWith('/rest/v1/portfolio_holdings')) return fulfill(route, []);
    if (pathname.endsWith('/auth/v1/user')) {
      return fulfill(route, {
        id: USER_ID,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'account-credential-save@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '계좌연동 테스트 사용자' },
        identities: [],
        created_at: NOW,
      });
    }
    return fulfill(route, { ok: true });
  });
}

test('saved Bitget credentials show a masked saved state, typed values can be revealed, and Save PUT persists the replacement payload', async ({ page }) => {
  await installAuthenticatedFuturesUser(page);

  let saveCalls = 0;
  let savedBody: Record<string, unknown> | null = null;
  const unexpectedMutations: string[] = [];

  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET'
      && path !== '/api/accounts/read-only/credentials/bitget'
      && /\/(?:order|orders|cancel|amend|transfer|withdraw|withdrawal)(?:\/|$)/i.test(path)) {
      unexpectedMutations.push(`${request.method()} ${path}`);
    }
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === '/api/accounts/read-only/toss' && method === 'GET') return fulfill(route, snapshot('toss'));
    if (path === '/api/accounts/read-only/upbit' && method === 'GET') return fulfill(route, snapshot('upbit'));
    if (path === '/api/accounts/read-only/bitget' && method === 'GET') {
      return fulfill(route, snapshot('bitget', {
        status: 'CONFIGURED_UNVERIFIED',
        errorCode: 'ACCOUNT_READ_DISABLED',
      }));
    }
    if (path === '/api/accounts/read-only/credentials/bitget' && method === 'PUT') {
      saveCalls += 1;
      savedBody = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
      return fulfill(route, {
        ok: true,
        provider: 'bitget',
        configured: true,
        purpose: 'read_only',
        credentialsReturned: false,
        privateProviderRequests: 0,
        orderRequests: 0,
        cancelRequests: 0,
        amendRequests: 0,
        transferRequests: 0,
        withdrawalRequests: 0,
        liveTradingEnabled: false,
        autoTradingEnabled: false,
      });
    }
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/portfolio?tab=holdings');

  await expect(page.getByTestId('connection-bitget')).toBeVisible();
  await page.getByRole('button', { name: 'Bitget 조회 연결 설정' }).click();

  const dialog = page.getByRole('dialog', { name: 'Bitget 조회 연결 설정' });
  await expect(dialog).toBeVisible();

  const apiKey = page.getByTestId('bitget-credential-primary');
  const secretKey = page.getByTestId('bitget-credential-secret');
  const passphrase = page.getByTestId('bitget-credential-passphrase');

  await expect(apiKey).toBeVisible();
  await expect(apiKey).toHaveAttribute('placeholder', /저장됨/);
  await expect(secretKey).toHaveAttribute('placeholder', /저장됨/);
  await expect(passphrase).toHaveAttribute('placeholder', /저장됨/);
  await expect(dialog).toContainText('기존 키가 암호화 저장되어 있습니다');

  await apiKey.fill('BITGET_API_REPLACEMENT_TEST_ONLY');
  await expect(apiKey).toHaveAttribute('type', 'password');
  await expect(dialog).toContainText('입력됨 · 아직 저장 전입니다.');

  await page.getByTestId('bitget-credential-primary-visibility').click();
  await expect(apiKey).toHaveAttribute('type', 'text');
  await expect(apiKey).toHaveValue('BITGET_API_REPLACEMENT_TEST_ONLY');

  await secretKey.fill('BITGET_SECRET_REPLACEMENT_TEST_ONLY');
  await passphrase.fill('BITGET_PASSPHRASE_REPLACEMENT_TEST_ONLY');
  await page.getByTestId('bitget-save-connection').click();

  await expect(page.getByRole('dialog', { name: 'Bitget 조회 연결 설정' })).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('저장 완료 · Bitget 조회 전용 키를 암호화 저장했습니다.');
  expect(saveCalls).toBe(1);
  expect(savedBody).toEqual({
    purpose: 'read_only',
    permissions: ['read'],
    credentials: {
      apiKey: 'BITGET_API_REPLACEMENT_TEST_ONLY',
      secretKey: 'BITGET_SECRET_REPLACEMENT_TEST_ONLY',
      passphrase: 'BITGET_PASSPHRASE_REPLACEMENT_TEST_ONLY',
    },
  });
  expect(unexpectedMutations).toEqual([]);

  const pageText = await page.locator('body').innerText();
  expect(pageText).not.toContain('BITGET_SECRET_REPLACEMENT_TEST_ONLY');
  expect(pageText).not.toContain('BITGET_PASSPHRASE_REPLACEMENT_TEST_ONLY');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
});
