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
  const login = qa.slice(qa.indexOf('async function login('), qa.indexOf('async function auditLayout'));
  const loginNavigation = login.slice(login.indexOf("await page.goto('/login'"), login.indexOf('const loginId'));
  expect(login.match(/page\.goto\(/g)).toHaveLength(2);
  expect(login).toContain("page.goto('/login', { waitUntil: 'commit', timeout: remainingReadinessMs() })");
  expect(login).toContain('Math.max(1, LOGIN_READY_BUDGET_MS - (Date.now() - readinessStartedAt))');
  expect(login).toContain("page.getByLabel('아이디')");
  expect(login).toContain("page.getByLabel('비밀번호')");
  expect(login).toContain("page.getByTestId('page-fallback').isVisible");
  expect(login).toContain("}).toBe('READY')");
  expect(login).not.toContain('timeout: 10_000');
  expect(loginNavigation).not.toContain('catch');
  expect(qa).toContain('const authStateByViewport = new Map<string, CachedAuthState>();');
  expect(login).toContain('const cached = authStateByViewport.get(cacheKey);');
  expect(login).toContain('await restoreCachedAuthState(page, cached);');
  expect(login).toContain("await page.goto('/', { waitUntil: 'commit', timeout: LOGIN_READY_BUDGET_MS })");
  expect(login).toContain('const state = await page.context().storageState();');
  expect(login).toContain('authStateByViewport.set(cacheKey, state);');
  const cachedBranch = login.slice(login.indexOf('if (cached) {'), login.indexOf('// Judge readiness'));
  expect(cachedBranch).not.toContain('loginButton.click');
  expect(cachedBranch).not.toContain('loginPassword.fill');
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
  const responseGate = matrix.indexOf("if (statuses.length === 0 || queryFetching === 'true') return 'timeout'");
  const terminalCheck = matrix.indexOf("page.getByTestId('unified-chart-canvas').isVisible", responseGate);

  expect(chart).toContain('data-chart-market={market}');
  expect(chart).toContain('data-chart-timeframe={timeframe}');
  expect(chart).toContain("data-chart-query-fetching={chartQuery.isFetching ? 'true' : 'false'}");
  expect(chart).toContain("data-chart-data-market={chartQuery.data?.market ?? ''}");
  expect(chart).toContain("data-chart-data-timeframe={chartQuery.data?.timeframe ?? ''}");
  expect(matrixStart).toBeGreaterThanOrEqual(0);
  expect(matrixEnd).toBeGreaterThan(matrixStart);
  expect(responseGate).toBeGreaterThan(0);
  expect(terminalCheck).toBeGreaterThan(responseGate);
  expect(matrix).toContain("selectedMarket !== market || selectedTimeframe !== timeframe");
  expect(matrix).toContain("dataMarket !== market || dataTimeframe !== timeframe");
  expect(matrix).toContain("{ timeout: 8_500, intervals: [100, 250, 500, 1_000] }");
  expect(marketData).toContain("const oneMinuteDisk = await readCandleDiskCache(ticker, '1m')");
  expect(marketData).toContain('aggregateOneMinuteCandles(oneMinuteDisk.candles, derivationSize)');
  expect(marketData).toContain('void cached(cacheKey, candleCacheTtl(timeframeText), load)');
});

test('Production cold-route modules settle before primary market data prewarm without competing with direct AI Chart bootstrap', () => {
  const app = source('src/App.tsx');
  const marketInformation = source('src/pages/market-information.tsx');
  const moduleWarmup = app.indexOf('void Promise.allSettled([');
  const marketDataWarmup = app.indexOf(']).then(() => prewarmPrimaryMarketInformation())', moduleWarmup);
  expect(moduleWarmup).toBeGreaterThanOrEqual(0);
  expect(marketDataWarmup).toBeGreaterThan(moduleWarmup);
  expect(app).toContain('loadMarketInformationPage()');
  expect(app).toContain('loadWatchlistPage()');
  expect(app).toContain('prewarmPrimaryMarketInformation()');
  expect(app).toContain("prefetchMarketInformationRoom(queryClient, '/stocks/kr')");
  expect(marketInformation).toContain('export async function prefetchMarketInformationRoom(');
  expect(marketInformation).toContain("queryKey: ['market-information-room', route.id]");
  expect(app).toContain('loadBacktestsPage()');
  expect(app).toContain('loadMorePage()');
  expect(app).toContain('loadStockInfoPage()');
  expect(app).toContain('loadDetailPage()');
  expect(app).toContain('loadTechnicalWorkspacePage()');
  expect(app).toContain('loadSignalScannerPage()');
  expect(app).toContain('loadAiChartPage()');
  expect(app).toContain('loadLearnPage()');
  expect(app).toContain('if (!auth.isApproved || directAiChartColdRoute) return;');
});