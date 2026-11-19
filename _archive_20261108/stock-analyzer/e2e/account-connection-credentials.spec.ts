import { test, expect, type Page, type Route } from '@playwright/test';

const NOW = '2026-08-17T08:30:00.000Z';
const USER_ID = '88888888-8888-4888-8888-888888888888';
const AUTH_STORAGE_KEY = 'sb-127-auth-token';

function fulfill(route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', headers, body: JSON.stringify(body) });
}

function emptySnapshot(provider: 'toss' | 'kiwoom' | 'upbit' | 'bitget', overrides: Record<string, unknown> = {}) {
  return {
    provider, readOnly: true, connected: false, status: 'NOT_CONFIGURED', accounts: null, balances: null, positions: null, openOrders: null,
    checkedAt: NOW, lastGoodAt: null, stale: false, errorCode: 'ACCOUNT_NOT_CONFIGURED',
    orderRequests: 0, cancelRequests: 0, amendRequests: 0, transferRequests: 0, withdrawalRequests: 0,
    credentialsReturned: false, liveTradingEnabled: false, autoTradingEnabled: false, ...overrides,
  };
}

async function installMember(page: Page, membershipLevel: 'regular' | 'admin' = 'regular') {
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
    if (path.startsWith('/api/trade-automation/connections/')) diagnostics.legacyConnectionCalls.push(`${request.method()} ${path}`);
  });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) return fulfill(route, {
      id: USER_ID,
      login_name: membershipLevel === 'admin' ? 'account-link-admin' : 'account-link-regular',
      display_name: '계좌연동 사용자',
      role: membershipLevel === 'admin' ? 'admin' : 'regular',
      status: 'approved',
      membership_level: membershipLevel,
      is_active: true,
      permissions_updated_at: NOW,
      updated_at: NOW,
    });
    if (pathname.endsWith('/auth/v1/user')) return fulfill(route, { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'account-link@accounts.invalid', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: '계좌연동 사용자' }, identities: [], created_at: NOW });
    return fulfill(route, { ok: true });
  });

  return {
    diagnostics,
    assertClean(expectedTradeConnectionCalls = 0) {
      expect(diagnostics.consoleErrors, diagnostics.consoleErrors.join('\n')).toEqual([]);
      expect(diagnostics.pageErrors, diagnostics.pageErrors.join('\n')).toEqual([]);
      expect(diagnostics.forbiddenTradeMutations, diagnostics.forbiddenTradeMutations.join('\n')).toEqual([]);
      expect(diagnostics.legacyConnectionCalls.length, diagnostics.legacyConnectionCalls.join('\n')).toBe(expectedTradeConnectionCalls);
    },
  };
}

test('regular user sees only Toss Upbit Bitget account linking and Kiwoom is hidden', async ({ page }) => {
  const { assertClean } = await installMember(page);
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
  const readonlyPanel = page.getByTestId('brokerage-account-connections');
  await expect(readonlyPanel).not.toContainText('Kiwoom');
  await expect(readonlyPanel).not.toContainText('키움');
  await expect(page.getByTestId('trade-execution-connections')).toHaveCount(0);
  assertClean();
});

test('regular user saves Upbit credentials only through canonical account-readonly vault', async ({ page }) => {
  const { assertClean } = await installMember(page);
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
    if (path === '/api/accounts/read-only/credentials/upbit' && route.request().method() === 'DELETE') {
      configured = false;
      return fulfill(route, { ok: true, provider: 'upbit', configured: false, purpose: 'read_only', credentialsReturned: false, privateProviderRequests: 0, orderRequests: 0, cancelRequests: 0, amendRequests: 0, transferRequests: 0, withdrawalRequests: 0, liveTradingEnabled: false, autoTradingEnabled: false });
    }
    if (path === '/api/user-integrations') return fulfill(route, { brokerConnections: [], telegram: { connected: false, status: 'DISCONNECTED', connectedAt: null }, preferences: {} });
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/account');
  await page.getByRole('button', { name: 'Upbit 조회 연결 설정' }).click();
  const accessKey = 'UPBIT_ACCESS_TEST_ONLY_123'; const secretKey = 'UPBIT_SECRET_TEST_ONLY_456';
  await page.getByTestId('upbit-credential-primary').fill(accessKey); await page.getByTestId('upbit-credential-secret').fill(secretKey); await page.getByTestId('upbit-save-connection').click();
  const upbit = page.getByTestId('connection-upbit');
  await expect(page.getByRole('status')).toContainText('저장 완료 · Upbit 조회 전용 키를 암호화 Vault에 저장했습니다.');
  await expect(upbit).toContainText('검증 필요');
  await expect(upbit).toContainText('보유 자산 미수집');
  await expect(upbit).not.toContainText('보유 자산 0개');
  await expect(upbit).not.toContainText('미연결');
  expect(savedBody).toEqual({ purpose: 'read_only', permissions: ['read'], credentials: { accessKey, secretKey } });
  expect(await page.locator('body').innerText()).not.toContain(accessKey); expect(await page.locator('body').innerText()).not.toContain(secretKey);
  await upbit.getByRole('button', { name: '조회 연결 해제' }).click();
  await expect(page.getByRole('status')).toContainText('연결 해제 완료 · Upbit 조회 키를 삭제했습니다.');
  await expect(upbit).toContainText('미연결');
  assertClean();
});

test('Toss credential form is read-only, Account Seq is optional, and mobile dialogs stay in viewport', async ({ page }) => {
  const { assertClean } = await installMember(page);
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
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(361);
  await expect(page.getByTestId('brokerage-account-connections')).not.toContainText('Kiwoom');
  await expect(page.getByTestId('trade-execution-connections')).toHaveCount(0);
  assertClean();
});

test('account metrics distinguish real zero from missing, stale, and unavailable evidence', async ({ page }) => {
  const { assertClean } = await installMember(page);
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/accounts/read-only/toss') return fulfill(route, emptySnapshot('toss', {
      connected: true,
      status: 'CONNECTED',
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

  await expect(page.getByTestId('brokerage-account-connections')).not.toContainText('Kiwoom');
  await expect(page.getByTestId('trade-execution-connections')).toHaveCount(0);
  assertClean();
});


test('server-declared Kiwoom capability exposes a read-only setup card and saves only App Key/App Secret', async ({ page }) => {
  const { assertClean } = await installMember(page);
  let savedBody: Record<string, unknown> | null = null;
  let configured = false;

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/accounts/read-only/credentials/status') {
      return fulfill(route, {
        ok: true,
        encryptionConfigured: true,
        supportedProviders: ['toss', 'kiwoom', 'upbit', 'bitget'],
        hiddenProviders: [],
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
    if (path === '/api/accounts/read-only/toss') return fulfill(route, emptySnapshot('toss'));
    if (path === '/api/accounts/read-only/kiwoom') return fulfill(route, emptySnapshot('kiwoom', configured ? { status: 'CONFIGURED_UNVERIFIED', errorCode: 'ACCOUNT_READ_DISABLED' } : {}));
    if (path === '/api/accounts/read-only/upbit') return fulfill(route, emptySnapshot('upbit'));
    if (path === '/api/accounts/read-only/bitget') return fulfill(route, emptySnapshot('bitget'));
    if (path === '/api/accounts/read-only/credentials/kiwoom' && method === 'PUT') {
      savedBody = route.request().postDataJSON() as Record<string, unknown>;
      configured = true;
      return fulfill(route, {
        ok: true,
        provider: 'kiwoom',
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
    if (path === '/api/user-integrations') return fulfill(route, { brokerConnections: [], telegram: { connected: false, status: 'DISCONNECTED', connectedAt: null }, preferences: {} });
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/account');

  const kiwoom = page.getByTestId('connection-kiwoom');
  await expect(kiwoom).toBeVisible();
  await expect(kiwoom).toContainText('공식 REST KR/US 잔고·미체결 조회');
  await page.getByRole('button', { name: 'Kiwoom 조회 연결 설정' }).click();

  const appKey = 'KIWOOM_APP_E2E_TEST_ONLY';
  const appSecret = 'KIWOOM_SECRET_E2E_TEST_ONLY';
  await page.getByTestId('kiwoom-credential-primary').fill(appKey);
  await page.getByTestId('kiwoom-credential-secret').fill(appSecret);
  await page.getByTestId('kiwoom-save-connection').click();

  expect(savedBody).toEqual({
    purpose: 'read_only',
    permissions: ['read'],
    credentials: { appKey, appSecret },
  });
  await expect(page.getByRole('status')).toContainText('저장 완료 · Kiwoom 조회 전용 키를 암호화 Vault에 저장했습니다.');
  const body = await page.locator('body').innerText();
  expect(body).not.toContain(appKey);
  expect(body).not.toContain(appSecret);
  assertClean();
});


test('admin live Upbit trading key is saved separately with read+orders only and does not activate live execution', async ({ page }) => {
  const { assertClean } = await installMember(page, 'admin');
  let savedBody: Record<string, unknown> | null = null;
  let configured = false;

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/accounts/read-only/credentials/status') {
      return fulfill(route, {
        ok: true,
        encryptionConfigured: true,
        supportedProviders: ['toss', 'upbit', 'bitget'],
        hiddenProviders: ['kiwoom'],
        credentialsReturned: false,
      });
    }
    if (path === '/api/accounts/read-only/toss') return fulfill(route, emptySnapshot('toss'));
    if (path === '/api/accounts/read-only/upbit') return fulfill(route, emptySnapshot('upbit'));
    if (path === '/api/accounts/read-only/bitget') return fulfill(route, emptySnapshot('bitget'));
    if (path === '/api/trade-automation/status') {
      return fulfill(route, {
        ok: true,
        policy: {
          mode: 'approval',
          automaticEnabled: false,
          emergencyStopped: false,
          marketEnabled: { domestic_stock: true, us_stock: true, crypto_spot: true, crypto_futures: true },
          stockBrokerByMarket: { domestic_stock: 'kiwoom', us_stock: 'kiwoom' },
          exchangeEnabled: { toss: false, kiwoom: false, upbit: false, bitget: false },
          enabledAssets: { toss: [], kiwoom: [], upbit: [], bitget: [] },
          enabledStrategies: [],
          totalCapitalKrw: 1_000_000,
          maxOrderKrw: 100_000,
          dailyLossLimitPercent: 5,
          maxAssetPercent: 30,
          maxOpenPositions: 5,
          maxDailyOrders: 10,
          maxConsecutiveLosses: 3,
          bitgetLeverage: 2,
        },
        connections: configured ? [{
          exchange: 'upbit',
          accountMode: 'live',
          configured: true,
          lastVerifiedAt: null,
          lastErrorCode: 'LIVE_EXECUTION_NOT_VERIFIED',
          credentialsExposed: false,
        }] : [],
        emergencyStopped: false,
        credentialVault: { encryptionConfigured: true, keyValueExposed: false },
        liveExecutionServerEnabled: { toss: false, kiwoom: false, upbit: false, bitget: false },
        lastOrder: null,
      });
    }
    if (path === '/api/trade-automation/connections/upbit' && method === 'PUT') {
      savedBody = route.request().postDataJSON() as Record<string, unknown>;
      configured = true;
      return fulfill(route, {
        ok: true,
        exchange: 'upbit',
        accountMode: 'live',
        configured: true,
        credentialsReturned: false,
        liveExecutionActivated: false,
        providerMutationRequests: 0,
      });
    }
    if (path === '/api/user-integrations') {
      return fulfill(route, { brokerConnections: [], telegram: { connected: false, status: 'DISCONNECTED', connectedAt: null }, preferences: {} });
    }
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/account');

  const panel = page.getByTestId('trade-execution-connections');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('live-connection-upbit')).toContainText(/거래키\s*미연결/);

  await page.getByTestId('live-connection-upbit').getByRole('button', { name: '다른 키 입력' }).click();
  const dialog = page.getByRole('dialog', { name: '실주문 거래키 연결' });
  await expect(dialog).toBeVisible();

  const accessKey = 'UPBIT_LIVE_ACCESS_TEST_ONLY';
  const secretKey = 'UPBIT_LIVE_SECRET_TEST_ONLY';
  await dialog.getByLabel('Access Key').fill(accessKey);
  await dialog.getByLabel('Secret Key').fill(secretKey);
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '실주문 거래키 저장' }).click();

  expect(savedBody).toEqual({
    accountMode: 'live',
    purpose: 'live_execution',
    permissions: ['read', 'orders'],
    credentials: { accessKey, secretKey },
  });
  await expect(page.getByTestId('live-connection-upbit')).toContainText(/거래키\s*저장됨/);
  await expect(page.getByTestId('live-connection-upbit')).toContainText(/수동 실주문\s*OFF/);
  await expect(page.getByTestId('live-connection-upbit')).toContainText(/자동 실주문\s*OFF/);
  await expect(page.getByRole('status')).toContainText('저장만으로 주문은 실행되지 않습니다.');

  const body = await page.locator('body').innerText();
  expect(body).not.toContain(accessKey);
  expect(body).not.toContain(secretKey);
  assertClean(1);
});

test('admin can reuse a saved read-only Upbit key for live verification without retyping secrets', async ({ page }) => {
  const { assertClean } = await installMember(page, 'admin');
  let reused = false;
  let reuseRequests = 0;

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/accounts/read-only/credentials/status') {
      return fulfill(route, {
        ok: true,
        encryptionConfigured: true,
        supportedProviders: ['toss', 'upbit', 'bitget'],
        hiddenProviders: ['kiwoom'],
        credentialsReturned: false,
      });
    }
    if (path === '/api/accounts/read-only/toss') return fulfill(route, emptySnapshot('toss'));
    if (path === '/api/accounts/read-only/upbit') return fulfill(route, emptySnapshot('upbit'));
    if (path === '/api/accounts/read-only/bitget') return fulfill(route, emptySnapshot('bitget'));
    if (path === '/api/trade-automation/status') {
      return fulfill(route, {
        ok: true,
        policy: {
          mode: 'automatic',
          automaticEnabled: true,
          emergencyStopped: false,
          marketEnabled: { domestic_stock: true, us_stock: true, crypto_spot: true, crypto_futures: true },
          stockBrokerByMarket: { domestic_stock: 'kiwoom', us_stock: 'kiwoom' },
          exchangeEnabled: { toss: true, kiwoom: true, upbit: true, bitget: true },
          enabledAssets: { toss: [], kiwoom: [], upbit: [], bitget: [] },
          enabledStrategies: [],
          totalCapitalKrw: 1_000_000,
          maxOrderKrw: 100_000,
          dailyLossLimitPercent: 5,
          maxAssetPercent: 30,
          maxOpenPositions: 5,
          maxDailyOrders: 10,
          maxConsecutiveLosses: 3,
          bitgetLeverage: 3,
        },
        connections: reused ? [{
          exchange: 'upbit',
          accountMode: 'live',
          configured: true,
          lastVerifiedAt: '2026-10-03T10:00:00.000Z',
          lastErrorCode: null,
          credentialsExposed: false,
        }] : [],
        emergencyStopped: false,
        credentialVault: { encryptionConfigured: true, keyValueExposed: false },
        liveExecutionServerEnabled: { toss: true, kiwoom: true, upbit: true, bitget: true },
        liveAutomaticExecutionServerEnabled: { toss: true, kiwoom: true, upbit: true, bitget: true },
        liveExecutionReadiness: {
          upbit: reused ? {
            connectionConfigured: true,
            providerVerified: true,
            manualServerGateEnabled: true,
            automaticServerGateEnabled: true,
            readyForManualOrderEvaluation: true,
            readyForAutomaticOrderEvaluation: true,
            blockers: [],
            orderTimeRiskRecheckRequired: true,
            orderSubmissionPerformedByStatusRequest: false,
          } : {
            connectionConfigured: false,
            providerVerified: false,
            manualServerGateEnabled: true,
            automaticServerGateEnabled: true,
            readyForManualOrderEvaluation: false,
            readyForAutomaticOrderEvaluation: false,
            blockers: ['LIVE_CONNECTION_NOT_CONFIGURED'],
            orderTimeRiskRecheckRequired: true,
            orderSubmissionPerformedByStatusRequest: false,
          },
        },
        lastOrder: null,
      });
    }
    if (path === '/api/trade-automation/connections/upbit/reuse-readonly' && method === 'POST') {
      reuseRequests += 1;
      expect(route.request().postDataJSON()).toEqual({ confirmed: true });
      reused = true;
      return fulfill(route, {
        ok: true,
        exchange: 'upbit',
        accountMode: 'live',
        configured: true,
        verified: true,
        reusedReadonlyCredential: true,
        lastVerifiedAt: '2026-10-03T10:00:00.000Z',
        providerRequests: 1,
        credentialsReturned: false,
        liveExecutionActivated: false,
        automaticLiveExecutionActivated: false,
        orderRequests: 0,
        cancelRequests: 0,
        amendRequests: 0,
        transferRequests: 0,
        withdrawalRequests: 0,
        realOrderSubmitted: false,
      });
    }
    if (path === '/api/user-integrations') {
      return fulfill(route, { brokerConnections: [], telegram: { connected: false, status: 'DISCONNECTED', connectedAt: null }, preferences: {} });
    }
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/account');

  const card = page.getByTestId('live-connection-upbit');
  await expect(card).toContainText(/거래키\s*미연결/);
  await expect(card.getByRole('button', { name: '저장된 조회키로 연결·검증' })).toBeVisible();
  await card.getByRole('button', { name: '저장된 조회키로 연결·검증' }).click();

  await expect(card).toContainText(/거래키\s*저장됨/);
  await expect(card).toContainText(/provider 검증\s*검증됨/);
  await expect(card).toContainText(/수동 실주문\s*ON/);
  await expect(card).toContainText(/자동 실주문\s*ON/);
  await expect(page.getByRole('status')).toContainText('저장된 실계좌 조회키를 재사용해 provider 검증까지 완료했습니다.');
  expect(reuseRequests).toBe(1);
  const body = await page.locator('body').innerText();
  expect(body).not.toContain('UPBIT_LIVE_ACCESS_TEST_ONLY');
  expect(body).not.toContain('UPBIT_LIVE_SECRET_TEST_ONLY');
  assertClean(1);
});

test('account refresh displays only allowlisted Toss and Bitget authentication diagnostics', async ({ page }) => {
  const { assertClean } = await installMember(page);
  let bitgetConnected = false;
  const forbidden = [
    'BITGET_UI_KEY_MUST_NOT_LEAK',
    'BITGET_UI_SECRET_MUST_NOT_LEAK',
    'BITGET_UI_PASSPHRASE_MUST_NOT_LEAK',
    'BITGET_UI_SIGNATURE_MUST_NOT_LEAK',
    'BITGET_UI_AUTHORIZATION_MUST_NOT_LEAK',
    'BITGET_UI_CIPHERTEXT_MUST_NOT_LEAK',
    'BITGET_UI_ACCOUNT_MUST_NOT_LEAK',
  ];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/accounts/read-only/toss') return fulfill(route, emptySnapshot('toss', {
      status: 'AUTH_FAILED', errorCode: 'TOSS_TOKEN_AUTH_FAILED',
    }));
    if (path === '/api/accounts/read-only/upbit') return fulfill(route, emptySnapshot('upbit'));
    if (path === '/api/accounts/read-only/bitget') {
      if (bitgetConnected) return fulfill(route, emptySnapshot('bitget', {
        connected: true, status: 'CONNECTED', errorCode: null, lastGoodAt: NOW, accounts: [], balances: [], positions: [], openOrders: [],
      }));
      return fulfill(route, emptySnapshot('bitget', {
        status: 'AUTH_FAILED', errorCode: 'BITGET_AUTH_FAILED',
      }), 200, {
        'X-Account-Readonly-Bitget-Diagnostic': JSON.stringify({
          provider: 'bitget',
          requestMethod: 'GET',
          requestPath: '/api/v2/mix/account/accounts',
          endpointFamily: 'CLASSIC',
          probe: 'ASSETS',
          httpStatus: 400,
          applicationCode: '40012',
          sanitizedClassification: 'BITGET_AUTH_FAILED',
          fallbackAttempted: true,
          timestampRejected: false,
          productionHost: true,
          credentialPresence: { key: true, secret: true, passphrase: true },
          apiKey: forbidden[0],
          secretKey: forbidden[1],
          passphrase: forbidden[2],
          signature: forbidden[3],
          authorization: forbidden[4],
          encryptedCredentials: forbidden[5],
          accountUid: forbidden[6],
        }),
      });
    }
    if (path === '/api/user-integrations') return fulfill(route, { brokerConnections: [], telegram: { connected: false, status: 'DISCONNECTED', connectedAt: null }, preferences: {} });
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/account');

  const toss = page.getByTestId('connection-toss');
  await expect(toss).toContainText('Toss Client ID / Client Secret을 다시 입력하거나 재발급해 주세요.');
  await expect(toss).toContainText('TOSS_TOKEN_AUTH_FAILED');
  await expect(toss.getByTestId('account-readonly-metadata-toss')).toContainText('조회 키 저장됨');
  await expect(toss.getByTestId('account-readonly-metadata-toss')).toContainText('최근 오류 TOSS_TOKEN_AUTH_FAILED');

  const bitget = page.getByTestId('connection-bitget');
  const diagnostic = bitget.getByTestId('bitget-readonly-diagnostic');
  await expect(diagnostic).toContainText('HTTP 400');
  await expect(diagnostic).toContainText('code 40012');
  await expect(diagnostic).toContainText('Classic');
  await expect(diagnostic).toContainText('ASSETS');
  await expect(diagnostic).toContainText('fallback=true');
  await expect(diagnostic).toContainText('BITGET_AUTH_FAILED');
  for (const value of forbidden) await expect(page.locator('body')).not.toContainText(value);

  bitgetConnected = true;
  await page.getByRole('button', { name: '계좌 연결 새로고침' }).click();
  await expect(bitget).toContainText('연결됨');
  await expect(bitget.getByTestId('bitget-readonly-diagnostic')).toHaveCount(0);
  assertClean();
});

test('saving Toss read-only credentials immediately refreshes its snapshot without a workflow or mutation', async ({ page }) => {
  const { assertClean } = await installMember(page);
  const clientId = 'TOSS_SAVE_REFRESH_CLIENT_TEST_ONLY';
  const clientSecret = 'TOSS_SAVE_REFRESH_SECRET_TEST_ONLY';
  let configured = false;
  let tossSnapshots = 0;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/accounts/read-only/toss') {
      tossSnapshots += 1;
      return fulfill(route, emptySnapshot('toss', configured
        ? { status: 'AUTH_FAILED', errorCode: 'TOSS_IP_NOT_ALLOWED' }
        : {}));
    }
    if (path === '/api/accounts/read-only/upbit') return fulfill(route, emptySnapshot('upbit'));
    if (path === '/api/accounts/read-only/bitget') return fulfill(route, emptySnapshot('bitget'));
    if (path === '/api/accounts/read-only/credentials/toss' && method === 'PUT') {
      configured = true;
      return fulfill(route, { ok: true, provider: 'toss', configured: true, purpose: 'read_only', credentialsReturned: false });
    }
    if (path === '/api/user-integrations') return fulfill(route, { brokerConnections: [], telegram: { connected: false, status: 'DISCONNECTED', connectedAt: null }, preferences: {} });
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/account');
  await page.getByRole('button', { name: 'Toss 조회 연결 설정' }).click();
  await page.getByTestId('toss-credential-primary').fill(clientId);
  await page.getByTestId('toss-credential-secret').fill(clientSecret);
  await page.getByTestId('toss-save-connection').click();

  const toss = page.getByTestId('connection-toss');
  await expect(page.getByRole('status')).toContainText('저장 완료 · Toss 조회 전용 키를 암호화 Vault에 저장했습니다.');
  await expect(toss).toContainText('Toss Open API 허용 IP를 확인해 주세요.');
  await expect(toss).toContainText('TOSS_IP_NOT_ALLOWED');
  expect(tossSnapshots).toBeGreaterThanOrEqual(2);
  const body = await page.locator('body').innerText();
  expect(body).not.toContain(clientId);
  expect(body).not.toContain(clientSecret);
  assertClean();
});

