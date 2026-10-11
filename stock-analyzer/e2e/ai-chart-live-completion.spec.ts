import { expect, test, type Page } from '@playwright/test';

const chartUrl = '/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m&strategyMode=SCALPING';

async function setup(page: Page) {
  const end = Math.floor(Date.now() / 300_000) * 300 - 600;
  const fixture = { end, status: 200, extraBars: 0, ageSeconds: 0, requests: 0 };
  const pageErrors: string[] = [];
  const orderWrites: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    if (request.method() !== 'GET' && /\/api\/.*(?:orders?|positions?|margin|leverage)/i.test(request.url())) orderWrites.push(request.url());
  });
  await page.route('https://**', route => route.abort());
  await page.route('**/api/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/stocks/*/candles**', route => {
    fixture.requests += 1;
    const url = new URL(route.request().url());
    const ticker = decodeURIComponent(url.pathname.split('/').at(-2)!);
    const timeframe = url.searchParams.get('tf') ?? '5m';
    const interval = timeframe === '15m' ? 900 : 300;
    const last = fixture.end + fixture.extraBars * 300 - fixture.ageSeconds;
    return route.fulfill({ status: fixture.status, contentType: 'application/json', body: JSON.stringify(fixture.status === 200 ? {
      ticker, timeframe, provider: `TEST_ONLY_${ticker}_${timeframe}`,
      // A fresh HTTP fetch must not disguise the source candle's age.
      updatedAt: new Date().toISOString(),
      candles: Array.from({ length: 90 + fixture.extraBars }, (_, i) => {
        const time = last - (89 + fixture.extraBars - i) * interval;
        return { time, sourceTime: new Date(time * 1000).toISOString(), open: 70000, high: 70500, low: 69500, close: 70000, volume: 1000, isClosed: true };
      }),
    } : { error: 'TEST_ONLY_PROVIDER_UNAVAILABLE' }) });
  });
  return { fixture, pageErrors, orderWrites };
}

async function ready(page: Page) {
  await page.goto(chartUrl);
  await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();
  const feed = page.getByTestId('ai-chart-live-feed');
  await expect(feed.locator('[data-event-kind="analysis"]')).toHaveCount(1);
  return feed;
}

async function refresh(page: Page, fixture: { requests: number }) {
  const previous = fixture.requests;
  await page.getByRole('button', { name: '차트 새로고침', exact: true }).click();
  await expect.poll(() => fixture.requests).toBeGreaterThan(previous);
  await expect(page.locator('[data-chart-query-fetching]')).toHaveAttribute('data-chart-query-fetching', 'false');
}

test('live judgment exposes provenance, conditions and source time without inventing a new bar or LLM', async ({ page }) => {
  const { fixture, pageErrors, orderWrites } = await setup(page);
  const feed = await ready(page);
  await expect(feed).toContainText('규칙 기반 기술분석 · LLM 해설 아님 · 주문 실행 없음');
  await expect(feed).toContainText('TEST_ONLY_005930_5m · REST 주기 조회');
  await expect(feed.locator('[data-event-kind="analysis"]')).toContainText('확인 조건');
  await expect(feed.locator('[data-event-kind="analysis"]')).toContainText('무효화 조건');
  await expect(feed.locator('[data-event-kind="bar"]')).toHaveCount(0);
  // Browser ICU data can differ from Node ICU data on Windows/Linux. Compare
  // the same source timestamp and Korean timezone using the display runtime.
  const sourceTime = await page.evaluate(end => new Date(end * 1000).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }), fixture.end);
  await expect(feed.getByTestId('chart-live-data-asof')).toContainText(sourceTime);
  await refresh(page, fixture);
  await expect(feed.locator('[data-event-kind="analysis"]')).toHaveCount(1);
  await expect(feed.locator('[data-event-kind="bar"]')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  expect(orderWrites).toEqual([]);
});

test('pause freezes only the displayed log; completed bars collect and filters/clear work', async ({ page }) => {
  const { fixture, pageErrors, orderWrites } = await setup(page);
  const feed = await ready(page);
  await feed.getByRole('button', { name: '일시정지', exact: true }).click();
  await expect(feed).toContainText('차트와 데이터 갱신은 계속됩니다');
  fixture.extraBars = 1;
  await refresh(page, fixture);
  await expect(feed.locator('[data-event-kind="bar"]')).toHaveCount(0);
  await feed.getByRole('button', { name: '재개', exact: true }).click();
  await expect(feed.locator('[data-event-kind="bar"]')).toHaveCount(1);
  await expect(feed).toContainText('새 완료봉 · 판단 갱신');
  await feed.getByRole('button', { name: '판단', exact: true }).click();
  // The new completed bar has its own updated judgment, alongside the baseline.
  await expect(feed.locator('[data-event-kind="analysis"]')).toHaveCount(2);
  await expect(feed.locator('[data-event-kind="bar"]')).toHaveCount(0);
  await feed.getByRole('button', { name: '데이터', exact: true }).click();
  await expect(feed.locator('[data-event-kind="analysis"]')).toHaveCount(0);
  await expect(feed.locator('[data-event-kind="data"]').first()).toBeVisible();
  await feed.getByRole('button', { name: '비우기', exact: true }).click();
  await expect(feed.getByTestId('chart-live-event')).toHaveCount(0);
  await refresh(page, fixture);
  await expect(feed.getByTestId('chart-live-event')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  expect(orderWrites).toEqual([]);
});

test('source staleness halts new opinions even with fresh updatedAt; recovery is explicit', async ({ page }) => {
  const { fixture, pageErrors, orderWrites } = await setup(page);
  const feed = await ready(page);
  fixture.ageSeconds = 86_400;
  await refresh(page, fixture);
  await expect(feed.getByTestId('chart-live-halted')).toContainText('오래된 데이터 · 새 판단 중단');
  await expect(feed.locator('[data-event-kind="analysis"]')).toHaveCount(1);
  await expect(feed.locator('[data-event-kind="bar"]')).toHaveCount(0);
  fixture.ageSeconds = 0;
  await refresh(page, fixture);
  await expect(feed.getByTestId('chart-live-halted')).toHaveCount(0);
  await expect(feed.locator('[data-event-kind="data"]').first()).toContainText(/정상|지연/);
  expect(pageErrors).toEqual([]);
  expect(orderWrites).toEqual([]);
});

test('a failed provider refresh clears current judgment and marks old log as historical', async ({ page }) => {
  const { fixture, pageErrors, orderWrites } = await setup(page);
  const feed = await ready(page);
  fixture.status = 503;
  await refresh(page, fixture);
  await expect(page.getByTestId('chart-error-state')).toBeVisible();
  await expect(feed.getByTestId('chart-live-halted')).toContainText('연결 오류 · 새 판단 중단');
  await expect(page.getByTestId('ai-chart-mobile-judgment')).toContainText('유효한 시세 확인 중');
  await expect(feed.locator('[data-event-kind="analysis"]')).toHaveCount(1);
  fixture.status = 200;
  await page.getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();
  await expect(feed.getByTestId('chart-live-halted')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  expect(orderWrites).toEqual([]);
});

test('symbol and timeframe changes never retain another selection’s live record', async ({ page }) => {
  const { pageErrors, orderWrites } = await setup(page);
  const feed = await ready(page);
  await page.getByRole('textbox', { name: '차트 종목 심볼', exact: true }).fill('000660');
  await page.getByTestId('apply-chart-symbol').click();
  await expect(feed).toContainText('TEST_ONLY_000660_5m');
  await expect(feed).not.toContainText('TEST_ONLY_005930_5m');
  await expect(feed.locator('[data-event-kind="analysis"]')).toHaveCount(1);
  await page.getByTestId('timeframe-15m').click();
  await expect(feed).toContainText('TEST_ONLY_000660_15m');
  await expect(feed).not.toContainText('TEST_ONLY_000660_5m');
  await expect(feed.locator('[data-event-kind="analysis"]')).toHaveCount(1);
  expect(pageErrors).toEqual([]);
  expect(orderWrites).toEqual([]);
});

for (const width of [320, 390, 430, 768, 820, 1440]) {
  test(`live feed ${width}px retains readable controls without document overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    const { pageErrors, orderWrites } = await setup(page);
    await page.goto(chartUrl);
    await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();
    if (width < 1024) await page.getByRole('tab', { name: 'AI 생중계', exact: true }).click();
    const feed = page.getByTestId('ai-chart-live-feed');
    await expect(feed).toBeVisible();
    await expect(feed.locator('[data-event-kind="analysis"]')).toHaveCount(1);
    const controls = await feed.getByRole('button').evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect(); return { height: box.height, left: box.left, right: box.right };
    }));
    expect(controls.every(box => box.height >= 44 && box.left >= 0 && box.right <= width)).toBe(true);
    const overflow = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, root: document.documentElement.scrollWidth }));
    expect(overflow.body).toBeLessThanOrEqual(overflow.viewport);
    expect(overflow.root).toBeLessThanOrEqual(overflow.viewport);
    if (width === 390 || width === 1440) await page.screenshot({ path: `test-results/chart-live-${width}.png`, fullPage: true });
    expect(pageErrors).toEqual([]);
    expect(orderWrites).toEqual([]);
  });
}
