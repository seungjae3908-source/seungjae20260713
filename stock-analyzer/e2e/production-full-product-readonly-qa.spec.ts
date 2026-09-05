import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Request, type Route } from '@playwright/test';
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
const RESEARCH_OVERVIEW_PATTERN = '**/api/admin/research/overview';
const SEARCH_PATTERN = '**/api/search/suggest?**';

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

type Diagnostic = {
  kind: 'console' | 'pageerror' | 'requestfailed' | 'http' | 'blocked-mutation';
  route: string;
  detail: string;
  status?: number;
};

type JourneyStep = {
  name: string;
  finalUrl: string;
  durationMs: number;
};

type ResilienceResult = {
  scenario: string;
  recovered: boolean;
  injectedStatuses: number[];
  expectedAborts: number;
};

function safeSlug(value: string) {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'evidence';
}

function writeJson(name: string, value: unknown) {
  fs.writeFileSync(path.join(ARTIFACT_DIR, name), JSON.stringify(value, null, 2), 'utf8');
}

function currentRoute(page: Page) {
  try { return new URL(page.url()).pathname; } catch { return 'unknown'; }
}

function requestPath(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return `${url.pathname}${url.search}`.slice(0, 500);
  } catch {
    return rawUrl.slice(0, 500);
  }
}

function attachDiagnostics(
  page: Page,
  diagnostics: Diagnostic[],
  expectedFailure?: (request: Request, errorText: string) => boolean,
) {
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    diagnostics.push({ kind: 'console', route: currentRoute(page), detail: message.text().slice(0, 600) });
  });
  page.on('pageerror', (error) => {
    diagnostics.push({ kind: 'pageerror', route: currentRoute(page), detail: error.message.slice(0, 600) });
  });
  page.on('response', (response) => {
    const status = response.status();
    if (status < 400) return;
    let url: URL;
    try { url = new URL(response.url()); } catch { return; }
    if (url.origin !== productionOrigin) return;
    diagnostics.push({
      kind: 'http',
      route: currentRoute(page),
      detail: `${response.request().method()} ${requestPath(response.url())}`,
      status,
    });
  });
  page.on('requestfailed', (request) => {
    const errorText = request.failure()?.errorText ?? 'request failed';
    if (expectedFailure?.(request, errorText)) return;
    if (isIgnorableProductionRequestFailure(request.url(), request.method(), errorText, productionOrigin)) return;
    diagnostics.push({
      kind: 'requestfailed',
      route: currentRoute(page),
      detail: `${request.method()} ${requestPath(request.url())} ${errorText}`.slice(0, 600),
    });
  });
}

async function installSafety(page: Page, diagnostics: Diagnostic[]) {
  await installProductionReadOnlyPolicy(page, productionOrigin, (request, reason) => {
    diagnostics.push({
      kind: 'blocked-mutation',
      route: currentRoute(page),
      detail: `${reason}: ${request.method()} ${requestPath(request.url())}`.slice(0, 600),
    });
  });
}

async function login(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await expect(page.getByTestId('page-fallback')).toHaveCount(0, { timeout: 10_000 });
  await page.getByLabel('아이디').fill(qaLogin, { timeout: 3_000 });
  await page.getByLabel('비밀번호').fill(qaPassword, { timeout: 3_000 });
  await page.getByRole('button', { name: '로그인', exact: true }).click({ timeout: 3_000 });
  await expect(page.getByTestId('membership-label')).toBeVisible({ timeout: 15_000 });
}

async function healthyNavigation(page: Page, route: string) {
  const started = Date.now();
  await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await expect(page.getByTestId('page-fallback')).toHaveCount(0, { timeout: 8_000 });
  await expect(page.locator('body')).toBeVisible();
  return { finalUrl: page.url(), durationMs: Date.now() - started };
}

async function screenshotGenericFailure(page: Page, testId: string, name: string) {
  const target = page.getByTestId(testId);
  if (!(await target.isVisible({ timeout: 1_000 }).catch(() => false))) return;
  await target.screenshot({
    path: path.join(ARTIFACT_DIR, `${safeSlug(name)}.png`),
    timeout: 4_000,
  }).catch(() => undefined);
}

function researchFailureBody(code: string) {
  return JSON.stringify({ error: code, message: code });
}

async function fulfillResearchFailure(route: Route, scenario: string) {
  if (scenario === 'abort') {
    await route.abort('failed');
    return;
  }
  if (scenario === 'null-200') {
    await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    return;
  }
  const statuses: Record<string, number> = {
    'http-401': 401,
    'http-403': 403,
    'http-429': 429,
    'http-500': 500,
    'provider-unavailable': 503,
  };
  const status = statuses[scenario];
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: researchFailureBody(scenario === 'provider-unavailable' ? 'RESEARCH_PROVIDER_UNAVAILABLE' : `INJECTED_${status}`),
  });
}

function searchFixture(query: '005930' | '000660') {
  const item = query === '005930'
    ? { ticker: '005930', koreanName: '삼성전자', englishName: 'Samsung Electronics' }
    : { ticker: '000660', koreanName: 'SK하이닉스', englishName: 'SK hynix' };
  const dataAsOf = '2026-09-05T00:00:00.000Z';
  return {
    ok: true,
    state: 'FULL',
    q: query,
    asset: 'stock',
    market: 'KR',
    results: [{
      id: `KR:${item.ticker}`,
      assetType: 'stock',
      market: 'KR',
      instrumentType: 'stock',
      exchange: 'KRX',
      ticker: item.ticker,
      productCode: item.ticker,
      koreanName: item.koreanName,
      englishName: item.englishName,
      displayName: `${item.koreanName} ${item.ticker}`,
      baseSymbol: item.ticker,
      quoteCurrency: 'KRW',
      matchType: 'ticker',
      active: true,
      provider: 'krx',
      dataAsOf,
    }],
    count: 1,
    dataAsOf,
    stale: false,
    partial: false,
    providers: [{ provider: 'krx', status: 'ok', count: 1, dataAsOf }],
    hiddenMatches: [],
  };
}

async function prepareDomesticSearch(page: Page) {
  await page.goto('/stocks', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await expect(page.getByTestId('unified-asset-search-page')).toBeVisible({ timeout: 10_000 });
  const domestic = page.getByRole('button', { name: '국내', exact: true });
  if (await domestic.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await domestic.click();
    await expect(domestic).toHaveAttribute('aria-pressed', 'true');
  }
  return page.getByRole('combobox', { name: '통합 자산 검색' });
}

test.describe('Production Full Product Browser E2E read-only QA', () => {
  test.skip(!productionQaEnabled, 'Dedicated Production QA credentials and read-only flag are required');

  test('critical user journey survives reload/navigation and fails closed after client session expiry', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'prod-desktop-1440');
    test.setTimeout(4 * 60_000);

    const diagnostics: Diagnostic[] = [];
    const steps: JourneyStep[] = [];
    attachDiagnostics(page, diagnostics);
    await installSafety(page, diagnostics);
    await login(page);
    steps.push({ name: 'login', finalUrl: page.url(), durationMs: 0 });

    const searchStarted = Date.now();
    const input = await prepareDomesticSearch(page);
    await input.fill('005930');
    await expect.poll(async () => {
      if (await page.getByRole('option').count()) return 'result';
      if (await page.getByTestId('unified-search-outcome').isVisible({ timeout: 200 }).catch(() => false)) return 'terminal';
      return 'pending';
    }, { timeout: 6_000, intervals: [100, 200, 400, 800] }).not.toBe('pending');
    const options = await page.getByRole('option').allTextContents();
    expect(options.some((value) => value.replace(/[^0-9]/g, '').includes('005930')), 'search did not return Samsung 005930').toBe(true);
    steps.push({ name: 'stock-search', finalUrl: page.url(), durationMs: Date.now() - searchStarted });

    const chart = await healthyNavigation(page, '/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m');
    await expect(page.getByTestId('unified-analysis-chart')).toBeVisible({ timeout: 12_000 });
    await page.getByTestId('timeframe-15m').click({ timeout: 2_500 });
    await expect(page).toHaveURL(/timeframe=15m/, { timeout: 4_000 });
    steps.push({ name: 'ai-chart', ...chart });

    for (const [name, route] of [
      ['account-integrations', '/account'],
      ['portfolio', '/portfolio'],
      ['paper', '/paper-trading'],
      ['research', '/research-center'],
    ] as const) {
      const navigation = await healthyNavigation(page, route);
      if (route === '/research-center') {
        await expect(page.getByTestId('research-center-page')).toBeVisible({ timeout: 12_000 });
      }
      steps.push({ name, ...navigation });
    }

    const reloadStarted = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 });
    await expect(page.getByTestId('research-center-page')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByTestId('page-fallback')).toHaveCount(0, { timeout: 8_000 });
    steps.push({ name: 'reload', finalUrl: page.url(), durationMs: Date.now() - reloadStarted });

    const navigationBack = await healthyNavigation(page, '/portfolio');
    steps.push({ name: 'route-navigation-after-reload', ...navigationBack });

    const expiryStarted = Date.now();
    await page.context().clearCookies();
    await page.evaluate(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
    });
    await page.goto('/portfolio', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await expect(page).toHaveURL(/\/(?:login|auth)(?:$|[?#])/, { timeout: 15_000 });
    await expect(page.getByRole('button', { name: '로그인', exact: true })).toBeVisible({ timeout: 8_000 });
    steps.push({ name: 'session-expiry-fail-closed', finalUrl: page.url(), durationMs: Date.now() - expiryStarted });

    writeJson(`${safeSlug(testInfo.project.name)}-full-product-journey.json`, {
      project: testInfo.project.name,
      steps,
      diagnostics,
      traceRetention: 'SUPPRESSED_BY_AUTHENTICATED_PRODUCTION_POLICY',
      serverMutation: 0,
      complete: true,
    });

    expect(diagnostics.filter((item) => item.kind === 'blocked-mutation'), 'journey attempted a Production mutation').toEqual([]);
    expect(diagnostics.filter((item) => item.kind === 'pageerror' || item.kind === 'requestfailed'), 'journey browser/runtime failure').toEqual([]);
  });

  test('research failures 401/403/429/500/provider/null/abort fail closed and recover', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'prod-desktop-1440');
    test.setTimeout(5 * 60_000);

    const bootstrapDiagnostics: Diagnostic[] = [];
    await installSafety(page, bootstrapDiagnostics);
    await login(page);

    const results: ResilienceResult[] = [];
    const scenarios = ['http-401', 'http-403', 'http-429', 'http-500', 'provider-unavailable', 'null-200', 'abort'] as const;

    for (const scenario of scenarios) {
      const scenarioPage = await page.context().newPage();
      const diagnostics: Diagnostic[] = [];
      let expectedAborts = 0;
      attachDiagnostics(scenarioPage, diagnostics, (request, errorText) => {
        const expected = scenario === 'abort'
          && new URL(request.url()).pathname === '/api/admin/research/overview'
          && request.method() === 'GET';
        if (expected) expectedAborts += 1;
        return expected || isIgnorableProductionRequestFailure(request.url(), request.method(), errorText, productionOrigin);
      });
      await installSafety(scenarioPage, diagnostics);
      await scenarioPage.route(RESEARCH_OVERVIEW_PATTERN, async (route) => {
        await fulfillResearchFailure(route, scenario);
      });

      await scenarioPage.goto('/research-center', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await expect(scenarioPage.getByTestId('research-error-state')).toBeVisible({ timeout: 25_000 });
      await expect(scenarioPage.getByTestId('page-fallback')).toHaveCount(0, { timeout: 5_000 });
      await screenshotGenericFailure(scenarioPage, 'research-error-state', `research-${scenario}-error-state`);

      const injectedStatuses = diagnostics
        .filter((item) => item.kind === 'http' && item.route === '/research-center')
        .map((item) => item.status)
        .filter((status): status is number => typeof status === 'number');

      await scenarioPage.unroute(RESEARCH_OVERVIEW_PATTERN);
      await scenarioPage.getByRole('button', { name: '다시 확인', exact: true }).click({ timeout: 3_000 });
      await expect(scenarioPage.getByTestId('research-error-state')).toHaveCount(0, { timeout: 20_000 });
      await expect(scenarioPage.getByTestId('research-overview-tab')).toBeVisible({ timeout: 20_000 });

      results.push({ scenario, recovered: true, injectedStatuses, expectedAborts });
      expect(diagnostics.filter((item) => item.kind === 'blocked-mutation'), `${scenario} attempted a Production mutation`).toEqual([]);
      expect(diagnostics.filter((item) => item.kind === 'pageerror' || item.kind === 'requestfailed'), `${scenario} emitted an unhandled browser failure`).toEqual([]);
      await scenarioPage.close();
    }

    writeJson(`${safeSlug(testInfo.project.name)}-research-resilience.json`, {
      project: testInfo.project.name,
      results,
      bootstrapDiagnostics,
      traceRetention: 'SUPPRESSED_BY_AUTHENTICATED_PRODUCTION_POLICY',
      complete: true,
    });
    expect(results).toHaveLength(scenarios.length);
  });

  test('search timeout/race/abort/unmount keeps latest result and recovers without stale overwrite', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'prod-desktop-1440');
    test.setTimeout(2 * 60_000);

    const diagnostics: Diagnostic[] = [];
    const events: Array<Record<string, unknown>> = [];
    let expectedSearchAborts = 0;
    attachDiagnostics(page, diagnostics, (request) => {
      const expected = request.method() === 'GET' && new URL(request.url()).pathname === '/api/search/suggest';
      if (expected) expectedSearchAborts += 1;
      return expected;
    });
    await installSafety(page, diagnostics);
    await login(page);

    const timeoutInput = await prepareDomesticSearch(page);
    await page.route(SEARCH_PATTERN, async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('q') !== '005930') {
        await route.continue();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5_200));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(searchFixture('005930')) }).catch(() => undefined);
    });
    await timeoutInput.fill('005930');
    await expect(page.getByTestId('unified-search-outcome')).toContainText('DATA_UNAVAILABLE', { timeout: 8_000 });
    await screenshotGenericFailure(page, 'unified-search-outcome', 'search-timeout-error-state');
    events.push({ scenario: 'timeout', terminal: 'DATA_UNAVAILABLE', expectedSearchAborts });

    await page.unroute(SEARCH_PATTERN);
    await page.getByRole('button', { name: '재시도', exact: true }).click({ timeout: 3_000 });
    await expect.poll(async () => await page.getByRole('option').count(), { timeout: 7_000 }).toBeGreaterThan(0);
    events.push({ scenario: 'timeout-recovery', optionCount: await page.getByRole('option').count() });

    const raceInput = await prepareDomesticSearch(page);
    await page.route(SEARCH_PATTERN, async (route) => {
      const url = new URL(route.request().url());
      const q = url.searchParams.get('q');
      if (q !== '005930' && q !== '000660') {
        await route.continue();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, q === '005930' ? 900 : 50));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(searchFixture(q)),
      }).catch(() => undefined);
    });

    await raceInput.fill('005930');
    await page.waitForTimeout(260);
    await raceInput.fill('000660');
    await expect.poll(async () => (await page.getByRole('option').allTextContents()).join(' '), {
      timeout: 5_000,
      intervals: [100, 200, 400],
    }).toContain('000660');
    const finalOptions = (await page.getByRole('option').allTextContents()).join(' ');
    expect(finalOptions, 'older 005930 response overwrote the newer 000660 query').not.toContain('005930');
    events.push({ scenario: 'stale-race', finalQuery: '000660', staleOverwrite: false });

    await raceInput.fill('005930');
    await page.waitForTimeout(260);
    await page.goto('/portfolio', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await expect(page.getByTestId('page-fallback')).toHaveCount(0, { timeout: 8_000 });
    await page.waitForTimeout(1_000);
    events.push({ scenario: 'unmount-abort', finalUrl: page.url(), expectedSearchAborts });
    await page.unroute(SEARCH_PATTERN);

    writeJson(`${safeSlug(testInfo.project.name)}-search-resilience.json`, {
      project: testInfo.project.name,
      events,
      diagnostics,
      traceRetention: 'SUPPRESSED_BY_AUTHENTICATED_PRODUCTION_POLICY',
      complete: true,
    });

    expect(diagnostics.filter((item) => item.kind === 'blocked-mutation'), 'search resilience attempted a Production mutation').toEqual([]);
    expect(diagnostics.filter((item) => item.kind === 'pageerror' || item.kind === 'requestfailed'), 'search resilience emitted an unhandled browser failure').toEqual([]);
    expect(expectedSearchAborts, 'timeout/race/unmount did not exercise any browser abort').toBeGreaterThan(0);
  });
});
