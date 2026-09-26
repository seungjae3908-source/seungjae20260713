import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Request, type TestInfo } from '@playwright/test';
import {
  installProductionReadOnlyPolicy,
  isIgnorableProductionRequestFailure,
} from './support/production-readonly-policy';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const baseUrl = required('PRODUCTION_BASE_URL').replace(/\/$/, '');
const productionOrigin = new URL(baseUrl).origin;
const expectedSha = required('PRODUCTION_EXPECTED_SHA').toLowerCase();
const qaLogin = required('PRODUCTION_QA_LOGIN');
const qaPassword = required('PRODUCTION_QA_PASSWORD');
if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('PRODUCTION_EXPECTED_SHA must be an exact 40-character SHA');

const artifactDir = path.resolve('production-browser-artifacts');
fs.mkdirSync(artifactDir, { recursive: true });

type Diagnostic = { test: string; path: string; detail: string; status?: number };
type RouteTransition = {
  path: string;
  phase: 'enter' | 'complete' | 'fallback-timeout';
  durationMs?: number;
};
type Evidence = {
  project: string;
  routeTransitions: RouteTransition[];
  loadingDurationsMs: Array<{ path: string; durationMs: number }>;
  failedRequests: Diagnostic[];
  consoleErrors: Diagnostic[];
  pageErrors: Diagnostic[];
  unhandledRejections: Diagnostic[];
  unexpectedHttpErrors: Diagnostic[];
  blockedMutations: Diagnostic[];
  privateAccountLiveQa: 'NOT_RUN';
  actualOrders: 0;
  actualCancels: 0;
  privateAccountRequests: 0;
  privateTradingRequests: 0;
  transfers: 0;
  withdrawals: 0;
};

function requestPath(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.pathname}${url.search}`.replace(/([?&](?:token|key|code|password|secret)=)[^&]*/gi, '$1[redacted]');
  } catch {
    return '[invalid-url]';
  }
}

function routeEvidencePath(route: string): string {
  try {
    return new URL(route, 'https://production-route.invalid').pathname;
  } catch {
    return '[invalid-route]';
  }
}

function sanitizedDetail(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'`<>]+/gi, '[redacted-url]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-token]')
    .replace(/((?:authorization|apikey|api[_-]?key|token|password|secret|key)\s*[:=]\s*)([^\s,;]+)/gi, '$1[redacted]');
}

function makeEvidence(testInfo: TestInfo): Evidence {
  return {
    project: testInfo.project.name,
    routeTransitions: [],
    loadingDurationsMs: [],
    failedRequests: [],
    consoleErrors: [],
    pageErrors: [],
    unhandledRejections: [],
    unexpectedHttpErrors: [],
    blockedMutations: [],
    privateAccountLiveQa: 'NOT_RUN',
    actualOrders: 0,
    actualCancels: 0,
    privateAccountRequests: 0,
    privateTradingRequests: 0,
    transfers: 0,
    withdrawals: 0,
  };
}

function writeEvidence(testInfo: TestInfo, evidence: Evidence) {
  fs.writeFileSync(
    path.join(artifactDir, `${testInfo.project.name}.json`),
    JSON.stringify(evidence, null, 2),
    'utf8',
  );
}

function recordRouteTransition(
  testInfo: TestInfo,
  evidence: Evidence,
  route: string,
  phase: RouteTransition['phase'],
  durationMs?: number,
) {
  const safePath = routeEvidencePath(route);
  evidence.routeTransitions.push({
    path: safePath,
    phase,
    ...(durationMs === undefined ? {} : { durationMs }),
  });
  testInfo.annotations.push({ type: 'production-route', description: `${phase}:${safePath}` });
  console.info(`[production-route] ${phase} ${safePath}${durationMs === undefined ? '' : ` ${durationMs}ms`}`);
  writeEvidence(testInfo, evidence);
}

function attachDiagnostics(page: Page, testInfo: TestInfo, evidence: Evidence) {
  const testName = testInfo.titlePath.join(' > ');
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const detail = sanitizedDetail(message.text());
    const diagnostic = { test: testName, path: requestPath(page.url()), detail };
    evidence.consoleErrors.push(diagnostic);
    if (/unhandled|uncaught.*promise|promise rejection/i.test(detail)) evidence.unhandledRejections.push(diagnostic);
  });
  page.on('pageerror', (error) => {
    const detail = sanitizedDetail(error.message);
    const diagnostic = { test: testName, path: requestPath(page.url()), detail };
    evidence.pageErrors.push(diagnostic);
    if (/unhandled|uncaught.*promise|promise rejection/i.test(detail)) evidence.unhandledRejections.push(diagnostic);
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    evidence.unexpectedHttpErrors.push({
      test: testName,
      path: requestPath(response.url()),
      status: response.status(),
      detail: `${response.request().method()} ${response.status()} ${response.statusText()}`,
    });
  });
  page.on('requestfailed', (request: Request) => {
    const errorText = request.failure()?.errorText ?? 'request failed';
    if (isIgnorableProductionRequestFailure(request.url(), request.method(), errorText, productionOrigin)) return;
    evidence.failedRequests.push({
      test: testName,
      path: requestPath(request.url()),
      status: 0,
      detail: sanitizedDetail(`${request.method()} ${errorText}`),
    });
  });
}

async function waitForFinitePageState(
  page: Page,
  evidence: Evidence,
  route: string,
  testInfo: TestInfo,
) {
  const startedAt = Date.now();
  try {
    await expect(page.getByTestId('page-fallback')).toHaveCount(0, { timeout: 15_000 });
  } catch (error) {
    recordRouteTransition(testInfo, evidence, route, 'fallback-timeout', Date.now() - startedAt);
    throw error;
  }
  const durationMs = Date.now() - startedAt;
  evidence.loadingDurationsMs.push({ path: routeEvidencePath(route), durationMs });
  await expect(page.locator('body')).toBeVisible();
  recordRouteTransition(testInfo, evidence, route, 'complete', durationMs);
}

async function openRoute(page: Page, evidence: Evidence, route: string, testInfo: TestInfo) {
  recordRouteTransition(testInfo, evidence, route, 'enter');
  await page.goto(route, { waitUntil: 'domcontentloaded' });
  await waitForFinitePageState(page, evidence, route, testInfo);
  if (route === '/paper-trading') {
    await expect(page.getByTestId('open-journal-sync')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('paper-trading-route-skeleton')).toHaveCount(0);
  }
}

async function login(page: Page, evidence: Evidence, testInfo: TestInfo) {
  await openRoute(page, evidence, '/login', testInfo);
  await page.getByLabel('아이디').fill(qaLogin);
  await page.getByLabel('비밀번호').fill(qaPassword);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.getByTestId('membership-label')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('관리자 승인 대기 중입니다.')).toHaveCount(0);
}

async function verifyHealth(page: Page) {
  const response = await page.request.get(`${baseUrl}/api/health`);
  expect(response.status()).toBe(200);
  const health = await response.json() as Record<string, unknown>;
  expect(health.ok).toBe(true);
  expect(health.deploySha).toBe(expectedSha);
  expect(health.processDeploySha).toBe(expectedSha);
  expect(health.deployMarkerSha).toBe(expectedSha);
  expect(health.identityMatch).toBe(true);
  expect(health.identityStatus).toBe('match');
}

const majorRoutes = [
  '/',
  '/stocks',
  '/stock-info?asset=stock&market=KR&ticker=005930',
  '/stock/005930',
  '/ai-chart',
  '/scanner',
  '/recommendations',
  '/paper-trading',
] as const;

test('Production read-only major paths terminate loading without browser errors', async ({ page }, testInfo) => {
  const evidence = makeEvidence(testInfo);
  attachDiagnostics(page, testInfo, evidence);
  await installProductionReadOnlyPolicy(page, productionOrigin, (request, reason) => {
    evidence.blockedMutations.push({
      test: testInfo.title,
      path: requestPath(request.url()),
      detail: `${reason}: ${request.method()}`,
    });
  });

  await verifyHealth(page);
  await login(page, evidence, testInfo);
  for (const route of majorRoutes) await openRoute(page, evidence, route, testInfo);

  await openRoute(page, evidence, '/account', testInfo);
  await expect(page.getByRole('heading', { name: '계정', exact: true })).toBeVisible();
  await expect(page.getByText('PRIVATE_ACCOUNT_LIVE_QA')).toHaveCount(0);

  await openRoute(page, evidence, '/', testInfo);
  await expect(page.getByText('홈', { exact: true }).first()).toBeVisible();

  expect(evidence.blockedMutations, `blocked mutation requests: ${JSON.stringify(evidence.blockedMutations)}`).toEqual([]);
  expect(evidence.consoleErrors, `console errors: ${JSON.stringify(evidence.consoleErrors)}`).toEqual([]);
  expect(evidence.pageErrors, `page errors: ${JSON.stringify(evidence.pageErrors)}`).toEqual([]);
  expect(evidence.unhandledRejections, `unhandled rejections: ${JSON.stringify(evidence.unhandledRejections)}`).toEqual([]);
  expect(evidence.unexpectedHttpErrors, `unexpected HTTP errors: ${JSON.stringify(evidence.unexpectedHttpErrors)}`).toEqual([]);
  expect(evidence.failedRequests, `failed requests: ${JSON.stringify(evidence.failedRequests)}`).toEqual([]);

  writeEvidence(testInfo, evidence);
});
