import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Request, type TestInfo } from '@playwright/test';
import {
  installProductionReadOnlyPolicy,
  isIgnorableProductionRequestFailure,
} from './support/production-readonly-policy';

const baseUrl = String(process.env.PRODUCTION_BASE_URL ?? '').replace(/\/$/, '');
const productionOrigin = baseUrl ? new URL(baseUrl).origin : 'http://production-observer-disabled.invalid';
const mode = String(process.env.PRODUCTION_OBSERVER_MODE ?? 'critical').toLowerCase();
const artifactDir = path.resolve('production-health-observer-artifacts');
fs.mkdirSync(artifactDir, { recursive: true });

const CRITICAL_ROUTES = ['/', '/login', '/stocks', '/scanner', '/ai-chart', '/news-information'] as const;
const FULL_ROUTES = [
  ...CRITICAL_ROUTES,
  '/stocks/kr', '/stocks/us', '/coins/spot', '/coins/futures', '/market-overview',
  '/market-rankings', '/market-browser', '/themes', '/learn', '/watchlist', '/alerts',
  '/portfolio', '/position', '/recommendations', '/backtests', '/paper-trading', '/account',
  '/more', '/settings',
] as const;

const routes = mode === 'full' ? FULL_ROUTES : CRITICAL_ROUTES;

type Diagnostic = {
  kind: 'navigation' | 'http' | 'console' | 'pageerror' | 'requestfailed' | 'fallback' | 'blocked-mutation';
  route: string;
  path: string;
  detail: string;
  status?: number;
};

type RouteResult = {
  route: string;
  finalUrl: string;
  status: number | null;
  loadMs: number;
  fallbackVisible: boolean;
};

function sanitizeDetail(raw: unknown) {
  return String(raw ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/([?&](?:token|key|secret|password|code)=)[^&\s]+/gi, '$1[REDACTED]')
    .slice(0, 500);
}

function safePath(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return `${url.pathname}${url.search}`.slice(0, 500);
  } catch {
    return 'unknown';
  }
}

function attachDiagnostics(page: Page, diagnostics: Diagnostic[], currentRoute: () => string) {
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    diagnostics.push({
      kind: 'console',
      route: currentRoute(),
      path: safePath(page.url()),
      detail: sanitizeDetail(message.text()),
    });
  });
  page.on('pageerror', (error) => {
    diagnostics.push({
      kind: 'pageerror',
      route: currentRoute(),
      path: safePath(page.url()),
      detail: sanitizeDetail(error.message),
    });
  });
  page.on('response', (response) => {
    if (response.status() < 500) return;
    let url: URL;
    try { url = new URL(response.url()); } catch { return; }
    if (url.origin !== productionOrigin) return;
    diagnostics.push({
      kind: 'http',
      route: currentRoute(),
      path: `${url.pathname}${url.search}`.slice(0, 500),
      status: response.status(),
      detail: sanitizeDetail(`${response.request().method()} ${response.status()} ${response.statusText()}`),
    });
  });
  page.on('requestfailed', (request: Request) => {
    const failure = request.failure()?.errorText ?? 'request failed';
    if (isIgnorableProductionRequestFailure(request.url(), request.method(), failure, productionOrigin)) return;
    diagnostics.push({
      kind: 'requestfailed',
      route: currentRoute(),
      path: safePath(request.url()),
      detail: sanitizeDetail(`${request.method()} ${failure}`),
    });
  });
}

function dedupeDiagnostics(items: Diagnostic[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}|${item.route}|${item.path}|${item.status ?? ''}|${item.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function visitRoute(page: Page, route: string, diagnostics: Diagnostic[]): Promise<RouteResult> {
  const started = Date.now();
  try {
    const response = await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    const status = response?.status() ?? null;
    if (status !== null && status >= 500) {
      diagnostics.push({ kind: 'http', route, path: route, status, detail: `navigation HTTP ${status}` });
    }
    await page.waitForTimeout(800);
    const fallback = page.getByTestId('page-fallback');
    const fallbackVisible = await fallback.isVisible().catch(() => false);
    if (fallbackVisible) {
      diagnostics.push({ kind: 'fallback', route, path: safePath(page.url()), detail: 'page-fallback visible after navigation' });
    }
    return { route, finalUrl: page.url(), status, loadMs: Date.now() - started, fallbackVisible };
  } catch (error) {
    diagnostics.push({
      kind: 'navigation',
      route,
      path: route,
      detail: sanitizeDetail(error instanceof Error ? error.message : error),
    });
    return { route, finalUrl: page.url(), status: null, loadMs: Date.now() - started, fallbackVisible: false };
  }
}

function artifactName(testInfo: TestInfo) {
  return `observer-${testInfo.project.name.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}.json`;
}

test('public Production critical routes remain reachable and read-only', async ({ page }, testInfo) => {
  test.skip(!baseUrl || process.env.PRODUCTION_READONLY_E2E !== 'true', 'Production observer is not enabled');

  const diagnostics: Diagnostic[] = [];
  let routeUnderTest = '/';
  attachDiagnostics(page, diagnostics, () => routeUnderTest);
  await installProductionReadOnlyPolicy(page, productionOrigin, (request, reason) => {
    diagnostics.push({
      kind: 'blocked-mutation',
      route: routeUnderTest,
      path: safePath(request.url()),
      detail: sanitizeDetail(`${reason}: ${request.method()}`),
    });
  });

  const results: RouteResult[] = [];
  for (const route of routes) {
    routeUnderTest = route;
    results.push(await visitRoute(page, route, diagnostics));
  }

  const failures = dedupeDiagnostics(diagnostics);
  fs.writeFileSync(path.join(artifactDir, artifactName(testInfo)), JSON.stringify({
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    project: testInfo.project.name,
    mode,
    baseUrl,
    routes: results,
    failures,
    safety: {
      authenticated: false,
      productionMutationsAllowed: false,
      privateProviderCallsAllowed: false,
      realOrdersAllowed: false,
      traceRetention: false,
      screenshotRetention: false,
    },
  }, null, 2), 'utf8');

  expect(failures, JSON.stringify(failures.slice(0, 8), null, 2)).toEqual([]);
});
