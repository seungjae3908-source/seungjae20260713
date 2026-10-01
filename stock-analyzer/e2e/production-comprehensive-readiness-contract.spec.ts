import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

test('Production route audit keeps the authenticated document mounted during strict route checks', () => {
  const app = source('src/App.tsx');
  const qa = source('e2e/production-comprehensive-readonly-qa.spec.ts');
  const navigationStart = qa.indexOf('async function navigateInMountedApp');
  const auditStart = qa.indexOf('async function auditRoute');
  const auditEnd = qa.indexOf('async function ensureSearchPage', auditStart);
  const navigation = qa.slice(navigationStart, auditStart);
  const auditRoute = qa.slice(auditStart, auditEnd);
  const shellCheck = auditRoute.indexOf("page.getByTestId('app-shell').isVisible");
  const busyCheck = auditRoute.indexOf("page.locator('[aria-busy=\"true\"]:visible').count", shellCheck);

  expect(app).toContain('data-testid="app-shell"');
  expect(navigationStart).toBeGreaterThanOrEqual(0);
  expect(auditStart).toBeGreaterThanOrEqual(0);
  expect(auditEnd).toBeGreaterThan(auditStart);
  expect(navigation).toContain("expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 1_000 })");
  expect(navigation).toContain("window.history.pushState({}, '', path)");
  expect(navigation).toContain("window.dispatchEvent(new PopStateEvent('popstate'");
  expect(navigation).toContain('current.pathname === target.pathname');
  expect(navigation).toContain('transition(intermediatePath)');
  expect(navigation).toContain('window.requestAnimationFrame');
  expect(navigation).toContain('transition(nextPath)');
  expect(navigation).toContain("{ timeout: 1_000, intervals: [50, 100, 200] }).toBe(targetPath)");
  expect(shellCheck).toBeGreaterThan(0);
  expect(busyCheck).toBeGreaterThan(shellCheck);
  expect(auditRoute).toContain("{ timeout: 5_000, intervals: [100, 200, 400, 800] }).toBe('READY')");
  expect(auditRoute).toContain('await navigateInMountedApp(page, route)');
  expect(auditRoute).not.toContain('page.goto(route');
  expect(qa).toContain('const LOGIN_READY_BUDGET_MS = 15_000;');
  expect(qa).toContain('const LOGIN_NAVIGATION_TIMEOUT_RETRIES = 1;');
  expect(qa).toContain('const LOGIN_INTERACTIVE_COLD_RETRIES = 1;');
  expect(qa).toContain('const CACHED_AUTH_TIMEOUT_RETRIES = 1;');
  const timeoutHelperStart = qa.indexOf('function isPlaywrightTimeout');
  const navigationRetryStart = qa.indexOf('async function gotoLoginWithTimeoutRetry');
  const validateCachedAuthStart = qa.indexOf('async function validateCachedAuthState');
  const loginStart = qa.indexOf('async function login(');
  const timeoutHelper = qa.slice(timeoutHelperStart, navigationRetryStart);
  const loginNavigation = qa.slice(navigationRetryStart, qa.indexOf('async function restoreCachedAuthState'));
  const validateCachedAuth = qa.slice(validateCachedAuthStart, loginStart);
  const login = qa.slice(loginStart, qa.indexOf('async function auditLayout'));
  expect(login.match(/page\.goto\(/g)).toBeNull();
  expect(login).toContain('await gotoLoginWithTimeoutRetry(page);');
  expect(loginNavigation).toContain("page.goto('/login', { waitUntil: 'commit', timeout: LOGIN_READY_BUDGET_MS })");
  expect(loginNavigation).toContain('attempt >= LOGIN_NAVIGATION_TIMEOUT_RETRIES');
  expect(loginNavigation).toContain('isPlaywrightTimeout(error)');
  expect(timeoutHelper).toContain("error.name === 'TimeoutError'");
  expect(timeoutHelper).toContain('/Timeout \\d+ms exceeded/i.test(error.message)');
  expect(login).toContain('await validateCachedAuthState(page, cached);');
  expect(validateCachedAuthStart).toBeGreaterThanOrEqual(0);
  expect(loginStart).toBeGreaterThan(validateCachedAuthStart);
  expect(validateCachedAuth).toContain("page.request.get(new URL('/api/auth/profile', baseUrl).toString()");
  expect(validateCachedAuth).toContain('Authorization: `Bearer ${token}`');
  expect(validateCachedAuth).toContain('const timeoutOnly = isPlaywrightTimeout(error);');
  expect(validateCachedAuth).toContain('attempt >= CACHED_AUTH_TIMEOUT_RETRIES');
  expect(validateCachedAuth).toContain('if (response.status() !== 200)');
  expect(validateCachedAuth).toContain('PRODUCTION_QA_CACHED_SESSION_PROFILE_INVALID');
  expect(login).toContain('Math.max(1, LOGIN_READY_BUDGET_MS - (Date.now() - readinessStartedAt))');
  expect(login).toContain('attempt <= LOGIN_INTERACTIVE_COLD_RETRIES');
  expect(login).toContain("currentPath(page) === '/login'");
  expect(login).toContain('diagnostics.length === diagnosticStart');
  expect(login).toContain('blocked.length === blockedStart');
  expect(login).toContain('attempt >= LOGIN_INTERACTIVE_COLD_RETRIES');
  expect(login).toContain("page.getByLabel('아이디')");
  expect(login).toContain("page.getByLabel('비밀번호')");
  expect(login).toContain("page.getByTestId('page-fallback').isVisible");
  expect(login).toContain("}).toBe('READY')");
  expect(login).not.toContain('timeout: 10_000');
  expect(qa).toContain('const authStateByViewport = new Map<string, CachedAuthState>();');
  expect(login).toContain('const cached = authStateByViewport.get(cacheKey);');
  expect(login).toContain('await restoreCachedAuthState(page, cached);');
  expect(login).not.toContain("await page.goto('/', { waitUntil: 'commit', timeout: LOGIN_READY_BUDGET_MS })");
  expect(validateCachedAuth).toContain("throw new Error(`PRODUCTION_QA_CACHED_SESSION_PROFILE_${response.status()}`)");
  expect(login).toContain('const state = await page.context().storageState();');
  expect(login).toContain('authStateByViewport.set(cacheKey, state);');
  const cachedBranch = login.slice(login.indexOf('if (cached) {'), login.indexOf('const loginId'));
  expect(cachedBranch).not.toContain('loginButton.click');
  expect(cachedBranch).not.toContain('loginPassword.fill');
  expect(cachedBranch).not.toContain('page.context().storageState()');
  expect(cachedBranch).toContain('The new page is still about:blank here.');
  expect(auditRoute).not.toContain("expect(page.getByTestId('page-fallback')).toHaveCount(0");
  expect(qa).toContain("expect(audits.filter((item) => item.busyAfter5s > 0)");
});

test('Production chart audit waits for the matching settled query before accepting terminal UI', () => {
  const chart = source('src/components/unified-analysis-chart.tsx');
  const qa = source('e2e/production-comprehensive-readonly-qa.spec.ts');
  const marketData = source('../api-server/src/services/market-data.base.service.ts');
  const matrixStart = qa.indexOf('async function chartMatrix');
  const matrixEnd = qa.indexOf("test.describe('Production comprehensive read-only QA'", matrixStart);
  const matrix = qa.slice(matrixStart, matrixEnd);
  const bootstrapAttach = matrix.indexOf("page.on('response', bootstrapListener)");
  const initialNavigation = matrix.indexOf("page.goto('/ai-chart?");
  const bootstrapDetach = matrix.indexOf("page.off('response', bootstrapListener)");
  const seededStatuses = matrix.indexOf('bootstrapStatuses.get(`${market}:${timeframe}`)');
  const responseGate = matrix.indexOf("if (statuses.length === 0 || queryFetching === 'true') return 'timeout'");
  const terminalCheck = matrix.indexOf("page.getByTestId('unified-chart-canvas').isVisible", responseGate);

  expect(chart).toContain('data-chart-market={market}');
  expect(chart).toContain('data-chart-timeframe={timeframe}');
  expect(chart).toContain("data-chart-query-fetching={chartQuery.isFetching ? 'true' : 'false'}");
  expect(chart).toContain("data-chart-data-market={chartQuery.data?.market ?? ''}");
  expect(chart).toContain("data-chart-data-timeframe={chartQuery.data?.timeframe ?? ''}");
  expect(matrixStart).toBeGreaterThanOrEqual(0);
  expect(matrixEnd).toBeGreaterThan(matrixStart);
  expect(bootstrapAttach).toBeGreaterThan(0);
  expect(initialNavigation).toBeGreaterThan(bootstrapAttach);
  expect(bootstrapDetach).toBeGreaterThan(initialNavigation);
  expect(seededStatuses).toBeGreaterThan(bootstrapDetach);
  expect(responseGate).toBeGreaterThan(0);
  expect(terminalCheck).toBeGreaterThan(responseGate);
  expect(matrix).toContain("selectedMarket !== market || selectedTimeframe !== timeframe");
  expect(matrix).toContain("dataMarket !== market || dataTimeframe !== timeframe");
  expect(matrix).toContain("{ timeout: 8_500, intervals: [100, 250, 500, 1_000] }");
  expect(marketData).toContain("const oneMinuteDisk = await readCandleDiskCache(ticker, '1m')");
  expect(marketData).toContain('aggregateOneMinuteCandles(oneMinuteDisk.candles, derivationSize)');
  expect(marketData).toContain('void cached(cacheKey, candleCacheTtl(timeframeText), load)');
});

test('Production search audit records one settled HTTP request at every configured viewport', () => {
  const qa = source('e2e/production-comprehensive-readonly-qa.spec.ts');
  const config = source('playwright.production-comprehensive.config.ts');
  const searchTestStart = qa.indexOf("test('Production market search matrix uses real UI and dozens of symbols'");
  const searchTestEnd = qa.indexOf("test('Production chart matrix", searchTestStart);
  const searchTest = qa.slice(searchTestStart, searchTestEnd);

  expect(searchTestStart).toBeGreaterThanOrEqual(0);
  expect(searchTestEnd).toBeGreaterThan(searchTestStart);
  expect(searchTest).not.toContain('test.skip(');
  expect(searchTest).toContain("testInfo.project.name === 'prod-desktop-1440'");
  expect(searchTest).toContain("testInfo.project.name === 'prod-mobile-390'");
  expect(searchTest).toContain("item.requests.length !== 1");
  expect(searchTest).toContain("request.status !== 200 || request.failure");
  expect(searchTest).toContain("request.market !== SEARCH_MARKET_PARAMS[item.market]");
  expect(searchTest).toContain("request.startedAfterInputMs < 150 || request.startedAfterInputMs > 1_000");
  expect(searchTest).toContain("item.kind === 'console' || item.kind === 'pageerror' || item.kind === 'requestfailed'");
  expect(searchTest).toContain("item.status === 401 || item.status === 403 || (item.status ?? 0) >= 500");
  expect(qa).toContain("url.pathname !== '/api/search/suggest' || url.searchParams.get('q') !== query");
  expect(qa).toContain('startedAfterInputMs: Date.now() - started');
  expect(qa).toContain('record.responseLatencyMs = Date.now() - (requestStartedAt.get(request) ?? Date.now())');
  for (const width of [1920, 1440, 1024, 800, 430, 390, 360, 320]) {
    expect(config).toContain(`width: ${width}`);
  }
});

test('Production read-only suites share the bounded cold login contract', () => {
  const loginSupport = source('e2e/support/production-readonly-login.ts');
  const consumers = [
    'e2e/production-critical-http-readonly-qa.spec.ts',
    'e2e/production-mobile-scroll-readonly-qa.spec.ts',
    'e2e/production-performance-readonly-qa.spec.ts',
    'e2e/production-research-center-readonly-qa.spec.ts',
    'e2e/production-account-readonly-live-qa.spec.ts',
  ];
  expect(loginSupport).toContain('const LOGIN_READY_BUDGET_MS = 15_000;');
  expect(loginSupport).toContain('const LOGIN_NAVIGATION_TIMEOUT_RETRIES = 1;');
  expect(loginSupport).toContain('const LOGIN_INTERACTIVE_COLD_RETRIES = 1;');
  expect(loginSupport).toContain("page.goto('/login', { waitUntil: 'commit', timeout: LOGIN_READY_BUDGET_MS })");
  expect(loginSupport).toContain('if (!isPlaywrightTimeout(error) || attempt >= LOGIN_NAVIGATION_TIMEOUT_RETRIES) throw error;');
  expect(loginSupport).toContain("page.getByLabel('아이디')");
  expect(loginSupport).toContain("page.getByLabel('비밀번호')");
  expect(loginSupport).toContain("page.getByTestId('page-fallback').isVisible");
  expect(loginSupport).toContain("new URL(page.url()).pathname === '/login'");
  expect(loginSupport).toContain('attempt >= LOGIN_INTERACTIVE_COLD_RETRIES');
  expect(loginSupport).toContain("}).toBe('READY')");
  for (const consumer of consumers) {
    const qa = source(consumer);
    const wrapperStart = qa.indexOf('async function login(');
    const wrapper = qa.slice(wrapperStart, qa.indexOf('\n}', wrapperStart) + 2);
    expect(qa).toContain("import { loginProductionReadOnly } from './support/production-readonly-login';");
    expect(wrapperStart).toBeGreaterThanOrEqual(0);
    expect(wrapper).toContain('await loginProductionReadOnly(page, { login: qaLogin, password: qaPassword });');
    expect(wrapper).not.toContain('page.goto');
  }
});

test('Production cold-route modules settle before primary market data prewarm without competing with direct AI Chart bootstrap', () => {
  const app = source('src/App.tsx');
  const marketInformation = source('src/pages/market-information.tsx');
  const moduleWarmup = app.indexOf('void Promise.allSettled([');
  const marketDataWarmup = app.indexOf("]).then(() => prewarmPrimaryMarketInformation(auth.can('canAccessFutures')))", moduleWarmup);
  expect(moduleWarmup).toBeGreaterThanOrEqual(0);
  expect(marketDataWarmup).toBeGreaterThan(moduleWarmup);
  expect(app).toContain('loadMarketInformationPage()');
  expect(app).toContain('loadWatchlistPage()');
  expect(app).toContain('loadScannerPage()');
  expect(app).toContain('loadPortfolioPage()');
  expect(app).toContain("prewarmPrimaryMarketInformation(auth.can('canAccessFutures'))");
  expect(app).toContain("prefetchMarketInformationRoom(queryClient, '/stocks/kr')");
  expect(app).toContain('if (includeFutures)');
  expect(app).toContain("prefetchMarketInformationRoom(queryClient, '/coins/futures')");
  expect(marketInformation).toContain('export async function prefetchMarketInformationRoom(');
  expect(marketInformation).toContain("queryKey: ['market-information-room', route.id]");
  expect(app).toContain('loadBacktestsPage()');
  expect(app).toContain('loadMorePage()');
  expect(app).toContain('loadStockInfoPage()');
  expect(app).toContain('loadDetailPage()');
  expect(app).toContain('loadTechnicalWorkspacePage()');
  expect(app).toContain('loadSignalScannerPage()');
  expect(app).toContain('loadAiChartPage()');
  expect(app).toContain('loadAiChatPage()');
  expect(app).toContain('loadThemesPage()');
  expect(app).toContain('const directLoginColdRoute');
  expect(app).toContain('void loadAccountPage();');
  expect(app).toContain('loadLearnPage()');
  expect(app).toContain('if (!auth.isApproved || directAiChartColdRoute) return;');
});
