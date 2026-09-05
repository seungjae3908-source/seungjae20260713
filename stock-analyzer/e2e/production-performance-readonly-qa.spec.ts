import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';
import {
  installProductionReadOnlyPolicy,
  isIgnorableProductionRequestFailure,
} from './support/production-readonly-policy';

const baseUrl = String(process.env.PRODUCTION_BASE_URL ?? '').replace(/\/$/, '');
const qaLogin = String(process.env.PRODUCTION_QA_LOGIN ?? '');
const qaPassword = String(process.env.PRODUCTION_QA_PASSWORD ?? '');
const productionQaEnabled = Boolean(
  baseUrl
  && qaLogin
  && qaPassword
  && process.env.PRODUCTION_READONLY_E2E === 'true',
);
const productionOrigin = baseUrl ? new URL(baseUrl).origin : 'http://production-qa-disabled.invalid';
const ARTIFACT_DIR = path.resolve('production-comprehensive-artifacts');
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

const PERFORMANCE_PROJECTS = new Set(['prod-desktop-1920', 'prod-mobile-390']);
const ROUTES = [
  '/',
  '/stocks',
  '/scanner',
  '/ai-chart',
  '/paper-trading',
  '/portfolio',
  '/account',
  '/stock-info/analysis?asset=stock&market=KR&ticker=005930',
] as const;

type Diagnostic = { kind: string; path: string; detail: string };
type Percentiles = { samples: number; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null };
type RoutePerformance = {
  route: string;
  finalUrl: string;
  navigationError: string | null;
  navigationMs: number | null;
  ttfbMs: number | null;
  fcpMs: number | null;
  lcpMs: number | null;
  cls: number;
  api: Percentiles;
  apiDurationsMs: number[];
};

function slug(value: string) {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'unknown';
}

function requestPath(rawUrl: string) {
  try { return new URL(rawUrl).pathname; } catch { return 'unknown'; }
}

function round(value: number) {
  return Number(value.toFixed(1));
}

function percentiles(values: number[]): Percentiles {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (quantile: number) => {
    if (!sorted.length) return null;
    const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1));
    return round(sorted[index]);
  };
  return {
    samples: sorted.length,
    p50Ms: at(0.50),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
  };
}

function writeEvidence(project: string, routeMetrics: RoutePerformance[], diagnostics: Diagnostic[], blocked: Diagnostic[], complete: boolean) {
  const apiDurations = routeMetrics.flatMap((item) => item.apiDurationsMs);
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, `${slug(project)}-performance.json`),
    JSON.stringify({
      project,
      collectedAt: new Date().toISOString(),
      thresholdsApplied: false,
      thresholdPolicy: 'evidence-only; no guessed performance budget',
      routeMetrics,
      apiSummary: percentiles(apiDurations),
      vitalsAvailability: {
        navigation: routeMetrics.filter((item) => item.navigationMs != null).length,
        ttfb: routeMetrics.filter((item) => item.ttfbMs != null).length,
        fcp: routeMetrics.filter((item) => item.fcpMs != null).length,
        lcp: routeMetrics.filter((item) => item.lcpMs != null).length,
        cls: routeMetrics.length,
      },
      diagnostics,
      blocked,
      complete,
    }, null, 2),
    'utf8',
  );
}

async function login(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await expect(page.getByTestId('page-fallback')).toHaveCount(0, { timeout: 10_000 });
  await page.getByLabel('아이디').fill(qaLogin, { timeout: 3_000 });
  await page.getByLabel('비밀번호').fill(qaPassword, { timeout: 3_000 });
  await page.getByRole('button', { name: '로그인', exact: true }).click({ timeout: 3_000 });
  await expect(page.getByTestId('membership-label')).toBeVisible({ timeout: 15_000 });
}

async function installWebVitalObservers(page: Page) {
  await page.addInitScript(() => {
    type PerfState = { lcpMs: number | null; cls: number };
    const target = window as typeof window & { __PRODUCTION_QA_PERF__?: PerfState };
    target.__PRODUCTION_QA_PERF__ = { lcpMs: null, cls: 0 };

    try {
      const lcpObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const latest = entries[entries.length - 1];
        if (latest && target.__PRODUCTION_QA_PERF__) {
          target.__PRODUCTION_QA_PERF__.lcpMs = latest.startTime;
        }
      });
      lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {
      // Browser support is reported as missing evidence, not synthesized.
    }

    try {
      const clsObserver = new PerformanceObserver((list) => {
        for (const rawEntry of list.getEntries()) {
          const entry = rawEntry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
          if (!entry.hadRecentInput && typeof entry.value === 'number' && target.__PRODUCTION_QA_PERF__) {
            target.__PRODUCTION_QA_PERF__.cls += entry.value;
          }
        }
      });
      clsObserver.observe({ type: 'layout-shift', buffered: true });
    } catch {
      // Browser support is reported as zero/missing evidence, not synthesized.
    }
  });
}

async function collectRoutePerformance(page: Page): Promise<Omit<RoutePerformance, 'route' | 'finalUrl' | 'navigationError'>> {
  return page.evaluate(() => {
    type PerfState = { lcpMs: number | null; cls: number };
    const target = window as typeof window & { __PRODUCTION_QA_PERF__?: PerfState };
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    const apiDurationsMs = performance.getEntriesByType('resource')
      .filter((entry) => {
        try {
          const url = new URL(entry.name);
          return url.origin === window.location.origin && url.pathname.startsWith('/api/');
        } catch {
          return false;
        }
      })
      .map((entry) => Number(entry.duration.toFixed(1)))
      .filter((value) => Number.isFinite(value) && value >= 0);

    const navigationMs = navigation
      ? Math.max(0, (navigation.loadEventEnd || performance.now()) - navigation.startTime)
      : null;
    const ttfbMs = navigation
      ? Math.max(0, navigation.responseStart - navigation.requestStart)
      : null;
    const state = target.__PRODUCTION_QA_PERF__;
    return {
      navigationMs: navigationMs == null ? null : Number(navigationMs.toFixed(1)),
      ttfbMs: ttfbMs == null ? null : Number(ttfbMs.toFixed(1)),
      fcpMs: fcp ? Number(fcp.startTime.toFixed(1)) : null,
      lcpMs: state?.lcpMs == null ? null : Number(state.lcpMs.toFixed(1)),
      cls: Number((state?.cls ?? 0).toFixed(4)),
      api: { samples: 0, p50Ms: null, p95Ms: null, p99Ms: null },
      apiDurationsMs,
    };
  }).then((value) => ({ ...value, api: percentiles(value.apiDurationsMs) }));
}

test.describe('Production user-perceived performance read-only evidence', () => {
  test.skip(!productionQaEnabled, 'Dedicated Production QA credentials and read-only flag are required');

  test('collects TTFB/FCP/LCP/CLS and same-origin API latency percentiles without mutations', async ({ page }, testInfo) => {
    test.skip(!PERFORMANCE_PROJECTS.has(testInfo.project.name));
    test.setTimeout(3 * 60_000);

    const diagnostics: Diagnostic[] = [];
    const blocked: Diagnostic[] = [];
    await installWebVitalObservers(page);
    await installProductionReadOnlyPolicy(page, productionOrigin, (request, reason) => {
      blocked.push({ kind: 'blocked-mutation', path: requestPath(request.url()), detail: `${reason}: ${request.method()}` });
    });
    page.on('pageerror', (error) => diagnostics.push({ kind: 'pageerror', path: page.url(), detail: error.message.slice(0, 400) }));
    page.on('requestfailed', (request: Request) => {
      const failure = request.failure()?.errorText ?? 'request failed';
      if (isIgnorableProductionRequestFailure(request.url(), request.method(), failure, productionOrigin)) return;
      diagnostics.push({ kind: 'requestfailed', path: requestPath(request.url()), detail: `${request.method()} ${failure}` });
    });

    await login(page);
    const routeMetrics: RoutePerformance[] = [];
    for (const route of ROUTES) {
      let navigationError: string | null = null;
      await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch((error) => {
        navigationError = String(error).split('\n')[0].slice(0, 220);
      });
      if (navigationError) {
        routeMetrics.push({
          route,
          finalUrl: page.url(),
          navigationError,
          navigationMs: null,
          ttfbMs: null,
          fcpMs: null,
          lcpMs: null,
          cls: 0,
          api: percentiles([]),
          apiDurationsMs: [],
        });
        writeEvidence(testInfo.project.name, routeMetrics, diagnostics, blocked, false);
        continue;
      }

      await expect(page.getByTestId('page-fallback')).toHaveCount(0, { timeout: 5_000 });
      await page.waitForLoadState('load', { timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(750);
      const evidence = await collectRoutePerformance(page);
      routeMetrics.push({ route, finalUrl: page.url(), navigationError, ...evidence });
      writeEvidence(testInfo.project.name, routeMetrics, diagnostics, blocked, false);
    }

    writeEvidence(testInfo.project.name, routeMetrics, diagnostics, blocked, true);
    expect(blocked, 'performance evidence attempted a blocked Production mutation').toEqual([]);
    expect(routeMetrics.filter((item) => item.navigationError), 'performance route navigation failed').toEqual([]);
    expect(routeMetrics.filter((item) => item.navigationMs == null || item.ttfbMs == null), 'navigation/TTFB evidence is missing').toEqual([]);
    expect(diagnostics, 'browser/runtime failures detected during performance evidence collection').toEqual([]);
  });
});
