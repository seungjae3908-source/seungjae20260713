import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page, type Request, type TestInfo } from '@playwright/test';
import {
  provisionEphemeralStagingAccounts,
  type StagingAccountCredentials,
  type StagingAccountLifecycle,
} from './support/staging-account-lifecycle';
import { expectHealthyScannerRoute } from './support/scanner-readiness';
import { requestWithBrowserSession } from './support/browser-session-api';
import {
  collectSafeApiDiagnostic,
  type SafeApiDiagnostic,
} from './support/safe-api-diagnostic';
import { expectUiBuilderStagingReadiness } from './support/ui-builder-staging-readiness';
import { APP_NAVIGATION } from '../src/lib/app-navigation';

const stagingMode = process.env.PHASE10_STAGING_E2E === 'true';
const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for full staging release validation`);
  return value;
};

const targetSha = stagingMode ? required('STAGING_TARGET_SHA').toLowerCase() : '';
const artifactDir = path.resolve(process.env.STAGING_ARTIFACT_DIR ?? '../staging-artifacts');
const diagnosticsPath = path.join(artifactDir, 'staging-browser-results.json');
const emptyAccounts: StagingAccountCredentials = {
  pending: { loginName: '', password: '' },
  associate: { loginName: '', password: '' },
  regular: { loginName: '', password: '' },
  admin: { loginName: '', password: '' },
};
let accounts = emptyAccounts;
let accountLifecycle: StagingAccountLifecycle | null = null;

type Diagnostic = { test: string; url: string; detail: string; status?: number };
type LogoutObservation = { candidates: Diagnostic[] };
type RouteTransitionObservation = {
  fromRoute: string;
  toRoute: string;
  candidates: Diagnostic[];
  pendingGetRequests: Set<Request>;
};
type AuthFaultObservation = {
  kind: 'reject' | 'timeout' | 'retry';
  candidates: Diagnostic[];
  requests: Set<Request>;
  startedAt: number | null;
  failedAt: number | null;
};
const activeLogoutObservations = new WeakMap<Page, LogoutObservation>();
const activeRouteTransitionObservations = new WeakMap<Page, RouteTransitionObservation>();
const activeAuthFaultObservations = new WeakMap<Page, AuthFaultObservation>();
const pendingMutatingRequests = new WeakMap<Page, Set<Request>>();
const pendingApiGetRequests = new WeakMap<Page, Set<Request>>();
const diagnostics: {
  console_errors: Diagnostic[];
  page_errors: Diagnostic[];
  unhandled_rejections: Diagnostic[];
  unexpected_http_errors: Diagnostic[];
  expected_logout_aborts: Diagnostic[];
  expected_auth_faults: Diagnostic[];
  expected_scanner_aborts: Diagnostic[];
  expected_route_transition_aborts: Diagnostic[];
  api_diagnostics: SafeApiDiagnostic[];
} = {
  console_errors: [],
  page_errors: [],
  unhandled_rejections: [],
  unexpected_http_errors: [],
  expected_logout_aborts: [],
  expected_auth_faults: [],
  expected_scanner_aborts: [],
  expected_route_transition_aborts: [],
  api_diagnostics: [],
};

function diagnosticUrl(raw: string) {
  try {
    const parsed = new URL(raw);
    if (
      parsed.pathname === '/auth/v1/logout'
      && parsed.searchParams.size === 1
      && parsed.searchParams.get('scope') === 'global'
    ) {
      return '/auth/v1/logout?scope=global';
    }
    return parsed.pathname || '/';
  } catch {
    return '[invalid-url]';
  }
}

function routeIdentity(raw: string, base?: string) {
  const parsed = base ? new URL(raw, base) : new URL(raw);
  return `${parsed.pathname}${parsed.search}`;
}

function diagnosticText(raw: string) {
  return raw
    .replace(/https?:\/\/[^\s"'`<>]+/gi, '[redacted-url]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-token]')
    .replace(/\b(?:sb_publishable|sb_secret|service_role|anon)_[A-Za-z0-9._-]+\b/gi, '[redacted-key]')
    .replace(/((?:authorization|apikey|api[_-]?key|token|password|secret|key)\s*[:=]\s*)([^\s,;]+)/gi, '$1[redacted]');
}

function isExpectedLogoutAbort(request: Request) {
  let parsed: URL;
  try {
    parsed = new URL(request.url());
  } catch {
    return false;
  }
  const query = [...parsed.searchParams.entries()];
  return request.method() === 'POST'
    && parsed.pathname === '/auth/v1/logout'
    && query.length === 1
    && query[0]?.[0] === 'scope'
    && query[0]?.[1] === 'global'
    && request.failure()?.errorText === 'net::ERR_ABORTED';
}

function isProfileRequest(request: Request) {
  try {
    const parsed = new URL(request.url());
    return request.method() === 'GET' && parsed.pathname === '/rest/v1/profiles';
  } catch {
    return false;
  }
}

function isExpectedAuthFault(request: Request, observation: AuthFaultObservation) {
  return observation.requests.has(request) && isProfileRequest(request);
}

function isExpectedRouteTransitionAbort(
  request: Request,
  observation: RouteTransitionObservation,
) {
  try {
    const parsed = new URL(request.url());
    return observation.fromRoute !== observation.toRoute
      && observation.pendingGetRequests.has(request)
      && request.method() === 'GET'
      && parsed.pathname.startsWith('/api/')
      && request.failure()?.errorText === 'net::ERR_ABORTED';
  } catch {
    return false;
  }
}

function isSameOriginApiGet(request: Request) {
  try {
    const parsed = new URL(request.url());
    return request.method() === 'GET'
      && parsed.origin === new URL(request.frame().url()).origin
      && parsed.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

function isMutatingBrowserRequest(request: Request) {
  try {
    const parsed = new URL(request.url());
    return parsed.origin === new URL(request.frame().url()).origin
      && parsed.pathname.startsWith('/api/')
      && !['GET', 'HEAD', 'OPTIONS'].includes(request.method());
  } catch {
    return false;
  }
}

function completeBrowserRequest(page: Page, request: Request) {
  pendingMutatingRequests.get(page)?.delete(request);
  pendingApiGetRequests.get(page)?.delete(request);
}

function recordUnhandled(testName: string, url: string, detail: string) {
  if (/unhandled|uncaught.*promise|promise rejection/i.test(detail)) {
    diagnostics.unhandled_rejections.push({ test: testName, url, detail });
  }
}

function attachDiagnostics(page: Page, testInfo: TestInfo) {
  const testName = testInfo.titlePath.join(' > ');
  const mutations = new Set<Request>();
  const apiGets = new Set<Request>();
  pendingMutatingRequests.set(page, mutations);
  pendingApiGetRequests.set(page, apiGets);
  page.on('request', (request) => {
    if (isMutatingBrowserRequest(request)) mutations.add(request);
    if (isSameOriginApiGet(request)) apiGets.add(request);
  });
  page.on('requestfinished', (request) => completeBrowserRequest(page, request));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const detail = diagnosticText(message.text());
    const url = diagnosticUrl(page.url());
    diagnostics.console_errors.push({ test: testName, url, detail });
    recordUnhandled(testName, url, detail);
  });
  page.on('pageerror', (error) => {
    const url = diagnosticUrl(page.url());
    const detail = diagnosticText(error.message);
    diagnostics.page_errors.push({ test: testName, url, detail });
    recordUnhandled(testName, url, detail);
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const authFault = activeAuthFaultObservations.get(page);
    if (authFault && authFault.kind !== 'timeout' && isExpectedAuthFault(response.request(), authFault)) {
      authFault.candidates.push({
        test: testName,
        url: diagnosticUrl(response.url()),
        status: response.status(),
        detail: diagnosticText(`${response.request().method()} ${response.status()} ${response.statusText()}`),
      });
      return;
    }
    diagnostics.unexpected_http_errors.push({
      test: testName,
      url: diagnosticUrl(response.url()),
      status: response.status(),
      detail: diagnosticText(`${response.request().method()} ${response.status()} ${response.statusText()}`),
    });
  });
  page.on('requestfailed', (request) => {
    completeBrowserRequest(page, request);
    const detail = diagnosticText(`${request.method()} ${request.failure()?.errorText ?? 'request failed'}`);
    const diagnostic: Diagnostic = {
      test: testName,
      url: diagnosticUrl(request.url()),
      status: 0,
      detail,
    };
    const logoutObservation = activeLogoutObservations.get(page);
    if (logoutObservation && isExpectedLogoutAbort(request)) {
      logoutObservation.candidates.push(diagnostic);
      return;
    }
    const authFault = activeAuthFaultObservations.get(page);
    if (authFault && authFault.kind === 'timeout' && isExpectedAuthFault(request, authFault)) {
      authFault.failedAt = Date.now();
      authFault.candidates.push(diagnostic);
      return;
    }
    const routeObservation = activeRouteTransitionObservations.get(page);
    if (routeObservation && isExpectedRouteTransitionAbort(request, routeObservation)) {
      routeObservation.candidates.push(diagnostic);
      return;
    }
    diagnostics.unexpected_http_errors.push(diagnostic);
  });
}

async function waitForPresentationFrame(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function waitForPendingMutations(page: Page) {
  await expect.poll(
    () => pendingMutatingRequests.get(page)?.size ?? 0,
    {
      message: 'mutating browser requests must finish before route navigation',
      timeout: 15_000,
      intervals: [100, 200, 300, 500],
    },
  ).toBe(0);
}

async function settle(page: Page) {
  await page.waitForLoadState('load');
  for (let pass = 0; pass < 2; pass += 1) {
    const urlBeforeFrame = page.url();
    await waitForPresentationFrame(page);
    await page.waitForTimeout(300);
    expect(page.url(), 'route changed while presentation was settling').toBe(urlBeforeFrame);
    await expect(page.locator('body')).toBeVisible();
  }
  await waitForPendingMutations(page);
}

function loginSubmitButton(page: Page) {
  return page.locator('form').getByRole('button', { name: /^로그인$|sign in|log in/i });
}

async function login(page: Page, loginName: string, password: string) {
  await page.goto('/login');
  const nameInput = page.locator('input[type="email"], input[name="email"], input[autocomplete="username"]').first();
  const passwordInput = page.locator('input[type="password"], input[name="password"], input[autocomplete="current-password"]').first();
  await expect(nameInput).toBeVisible();
  await nameInput.fill(loginName);
  await passwordInput.fill(password);
  await loginSubmitButton(page).click();
  await expect(page.getByRole('button', { name: /로그아웃|sign out/i })).toBeVisible({ timeout: 30_000 });
}

async function logout(page: Page) {
  const logoutButton = page.getByRole('button', { name: /로그아웃|sign out/i });
  await expect(logoutButton).toBeVisible();
  const observation: LogoutObservation = { candidates: [] };
  activeLogoutObservations.set(page, observation);
  let confirmed = false;
  try {
    await logoutButton.click();
    await expect(loginSubmitButton(page)).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(300);

    await page.reload();
    await settle(page);
    await expect(loginSubmitButton(page)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /로그아웃|sign out/i })).toHaveCount(0);

    const protectedResponse = await page.request.get('/api/paper-journal/snapshot');
    expect(
      [401, 403],
      `protected API remained accessible after logout: ${protectedResponse.status()}`,
    ).toContain(protectedResponse.status());

    confirmed = true;
    diagnostics.expected_logout_aborts.push(...observation.candidates);
  } finally {
    activeLogoutObservations.delete(page);
    if (!confirmed && observation.candidates.length > 0) {
      diagnostics.unexpected_http_errors.push(...observation.candidates.map((item) => ({
        ...item,
        detail: `unconfirmed logout abort: ${item.detail}`,
      })));
    }
  }
}

async function expectMembership(page: Page, label: RegExp) {
  await expect(page.getByTestId('membership-label')).toContainText(label);
}

async function finishRouteTransition(
  page: Page,
  observation: RouteTransitionObservation,
  confirmed: boolean,
) {
  await expect.poll(
    () => {
      const pending = pendingApiGetRequests.get(page);
      if (!pending) return 0;
      return [...observation.pendingGetRequests]
        .filter((request) => pending.has(request))
        .length;
    },
    {
      message: 'pre-navigation GET requests must settle before route observation closes',
      timeout: 15_000,
      intervals: [100, 200, 300, 500],
    },
  ).toBe(0);

  activeRouteTransitionObservations.delete(page);
  if (confirmed) {
    diagnostics.expected_route_transition_aborts.push(...observation.candidates);
    return;
  }
  diagnostics.unexpected_http_errors.push(...observation.candidates.map((item) => ({
    ...item,
    detail: `unconfirmed route-transition abort: ${item.detail}`,
  })));
}

async function expectHealthyRoute(page: Page, route: string) {
  await settle(page);
  const requestedRoute = routeIdentity(route, page.url());
  const expectedRoute = requestedRoute === '/stock/005930'
    ? '/stock/005930?tab=overview'
    : requestedRoute;
  const observation: RouteTransitionObservation = {
    fromRoute: routeIdentity(page.url()),
    toRoute: expectedRoute,
    candidates: [],
    pendingGetRequests: new Set(pendingApiGetRequests.get(page) ?? []),
  };
  activeRouteTransitionObservations.set(page, observation);
  let confirmed = false;
  try {
    const response = await page.goto(route, { waitUntil: 'domcontentloaded' });
    if (response) expect(response.status(), `${route} returned HTTP ${response.status()}`).toBeLessThan(400);
    if (expectedRoute !== requestedRoute) {
      await expect.poll(
        () => routeIdentity(page.url()),
        {
          message: 'stock detail fixture must reach its exact canonical overview route',
          timeout: 15_000,
          intervals: [100, 200, 300, 500],
        },
      ).toBe(expectedRoute);
    }
    await settle(page);
    expect(routeIdentity(page.url())).toBe(observation.toRoute);
    await expect(page.locator('body')).not.toContainText(/페이지를 찾을 수 없습니다|page not found/i);
    await expect(page.locator('body')).not.toBeEmpty();
    confirmed = true;
  } finally {
    await finishRouteTransition(page, observation, confirmed);
  }
}

async function expectDeniedRoute(page: Page, route: string) {
  await settle(page);
  const observation: RouteTransitionObservation = {
    fromRoute: routeIdentity(page.url()),
    toRoute: routeIdentity(route, page.url()),
    candidates: [],
    pendingGetRequests: new Set(pendingApiGetRequests.get(page) ?? []),
  };
  activeRouteTransitionObservations.set(page, observation);
  let confirmed = false;
  try {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('capability-denied')).toBeVisible();
    await settle(page);
    expect(routeIdentity(page.url())).toBe(observation.toRoute);
    confirmed = true;
  } finally {
    await finishRouteTransition(page, observation, confirmed);
  }
}

async function expectScannerAfterFutures(page: Page) {
  const observation: RouteTransitionObservation = {
    fromRoute: routeIdentity(page.url()),
    toRoute: routeIdentity('/scanner', page.url()),
    candidates: [],
    pendingGetRequests: new Set(pendingApiGetRequests.get(page) ?? []),
  };
  activeRouteTransitionObservations.set(page, observation);
  let confirmed = false;
  try {
    await expectHealthyScannerRoute(page);
    expect(routeIdentity(page.url())).toBe(observation.toRoute);
    confirmed = true;
  } finally {
    await finishRouteTransition(page, observation, confirmed);
  }
}

function scannerFixture(state: 'complete' | 'partial' | 'unavailable') {
  const unavailable = state === 'unavailable';
  const partial = state !== 'complete';
  const elapsedMs = unavailable ? 9_500 : 25;
  return {
    ok: true,
    partial,
    requestId: `phase10-${state}`,
    assetClass: 'stock',
    market: 'KR',
    timeframe: '1D',
    cards: [],
    alerts: [],
    failures: unavailable
      ? [{ symbol: 'KRX', reason: 'timeout', message: 'bounded verifier fixture timeout' }]
      : [],
    execution: {
      requestedCount: 1,
      startedCount: 1,
      completedCount: unavailable ? 0 : 1,
      excludedCount: 0,
      providerErrorCount: 0,
      timeoutCount: unavailable ? 1 : 0,
      partial,
      timedOut: unavailable,
      cancelled: false,
      duplicate: false,
      elapsedMs,
      deadlineMs: 10_000,
      itemTimeoutMs: 3_000,
      maxConcurrency: 1,
    },
    universe: {
      totalCount: 1,
      cursor: 0,
      nextCursor: null,
      source: 'phase10-safe-browser-fixture',
      partial,
      stale: false,
      listingStatusCoverage: 'listed-or-unknown',
    },
    dataState: state,
    message: `phase10 scanner ${state} contract`,
    elapsedMs,
    generatedAt: new Date().toISOString(),
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

async function finishAuthFault(
  page: Page,
  observation: AuthFaultObservation,
  confirmed: boolean,
) {
  activeAuthFaultObservations.delete(page);
  if (confirmed) {
    diagnostics.expected_auth_faults.push(...observation.candidates);
    return;
  }
  diagnostics.unexpected_http_errors.push(...observation.candidates.map((item) => ({
    ...item,
    detail: `unconfirmed auth fault: ${item.detail}`,
  })));
}

async function expectBootstrapTerminalError(page: Page) {
  await expect(page.getByTestId('error-state')).toBeVisible({ timeout: 10_500 });
  await expect(page.getByTestId('page-fallback')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '다시 시도', exact: true })).toBeVisible();
}

function errorsFor(testInfo: TestInfo) {
  const testName = testInfo.titlePath.join(' > ');
  return {
    console: diagnostics.console_errors.filter((item) => item.test === testName),
    page: diagnostics.page_errors.filter((item) => item.test === testName),
    rejection: diagnostics.unhandled_rejections.filter((item) => item.test === testName),
    http: diagnostics.unexpected_http_errors.filter((item) => item.test === testName),
  };
}

test.describe('real staging release readiness', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!stagingMode, 'Requires isolated staging, exact SHA, and ephemeral staging-only accounts');

  test.beforeAll(async () => {
    accountLifecycle = await provisionEphemeralStagingAccounts({
      supabaseUrl: required('STAGING_SUPABASE_URL'),
      supabaseSecretKey: required('STAGING_SUPABASE_SECRET_KEY'),
      artifactDir,
    });
    accounts = accountLifecycle.accounts;
  });

  test.beforeEach(async ({ page }, testInfo) => {
    attachDiagnostics(page, testInfo);
  });

  test.afterEach(async ({}, testInfo) => {
    const errors = errorsFor(testInfo);
    expect(errors.console, 'browser console errors').toEqual([]);
    expect(errors.page, 'pageerror events').toEqual([]);
    expect(errors.rejection, 'unhandled promise rejections').toEqual([]);
    expect(errors.http, 'unexpected browser HTTP 4xx/5xx or failed requests').toEqual([]);
  });

  test.afterAll(async () => {
    let cleanupError: unknown = null;
    try {
      await accountLifecycle?.cleanup();
    } catch (cause) {
      cleanupError = cause;
    } finally {
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.writeFileSync(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8');
    }
    if (cleanupError) throw cleanupError;
  });

  test('anonymous: health, login boundary, and protected API denial', async ({ page }) => {
    const health = await page.request.get('/api/health');
    expect(health.ok()).toBeTruthy();
    const body = await health.json();
    expect(body.ok).toBe(true);
    const reportedSha = String(body.deploySha ?? body.sha ?? body.commitSha ?? '').toLowerCase();
    expect(reportedSha).toBe(targetSha);

    await page.goto('/paper-trading');
    await expect(loginSubmitButton(page)).toBeVisible();
    await expect(page.locator('nav')).toHaveCount(0);

    const protectedResponse = await page.request.get('/api/paper-journal/snapshot');
    expect([401, 403]).toContain(protectedResponse.status());
  });

  for (const [name, width, height] of [
    ['desktop', 1440, 900],
    ['mobile', 390, 844],
  ] as const) {
    test(`${name}: login, refresh session retention, responsive layout, and logout`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await login(page, accounts.regular.loginName, accounts.regular.password);
      await expectMembership(page, /정회원/);
      await page.reload();
      await settle(page);
      await expect(page.getByRole('button', { name: /로그아웃|sign out/i })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await logout(page);
    });
  }

  test('bootstrap finite-state: rejected profile bootstrap exits loading with terminal retry UI', async ({ page }) => {
    await login(page, accounts.regular.loginName, accounts.regular.password);
    const observation: AuthFaultObservation = {
      kind: 'reject',
      candidates: [],
      requests: new Set<Request>(),
      startedAt: null,
      failedAt: null,
    };
    activeAuthFaultObservations.set(page, observation);
    let requestCount = 0;
    let confirmed = false;
    await page.route('**/rest/v1/profiles*', async (route) => {
      const request = route.request();
      if (!isProfileRequest(request)) {
        await route.continue();
        return;
      }
      requestCount += 1;
      observation.requests.add(request);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 'phase10-profile-a' },
          { id: 'phase10-profile-b' },
        ]),
      });
    });
    try {
      await expectHealthyRoute(page, '/');
      await expectBootstrapTerminalError(page);
      expect(requestCount, 'initial bootstrap must issue one profile request').toBe(1);
      expect(observation.candidates, 'semantic bootstrap rejection must not create a network-error exemption').toHaveLength(0);
      confirmed = true;
    } finally {
      await page.unroute('**/rest/v1/profiles*');
      await finishAuthFault(page, observation, confirmed);
    }
  });

  test('profile timeout abort: frontend deadline cancels the stalled profile request and exits loading', async ({ page }) => {
    await login(page, accounts.regular.loginName, accounts.regular.password);
    const observation: AuthFaultObservation = {
      kind: 'timeout',
      candidates: [],
      requests: new Set<Request>(),
      startedAt: null,
      failedAt: null,
    };
    activeAuthFaultObservations.set(page, observation);
    let requestCount = 0;
    let confirmed = false;
    let timeoutRouteSettled = Promise.resolve();
    await page.route('**/rest/v1/profiles*', async (route) => {
      const request = route.request();
      if (!isProfileRequest(request)) {
        await route.continue();
        return;
      }
      requestCount += 1;
      observation.requests.add(request);
      observation.startedAt = Date.now();
      timeoutRouteSettled = (async () => {
        await page.waitForTimeout(9_000);
        if (request.failure() === null) await route.abort('timedout');
      })();
      await timeoutRouteSettled;
    });
    try {
      await expectHealthyRoute(page, '/');
      await expectBootstrapTerminalError(page);
      await expect.poll(
        () => observation.failedAt,
        {
          message: 'the frontend profile deadline must cancel the intercepted request',
          timeout: 9_500,
          intervals: [100, 200, 300],
        },
      ).not.toBeNull();
      expect(requestCount, 'timeout bootstrap must issue one profile request').toBe(1);
      expect(observation.candidates, 'the cancelled profile request must be observed once').toHaveLength(1);
      expect(observation.candidates[0]?.detail).toContain('net::ERR_ABORTED');
      expect(Number(observation.failedAt) - Number(observation.startedAt)).toBeLessThan(9_000);
      confirmed = true;
    } finally {
      await timeoutRouteSettled;
      await page.unroute('**/rest/v1/profiles*');
      await finishAuthFault(page, observation, confirmed);
    }
  });

  test('retry recovery: first profile bootstrap fails, retry performs one fresh request and restores authenticated UI', async ({ page }) => {
    await login(page, accounts.regular.loginName, accounts.regular.password);
    const observation: AuthFaultObservation = {
      kind: 'retry',
      candidates: [],
      requests: new Set<Request>(),
      startedAt: null,
      failedAt: null,
    };
    activeAuthFaultObservations.set(page, observation);
    let requestCount = 0;
    let confirmed = false;
    await page.route('**/rest/v1/profiles*', async (route) => {
      const request = route.request();
      if (!isProfileRequest(request)) {
        await route.continue();
        return;
      }
      requestCount += 1;
      observation.requests.add(request);
      if (requestCount === 1) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            { id: 'phase10-profile-a' },
            { id: 'phase10-profile-b' },
          ]),
        });
        return;
      }
      await route.continue();
    });
    try {
      await expectHealthyRoute(page, '/');
      await expectBootstrapTerminalError(page);
      await page.getByRole('button', { name: '다시 시도', exact: true }).click();
      await expect(page.locator('nav')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('error-state')).toHaveCount(0);
      await expect(page.getByTestId('page-fallback')).toHaveCount(0);
      expect(requestCount, 'retry must create exactly one fresh profile request after the first failure').toBe(2);
      expect(observation.candidates, 'semantic first-attempt rejection must not create a network-error exemption').toHaveLength(0);
      await expectHealthyRoute(page, '/account');
      await expect(page.getByRole('button', { name: /로그아웃|sign out/i })).toBeVisible();
      confirmed = true;
    } finally {
      await page.unroute('**/rest/v1/profiles*');
      await finishAuthFault(page, observation, confirmed);
    }
  });

  test('scanner readiness: complete, partial, and strict unavailable states satisfy the frontend contract', async ({ page }) => {
    await login(page, accounts.regular.loginName, accounts.regular.password);
    for (const state of ['complete', 'partial', 'unavailable'] as const) {
      await page.route('**/api/market/scan*', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(scannerFixture(state)),
        });
      });
      try {
        const evidence = await expectHealthyScannerRoute(page);
        expect(evidence.httpStatus).toBe(200);
        expect(evidence.dataState).toBe(state);
        expect(evidence.elapsedMs).toBeLessThanOrEqual(12_000);
        expect(evidence.requestElapsedMs).toBeLessThanOrEqual(12_000);
        expect(evidence.orderCapableRequests).toEqual([]);
        if (state === 'unavailable') {
          expect(evidence.partial).toBe(true);
          expect(evidence.executionPartial).toBe(true);
          expect(evidence.executionTimedOut).toBe(true);
          expect(evidence.timeoutCount).toBeGreaterThanOrEqual(1);
          expect(evidence.deadlineMs).toBeGreaterThan(0);
          expect(evidence.deadlineMs).toBeLessThan(12_000);
          expect(evidence.cards).toEqual([]);
        }
      } finally {
        await page.unroute('**/api/market/scan*');
      }
    }
  });

  test('pending: approval-waiting account cannot enter approved UI, URL, or API', async ({ page }) => {
    await login(page, accounts.pending.loginName, accounts.pending.password);
    await expectMembership(page, /승인대기/);
    await expect(page.getByText(/관리자 승인 대기 중/)).toBeVisible();
    await settle(page);
    await page.goto('/stock-info', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/관리자 승인 대기 중/)).toBeVisible();
    await expect(page.locator('nav')).toHaveCount(0);
    const response = await requestWithBrowserSession(page, '/api/paper-journal/snapshot');
    expect(response.status()).toBe(403);
  });

  test('associate: basic stock, spot, and scanner access allowed; futures, AI-risk, portfolio, and APIs denied', async ({ page }) => {
    await login(page, accounts.associate.loginName, accounts.associate.password);
    await expectMembership(page, /준회원/);
    await expectHealthyRoute(page, '/');
    await expectHealthyRoute(page, '/stock-info?asset=stock&market=KR&ticker=005930');
    await expectHealthyRoute(page, '/stock-info?asset=coin&coinMarket=spot&symbol=BTC');

    await expectDeniedRoute(page, '/stock-info?asset=coin&coinMarket=futures&symbol=BTCUSDT');
    await expectScannerAfterFutures(page);
    await expectDeniedRoute(page, '/portfolio');

    const response = await requestWithBrowserSession(
      page,
      '/api/paper-journal/ai-review/preview',
      { method: 'POST', data: {} },
    );
    expect(response.status()).toBe(403);
  });

  test('regular: futures, scanner, paper trading, and safe AI preview are available without real orders', async ({ page }) => {
    await login(page, accounts.regular.loginName, accounts.regular.password);
    await expectMembership(page, /정회원/);
    await expectHealthyRoute(page, '/stock-info?asset=coin&coinMarket=futures&symbol=BTCUSDT');
    await expectScannerAfterFutures(page);
    await expectHealthyRoute(page, '/paper-trading');
    await expect(page.locator('body')).toContainText(/모의|paper/i);
    await expectDeniedRoute(page, '/admin/ui-layouts');

    const preview = await requestWithBrowserSession(
      page,
      '/api/paper-journal/ai-review/preview',
      { method: 'POST', data: {} },
    );
    const previewDiagnostic = await collectSafeApiDiagnostic(preview, {
      testStep: 'regular-ai-preview',
      requestPath: '/api/paper-journal/ai-review/preview',
    });
    diagnostics.api_diagnostics.push(previewDiagnostic);
    expect(
      preview.ok(),
      `safe AI preview diagnostic: ${JSON.stringify(previewDiagnostic)}`,
    ).toBeTruthy();
    expect(previewDiagnostic.externalAiCalled).toBe(false);
    expect(previewDiagnostic.orderSubmitted).toBe(false);
    expect(previewDiagnostic.exchangeRequestSent).toBe(false);
  });

  test('admin: member management is allowed while another users private journal remains blocked', async ({ page }) => {
    await login(page, accounts.admin.loginName, accounts.admin.password);
    await expectMembership(page, /관리자/);
    await expectHealthyRoute(page, '/admin');
    await expect(page.locator('body')).toContainText(/회원|member/i);
    const foreignJournal = await requestWithBrowserSession(
      page,
      '/api/paper-journal/snapshot?userId=11111111-1111-1111-1111-111111111111',
    );
    expect([400, 403]).toContain(foreignJournal.status());
  });

  test('admin UI Builder actual staging release acceptance', async ({ page }) => {
    await login(page, accounts.admin.loginName, accounts.admin.password);
    await expectMembership(page, /관리자/);
    await expectUiBuilderStagingReadiness(page, (route) => expectHealthyRoute(page, route));
  });

  for (const [name, width, height] of [
    ['desktop', 1440, 900],
    ['mobile', 390, 844],
  ] as const) {
    test(`${name}: major screens, search/detail, domestic/overseas/coin, watchlist, alerts, and settings`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await login(page, accounts.regular.loginName, accounts.regular.password);
      for (const route of [
        '/',
        '/search',
        '/stock/005930',
        '/stock-info?asset=stock&market=KR&ticker=005930',
        '/stock-info?asset=stock&market=US&ticker=AAPL',
        '/stock-info?asset=coin&coinMarket=spot&symbol=BTC',
        '/watchlist',
        '/alerts',
        '/themes',
        '/market-overview',
        '/learn',
        '/more',
      ]) {
        await expectHealthyRoute(page, route);
      }
    });
  }

  test('bottom navigation and popup menus traverse every visible destination', async ({ page }) => {
    await login(page, accounts.regular.loginName, accounts.regular.password);
    await expectHealthyRoute(page, '/');
    const nav = page.locator('nav');
    await expect(nav).toBeVisible();

    for (const label of ['홈', '종목', '기술', '정보', '설정']) {
      await settle(page);
      await nav.getByRole('button', { name: label, exact: true }).click();
      await settle(page);
    }

    await settle(page);
    await nav.getByRole('button', { name: '기술', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: '승인형 주문', exact: true })).toHaveCount(0);
    for (const label of ['AI 신호검색기', 'AI 차트', '백테스트', '모의매매']) {
      await settle(page);
      const item = page.getByRole('menuitem', { name: label, exact: true });
      if (label === 'AI 신호검색기') {
        await expectHealthyScannerRoute(page, {
          open: async () => {
            await item.click();
          },
        });
      } else {
        await item.click();
        await settle(page);
      }
      await nav.getByRole('button', { name: '기술', exact: true }).click();
    }
    await page.keyboard.press('Escape');

    await settle(page);
    await nav.getByRole('button', { name: '정보', exact: true }).click();
    for (const label of ['투자 공부', 'AI 정보', '포트폴리오']) {
      await settle(page);
      await page.getByRole('menuitem', { name: label, exact: true }).click();
      await settle(page);
      await nav.getByRole('button', { name: '정보', exact: true }).click();
    }
    expect(diagnostics.expected_scanner_aborts, 'scanner net::ERR_ABORTED must remain zero').toEqual([]);
  });
});
