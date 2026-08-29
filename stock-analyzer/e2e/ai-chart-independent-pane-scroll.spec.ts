import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const chartUrl = '/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m&strategyMode=SCALPING';
const paneSelector = 'div:has(> header h1[aria-label="AI 차트 생중계 · AI 차트 2.0"])';

const cssSource = fs.readFileSync(path.resolve(process.cwd(), 'public/ai-chart-pane-scroll.css'), 'utf8');
const indexSource = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');

function candleRows() {
  const end = Date.now() - 5 * 60_000;
  return Array.from({ length: 120 }, (_, index) => {
    const base = 70_000 + index * 15;
    return {
      time: new Date(end - (119 - index) * 5 * 60_000).toISOString(),
      open: base - 10,
      high: base + 75,
      low: base - 70,
      close: base + 25,
      volume: 1_000 + index * 20,
      isClosed: true,
    };
  });
}

async function installMocks(context: BrowserContext) {
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());

    if (/\/api\/stocks\/[^/]+\/(?:chart|candles)$/.test(url.pathname)) {
      const timeframe = url.searchParams.get('tf') ?? '5m';
      const updatedAt = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ticker: '005930',
          timeframe,
          provider: 'ai-chart-independent-scroll-test',
          fetchedAt: updatedAt,
          updatedAt,
          candles: candleRows(),
        }),
      });
      return;
    }

    if (url.pathname === '/api/quotes') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ quotes: [] }),
      });
      return;
    }

    await route.continue();
  });
}

async function scrollTop(locator: ReturnType<Page['locator']>) {
  return locator.evaluate((node) => (node as HTMLElement).scrollTop);
}

async function visibleRange(page: Page) {
  const value = await page.getByTestId('unified-chart-wrapper').getAttribute('data-visible-logical-range');
  expect(value).toBeTruthy();
  return String(value);
}

test('AI Chart desktop pane geometry is loaded without changing mobile source layout', () => {
  expect(indexSource).toContain('<link rel="stylesheet" href="/ai-chart-pane-scroll.css" />');
  expect(cssSource).toContain('@media (min-width: 1024px)');
  expect(cssSource).toContain('overflow: hidden !important');
  expect(cssSource).toContain('overflow-y: auto');
  expect(cssSource).toContain('overscroll-behavior: contain');
  expect(cssSource).toContain('> main.mx-auto.grid.max-w-7xl > section');
  expect(cssSource).toContain('> main.mx-auto.grid.max-w-7xl > aside');
  expect(cssSource).toContain('section:has([data-testid="unified-chart-canvas"]:hover)');
});

test('desktop chart wheel interaction and analysis scrolling are independent while navigation stays fixed', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 620 });
  await installMocks(context);
  await page.goto(chartUrl);

  const shell = page.locator(paneSelector).first();
  const workspace = shell.locator(':scope > main.mx-auto.grid.max-w-7xl');
  const chartPane = workspace.locator(':scope > section');
  const analysisPane = workspace.locator(':scope > aside');
  const canvas = page.getByTestId('unified-chart-canvas');
  const nav = page.getByRole('navigation', { name: '주요 메뉴' });

  await expect(shell).toBeVisible();
  await expect(workspace).toBeVisible();
  await expect(chartPane).toBeVisible();
  await expect(analysisPane).toBeVisible();
  await expect(canvas).toBeVisible();
  await expect(nav).toBeVisible();

  expect(await shell.evaluate((node) => getComputedStyle(node).overflowY)).toBe('hidden');
  expect(await workspace.evaluate((node) => getComputedStyle(node).overflowY)).toBe('hidden');
  expect(await chartPane.evaluate((node) => getComputedStyle(node).overflowY)).toBe('auto');
  expect(await analysisPane.evaluate((node) => getComputedStyle(node).overflowY)).toBe('auto');
  expect(await chartPane.evaluate((node) => node.scrollHeight > node.clientHeight + 1)).toBe(true);
  expect(await analysisPane.evaluate((node) => node.scrollHeight > node.clientHeight + 1)).toBe(true);

  const navBefore = await nav.boundingBox();
  expect(navBefore).not.toBeNull();

  await canvas.scrollIntoViewIfNeeded();
  const chartScrollBeforeZoom = await scrollTop(chartPane);
  const rangeBefore = await visibleRange(page);
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width * 0.58;
  const y = box!.y + box!.height * 0.55;
  await page.mouse.move(x, y);
  await expect.poll(() => chartPane.evaluate((node) => getComputedStyle(node).overflowY)).toBe('hidden');
  await page.mouse.wheel(0, -420);
  await expect.poll(() => visibleRange(page)).not.toBe(rangeBefore);
  expect(await scrollTop(chartPane)).toBe(chartScrollBeforeZoom);
  expect(await scrollTop(analysisPane)).toBe(0);

  await analysisPane.hover({ position: { x: 120, y: 160 } });
  await expect.poll(() => chartPane.evaluate((node) => getComputedStyle(node).overflowY)).toBe('auto');
  const chartScrollBeforeAnalysis = await scrollTop(chartPane);
  await page.mouse.wheel(0, 700);
  await expect.poll(() => scrollTop(analysisPane)).toBeGreaterThan(0);
  expect(await scrollTop(chartPane)).toBe(chartScrollBeforeAnalysis);

  const navAfter = await nav.boundingBox();
  expect(navAfter).not.toBeNull();
  expect(Math.abs(navAfter!.y - navBefore!.y)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('mobile AI Chart keeps its existing single-page tab scroll contract', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMocks(context);
  await page.goto(chartUrl);

  const shell = page.locator(paneSelector).first();
  await expect(shell).toBeVisible();
  expect(await shell.evaluate((node) => getComputedStyle(node).overflowY)).toBe('auto');
  await expect(page.getByRole('tab', { name: '차트', exact: true })).toBeVisible();

  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
});
