import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test('direct AI Chart prewarm prioritizes the route before app and renderer graphs after the root exists', () => {
  const html = fs
    .readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8')
    .replace(/\r\n?/g, '\n');
  const appEntryImport = "void import('/src/main.tsx');";
  const routePrewarmImport = "void import('/src/pages/ai-chart.tsx');";
  const rendererPrewarmImport = "void import('/src/components/unified-analysis-chart.tsx');";
  const prewarmGuard = "window.location.pathname.endsWith('/ai-chart')";
  const root = '<div id="root"></div>';
  const moduleScripts = html.match(/<script\s+type="module"[^>]*>/g) ?? [];

  expect(html).toContain(prewarmGuard);
  expect(html).toContain(appEntryImport);
  expect(html).toContain(routePrewarmImport);
  expect(html).toContain(rendererPrewarmImport);
  expect(html.match(/import\('\/src\/main\.tsx'\)/g)).toHaveLength(1);
  expect(html.match(/import\('\/src\/pages\/ai-chart\.tsx'\)/g)).toHaveLength(1);
  expect(html.match(/import\('\/src\/components\/unified-analysis-chart\.tsx'\)/g)).toHaveLength(1);
  expect(html).not.toMatch(/rel="modulepreload"[^>]+href="[^"]+\.tsx(?:\?|\")/);
  expect(moduleScripts).toHaveLength(1);
  for (const script of moduleScripts) {
    expect(script, 'the canonical app entry must retain native module defer ordering').not.toMatch(/\sasync(?:\s|>)/);
  }
  expect(html.indexOf(root)).toBeLessThan(html.indexOf(routePrewarmImport));
  expect(html.indexOf(routePrewarmImport)).toBeLessThan(html.indexOf(appEntryImport));
  expect(html.indexOf(appEntryImport)).toBeLessThan(html.indexOf(rendererPrewarmImport));
});

test('direct AI Chart shell does not statically wait for the chart renderer graph', () => {
  const source = fs
    .readFileSync(path.resolve(process.cwd(), 'src/pages/ai-chart.tsx'), 'utf8')
    .replace(/\r\n?/g, '\n');
  const rendererImport = "import('@/components/unified-analysis-chart')";

  expect(source).not.toMatch(/import\s+\{\s*UnifiedAnalysisChart\s*\}\s+from\s+['"]@\/components\/unified-analysis-chart['"]/);
  expect(source.match(/import\(['"]@\/components\/unified-analysis-chart['"]\)/g)).toHaveLength(1);
  expect(source).toContain(`const LazyUnifiedAnalysisChart = lazy(() =>\n  ${rendererImport}`);
  expect(source).toContain('aria-label="AI 차트 생중계 · AI 차트 2.0"');
  expect(source).toContain('data-testid="ai-chart-renderer-loading"');
  expect(source).toContain('<LazyUnifiedAnalysisChart');
  expect(source).not.toMatch(/data-testid=["']unified-chart-canvas["'][\s\S]{0,500}차트 데이터와 렌더러를 준비/);
});

test('direct AI Chart paints its H1 before a delayed prewarmed chart renderer becomes usable', async ({ page }, testInfo) => {
  const candles = Array.from({ length: 80 }, (_, index) => ({
    time: 1_775_000_000 + index * 300,
    open: 80_000 + index,
    high: 80_004 + index,
    low: 79_997 + index,
    close: 80_002 + index,
    volume: 1_000 + index * 10,
    isClosed: index < 79,
  }));
  const chartDataRequests: string[] = [];
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const isChartRequest = /\/api\/stocks\/[^/]+\/chart$/.test(pathname);
    const isPrimaryCandlesRequest = /\/api\/stocks\/[^/]+\/candles$/.test(pathname);
    if (isChartRequest || isPrimaryCandlesRequest) {
      chartDataRequests.push(`${pathname}${url.search}`);
    }
    return route.fulfill({
      status: isPrimaryCandlesRequest ? 404 : 200,
      contentType: 'application/json',
      body: isChartRequest ? JSON.stringify({
        provider: 'cold-shell-fixture',
        fetchedAt: '2026-09-07T00:00:00.000Z',
        updatedAt: '2026-09-07T00:00:00.000Z',
        candles,
      }) : '{}',
    });
  });

  let releaseRenderer = () => {};
  let markRendererRequested = () => {};
  let rendererRequestCount = 0;
  const rendererRelease = new Promise<void>((resolve) => { releaseRenderer = resolve; });
  const rendererRequested = new Promise<void>((resolve) => { markRendererRequested = resolve; });
  await page.route('**/src/components/unified-analysis-chart.tsx*', async (route) => {
    rendererRequestCount += 1;
    markRendererRequested();
    await rendererRelease;
    await route.continue();
  });

  const startedAt = Date.now();
  try {
    await page.goto('/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m', {
      waitUntil: 'domcontentloaded',
    });
    await rendererRequested;
    await expect(page.getByRole('heading', { name: /AI 차트 생중계/, level: 1 })).toBeVisible({ timeout: 5_000 });
    const firstShellMs = Date.now() - startedAt;
    await expect(page.getByTestId('ai-chart-renderer-loading')).toBeVisible();
    await expect(page.getByTestId('unified-chart-canvas')).toHaveCount(0);

    const firstRouteChunkMs = await page.evaluate(() => {
      const routeChunk = performance.getEntriesByType('resource')
        .find((entry) => new URL(entry.name).pathname.endsWith('/src/pages/ai-chart.tsx'));
      return routeChunk ? Math.round(routeChunk.responseEnd) : null;
    });
    expect(firstRouteChunkMs, 'missing AI Chart route timing is not zero').not.toBeNull();

    releaseRenderer();
    await expect(page.getByTestId('unified-chart-canvas')).toBeVisible({ timeout: 5_000 });
    const firstUsableChartMs = Date.now() - startedAt;
    expect(rendererRequestCount, 'document prewarm and React.lazy must share one renderer request').toBe(1);
    expect(chartDataRequests, 'cold prefetch and mounted query must share one exact data chain').toEqual([
      '/api/stocks/005930/candles?tf=5m',
      '/api/stocks/005930/chart?tf=5m',
    ]);
    const timing = {
      firstShellMs,
      firstRouteChunkMs,
      firstUsableChartMs,
      rendererRequestCount,
      chartDataRequests,
    };
    await testInfo.attach('ai-chart-cold-layer-timing.json', {
      body: Buffer.from(JSON.stringify(timing, null, 2)),
      contentType: 'application/json',
    });
    expect(firstShellMs).toBeLessThanOrEqual(5_000);
    expect(firstUsableChartMs).toBeLessThanOrEqual(5_000);
  } finally {
    releaseRenderer();
  }
});
