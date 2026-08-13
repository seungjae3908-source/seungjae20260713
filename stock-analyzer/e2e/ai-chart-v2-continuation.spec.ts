import { readFileSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const directSignalUrl = '/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m&strategyMode=SCALPING&signalId=scanner-signal-42';
const positionSignalUrl = '/ai-chart?assetType=stock&market=US&symbol=AAPL&ticker=AAPL&name=Apple&timeframe=1D&strategyMode=MID_LONG&signalId=position-signal-9';
const futuresUrl = '/ai-chart?assetType=coin_futures&market=BITGET&symbol=BTCUSDT&ticker=BTCUSDT&name=BTCUSDT&timeframe=15m&strategyMode=SWING&signalId=futures-signal-7';

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

async function installReadOnlyChartMocks(context: BrowserContext) {
  const privateTradingRequests: string[] = [];
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (/\/(orders?|cancel|balances?|positions?)(?:\/|\?|$)/i.test(url.pathname) && request.method() !== 'GET') {
      privateTradingRequests.push(`${request.method()} ${url.pathname}`);
    }
    if (/\/api\/stocks\/[^/]+\/(?:chart|candles)$/.test(url.pathname)) {
      const timeframe = url.searchParams.get('tf') ?? '5m';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ticker: url.pathname.includes('AAPL') ? 'AAPL' : '005930',
          timeframe,
          provider: `ai-chart-v2-continuation-${timeframe}`,
          fetchedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
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
  return privateTradingRequests;
}

async function installFuturesChartMocks(context: BrowserContext) {
  const privateTradingRequests: string[] = [];
  let snapshotCalls = 0;
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (/\/(orders?|cancel|balances?|positions?)(?:\/|\?|$)/i.test(url.pathname) && request.method() !== 'GET') {
      privateTradingRequests.push(`${request.method()} ${url.pathname}`);
    }
    if (url.pathname === '/api/crypto/futures/candles') {
      const timeframe = url.searchParams.get('granularity') ?? '15m';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          symbol: 'BTCUSDT',
          timeframe,
          provider: 'bitget-e2e-public',
          fetchedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          candles: candleRows(timeframe),
        }),
      });
      return;
    }
    if (url.pathname === '/api/crypto/futures/BTCUSDT/snapshot') {
      snapshotCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            symbol: 'BTCUSDT',
            markPrice: 61_234.5,
            fundingRate: 0.0001,
            nextFundingAt: '2026-08-13T08:00:00.000Z',
            openInterest: 123_456,
            previousOpenInterest: 120_000,
            openInterestChangePercent: 2.88,
            status: 'live',
            updatedAt: new Date().toISOString(),
            warnings: [],
          },
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
  return {
    privateTradingRequests,
    snapshotCalls: () => snapshotCalls,
  };
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test('Signal Scanner emits the canonical AI Chart signalId and strategyMode deep-link context', () => {
  const source = readFileSync(new URL('../src/pages/signal-scanner.tsx', import.meta.url), 'utf8');
  expect(source).toContain("params.set('signalId', card.signalId)");
  expect(source).toContain('const chartStrategyMode = card.strategyMode ?? strategy');
  expect(source).toContain("params.set('strategyMode', toAiChartStrategyMode(chartStrategyMode))");
  expect(source).toContain('navigate(`/ai-chart?${params.toString()}`)');
  expect(source).toContain("if (card.assetClass === 'coin_spot') return 'UPBIT'");
  expect(source).toContain("if (card.assetClass === 'coin_futures') return 'BITGET'");
});

test('AI Chart consumes selected scanner signalId and strategyMode without inventing execution authority', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const privateTradingRequests = await installReadOnlyChartMocks(context);
  const consoleErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  await page.goto(directSignalUrl);
  const overlay = page.getByTestId('ai-chart-v2-signal-overlay');
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText('scanner-signal-42');
  await expect(page.getByTestId('strategy-mode-SCALPING')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('ai-chart-order-plan-preview')).toContainText('ENTRY 3');
  await expect(page.getByTestId('ai-chart-order-plan-preview')).toContainText('UNAVAILABLE');
  await expect(page.getByTestId('futures-public-context')).toHaveCount(0);
  expect(privateTradingRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('AI Chart restores the canonical MID_LONG mode used by Scanner position strategy', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const privateTradingRequests = await installReadOnlyChartMocks(context);
  const consoleErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  await page.goto(positionSignalUrl);
  await expect(page.getByTestId('ai-chart-v2-signal-overlay')).toContainText('position-signal-9');
  await expect(page.getByTestId('strategy-mode-MID_LONG')).toHaveAttribute('aria-pressed', 'true');
  expect(privateTradingRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('BITGET AI Chart shows one public futures snapshot without promoting it to a trade signal', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const mock = await installFuturesChartMocks(context);
  const consoleErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  await page.goto(futuresUrl);
  const panel = page.getByTestId('futures-public-context');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('61,234.5 USDT');
  await expect(panel).toContainText('0.0100%');
  await expect(panel).toContainText('123,456');
  await expect(panel).toContainText('+2.88%');
  await expect(panel).toContainText('NOT A TRADE SIGNAL');
  await expect(page.getByTestId('strategy-mode-SWING')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('ai-chart-v2-signal-overlay')).toContainText('futures-signal-7');
  expect(mock.snapshotCalls()).toBe(1);
  expect(mock.privateTradingRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('AI Chart 2.0 remains usable with no horizontal overflow at 320/360/390/412/430 widths', async ({ page, context }) => {
  const privateTradingRequests = await installReadOnlyChartMocks(context);
  const consoleErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  for (const width of [320, 360, 390, 412, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(directSignalUrl);
    await expect(page.getByTestId('unified-analysis-chart')).toBeVisible();
    await expect(page.getByTestId('ai-chart-v2-intelligence')).toBeVisible();
    await expect(page.getByTestId('ai-chart-v2-signal-overlay')).toBeVisible();
    await expect(page.getByTestId('strategy-mode-SCALPING')).toBeVisible();
    await expect(page.getByRole('button', { name: '5분', exact: true })).toBeVisible();
    await expect(page.getByTestId('load-multi-timeframe')).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }

  expect(privateTradingRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});