import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Browser, type Page, type Request, type TestInfo } from '@playwright/test';
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

const logoutScopedReadPaths = new Set([
  '/api/user-integrations',
  '/api/accounts/read-only/toss',
  '/api/accounts/read-only/upbit',
  '/api/accounts/read-only/bitget',
]);

type Diagnostic = { test: string; url: string; detail: string; status?: number };
type LogoutObservation = {
  candidates: Diagnostic[];
  origin: string;
  logoutScopedReads: Set<Request>;
};
type RouteTransitionObservation = {
  fromRoute: string;
  toRoute: string;
  origin: string;
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
type PerformanceSummary = {
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  overFiveSeconds: number;
  userAcceptableWaitMs: number;
};
type AuthenticatedSearchEvidence = {
  market: 'KR' | 'US' | 'spot' | 'futures';
  query: string;
  normalizedSymbol: string | null;
  durationMs: number;
  httpStatus: number;
  terminalState: string;
  resultCount: number;
  exactMatch: boolean;
  providerStatus: string[];
  freshness: { dataAsOf: string | null; stale: boolean; partial: boolean };
  failureCode: string | null;
};
type AiChartSessionTiming = {
  session: number;
  coldDocumentMs: number;
  coldChunkMs: number;
  firstShellMs: number;
  firstUsableChartMs: number;
  warmRouteMs: number;
  warmUsableChartMs: number;
};
type AuthenticatedViewportEvidence = {
  test: string;
  width: number;
  height: number;
  route: string;
  finalRoute: string;
  blank: boolean;
  horizontalOverflowPx: number;
  criticalNavOverlap: string[];
  inputOverlap: string[];
  deadScroll: string[];
  criticalClipping: string[];
  consoleErrors: number;
  pageErrors: number;
  unexpectedHttpErrors: number;
};
const activeLogoutObservations = new WeakMap<Page, LogoutObservation>();
const confirmedLogoutAbortRequests = new WeakMap<Request, string>();
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
  authenticated_search: {
    samples: AuthenticatedSearchEvidence[];
    summary: PerformanceSummary | null;
  };
  authenticated_ai_chart: {
    sessions: AiChartSessionTiming[];
    summary: Record<keyof Omit<AiChartSessionTiming, 'session'>, PerformanceSummary> | null;
  };
  authenticated_viewports: AuthenticatedViewportEvidence[];
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
  authenticated_search: { samples: [], summary: null },
  authenticated_ai_chart: { sessions: [], summary: null },
  authenticated_viewports: [],
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

function isLogoutScopedReadIdentity(
  method: string,
  rawUrl: string,
  expectedOrigin: string,
) {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  return method === 'GET'
    && logoutScopedReadPaths.has(parsed.pathname)
    && parsed.searchParams.size === 0
    && parsed.origin === expectedOrigin;
}

function isLogoutScopedRead(request: Request, expectedOrigin: string) {
  return isLogoutScopedReadIdentity(request.method(), request.url(), expectedOrigin);
}

function isPersonalIntegrationLogoutRead(request: Request, expectedOrigin: string) {
  let parsed: URL;
  try {
    parsed = new URL(request.url());
  } catch {
    return false;
  }
  return parsed.pathname === '/api/user-integrations'
    && isLogoutScopedRead(request, expectedOrigin);
}

function isExpectedLogoutAbort(request: Request, observation: LogoutObservation) {
  let parsed: URL;
  try {
    parsed = new URL(request.url());
  } catch {
    return false;
  }
  const query = [...parsed.searchParams.entries()];
  const aborted = request.failure()?.errorText === 'net::ERR_ABORTED';
  const abortedLogoutRequest = request.method() === 'POST'
    && parsed.pathname === '/auth/v1/logout'
    && query.length === 1
    && query[0]?.[0] === 'scope'
    && query[0]?.[1] === 'global';
  const abortedScopedRead = observation.logoutScopedReads.has(request)
    && isLogoutScopedRead(request, observation.origin);
  return aborted && (abortedLogoutRequest || abortedScopedRead);
}

function isConfirmedLogoutAbort(request: Request) {
  const expectedOrigin = confirmedLogoutAbortRequests.get(request);
  return expectedOrigin !== undefined
    && request.failure()?.errorText === 'net::ERR_ABORTED'
    && isLogoutScopedRead(request, expectedOrigin);
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

function isExpectedLateAiChartCandleAbortIdentity(input: {
  method: string;
  rawUrl: string;
  errorText: string | undefined;
  frameRoute: string;
  observation: Pick<RouteTransitionObservation, 'fromRoute' | 'toRoute' | 'origin'>;
}) {
  try {
    const parsed = new URL(input.rawUrl);
    const fromPath = new URL(input.observation.fromRoute, input.observation.origin).pathname;
    return input.observation.fromRoute !== input.observation.toRoute
      && fromPath === '/ai-chart'
      && routeIdentity(input.frameRoute, input.observation.origin) === input.observation.toRoute
      && input.method === 'GET'
      && parsed.origin === input.observation.origin
      && /^\/api\/stocks\/[^/]+\/candles$/.test(parsed.pathname)
      && input.errorText === 'net::ERR_ABORTED';
  } catch {
    return false;
  }
}

function isExpectedRouteTransitionAbort(
  request: Request,
  observation: RouteTransitionObservation,
) {
  try {
    const parsed = new URL(request.url());
    const routeRead = parsed.pathname.startsWith('/api/')
      || isProfileRequest(request)
      || request.resourceType() === 'script';
    return observation.fromRoute !== observation.toRoute
      && request.method() === 'GET'
      && routeRead
      && parsed.pathname !== '/api/market/scan'
      && request.failure()?.errorText === 'net::ERR_ABORTED'
      && (
        observation.pendingGetRequests.has(request)
        || isExpectedLateAiChartCandleAbortIdentity({
          method: request.method(),
          rawUrl: request.url(),
          errorText: request.failure()?.errorText,
          frameRoute: request.frame().url(),
          observation,
        })
      );
  } catch {
    return false;
  }
}

function isSameOriginApiGet(request: Request) {
  try {
    const parsed = new URL(request.url());
    const routeRead = parsed.pathname.startsWith('/api/')
      || isProfileRequest(request)
      || request.resourceType() === 'script';
    return request.method() === 'GET'
      && parsed.origin === new URL(request.frame().url()).origin
      && routeRead
      && parsed.pathname !== '/api/market/scan';
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
    const logoutObservation = activeLogoutObservations.get(page);
    if (
      logoutObservation
      && isLogoutScopedRead(request, logoutObservation.origin)
    ) {
      logoutObservation.logoutScopedReads.add(request);
    }
    if (isMutatingBrowserRequest(request)) mutations.add(request);
    if (isSameOriginApiGet(request)) {
      apiGets.add(request);
      const routeObservation = activeRouteTransitionObservations.get(page);
      if (routeObservation && routeIdentity(page.url()) === routeObservation.fromRoute) {
        routeObservation.pendingGetRequests.add(request);
      }
    }
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
    if (logoutObservation && isExpectedLogoutAbort(request, logoutObservation)) {
      logoutObservation.candidates.push(diagnostic);
      return;
    }
    if (isConfirmedLogoutAbort(request)) {
      diagnostics.expected_logout_aborts.push(diagnostic);
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

async function waitForPendingPersonalIntegrationReads(page: Page) {
  const expectedOrigin = new URL(page.url()).origin;
  await expect.poll(
    () => {
      const pending = pendingApiGetRequests.get(page);
      if (!pending) return 0;
      return [...pending]
        .filter((request) => isPersonalIntegrationLogoutRead(request, expectedOrigin))
        .length;
    },
    {
      message: 'personal integration GET must settle before verifier-owned authenticated navigation',
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
  await settle(page);
  await waitForPendingPersonalIntegrationReads(page);
}

async function logout(page: Page) {
  const logoutButton = page.getByRole('button', { name: /로그아웃|sign out/i });
  await expect(logoutButton).toBeVisible();
  const origin = new URL(page.url()).origin;
  const observation: LogoutObservation = {
    candidates: [],
    origin,
    logoutScopedReads: new Set(
      [...(pendingApiGetRequests.get(page) ?? [])]
        .filter((request) => isLogoutScopedRead(request, origin)),
    ),
  };
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

    for (const request of observation.logoutScopedReads) {
      confirmedLogoutAbortRequests.set(request, observation.origin);
    }
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

async function expectNavigationTransition(
  page: Page,
  route: string,
  open: () => Promise<void>,
) {
  await settle(page);
  const observation: RouteTransitionObservation = {
    fromRoute: routeIdentity(page.url()),
    toRoute: routeIdentity(route, page.url()),
    origin: new URL(page.url()).origin,
    candidates: [],
    pendingGetRequests: new Set(pendingApiGetRequests.get(page) ?? []),
  };
  activeRouteTransitionObservations.set(page, observation);
  let confirmed = false;
  try {
    await open();
    await settle(page);
    expect(routeIdentity(page.url())).toBe(observation.toRoute);
    await expect(page.locator('body')).not.toContainText(/페이지를 찾을 수 없습니다|page not found/i);
    await expect(page.locator('body')).not.toBeEmpty();
    confirmed = true;
  } finally {
    await finishRouteTransition(page, observation, confirmed);
  }
}

async function expectHealthyRoute(page: Page, route: string) {
  await settle(page);
  const requestedRoute = routeIdentity(route, page.url());
  const expectedRoute = requestedRoute === '/stock/005930'
    ? '/stock-info?back=%2Fstocks&asset=stock&market=KR&ticker=005930'
    : requestedRoute;
  const observation: RouteTransitionObservation = {
    fromRoute: routeIdentity(page.url()),
    toRoute: expectedRoute,
    origin: new URL(page.url()).origin,
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
          message: 'stock detail fixture must reach its exact canonical stock-info route',
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
    origin: new URL(page.url()).origin,
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
    origin: new URL(page.url()).origin,
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

function performanceSummary(values: number[]): PerformanceSummary {
  if (values.length === 0) throw new Error('performance summary requires at least one sample');
  const sorted = [...values].sort((a, b) => a - b);
  const medianIndex = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? ((sorted[medianIndex - 1] ?? 0) + (sorted[medianIndex] ?? 0)) / 2
    : (sorted[medianIndex] ?? 0);
  return {
    medianMs: Math.round(median),
    p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
    maxMs: sorted.at(-1) ?? 0,
    overFiveSeconds: sorted.filter((value) => value > 5_000).length,
    userAcceptableWaitMs: 5_000,
  };
}

function normalizedAssetSymbol(value: unknown) {
  return String(value ?? '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

async function runAuthenticatedSearchCertification(page: Page) {
  const matrix = [
    { market: 'KR', label: '국내', query: '034730', acceptable: ['034730'] },
    { market: 'US', label: '미국', query: 'AAPL', acceptable: ['AAPL'] },
    { market: 'spot', label: '코인 현물', query: 'KRW-BTC', acceptable: ['KRWBTC', 'BTC'] },
    { market: 'futures', label: '코인 선물', query: 'DOGEUSDT', acceptable: ['DOGEUSDT'] },
  ] as const;
  await expectHealthyRoute(page, '/search');
  const input = page.getByRole('combobox', { name: '통합 자산 검색' });
  await expect(input).toBeEditable();
  const samples: AuthenticatedSearchEvidence[] = [];

  for (const item of matrix) {
    const tab = page.getByRole('button', { name: item.label, exact: true });
    await expect(tab).toBeVisible();
    await tab.click();
    await expect(tab).toHaveAttribute('aria-pressed', 'true');
    await input.fill('');
    const started = Date.now();
    const responsePromise = page.waitForResponse((response) => {
      try {
        const url = new URL(response.url());
        return url.pathname === '/api/search/suggest'
          && url.searchParams.get('market') === item.market
          && url.searchParams.get('q') === item.query;
      } catch {
        return false;
      }
    }, { timeout: 5_000 });
    await input.fill(item.query);
    const response = await responsePromise;
    const durationMs = Date.now() - started;
    const payload = await response.json().catch(() => ({})) as {
      ok?: boolean;
      state?: string;
      results?: Array<Record<string, unknown>>;
      count?: number;
      dataAsOf?: string | null;
      stale?: boolean;
      partial?: boolean;
      providers?: Array<{ provider?: string; status?: string }>;
      error?: string;
      message?: string;
    };
    const results = Array.isArray(payload.results) ? payload.results : [];
    const match = results.find((result) => {
      const identities = [result.productCode, result.ticker, result.symbol, result.baseSymbol]
        .map(normalizedAssetSymbol)
        .filter(Boolean);
      return item.acceptable.some((expected) => identities.includes(expected));
    });
    const failureCode = response.status() !== 200
      ? `HTTP_${response.status()}`
      : payload.ok !== true
        ? String(payload.error ?? 'DATA_UNAVAILABLE')
        : match
          ? null
          : results.length === 0
            ? 'DATA_UNAVAILABLE'
            : 'EXACT_MATCH_MISSING';
    const sample: AuthenticatedSearchEvidence = {
      market: item.market,
      query: item.query,
      normalizedSymbol: match
        ? normalizedAssetSymbol(match.productCode ?? match.ticker ?? match.symbol ?? match.baseSymbol)
        : null,
      durationMs,
      httpStatus: response.status(),
      terminalState: String(payload.state ?? 'UNKNOWN'),
      resultCount: Number(payload.count ?? results.length),
      exactMatch: Boolean(match),
      providerStatus: (payload.providers ?? []).map((provider) => `${provider.provider ?? 'unknown'}:${provider.status ?? 'unknown'}`),
      freshness: {
        dataAsOf: typeof payload.dataAsOf === 'string' ? payload.dataAsOf : null,
        stale: payload.stale === true,
        partial: payload.partial === true,
      },
      failureCode,
    };
    samples.push(sample);
    diagnostics.authenticated_search.samples.push(sample);
    await expect.poll(async () => {
      const optionText = (await page.getByRole('option').allTextContents())
        .map(normalizedAssetSymbol);
      if (item.acceptable.some((expected) => optionText.some((text) => text.includes(expected)))) {
        return 'RESULTS_AVAILABLE';
      }
      if (await page.getByTestId('unified-search-outcome').isVisible().catch(() => false)) return 'DATA_UNAVAILABLE';
      return 'PENDING';
    }, { timeout: 5_000, intervals: [100, 200, 400, 800] }).toBe('RESULTS_AVAILABLE');
    expect(sample.httpStatus, `${item.label} search HTTP evidence: ${JSON.stringify(sample)}`).toBe(200);
    expect(sample.failureCode, `${item.label} search terminal evidence: ${JSON.stringify(sample)}`).toBeNull();
    expect(sample.exactMatch, `${item.label} search exact-match evidence: ${JSON.stringify(sample)}`).toBe(true);
    expect(sample.durationMs, `${item.label} search exceeded the 5s hard maximum`).toBeLessThan(5_000);
  }

  const summary = performanceSummary(samples.map((sample) => sample.durationMs));
  diagnostics.authenticated_search.summary = summary;
  expect(summary.p95Ms, `authenticated Search p95 evidence: ${JSON.stringify(summary)}`).toBeLessThanOrEqual(2_000);
  expect(summary.maxMs, `authenticated Search max evidence: ${JSON.stringify(summary)}`).toBeLessThan(5_000);
  expect(summary.overFiveSeconds).toBe(0);
}

async function waitForUsableAiChart(page: Page, startedAt: number) {
  await expect(page.getByRole('heading', { name: /AI 차트 생중계/, level: 1 })).toBeVisible({ timeout: 5_000 });
  const firstShellMs = Date.now() - startedAt;
  await expect.poll(async () => {
    if (await page.getByTestId('chart-error-state').isVisible().catch(() => false)) return 'error';
    if (await page.getByTestId('chart-empty-state').isVisible().catch(() => false)) return 'empty';
    if (await page.getByTestId('unified-chart-canvas').isVisible().catch(() => false)) return 'canvas';
    return 'pending';
  }, { timeout: 5_000, intervals: [100, 200, 400, 800] }).toBe('canvas');
  return { firstShellMs, usableMs: Date.now() - startedAt };
}

async function runAuthenticatedAiChartCertification(
  authenticatedPage: Page,
  browser: Browser,
  testInfo: TestInfo,
) {
  const storageState = await authenticatedPage.context().storageState();
  const sessions: AiChartSessionTiming[] = [];
  for (let session = 1; session <= 3; session += 1) {
    const context = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      storageState,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    attachDiagnostics(page, testInfo);
    try {
      const coldStarted = Date.now();
      const response = await page.goto('/ai-chart', { waitUntil: 'domcontentloaded' });
      if (response) expect(response.status(), `AI Chart cold document HTTP ${response.status()}`).toBeLessThan(400);
      const cold = await waitForUsableAiChart(page, coldStarted);
      const navigationTiming = await page.evaluate(() => {
        const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        const scriptEntries = performance.getEntriesByType('resource')
          .filter((entry) => entry instanceof PerformanceResourceTiming && entry.initiatorType === 'script');
        return {
          documentMs: Math.round(navigation?.domContentLoadedEventEnd ?? 0),
          chunkMs: Math.round(scriptEntries.reduce((max, entry) => Math.max(max, entry.responseEnd), 0)),
        };
      });

      await expectHealthyRoute(page, '/');
      const nav = page.locator('nav');
      await nav.getByRole('button', { name: '기술', exact: true }).click();
      const aiChartItem = page.getByRole('menuitem', { name: 'AI 차트', exact: true });
      await expect(aiChartItem).toBeVisible();
      let warmRouteMs = 0;
      let warmUsableChartMs = 0;
      await expectNavigationTransition(page, '/ai-chart', async () => {
        const warmStarted = Date.now();
        await aiChartItem.click();
        await expect.poll(() => routeIdentity(page.url()), {
          timeout: 5_000,
          intervals: [50, 100, 200, 400],
        }).toBe('/ai-chart');
        warmRouteMs = Date.now() - warmStarted;
        const warm = await waitForUsableAiChart(page, warmStarted);
        warmUsableChartMs = warm.usableMs;
      });
      const timing: AiChartSessionTiming = {
        session,
        coldDocumentMs: navigationTiming.documentMs,
        coldChunkMs: navigationTiming.chunkMs,
        firstShellMs: cold.firstShellMs,
        firstUsableChartMs: cold.usableMs,
        warmRouteMs,
        warmUsableChartMs,
      };
      sessions.push(timing);
      diagnostics.authenticated_ai_chart.sessions.push(timing);
      await expectHealthyRoute(page, '/');
    } finally {
      await context.close();
    }
  }

  const summary = {
    coldDocumentMs: performanceSummary(sessions.map((item) => item.coldDocumentMs)),
    coldChunkMs: performanceSummary(sessions.map((item) => item.coldChunkMs)),
    firstShellMs: performanceSummary(sessions.map((item) => item.firstShellMs)),
    firstUsableChartMs: performanceSummary(sessions.map((item) => item.firstUsableChartMs)),
    warmRouteMs: performanceSummary(sessions.map((item) => item.warmRouteMs)),
    warmUsableChartMs: performanceSummary(sessions.map((item) => item.warmUsableChartMs)),
  };
  diagnostics.authenticated_ai_chart.summary = summary;
  expect(summary.firstUsableChartMs.p95Ms, `AI Chart cold p95 evidence: ${JSON.stringify(summary)}`).toBeLessThanOrEqual(5_000);
  expect(summary.warmUsableChartMs.p95Ms, `AI Chart warm p95 evidence: ${JSON.stringify(summary)}`).toBeLessThanOrEqual(5_000);
  expect(summary.firstUsableChartMs.overFiveSeconds).toBe(0);
  expect(summary.warmUsableChartMs.overFiveSeconds).toBe(0);
}

async function auditAuthenticatedViewport(
  page: Page,
  testInfo: TestInfo,
  route: string,
  width: number,
  height: number,
) {
  const before = {
    console: diagnostics.console_errors.length,
    page: diagnostics.page_errors.length,
    http: diagnostics.unexpected_http_errors.length,
  };
  await page.setViewportSize({ width, height });
  const scannerOrigin = new URL(page.url()).origin;
  const scannerResponsePromise = route === '/scanner'
    ? page.waitForResponse((response) => {
        try {
          const url = new URL(response.url());
          return response.request().method() === 'GET'
            && url.origin === scannerOrigin
            && url.pathname === '/api/market/scan';
        } catch {
          return false;
        }
      }, { timeout: 15_000 })
    : null;
  await expectHealthyRoute(page, route);
  if (scannerResponsePromise) {
    const scannerResponse = await scannerResponsePromise;
    expect(
      scannerResponse.status(),
      `scanner viewport API returned HTTP ${scannerResponse.status()}`,
    ).toBe(200);
    const scannerError = await scannerResponse.finished();
    expect(scannerError, 'scanner viewport response must finish before the verifier leaves /scanner').toBeNull();
    const scannerBody = await scannerResponse.json().catch(() => null) as { ok?: boolean; elapsedMs?: number } | null;
    expect(scannerBody?.ok, 'scanner viewport API must return an explicit successful scanner envelope').toBe(true);
    expect(
      Number(scannerBody?.elapsedMs),
      'scanner viewport API must remain inside the existing 12s scanner contract',
    ).toBeLessThanOrEqual(12_000);
    await settle(page);
  }
  const layout = await page.evaluate(() => {
    const visible = (element: Element) => {
      const rect = (element as HTMLElement).getBoundingClientRect();
      const style = getComputedStyle(element as HTMLElement);
      return rect.width > 1 && rect.height > 1
        && rect.bottom > 0 && rect.right > 0
        && rect.top < innerHeight && rect.left < innerWidth
        && style.display !== 'none' && style.visibility !== 'hidden'
        && Number(style.opacity || '1') > 0.01;
    };
    const label = (element: Element) => String(
      element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.textContent || element.tagName,
    ).trim().replace(/\s+/g, ' ').slice(0, 80);
    const overlapRatio = (a: DOMRect, b: DOMRect) => {
      const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      const minimum = Math.min(a.width * a.height, b.width * b.height);
      return minimum > 0 ? (x * y) / minimum : 0;
    };
    const inputs = Array.from(document.querySelectorAll('input,textarea,select,[role="combobox"]')).filter(visible);
    const nav = document.querySelector('nav[aria-label="주요 메뉴"], nav');
    const critical = Array.from(document.querySelectorAll('h1,input,textarea,select,[role="combobox"]')).filter(visible);
    const criticalNavOverlap: string[] = [];
    if (nav && visible(nav)) {
      const navRect = nav.getBoundingClientRect();
      for (const element of critical) {
        if (nav.contains(element)) continue;
        if (overlapRatio(navRect, element.getBoundingClientRect()) >= 0.25) criticalNavOverlap.push(label(element));
      }
    }
    const inputOverlap: string[] = [];
    for (let left = 0; left < inputs.length; left += 1) {
      for (let right = left + 1; right < inputs.length; right += 1) {
        if (overlapRatio(inputs[left].getBoundingClientRect(), inputs[right].getBoundingClientRect()) >= 0.25) {
          inputOverlap.push(`${label(inputs[left])} <> ${label(inputs[right])}`);
        }
      }
    }
    const criticalClipping = [nav, ...critical].filter((element): element is Element => Boolean(element) && visible(element as Element))
      .flatMap((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -2 || rect.right > innerWidth + 2 ? [label(element)] : [];
      });
    const scrollables = [document.scrollingElement, ...Array.from(document.querySelectorAll('main,section,div,ul'))]
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .filter((element, index, all) => all.indexOf(element) === index)
      .filter((element) => {
        const style = getComputedStyle(element);
        const root = element === document.scrollingElement;
        return element.scrollHeight > element.clientHeight + 32
          && (root || /(auto|scroll)/.test(style.overflowY));
      });
    const deadScroll: string[] = [];
    for (const element of scrollables.slice(0, 30)) {
      const before = element.scrollTop;
      element.scrollTop = 0;
      element.scrollTop = Math.min(32, element.scrollHeight - element.clientHeight);
      if (element.scrollTop < 1) deadScroll.push(label(element));
      element.scrollTop = before;
    }
    return {
      blank: (document.body?.innerText ?? '').trim().length === 0,
      horizontalOverflowPx: Math.max(0, Math.round(Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0) - innerWidth)),
      criticalNavOverlap: [...new Set(criticalNavOverlap)],
      inputOverlap: [...new Set(inputOverlap)],
      deadScroll: [...new Set(deadScroll)],
      criticalClipping: [...new Set(criticalClipping)],
    };
  });
  const evidence: AuthenticatedViewportEvidence = {
    test: testInfo.titlePath.join(' > '),
    width,
    height,
    route,
    finalRoute: routeIdentity(page.url()),
    ...layout,
    consoleErrors: diagnostics.console_errors.length - before.console,
    pageErrors: diagnostics.page_errors.length - before.page,
    unexpectedHttpErrors: diagnostics.unexpected_http_errors.length - before.http,
  };
  diagnostics.authenticated_viewports.push(evidence);
  return evidence;
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

test('logout abort proof keeps session-scoped account reads exact and query-free', () => {
  const origin = 'https://staging.example.test';
  for (const route of [
    '/api/user-integrations',
    '/api/accounts/read-only/toss',
    '/api/accounts/read-only/upbit',
    '/api/accounts/read-only/bitget',
  ]) {
    expect(isLogoutScopedReadIdentity('GET', `${origin}${route}`, origin)).toBe(true);
  }
  expect(isLogoutScopedReadIdentity('GET', `${origin}/api/accounts/read-only/kiwoom`, origin)).toBe(false);
  expect(isLogoutScopedReadIdentity('GET', `${origin}/api/accounts/read-only/toss?refresh=1`, origin)).toBe(false);
  expect(isLogoutScopedReadIdentity('GET', `${origin}/api/accounts/read-only/toss/history`, origin)).toBe(false);
  expect(isLogoutScopedReadIdentity('POST', `${origin}/api/accounts/read-only/toss`, origin)).toBe(false);
  expect(isLogoutScopedReadIdentity('GET', 'https://other.example.test/api/accounts/read-only/toss', origin)).toBe(false);

  const observation = { fromRoute: '/ai-chart', toRoute: '/portfolio', origin };
  const lateCandleAbort = {
    method: 'GET',
    rawUrl: `${origin}/api/stocks/005930/candles?tf=1D`,
    errorText: 'net::ERR_ABORTED',
    frameRoute: `${origin}/portfolio`,
    observation,
  };
  expect(isExpectedLateAiChartCandleAbortIdentity(lateCandleAbort)).toBe(true);
  expect(isExpectedLateAiChartCandleAbortIdentity({ ...lateCandleAbort, method: 'POST' })).toBe(false);
  expect(isExpectedLateAiChartCandleAbortIdentity({ ...lateCandleAbort, errorText: 'net::ERR_FAILED' })).toBe(false);
  expect(isExpectedLateAiChartCandleAbortIdentity({ ...lateCandleAbort, rawUrl: `${origin}/api/market/scan` })).toBe(false);
  expect(isExpectedLateAiChartCandleAbortIdentity({ ...lateCandleAbort, rawUrl: `${origin}/api/stocks/005930/chart` })).toBe(false);
  expect(isExpectedLateAiChartCandleAbortIdentity({ ...lateCandleAbort, rawUrl: 'https://other.example.test/api/stocks/005930/candles' })).toBe(false);
  expect(isExpectedLateAiChartCandleAbortIdentity({ ...lateCandleAbort, frameRoute: `${origin}/ai-chart` })).toBe(false);
  expect(isExpectedLateAiChartCandleAbortIdentity({
    ...lateCandleAbort,
    observation: { ...observation, fromRoute: '/scanner' },
  })).toBe(false);
});

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
      await settle(page);
      await waitForPendingPersonalIntegrationReads(page);
      await page.reload();
      await settle(page);
      await waitForPendingPersonalIntegrationReads(page);
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
      await expectHealthyRoute(page, '/account');
      await expectBootstrapTerminalError(page);
      await page.getByRole('button', { name: '다시 시도', exact: true }).click();
      await expect(page.locator('nav')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('error-state')).toHaveCount(0);
      await expect(page.getByTestId('page-fallback')).toHaveCount(0);
      expect(requestCount, 'retry must create exactly one fresh profile request after the first failure').toBe(2);
      expect(observation.candidates, 'semantic first-attempt rejection must not create a network-error exemption').toHaveLength(0);
      await expect(page.getByRole('button', { name: /로그아웃|sign out/i })).toBeVisible();
      confirmed = true;
    } finally {
      await page.unroute('**/rest/v1/profiles*');
      await finishAuthFault(page, observation, confirmed);
    }
  });

  test('scanner readiness: complete, partial, and strict unavailable states satisfy the frontend contract', async ({ page }) => {
    await login(page, accounts.regular.loginName, accounts.regular.password);
    let fixtureState: 'complete' | 'partial' | 'unavailable' = 'complete';
    await page.route('**/api/market/scan**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(scannerFixture(fixtureState)),
      });
    });
    const refreshScanner = async () => {
      const heading = page.getByRole('heading', { name: 'AI 신호검색기', exact: true });
      const header = heading.locator('..').locator('..');
      await header.getByRole('button', { name: '새로고침', exact: true }).click();
    };
    try {
      const complete = await expectHealthyScannerRoute(page);
      expect(complete.httpStatus).toBe(200);
      expect(complete.dataState).toBe('complete');
      expect(complete.elapsedMs).toBeLessThanOrEqual(12_000);
      expect(complete.requestElapsedMs).toBeLessThanOrEqual(12_000);
      expect(complete.orderCapableRequests).toEqual([]);

      fixtureState = 'partial';
      const partial = await expectHealthyScannerRoute(page, { open: refreshScanner });
      expect(partial.httpStatus).toBe(200);
      expect(partial.dataState).toBe('partial');
      expect(partial.elapsedMs).toBeLessThanOrEqual(12_000);
      expect(partial.requestElapsedMs).toBeLessThanOrEqual(12_000);
      expect(partial.orderCapableRequests).toEqual([]);

      fixtureState = 'unavailable';
      const unavailable = await expectHealthyScannerRoute(page, { open: refreshScanner });
      expect(unavailable.httpStatus).toBe(200);
      expect(unavailable.dataState).toBe('unavailable');
      expect(unavailable.elapsedMs).toBeLessThanOrEqual(12_000);
      expect(unavailable.requestElapsedMs).toBeLessThanOrEqual(12_000);
      expect(unavailable.orderCapableRequests).toEqual([]);
      expect(unavailable.partial).toBe(true);
      expect(unavailable.executionPartial).toBe(true);
      expect(unavailable.executionTimedOut).toBe(true);
      expect(unavailable.timeoutCount).toBeGreaterThanOrEqual(1);
      expect(unavailable.deadlineMs).toBeGreaterThan(0);
      expect(unavailable.deadlineMs).toBeLessThan(12_000);
      expect(unavailable.cards).toEqual([]);
    } finally {
      await page.unroute('**/api/market/scan**');
    }
    expect(diagnostics.expected_scanner_aborts, 'scanner net::ERR_ABORTED must remain zero').toEqual([]);
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

  test('regular: futures, scanner, paper trading, and safe AI preview are available without real orders', async ({ page, browser }, testInfo) => {
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
    await runAuthenticatedSearchCertification(page);
    await runAuthenticatedAiChartCertification(page, browser, testInfo);
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

  const certificationRoutes = [
    '/', '/search', '/scanner', '/ai-chart', '/ai-chat', '/portfolio', '/account', '/learn', '/auto-trading',
  ] as const;
  const functionalRoutes = [
    '/stock/005930',
    '/stock-info?asset=stock&market=KR&ticker=005930',
    '/stock-info?asset=stock&market=US&ticker=AAPL',
    '/stock-info?asset=coin&coinMarket=spot&symbol=BTC',
    '/watchlist',
    '/alerts',
    '/themes',
    '/market-overview',
    '/more',
  ] as const;
  const assertViewportEvidence = (evidence: AuthenticatedViewportEvidence[]) => {
    expect(evidence.filter((item) => item.blank), 'blank authenticated viewport').toEqual([]);
    expect(evidence.filter((item) => item.horizontalOverflowPx > 0), 'horizontal overflow in authenticated viewport').toEqual([]);
    expect(evidence.filter((item) => item.criticalNavOverlap.length > 0), 'critical navigation overlap').toEqual([]);
    expect(evidence.filter((item) => item.inputOverlap.length > 0), 'input overlap').toEqual([]);
    expect(evidence.filter((item) => item.deadScroll.length > 0), 'dead scroll container').toEqual([]);
    expect(evidence.filter((item) => item.criticalClipping.length > 0), 'critical horizontal clipping').toEqual([]);
    expect(evidence.filter((item) => item.consoleErrors > 0), 'viewport console errors').toEqual([]);
    expect(evidence.filter((item) => item.pageErrors > 0), 'viewport page errors').toEqual([]);
    expect(evidence.filter((item) => item.unexpectedHttpErrors > 0), 'viewport unexpected HTTP failures').toEqual([]);
  };

  test('desktop: major screens, search/detail, domestic/overseas/coin, watchlist, alerts, and settings', async ({ page }, testInfo) => {
    const viewports = [[1440, 900], [1024, 768]] as const;
    const [loginWidth, loginHeight] = viewports[0];
    await page.setViewportSize({ width: loginWidth, height: loginHeight });
    await login(page, accounts.regular.loginName, accounts.regular.password);
    const evidence: AuthenticatedViewportEvidence[] = [];
    for (const [width, height] of viewports) {
      for (const route of certificationRoutes) {
        evidence.push(await auditAuthenticatedViewport(page, testInfo, route, width, height));
      }
    }
    await page.setViewportSize({ width: loginWidth, height: loginHeight });
    for (const route of functionalRoutes) await expectHealthyRoute(page, route);
    assertViewportEvidence(evidence);
  });

  for (const [width, height] of [
    [320, 740], [360, 800], [390, 844], [412, 915], [430, 932],
  ] as const) {
    test(`mobile ${width}x${height}: major screens`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await login(page, accounts.regular.loginName, accounts.regular.password);
      const evidence: AuthenticatedViewportEvidence[] = [];
      for (const route of certificationRoutes) {
        evidence.push(await auditAuthenticatedViewport(page, testInfo, route, width, height));
      }
      assertViewportEvidence(evidence);
    });
  }

  test('mobile: search/detail, domestic/overseas/coin, watchlist, alerts, and settings', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await login(page, accounts.regular.loginName, accounts.regular.password);
    for (const route of functionalRoutes) await expectHealthyRoute(page, route);
  });

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

    const technicalMenu = APP_NAVIGATION.find((group) => group.id === 'technical')?.menu ?? [];
    await settle(page);
    await nav.getByRole('button', { name: '기술', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: '승인형 주문', exact: true })).toHaveCount(0);
    for (const label of ['AI 신호검색기', 'AI 차트', '백테스트', '모의매매']) {
      const target = technicalMenu.find((menuItem) => menuItem.label === label);
      if (!target) throw new Error(`missing technical navigation item: ${label}`);
      const item = page.getByRole('menuitem', { name: label, exact: true });
      await expectNavigationTransition(page, target.href, async () => {
        if (label === 'AI 신호검색기') {
          await expectHealthyScannerRoute(page, {
            open: async () => {
              await item.click();
            },
          });
          return;
        }
        await item.click();
      });
      await nav.getByRole('button', { name: '기술', exact: true }).click();
    }
    await page.keyboard.press('Escape');

    const informationMenu = APP_NAVIGATION.find((group) => group.id === 'information')?.menu ?? [];
    await settle(page);
    await nav.getByRole('button', { name: '정보', exact: true }).click();
    for (const label of ['투자 공부', 'AI 정보', '포트폴리오']) {
      const target = informationMenu.find((menuItem) => menuItem.label === label);
      if (!target) throw new Error(`missing information navigation item: ${label}`);
      const item = page.getByRole('menuitem', { name: label, exact: true });
      await expectNavigationTransition(page, target.href, async () => {
        await item.click();
      });
      await nav.getByRole('button', { name: '정보', exact: true }).click();
    }
    expect(diagnostics.expected_scanner_aborts, 'scanner net::ERR_ABORTED must remain zero').toEqual([]);
  });
});