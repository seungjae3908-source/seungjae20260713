import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  aggregateMultiTimeframe,
  buildTechnicalTimeframeEvidence,
  mapPricePlan,
  signalLifecycleFromAnalysis,
  strategyModeTimeframes,
  type AiChartTimeframeEvidence,
} from '../src/lib/ai-chart-v2-intelligence';

const chartUrl = '/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m&strategyMode=SCALPING';

function candleRows(timeframe: string) {
  const stepMinutes = timeframe === '1m' ? 1 : timeframe === '3m' ? 3 : timeframe === '5m' ? 5 : timeframe === '15m' ? 15 : 60;
  const end = Date.now() - stepMinutes * 60_000;
  return Array.from({ length: 90 }, (_, index) => {
    const base = 70_000 + index * 20;
    return {
      time: new Date(end - (89 - index) * stepMinutes * 60_000).toISOString(),
      open: base - 10,
      high: base + 80,
      low: base - 80,
      close: base + 30,
      volume: 1_000 + index * 25,
      isClosed: true,
    };
  });
}

async function installMocks(
  context: BrowserContext,
  options: { ageMs?: number; unavailable?: boolean } = {},
) {
  const calls = new Map<string, number>();
  const privateTradingRequests: string[] = [];
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (/\/(orders?|cancel|balances?|positions?)(?:\/|\?|$)/i.test(url.pathname) && request.method() !== 'GET') {
      privateTradingRequests.push(`${request.method()} ${url.pathname}`);
    }
    if (/\/api\/stocks\/[^/]+\/(?:chart|candles)$/.test(url.pathname)) {
      const timeframe = url.searchParams.get('tf') ?? '5m';
      calls.set(timeframe, (calls.get(timeframe) ?? 0) + 1);
      if (options.unavailable) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'provider unavailable' }),
        });
        return;
      }
      const updatedAt = new Date(Date.now() - (options.ageMs ?? 0)).toISOString();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ticker: '005930',
          timeframe,
          provider: `ai-chart-v2-${timeframe}`,
          fetchedAt: updatedAt,
          updatedAt,
          candles: candleRows(timeframe),
        }),
      });
      return;
    }
    if (url.pathname === '/api/quotes') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ quotes: [] }) });
      return;
    }
    await route.continue();
  });
  return { calls, privateTradingRequests };
}

function totalChartCalls(calls: Map<string, number>): number {
  return [...calls.values()].reduce((total, count) => total + count, 0);
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test('AI Chart 2.0 domain helpers preserve lifecycle, price-plan gaps, and higher-timeframe conflicts', () => {
  expect(signalLifecycleFromAnalysis('invalidated')).toBe('INVALIDATED');
  expect(signalLifecycleFromAnalysis('expired')).toBe('EXPIRED');
  expect(strategyModeTimeframes('SCALPING')).toEqual(['1m', '3m', '5m', '15m']);
  expect(mapPricePlan({
    entryZone: { from: 100, to: 102 },
    stopLoss: 95,
    invalidation: 94,
    targets: [110, 115],
    riskReward: 2,
  }).entries).toEqual([100, 102, null]);

  const evidence = buildTechnicalTimeframeEvidence({
    market: 'BITGET',
    mode: 'SCALPING',
    timeframe: '5m',
    dataStatus: 'ok',
    candleCount: 90,
    trend: 'bullish',
    close: 100,
    ema12: 101,
    ema26: 99,
    vwap: 98,
    rsi14: 58,
    macdHistogram: 1,
    volumeRatio20: 1.6,
    atr14: 1,
  });
  expect(evidence.side).toBe('LONG');

  const staleEvidence = buildTechnicalTimeframeEvidence({
    market: 'KR',
    mode: 'SCALPING',
    timeframe: '5m',
    dataStatus: 'stale',
    candleCount: 90,
    trend: 'bullish',
    close: 100,
    ema12: 101,
    ema26: 99,
    vwap: 98,
    rsi14: 58,
    macdHistogram: 1,
    volumeRatio20: 1.6,
    atr14: 1,
  });
  expect(staleEvidence.state).toBe('INSUFFICIENT_DATA');
  expect(staleEvidence.side).toBe('WAIT');
  expect(staleEvidence.score).toBeNull();
  expect(staleEvidence.quality).toBe('STALE');

  const context = (timeframe: AiChartTimeframeEvidence['timeframe'], side: AiChartTimeframeEvidence['side']): AiChartTimeframeEvidence => ({
    timeframe,
    state: 'READY',
    side,
    score: 80,
    quality: 'LIVE',
    positiveFactors: [],
    negativeFactors: [],
    riskFactors: [],
    reasonCodes: [],
    source: 'TECHNICAL_EVIDENCE',
  });
  const aggregate = aggregateMultiTimeframe('SWING', [
    context('15m', 'BUY'),
    context('1H', 'BUY'),
    context('4H', 'SELL'),
    context('1D', 'WAIT'),
  ], '15m');
  expect(aggregate.higherTimeframeConflict).toBe(true);
  expect(aggregate.conflictTimeframes).toEqual(['4H']);
});

test('desktop AI Chart 2.0 preserves one initial chart request, loads MTF on demand, and stays read-only', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const mock = await installMocks(context);
  const consoleErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  await page.goto(chartUrl);
  await expect(page.getByTestId('ai-chart-v2-intelligence')).toBeVisible();
  await expect(page.getByTestId('strategy-mode-SCALPING')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('mtf-not-loaded')).toBeVisible();
  await expect.poll(() => totalChartCalls(mock.calls)).toBe(1);

  const overlay = page.getByTestId('ai-chart-v2-signal-overlay');
  const overlayToggle = page.getByTestId('toggle-ai-signal-overlay');
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveAttribute('data-signal-status', /ACTIVE|WEAKENED|INVALIDATED|EXPIRED/);
  await expect(overlay).toHaveAttribute('data-signal-id', 'UNAVAILABLE');
  await overlayToggle.click();
  await expect(overlay).toHaveCount(0);
  await expect(overlayToggle).toHaveAttribute('aria-pressed', 'false');
  await overlayToggle.click();
  await expect(overlay).toBeVisible();
  await expect(overlayToggle).toHaveAttribute('aria-pressed', 'true');

  await page.getByTestId('load-multi-timeframe').click();
  for (const timeframe of ['1m', '3m', '5m', '15m']) {
    await expect(page.getByTestId(`mtf-${timeframe}`)).toBeVisible();
  }
  await expect.poll(() => mock.calls.size).toBeGreaterThanOrEqual(4);

  await expect(page.getByTestId('ai-evidence-panel')).toBeVisible();
  await expect(page.getByTestId('ai-chart-order-plan-preview')).toContainText('ENTRY 3');
  await expect(page.getByTestId('ai-chart-order-plan-preview')).toContainText('UNAVAILABLE');
  await expect(page.getByTestId('ai-chart-data-provenance')).toContainText('Historical Performance');
  await expect(page.getByTestId('ai-chart-data-provenance')).toContainText('UNAVAILABLE');

  await page.getByRole('button', { name: '30분', exact: true }).click();
  await expect(page).toHaveURL(/timeframe=30m/);
  await expect.poll(() => mock.calls.get('30m') ?? 0).toBeGreaterThan(0);
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText('30m');
  await expect(page.getByTestId('mtf-not-loaded')).toBeVisible();
  await expect(page.getByTestId('mtf-30m')).toHaveCount(0);

  await page.getByTestId('strategy-mode-SWING').click();
  await expect(page.getByTestId('strategy-mode-SWING')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('mtf-not-loaded')).toBeVisible();
  await page.getByTestId('load-multi-timeframe').click();
  for (const timeframe of ['15m', '1H', '4H', '1D']) {
    await expect(page.getByTestId(`mtf-${timeframe}`)).toBeVisible();
  }

  expect(mock.privateTradingRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('current AI evidence fails closed on stale shared chart data without duplicate requests', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const mock = await installMocks(context, { ageMs: 60 * 60_000 });
  await page.goto(chartUrl);

  const evidence = page.getByTestId('ai-evidence-panel');
  await expect(evidence).toContainText('WAIT');
  await expect(evidence).toContainText('STALE');
  await expect(page.getByTestId('insufficient-data-evidence')).toBeVisible();
  await expect.poll(() => totalChartCalls(mock.calls)).toBe(1);
  expect(mock.privateTradingRequests).toEqual([]);
});

test('current AI evidence fails closed when the shared chart provider is unavailable', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const mock = await installMocks(context, { unavailable: true });
  await page.goto(chartUrl);

  const evidence = page.getByTestId('ai-evidence-panel');
  await expect(evidence).toContainText('WAIT');
  await expect(evidence).toContainText('UNAVAILABLE');
  await expect(page.getByTestId('insufficient-data-evidence')).toBeVisible();
  await expect.poll(() => totalChartCalls(mock.calls)).toBe(2);
  expect(mock.privateTradingRequests).toEqual([]);
});

test('mobile AI Chart 2.0 keeps chart usable and on-demand MTF inside viewport', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mock = await installMocks(context);
  await page.goto(chartUrl);

  await expect(page.getByTestId('unified-analysis-chart')).toBeVisible();
  await expect(page.getByTestId('ai-chart-v2-intelligence')).toBeVisible();
  await expect(page.getByTestId('ai-chart-v2-signal-overlay')).toBeVisible();
  await expect.poll(() => totalChartCalls(mock.calls)).toBe(1);
  await page.getByTestId('strategy-mode-SWING').click();
  await expect(page.getByTestId('multi-timeframe-ai')).toBeVisible();
  await expect(page.getByTestId('mtf-not-loaded')).toBeVisible();
  await page.getByTestId('load-multi-timeframe').click();
  for (const timeframe of ['15m', '1H', '4H', '1D']) {
    await expect(page.getByTestId(`mtf-${timeframe}`)).toBeVisible();
  }
  await expectNoHorizontalOverflow(page);

  await page.getByRole('button', { name: /지표 설정/ }).click();
  await expect(page.getByTestId('overlay-markers')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expect(mock.privateTradingRequests).toEqual([]);
});
