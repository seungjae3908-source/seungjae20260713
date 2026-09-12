import { expect, test, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  INVALID_ACCOUNT_READONLY_RESPONSE,
  isAccountReadonlySnapshotPath,
  requireAccountReadonlySnapshotResponse,
} from '../src/lib/account-readonly-response';

const authFetchPath = fileURLToPath(new URL('../src/lib/auth-fetch.ts', import.meta.url));
const componentPath = fileURLToPath(new URL('../src/components/brokerage-account-connections.tsx', import.meta.url));
const backendContractPath = fileURLToPath(new URL('../../api-server/src/features/account-readonly/account-readonly.contract.ts', import.meta.url));

const now = Date.parse('2026-09-10T00:00:00.000Z');
const accountUserId = '77777777-7777-4777-8777-777777777777';
const accountAuthStorageKey = 'sb-127-auth-token';
const canonical = {
  provider: 'toss',
  readOnly: true,
  connected: true,
  status: 'CONNECTED',
  accounts: [],
  balances: [],
  positions: [],
  openOrders: [],
  checkedAt: '2026-09-10T00:00:00.000Z',
  lastGoodAt: '2026-09-10T00:00:00.000Z',
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
};

const canonicalNotConfigured = {
  ...canonical,
  connected: false,
  status: 'NOT_CONFIGURED',
  accounts: null,
  balances: null,
  positions: null,
  openOrders: null,
  lastGoodAt: null,
  errorCode: 'ACCOUNT_NOT_CONFIGURED',
};

function canonicalUserIntegrations() {
  return {
    ok: true,
    brokerConnections: [],
    brokerConnectionsAvailable: true,
    brokerConnectionsErrorCode: null,
    brokerMetadataRead: true,
    telegram: { connected: false, status: 'DISCONNECTED', connectedAt: null },
    preferences: {
      ORDER_SUBMITTED: false,
      ORDER_PARTIALLY_FILLED: false,
      ORDER_FILLED: false,
      ORDER_CANCELLED: false,
      ORDER_REJECTED: false,
      POSITION_OPENED: false,
      POSITION_INCREASED: false,
      POSITION_REDUCED: false,
      POSITION_CLOSED: false,
      TAKE_PROFIT_FILLED: false,
      STOP_FILLED: false,
      MANUAL_PORTFOLIO_ENTRY: false,
    },
    deliveries: [],
    telegramStorageAvailable: true,
    telegramStorageErrorCode: null,
    alertPolicy: {
      userId: accountUserId,
      enabled: false,
      markets: ['KR', 'US', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'],
      signalTypes: ['BUY', 'LONG', 'SHORT', 'NO_TRADE', 'PRICE_TARGET', 'STRATEGY_HEALTH', 'CHAMPION', 'RESEARCH', 'SETTLEMENT', 'PROVIDER_SERVER_ERROR'],
      priorities: ['CRITICAL', 'IMPORTANT', 'INFO'],
      quietHours: { enabled: false, start: '22:00', end: '07:00', timeZone: 'Asia/Seoul', criticalBypass: true },
      cooldownMs: 300_000,
      sameEventDedupeMs: 86_400_000,
      sameSymbolWindowMs: 3_600_000,
      sameSymbolRepeatLimit: 3,
      deliveryMode: 'IMMEDIATE',
      digest: { enabled: false, windowMs: 1_800_000 },
    },
    alertPolicySource: 'DEFAULT_MISSING',
    alertPolicyStorageAvailable: true,
    alertPolicyStorageErrorCode: null,
    telegramRuntime: {
      deliveryReady: false,
      linkingReady: false,
      webhookConfigured: false,
      botUsernameConfigured: false,
      stockRoomReady: false,
      cryptoRoomReady: false,
      richSignalEnabled: false,
      aiExplanationEnabled: false,
      signalFollowupEnabled: false,
      memberHoldingsEnabled: false,
      orderAuthority: 'NONE',
      privateTradingApiAllowed: false,
      realOrderAllowed: false,
    },
    prioritySemantics: 'DELIVERY_URGENCY_ONLY',
    partial: false,
    privateApiRequests: 0,
    ordersSubmitted: 0,
    ordersCancelled: 0,
  };
}

function fulfill(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });
}

async function installMalformedAccountSnapshot(page: Page) {
  await page.addInitScript(({ storageKey, userId }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'account-response-truth-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'account-response-truth@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Account Truth QA' },
        identities: [],
        created_at: '2026-09-10T00:00:00.000Z',
      },
    }));
  }, { storageKey: accountAuthStorageKey, userId: accountUserId });

  const financialMutations: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/(?:order|orders|cancel|amend|transfer|withdraw)(?:\/|$)/i.test(path)
      && request.method() !== 'GET') {
      financialMutations.push(`${request.method()} ${path}`);
    }
  });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: accountUserId,
        login_name: 'account-response-truth',
        display_name: 'Account Truth QA',
        role: 'regular',
        status: 'approved',
        membership_level: 'regular',
        is_active: true,
        permissions_updated_at: '2026-09-10T00:00:00.000Z',
        updated_at: '2026-09-10T00:00:00.000Z',
      });
    }
    if (path.endsWith('/auth/v1/user')) {
      return fulfill(route, {
        id: accountUserId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'account-response-truth@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Account Truth QA' },
        identities: [],
        created_at: '2026-09-10T00:00:00.000Z',
      });
    }
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/accounts/read-only/toss') return fulfill(route, { connected: true });
    if (path === '/api/accounts/read-only/upbit') {
      return fulfill(route, { ...canonicalNotConfigured, provider: 'upbit' });
    }
    if (path === '/api/accounts/read-only/bitget') {
      return fulfill(route, { ...canonicalNotConfigured, provider: 'bitget' });
    }
    if (path === '/api/user-integrations') {
      return fulfill(route, canonicalUserIntegrations());
    }
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });

  return financialMutations;
}

test('recognizes only canonical provider snapshot GET routes', () => {
  expect(isAccountReadonlySnapshotPath('/api/accounts/read-only/toss', 'GET')).toBe(true);
  expect(isAccountReadonlySnapshotPath('/api/accounts/read-only/upbit', 'GET')).toBe(true);
  expect(isAccountReadonlySnapshotPath('/api/accounts/read-only/bitget', 'GET')).toBe(true);
  expect(isAccountReadonlySnapshotPath('/api/accounts/read-only/credentials/toss', 'GET')).toBe(false);
  expect(isAccountReadonlySnapshotPath('/api/accounts/read-only/toss', 'PUT')).toBe(false);
});

test('malformed account HTTP 200 cannot become connected or empty UI truth', () => {
  expect(() => requireAccountReadonlySnapshotResponse(
    '/api/accounts/read-only/toss',
    'GET',
    {},
    now,
  )).toThrow(INVALID_ACCOUNT_READONLY_RESPONSE);

  expect(() => requireAccountReadonlySnapshotResponse(
    '/api/accounts/read-only/toss',
    'GET',
    { connected: true },
    now,
  )).toThrow(INVALID_ACCOUNT_READONLY_RESPONSE);

  expect(() => requireAccountReadonlySnapshotResponse(
    '/api/accounts/read-only/toss',
    'GET',
    { ...canonical, provider: 'upbit' },
    now,
  )).toThrow(INVALID_ACCOUNT_READONLY_RESPONSE);

  expect(requireAccountReadonlySnapshotResponse(
    '/api/accounts/read-only/toss',
    'GET',
    canonical,
    now,
  )).toBe(canonical);
});

test('requires coherent connected and stale state', () => {
  expect(() => requireAccountReadonlySnapshotResponse(
    '/api/accounts/read-only/toss',
    'GET',
    { ...canonical, status: 'CONNECTED', connected: false },
    now,
  )).toThrow(INVALID_ACCOUNT_READONLY_RESPONSE);

  expect(() => requireAccountReadonlySnapshotResponse(
    '/api/accounts/read-only/toss',
    'GET',
    { ...canonical, status: 'STALE', stale: false },
    now,
  )).toThrow(INVALID_ACCOUNT_READONLY_RESPONSE);

  expect(requireAccountReadonlySnapshotResponse(
    '/api/accounts/read-only/toss',
    'GET',
    canonicalNotConfigured,
    now,
  )).toBe(canonicalNotConfigured);
});

test('locks zero financial authority invariants', () => {
  for (const unsafe of [
    { orderRequests: 1 },
    { cancelRequests: 1 },
    { amendRequests: 1 },
    { transferRequests: 1 },
    { withdrawalRequests: 1 },
    { credentialsReturned: true },
    { liveTradingEnabled: true },
    { autoTradingEnabled: true },
  ]) {
    expect(() => requireAccountReadonlySnapshotResponse(
      '/api/accounts/read-only/toss',
      'GET',
      { ...canonical, ...unsafe },
      now,
    )).toThrow(INVALID_ACCOUNT_READONLY_RESPONSE);
  }
});

test('rejects future timestamps and malformed displayed investment facts', () => {
  expect(() => requireAccountReadonlySnapshotResponse(
    '/api/accounts/read-only/toss',
    'GET',
    { ...canonical, checkedAt: '2026-09-10T00:02:00.000Z' },
    now,
  )).toThrow(INVALID_ACCOUNT_READONLY_RESPONSE);

  expect(() => requireAccountReadonlySnapshotResponse(
    '/api/accounts/read-only/toss',
    'GET',
    {
      ...canonical,
      positions: [{ market: 'KR', symbol: '005930', quantity: '10' }],
    },
    now,
  )).toThrow(INVALID_ACCOUNT_READONLY_RESPONSE);
});

test('central authenticated transport guards every read-only provider snapshot', async () => {
  const [authFetch, component, backendContract] = await Promise.all([
    readFile(authFetchPath, 'utf8'),
    readFile(componentPath, 'utf8'),
    readFile(backendContractPath, 'utf8'),
  ]);

  expect(authFetch).toContain('isAccountReadonlySnapshotPath(path, method)');
  expect(authFetch).toContain('requireAccountReadonlySnapshotResponse(path, method, await response.clone().json())');
  expect(authFetch).toContain('throw new Error(INVALID_ACCOUNT_READONLY_RESPONSE)');

  expect(component).toContain("if (snapshot.connected) return snapshot.stale ? '이전 정상값' : '연결됨';");
  expect(component).toContain('jsonRequest<CanonicalAccountSnapshot>(`/api/accounts/read-only/${provider}`');

  expect(backendContract).toContain('provider: AccountProvider; readOnly: true; connected: boolean; status: AccountReadStatus;');
  expect(backendContract).toContain('orderRequests: 0; cancelRequests: 0; amendRequests: 0; transferRequests: 0; withdrawalRequests: 0;');
  expect(backendContract).toContain('credentialsReturned: false; liveTradingEnabled: false; autoTradingEnabled: false;');
});

test('malformed Toss HTTP 200 fails before the account UI can show connected', async ({ page }) => {
  const financialMutations = await installMalformedAccountSnapshot(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/account');

  await expect(page.getByRole('alert')).toContainText('TOSS: INVALID_ACCOUNT_READONLY_RESPONSE');
  const toss = page.getByTestId('connection-toss');
  await expect(toss).toContainText('확인 전');
  await expect(toss.getByText('연결됨', { exact: true })).toHaveCount(0);
  expect(financialMutations).toEqual([]);
});