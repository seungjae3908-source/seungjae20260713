import { expect, test, type Page } from '@playwright/test';
import {
  SIGNAL_SCANNER_INTEGRATION_LAYOUTS,
  signalScannerPublishedLayoutStorageKey,
} from '../src/lib/ui-builder-layout';

const forbiddenRequest = /\/(?:stocks\/auto-trade|trade-automation|paper-trading|crypto\/(?:spot\/accounts|futures\/(?:auto|account|positions))|orders?|cancel)(?:[/?]|$)/i;

function scannerResponse() {
  return {
    ok: true,
    requestId: 'ui-builder-integration',
    assetClass: 'stock',
    market: 'KR',
    timeframe: '1D',
    cards: [{
      signalId: 'signal:KR:005930:1D',
      assetClass: 'stock',
      market: 'KR',
      exchange: 'KRX',
      symbol: '005930',
      name: '삼성전자',
      currency: 'KRW',
      assetType: 'STOCK',
      listingStatus: 'LISTED',
      price: 75_000,
      changePercent: 1.25,
      direction: 'LONG',
      signalState: 'WATCHING',
      score: 82,
      confidence: 78,
      dataCompleteness: 92,
      riskScore: 24,
      riskLevel: 'LOW',
      liquidity: 1_000_000_000,
      volume: 100_000,
      tradingValue: 7_500_000_000,
      spreadPercent: 0.05,
      volatilityPercent: 1.4,
      matched: ['추세 일치', '유동성·거래대금'],
      notMatched: [],
      unverified: [],
      evidence: [],
      pricePlan: {
        entryZone: { from: 74_000, to: 75_000 },
        invalidation: 70_000,
        stopLoss: 70_000,
        targets: [82_000, 86_000],
        riskReward: 1.6,
      },
      dataState: 'complete',
      dataSources: ['market-quote', 'market-candles'],
      observedAt: '2026-08-10T00:00:00.000Z',
      expiresAt: '2026-08-10T03:00:00.000Z',
      strongSignalEligible: false,
      warnings: [],
    }],
    alerts: [],
    failures: [],
    execution: {
      requestedCount: 1,
      startedCount: 1,
      completedCount: 1,
      excludedCount: 0,
      providerErrorCount: 0,
      timeoutCount: 0,
      partial: false,
      timedOut: false,
      cancelled: false,
      duplicate: false,
      elapsedMs: 25,
      deadlineMs: 12_000,
      itemTimeoutMs: 3_500,
      maxConcurrency: 1,
    },
    universe: {
      totalCount: 1,
      cursor: 0,
      nextCursor: null,
      source: 'krx-symbol-master',
      partial: false,
      stale: false,
      listingStatusCoverage: 'listed-or-unknown',
    },
    dataState: 'complete',
    message: '공개 데이터 분석을 완료했습니다.',
    generatedAt: '2026-08-10T00:00:00.000Z',
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

async function installMocks(page: Page, forbidden: string[], unexpectedHttp: string[]) {
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (forbiddenRequest.test(path)) forbidden.push(path);
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && ![401, 403, 409, 429, 502].includes(response.status())) {
      unexpectedHttp.push(`${response.status()} ${response.url()}`);
    }
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const payload = url.pathname.includes('/api/market/scan')
      ? scannerResponse()
      : url.pathname.includes('/chart')
        ? {
            ticker: '005930',
            timeframe: '1D',
            provider: 'fixture',
            fetchedAt: '2026-08-10T00:00:00.000Z',
            candles: [],
          }
        : {};
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });
}

async function seedLayout(page: Page, device: 'mobile' | 'desktop') {
  const key = signalScannerPublishedLayoutStorageKey(device);
  const layout = SIGNAL_SCANNER_INTEGRATION_LAYOUTS[device];
  await page.addInitScript(({ storageKey, value }) => {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  }, { storageKey: key, value: layout });
}

for (const [width, height] of [[320, 760], [360, 800], [390, 844], [430, 932]] as const) {
  test(`UI Builder mobile Signal Scanner layout is safe at ${width}x${height}`, async ({ page }) => {
    const forbidden: string[] = [];
    const unexpectedHttp: string[] = [];
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await installMocks(page, forbidden, unexpectedHttp);
    await seedLayout(page, 'mobile');

    await page.setViewportSize({ width, height });
    await page.goto('/__phase11-technical-workspace-e2e');

    await expect(page.getByTestId('ui-builder-signal-scanner-mobile')).toBeVisible();
    await expect(page.getByTestId('ui-builder-surface-scanner')).toBeVisible();
    await expect(page.getByTestId('ui-builder-surface-position')).toBeVisible();
    await expect(page.getByTestId('ui-builder-surface-trade-review')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'AI 신호검색기' })).toBeVisible();

    const metrics = await page.evaluate(() => {
      const root = document.documentElement;
      const scrollable = [...document.querySelectorAll<HTMLElement>('*')].filter((element) => {
        const style = getComputedStyle(element);
        return ['auto', 'scroll'].includes(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
      });
      const builder = document.querySelector<HTMLElement>('[data-testid="ui-builder-signal-scanner-mobile"]');
      return {
        overflow: root.scrollWidth > root.clientWidth,
        nestedVerticalScrollCount: scrollable.length,
        bottomPadding: builder ? Number.parseFloat(getComputedStyle(builder).paddingBottom) : 0,
      };
    });
    expect(metrics.overflow).toBe(false);
    expect(metrics.nestedVerticalScrollCount).toBeLessThanOrEqual(1);
    expect(metrics.bottomPadding).toBeGreaterThanOrEqual(80);
    expect(forbidden).toEqual([]);
    expect(unexpectedHttp).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}

for (const [width, height] of [[1024, 800], [1280, 900], [1440, 1000], [1920, 1080]] as const) {
  test(`UI Builder desktop Signal Scanner layout is safe at ${width}x${height}`, async ({ page }) => {
    const forbidden: string[] = [];
    const unexpectedHttp: string[] = [];
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await installMocks(page, forbidden, unexpectedHttp);
    await seedLayout(page, 'desktop');

    await page.setViewportSize({ width, height });
    await page.goto('/__phase11-technical-workspace-e2e');

    await expect(page.getByTestId('ui-builder-signal-scanner-desktop')).toBeVisible();
    await expect(page.getByTestId('ui-builder-surface-scanner')).toBeVisible();
    await expect(page.getByTestId('ui-builder-surface-chart')).toBeVisible();
    await expect(page.getByTestId('ui-builder-surface-position')).toBeVisible();
    await expect(page.getByTestId('ui-builder-surface-trade-review')).toBeVisible();

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(forbidden).toEqual([]);
    expect(unexpectedHttp).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}

test('invalid Builder layout falls back to the current Stock App workspace', async ({ page }) => {
  const forbidden: string[] = [];
  const unexpectedHttp: string[] = [];
  await installMocks(page, forbidden, unexpectedHttp);
  const invalid = structuredClone(SIGNAL_SCANNER_INTEGRATION_LAYOUTS.mobile) as any;
  invalid.blocks[1].props.endpoint = '/api/private/orders';
  await page.addInitScript(({ storageKey, value }) => {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  }, {
    storageKey: signalScannerPublishedLayoutStorageKey('mobile'),
    value: invalid,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__phase11-technical-workspace-e2e');

  await expect(page.getByTestId('ui-builder-signal-scanner-mobile')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'AI 신호검색기' })).toBeVisible();
  expect(forbidden).toEqual([]);
  expect(unexpectedHttp).toEqual([]);
});

test('Mobile and Desktop published layouts remain isolated across viewport changes', async ({ page }) => {
  await installMocks(page, [], []);
  await seedLayout(page, 'mobile');
  await seedLayout(page, 'desktop');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__phase11-technical-workspace-e2e');
  await expect(page.getByTestId('ui-builder-signal-scanner-mobile')).toHaveAttribute('data-layout-id', 'signal-scanner-integration-mobile');

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByTestId('ui-builder-signal-scanner-desktop')).toHaveAttribute('data-layout-id', 'signal-scanner-integration-desktop');
});
