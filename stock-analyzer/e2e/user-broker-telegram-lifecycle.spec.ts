import { expect, test, type Page, type Route } from '@playwright/test';
import { UserIntegrationsRequestLifecycle } from '../src/lib/user-integrations-request-lifecycle';

const NOW = '2026-08-15T00:00:00.000Z';
const USER_ID = '91919191-9191-4919-8919-919191919191';
const AUTH_STORAGE_KEY = 'sb-127-auth-token';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });
}

function emptyIntegrationState() {
  return {
    brokerConnections: [],
    telegram: { connected: false, status: 'DISCONNECTED', connectedAt: null },
    preferences: {},
  };
}

type RuntimeOptions = {
  integration(route: Route, requestNumber: number): Promise<void>;
  expectedIntegrationErrorStatus?: number;
};

async function installRuntime(page: Page, options: RuntimeOptions) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'user-integrations-e2e-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'user-integrations@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Lifecycle Member' },
        identities: [],
        created_at: now,
      },
    }));
  }, { storageKey: AUTH_STORAGE_KEY, userId: USER_ID, now: NOW });

  const diagnostics = {
    consoleErrors: [] as string[],
    pageErrors: [] as string[],
    requestFailures: [] as string[],
    unexpectedHttp: [] as string[],
    events: [] as string[],
    integrationRequests: 0,
    integrationResponses: 0,
    integrationAborts: 0,
    logoutRequests: 0,
    postLogoutIntegrationRequests: 0,
  };

  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    const path = new URL(request.url()).pathname;
    const detail = `${request.method()} ${path} ${request.failure()?.errorText ?? ''}`;
    diagnostics.requestFailures.push(detail);
    if (path === '/api/user-integrations') diagnostics.integrationAborts += 1;
  });
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (path === '/api/user-integrations') {
      diagnostics.integrationResponses += 1;
      diagnostics.events.push(`integration-response:${response.status()}`);
    }
    if (
      path.startsWith('/api/')
      && response.status() >= 400
      && !(path === '/api/user-integrations' && response.status() === options.expectedIntegrationErrorStatus)
    ) {
      diagnostics.unexpectedHttp.push(`${response.status()} ${path}`);
    }
  });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: USER_ID,
        login_name: 'lifecycle-member',
        display_name: 'Lifecycle Member',
        role: 'user',
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
        email: 'user-integrations@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Lifecycle Member' },
        identities: [],
        created_at: NOW,
      });
    }
    if (pathname.endsWith('/auth/v1/logout')) {
      diagnostics.logoutRequests += 1;
      diagnostics.events.push('logout-start');
      return fulfill(route, { ok: true });
    }
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/user-integrations' && request.method() === 'GET') {
      if (diagnostics.logoutRequests > 0) diagnostics.postLogoutIntegrationRequests += 1;
      diagnostics.integrationRequests += 1;
      diagnostics.events.push(`integration-start:${diagnostics.integrationRequests}`);
      return options.integration(route, diagnostics.integrationRequests);
    }
    return fulfill(route, { ok: true, items: [] });
  });

  return {
    diagnostics,
    assertClean(expectedConsoleErrors: string[] = []) {
      expect(diagnostics.consoleErrors, diagnostics.consoleErrors.join('\n')).toEqual(expectedConsoleErrors);
      expect(diagnostics.pageErrors, diagnostics.pageErrors.join('\n')).toEqual([]);
      expect(diagnostics.requestFailures, diagnostics.requestFailures.join('\n')).toEqual([]);
      expect(diagnostics.unexpectedHttp, diagnostics.unexpectedHttp.join('\n')).toEqual([]);
    },
  };
}

test('normal and empty connection load reaches one explicit HTTP 200 terminal and repeated refresh coalesces', async ({ page }) => {
  const manual = deferred<void>();
  const runtime = await installRuntime(page, {
    integration: async (route, requestNumber) => {
      if (requestNumber === 2) await manual.promise;
      await fulfill(route, emptyIntegrationState());
    },
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/account');
  const panel = page.getByTestId('user-broker-telegram-panel');
  await expect(panel).toHaveAttribute('data-user-integrations-request-state', 'success');
  await expect(panel).toContainText('등록된 Broker 연결이 없습니다.');
  await expect(panel).toContainText('연결 안 됨');
  expect(runtime.diagnostics.integrationRequests).toBe(1);
  expect(runtime.diagnostics.integrationResponses).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1441);

  await page.getByRole('button', { name: '연결 상태 새로고침' }).evaluate((button) => {
    button.click();
    button.click();
  });
  await expect.poll(() => runtime.diagnostics.integrationRequests).toBe(2);
  manual.resolve();
  await expect(panel).toHaveAttribute('data-user-integrations-request-state', 'success');
  expect(runtime.diagnostics.integrationRequests).toBe(2);
  runtime.assertClean();
});

test('actual API failure remains visible and is not converted to an empty or disconnected success', async ({ page }) => {
  const runtime = await installRuntime(page, {
    expectedIntegrationErrorStatus: 503,
    integration: (route) => fulfill(route, { error: 'USER_INTEGRATIONS_UPSTREAM_UNAVAILABLE' }, 503),
  });

  await page.goto('/account');
  const panel = page.getByTestId('user-broker-telegram-panel');
  await expect(panel).toHaveAttribute('data-user-integrations-request-state', 'failure');
  await expect(panel.getByRole('alert')).toContainText('USER_INTEGRATIONS_UPSTREAM_UNAVAILABLE');
  await expect(panel).not.toContainText('등록된 Broker 연결이 없습니다.');
  await expect(panel).not.toContainText('연결 안 됨');
  expect(runtime.diagnostics.integrationRequests).toBe(1);
  expect(runtime.diagnostics.integrationResponses).toBe(1);
  runtime.assertClean(['Failed to load resource: the server responded with a status of 503 (Service Unavailable)']);
});

test('immediate logout drains the initial read before auth invalidation with zero abort and zero post-logout GET', async ({ page }) => {
  const initial = deferred<void>();
  const runtime = await installRuntime(page, {
    integration: async (route) => {
      await initial.promise;
      await fulfill(route, emptyIntegrationState());
    },
  });

  await page.goto('/account');
  await expect.poll(() => runtime.diagnostics.integrationRequests).toBe(1);
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page.getByTestId('user-broker-telegram-panel')).toHaveCount(0);
  expect(runtime.diagnostics.logoutRequests).toBe(0);

  initial.resolve();
  await expect.poll(() => runtime.diagnostics.logoutRequests).toBe(1);
  expect(runtime.diagnostics.integrationResponses).toBe(1);
  expect(runtime.diagnostics.integrationAborts).toBe(0);
  expect(runtime.diagnostics.postLogoutIntegrationRequests).toBe(0);
  expect(runtime.diagnostics.events.indexOf('integration-response:200'))
    .toBeLessThan(runtime.diagnostics.events.indexOf('logout-start'));
  runtime.assertClean();
});

test('route unmount cannot apply stale state and remount reuses the same terminal initial read', async ({ page }) => {
  const initial = deferred<void>();
  const runtime = await installRuntime(page, {
    integration: async (route) => {
      await initial.promise;
      await fulfill(route, emptyIntegrationState());
    },
  });

  await page.goto('/account');
  await expect.poll(() => runtime.diagnostics.integrationRequests).toBe(1);
  await page.evaluate(() => {
    window.history.pushState(null, '', '/settings');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByTestId('user-broker-telegram-panel')).toHaveCount(0);
  initial.resolve();
  await expect.poll(() => runtime.diagnostics.integrationResponses).toBe(1);

  await page.evaluate(() => {
    window.history.pushState(null, '', '/account');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  const panel = page.getByTestId('user-broker-telegram-panel');
  await expect(panel).toHaveAttribute('data-user-integrations-request-state', 'success');
  await expect(panel).toContainText('등록된 Broker 연결이 없습니다.');
  expect(runtime.diagnostics.integrationRequests).toBe(1);
  expect(runtime.diagnostics.integrationAborts).toBe(0);
  runtime.assertClean();
});

test('request lifecycle rejects obsolete generations, blocks post-logout starts, and terminates on its own deadline', async () => {
  const lifecycle = new UserIntegrationsRequestLifecycle<string>(50);
  lifecycle.setIdentity('user-a', 'session-a');
  const old = deferred<string>();
  let loads = 0;
  const first = lifecycle.request({
    identity: 'user-a',
    requestKey: 'session-a',
    load: async () => { loads += 1; return old.promise; },
  });
  const duplicate = lifecycle.request({
    identity: 'user-a',
    requestKey: 'session-a',
    load: async () => { loads += 1; return 'duplicate'; },
  });
  expect(loads).toBe(0);
  await Promise.resolve();
  expect(loads).toBe(1);

  const drain = lifecycle.beginLogout();
  const blocked = await lifecycle.request({
    identity: 'user-a',
    requestKey: 'session-a',
    force: true,
    load: async () => { loads += 1; return 'forbidden'; },
  });
  expect(blocked).toEqual({ status: 'skipped', reason: 'logout-in-progress' });
  old.resolve('obsolete');
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate, drain]).then(([a, b]) => [a, b]);
  expect(firstResult.status).toBe('success');
  expect(duplicateResult.status).toBe('success');
  expect(lifecycle.isCurrent(firstResult)).toBe(false);
  expect(loads).toBe(1);

  lifecycle.finishLogout();
  lifecycle.setIdentity('user-b', 'session-b');
  const timed = await lifecycle.request({
    identity: 'user-b',
    requestKey: 'session-b',
    load: async () => new Promise<string>(() => undefined),
  });
  expect(timed.status).toBe('failure');
  if (timed.status === 'failure') expect(timed.error).toMatchObject({ name: 'TimeoutError' });
  expect(lifecycle.snapshot()).toMatchObject({ activeCount: 0, terminalStatus: 'failure' });
});
