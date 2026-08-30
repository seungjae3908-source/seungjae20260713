import { test, expect, type Page, type Route } from '@playwright/test';
import { accountSnapshotForDisplay, parseReadonlyAccount } from '../src/lib/readonly-account-evidence';

const NOW = '2026-08-17T08:30:00.000Z';
const USER_ID = '88888888-8888-4888-8888-888888888888';
const AUTH_STORAGE_KEY = 'sb-127-auth-token';

test('canonical account evidence rejects unsafe or malformed snapshots and expires old reads', () => {
  const time = Date.parse(NOW);
  const good = emptySnapshot('upbit', { connected: true, status: 'CONNECTED', lastGoodAt: NOW, errorCode: null, balances: [{ currency: 'KRW', available: 0, locked: 0, total: 0, estimatedKrwValue: null }] });
  expect(parseReadonlyAccount(good, 'upbit', time)).toEqual(good);
  for (const invalid of [
    {}, { ...good, provider: 'bitget' }, { ...good, connected: 'true' }, { ...good, connected: false },
    { ...good, orderRequests: 1 }, { ...good, credentialsReturned: true }, { ...good, liveTradingEnabled: true },
    { ...good, checkedAt: null }, { ...good, checkedAt: '2026-02-30T00:00:00Z' },
    { ...good, balances: {} }, { ...good, balances: [{ currency: 'KRW', total: true }] },
    { ...good, balances: [{ total: 0 }] }, { ...good, positions: [{ market: 'UPBIT', quantity: 1 }] },
  ]) expect(() => parseReadonlyAccount(invalid, 'upbit', time)).toThrow();
  const parsed = parseReadonlyAccount(good, 'upbit', time);
  expect(accountSnapshotForDisplay(parsed, time + 60_001)).toMatchObject({ stale: true, status: 'STALE' });
  expect(accountSnapshotForDisplay(parsed, time)).toMatchObject({ stale: false, status: 'CONNECTED' });
  expect(accountSnapshotForDisplay({ ...parsed, lastGoodAt: null }, time)).toMatchObject({ stale: true, status: 'STALE' });
});

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

function emptySnapshot(provider: 'toss' | 'upbit' | 'bitget', overrides: Record<string, unknown> = {}) {
  return {
    provider, readOnly: true, connected: false, status: 'NOT_CONFIGURED', accounts: null, balances: null, positions: null, openOrders: null,
    checkedAt: NOW, lastGoodAt: null, stale: false, errorCode: 'ACCOUNT_NOT_CONFIGURED',
    orderRequests: 0, cancelRequests: 0, amendRequests: 0, transferRequests: 0, withdrawalRequests: 0,
    credentialsReturned: false, liveTradingEnabled: false, autoTradingEnabled: false, ...overrides,
  };
}

async function installRegular(page: Page) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken, refresh_token: 'account-link-refresh', expires_in: 3600, expires_at: expiresAt, token_type: 'bearer',
      user: { id: userId, aud: 'authenticated', role: 'authenticated', email: 'account-link@accounts.invalid', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: '계좌연동 사용자' }, identities: [], created_at: now },
    }));
  }, { storageKey: AUTH_STORAGE_KEY, userId: USER_ID, now: NOW });

  const diagnostics = { consoleErrors: [] as string[], pageErrors: [] as string[], forbiddenTradeMutations: [] as string[], legacyConnectionCalls: [] as string[] };
  page.on('console', (message) => { if (message.type() === 'error') diagnostics.consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/(?:order|orders|cancel|transfer|withdraw|deposit)(?:\/|$)/i.test(path) && request.method() !== 'GET') diagnostics.forbiddenTradeMutations.push(`${request.method()} ${path}`);
    if (path.startsWith('/api/trade-automation/connections/') || /^\/api\/crypto\/(?:spot\/accounts|futures\/(?:account|positions))$/.test(path)) diagnostics.legacyConnectionCalls.push(`${request.method()} ${path}`);
  });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) return fulfill(route, { id: USER_ID, login_name: 'account-link-regular', display_name: '계좌연동 사용자', role: 'regular', status: 'approved', membership_level: 'regular', is_active: true, permissions_updated_at: NOW, updated_at: NOW });
    if (pathname.endsWith('/auth/v1/user')) return fulfill(route, { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'account-link@accounts.invalid', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: '계좌연동 사용자' }, identities: [], created_at: NOW });
    if (pathname.endsWith('/rest/v1/portfolio_holdings')) return fulfill(route, []);
    return fulfill(route, { ok: true });
  });

  return {
    diagnostics,
    assertClean() {
      expect(diagnostics.consoleErrors, diagnostics.consoleErrors.join('\n')).toEqual([]);
      expect(diagnostics.pageErrors, diagnostics.pageErrors.join('\n')).toEqual([]);
      expect(diagnostics.forbiddenTradeMutations, diagnostics.forbiddenTradeMutations.join('\n')).toEqual([]);
      expect(diagnostics.legacyConnectionCalls, diagnostics.legacyConnectionCalls.join('\n')).toEqual([]);
    },
  };
}

test('regular user sees only Toss Upbit Bitget account linking and Kiwoom is hidden', async ({ page }) => {
  const { assertClean } = await installRegular(page);
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/accounts/read-only/toss') return fulfill(route, emptySnapshot('toss'));
    if (path === '/api/accounts/read-only/upbit') return fulfill(route, emptySnapshot('upbit'));
    if (path === '/api/accounts/read-only/bitget') return fulfill(route, emptySnapshot('bitget'));
    if (path === '/api/user-integrations') return fulfill(route, { brokerConnections: [], telegram: { connected: false, status: 'DISCONNECTED', connectedAt: null }, preferences: {} });
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/account');
  await expect(page.getByTestId('brokerage-account-connections')).toBeVisible();
  await expect(page.getByTestId('connection-toss')).toBeVisible();
  await expect(page.getByTestId('connection-upbit')).toBeVisible();
  await expect(page.getByTestId('connection-bitget')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Kiwoom');
  await expect(page.locator('body')).not.toContainText('키움');
  assertClean();
});

test('regular user saves Upbit credentials only through canonical account-readonly vault', async ({ page }) => {
  const { assertClean } = await installRegular(page);
  let savedBody: Record<string, unknown> | null = null;
  let configured = false;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/accounts/read-only/toss') return fulfill(route, emptySnapshot('toss'));
    if (path === '/api/accounts/read-only/bitget') return fulfill(route, emptySnapshot('bitget'));
    if (path === '/api/accounts/read-only/upbit') return fulfill(route, emptySnapshot('upbit', configured ? { status: 'CONFIGURED_UNVERIFIED', errorCode: 'ACCOUNT_READ_DISABLED' } : {}));
    if (path === '/api/accounts/read-only/credentials/upbit' && route.request().method() === 'PUT') {
      savedBody = route.request().postDataJSON() as Record<string, unknown>; configured = true;
      return fulfill(route, { ok: true, provider: 'upbit', configured: true, purpose: 'read_only', credentialsReturned: false, privateProviderRequests: 0, orderRequests: 0, cancelRequests: 0, amendRequests: 0, transferRequests: 0, withdrawalRequests: 0, liveTradingEnabled: false, autoTradingEnabled: false });
    }
    if (path === '/api/user-integrations') return fulfill(route, { brokerConnections: [], telegram: { connected: false, status: 'DISCONNECTED', connectedAt: null }, preferences: {} });
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/account');
  await page.getByRole('button', { name: 'Upbit 조회 연결 설정' }).click();
  const accessKey = 'UPBIT_ACCESS_TEST_ONLY_123'; const secretKey = 'UPBIT_SECRET_TEST_ONLY_456';
  await page.getByTestId('upbit-credential-primary').fill(accessKey); await page.getByTestId('upbit-credential-secret').fill(secretKey); await page.getByTestId('upbit-save-connection').click();
  const upbit = page.getByTestId('connection-upbit');
  await expect(page.getByRole('status')).toContainText('암호화 저장');
  await expect(upbit).toContainText('검증 필요');
  await expect(upbit).toContainText('보유 자산 미수집');
  await expect(upbit).not.toContainText('보유 자산 0개');
  await expect(upbit).not.toContainText('미연결');
  expect(savedBody).toEqual({ purpose: 'read_only', permissions: ['read'], credentials: { accessKey, secretKey } });
  expect(await page.locator('body').innerText()).not.toContain(accessKey); expect(await page.locator('body').innerText()).not.toContain(secretKey); assertClean();
});

test('Toss credential form is read-only, Account Seq is optional, and mobile dialogs stay in viewport', async ({ page }) => {
  const { assertClean } = await installRegular(page);
  let tossBody: Record<string, unknown> | null = null;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/accounts/read-only/toss') return fulfill(route, emptySnapshot('toss'));
    if (path === '/api/accounts/read-only/upbit') return fulfill(route, emptySnapshot('upbit'));
    if (path === '/api/accounts/read-only/bitget') return fulfill(route, emptySnapshot('bitget'));
    if (path === '/api/accounts/read-only/credentials/toss' && route.request().method() === 'PUT') { tossBody = route.request().postDataJSON() as Record<string, unknown>; return fulfill(route, { ok: true, provider: 'toss', configured: true, purpose: 'read_only', credentialsReturned: false }); }
    if (path === '/api/user-integrations') return fulfill(route, { brokerConnections: [], telegram: { connected: false, status: 'DISCONNECTED', connectedAt: null }, preferences: {} });
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });
  await page.setViewportSize({ width: 360, height: 800 }); await page.goto('/account');
  await page.getByRole('button', { name: 'Toss 조회 연결 설정' }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox(); expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(361);
  await page.getByTestId('toss-credential-primary').fill('TOSS_CLIENT_TEST_ONLY'); await page.getByTestId('toss-credential-secret').fill('TOSS_SECRET_TEST_ONLY'); await page.getByTestId('toss-save-connection').click();
  expect(tossBody).toEqual({ purpose: 'read_only', permissions: ['read'], credentials: { clientId: 'TOSS_CLIENT_TEST_ONLY', clientSecret: 'TOSS_SECRET_TEST_ONLY' } });
  await page.getByRole('button', { name: 'Bitget 조회 연결 설정' }).click(); const bitgetBox = await page.getByRole('dialog').boundingBox(); expect(bitgetBox).not.toBeNull(); expect(bitgetBox!.x + bitgetBox!.width).toBeLessThanOrEqual(361);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(361); await expect(page.locator('body')).not.toContainText('Kiwoom'); assertClean();
});

test('account metrics distinguish real zero from missing, stale, and unavailable evidence', async ({ page }) => {
  const { assertClean } = await installRegular(page);
  const observedAt = new Date().toISOString();
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/accounts/read-only/toss') return fulfill(route, emptySnapshot('toss', {
      connected: true,
      status: 'CONNECTED',
      checkedAt: observedAt,
      lastGoodAt: observedAt,
      errorCode: null,
      accounts: [],
      positions: [{ market: 'KR', symbol: '005930', quantity: 1, availableQuantity: 1, averageEntryPrice: null, currentPrice: null, marketValue: null, unrealizedPnl: 0, unrealizedPnlPercent: 0, leverage: null, liquidationPrice: null, marginMode: null, side: null }],
    }));
    if (path === '/api/accounts/read-only/upbit') return fulfill(route, emptySnapshot('upbit', {
      connected: true,
      status: 'STALE',
      stale: true,
      lastGoodAt: NOW,
      errorCode: 'ACCOUNT_LAST_GOOD_STALE',
      balances: [{ currency: 'KRW', available: 0, locked: 0, total: 0, estimatedKrwValue: 0 }],
    }));
    if (path === '/api/accounts/read-only/bitget') return fulfill(route, emptySnapshot('bitget', {
      status: 'UNAVAILABLE',
      errorCode: 'ACCOUNT_PROVIDER_UNAVAILABLE',
    }));
    if (path === '/api/user-integrations') return fulfill(route, { brokerConnections: [], telegram: { connected: false, status: 'DISCONNECTED', connectedAt: null }, preferences: {} });
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/account');

  const toss = page.getByTestId('connection-toss');
  await expect(toss).toContainText('0개 시장');
  await expect(toss).toContainText('1종목');
  await expect(toss).toContainText('평가 미수집 · 손익 0');
  await expect(toss).not.toContainText('평가 -');

  const upbit = page.getByTestId('connection-upbit');
  await expect(upbit).toContainText('이전 정상값');
  await expect(upbit).toContainText('보유 자산 오래된 데이터');

  const bitget = page.getByTestId('connection-bitget');
  await expect(bitget).toContainText('조회 불가');
  await expect(bitget).toContainText('사용 불가');

  await expect(page.locator('body')).not.toContainText('Kiwoom');
  assertClean();
});

const accountViewports = [
  { width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 320, height: 740 },
  { width: 360, height: 800 }, { width: 390, height: 844 }, { width: 412, height: 915 }, { width: 430, height: 932 },
];
for (const viewport of accountViewports) {
  test(`coin portfolio uses member readonly evidence, clears failed refresh and never calls legacy private routes ${viewport.width}`, async ({ page }) => {
    const { assertClean } = await installRegular(page);
    await page.setViewportSize(viewport);
    await page.addInitScript(() => localStorage.setItem('knowledge-info-asset-mode-v1', JSON.stringify({ asset: 'coin', stockMarket: 'KR', coinMarket: 'spot' })));
    let malformed = false;
    const reads: string[] = [];
    await page.route('**/api/**', (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/accounts/read-only/upbit') {
        reads.push(pathname);
        const time = new Date().toISOString();
        return fulfill(route, malformed ? { provider: 'upbit', connected: true, status: 'CONNECTED' } : emptySnapshot('upbit', {
          connected: true, status: 'CONNECTED', checkedAt: time, lastGoodAt: time, errorCode: null,
          balances: [{ currency: 'KRW', available: 0, locked: 0, total: 0, estimatedKrwValue: null }],
        }));
      }
      if (pathname === '/api/accounts/read-only/toss') return fulfill(route, emptySnapshot('toss'));
      if (pathname === '/api/accounts/read-only/bitget') throw new Error('spot portfolio must not load futures credentials');
      if (pathname === '/api/backup/latest') return fulfill(route, { ok: true, exists: false });
      return fulfill(route, { ok: true, items: [], rows: [], results: [] });
    });
    await page.goto('/portfolio?tab=holdings');
    const portfolio = page.getByTestId('portfolio-coin-readonly');
    await expect(portfolio).toBeVisible();
    const upbit = page.getByTestId('connection-upbit');
    await expect(upbit).toContainText('연결됨');
    await expect(upbit).toContainText('보유 자산 0개');
    await expect(page.getByTestId('connection-bitget')).toHaveCount(0);
    malformed = true;
    await portfolio.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect(upbit).toContainText('조회 불가');
    await expect(upbit).not.toContainText('연결됨');
    await expect(upbit).not.toContainText('보유 자산 0개');
    await expect(portfolio.getByRole('alert')).toContainText('ACCOUNT_RESPONSE_INVALID');
    expect(reads.length).toBe(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1);
    assertClean();
  });
}

test('account display stops presenting an old successful read as current', async ({ page }) => {
  const { assertClean } = await installRegular(page);
  const time = new Date();
  await page.clock.install({ time });
  await page.route('**/api/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/accounts/read-only/upbit') return fulfill(route, emptySnapshot('upbit', {
      connected: true, status: 'CONNECTED', checkedAt: time.toISOString(), lastGoodAt: time.toISOString(), errorCode: null, balances: [],
    }));
    if (pathname === '/api/accounts/read-only/toss') return fulfill(route, emptySnapshot('toss'));
    if (pathname === '/api/accounts/read-only/bitget') return fulfill(route, emptySnapshot('bitget'));
    if (pathname === '/api/backup/latest') return fulfill(route, { ok: true, exists: false });
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });
  await page.goto('/account');
  const upbit = page.getByTestId('connection-upbit');
  await expect(upbit).toContainText('연결됨');
  await page.clock.fastForward(91_000);
  await expect(upbit).toContainText('이전 정상값');
  await expect(upbit).toContainText('보유 자산 오래된 데이터');
  await expect(upbit).not.toContainText('보유 자산 0개');
  assertClean();
});
