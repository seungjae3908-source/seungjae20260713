import { expect, test, type Page, type Route } from '@playwright/test';

const forbiddenRequest = /\/(?:stocks\/auto-trade|trade-automation|paper-trading|crypto\/(?:spot\/accounts|futures\/(?:auto|account|positions))|orders?|cancel)(?:[/?]|$)/i;

type ResponseOptions = {
  market?: string;
  assetClass?: 'stock' | 'coin_spot' | 'coin_futures';
  symbol?: string;
  name?: string;
  timeframe?: string;
  partial?: boolean;
  failure?: boolean;
  generatedAt?: string;
};

function scannerResponse(options: ResponseOptions = {}) {
  const market = options.market ?? 'KR';
  const assetClass = options.assetClass ?? 'stock';
  const symbol = options.symbol ?? '005930';
  const name = options.name ?? '삼성전자';
  const timeframe = options.timeframe ?? '1D';
  const partial = options.partial ?? false;
  const card = {
    signalId: `signal:${market}:${symbol}:${timeframe}`,
    assetClass,
    market,
    exchange: assetClass === 'coin_spot' ? 'UPBIT' : assetClass === 'coin_futures' ? 'BITGET' : 'KRX',
    symbol,
    name,
    currency: assetClass === 'coin_spot' ? 'KRW' : assetClass === 'coin_futures' ? 'USDT' : market === 'US' ? 'USD' : 'KRW',
    assetType: assetClass === 'stock' ? 'STOCK' : assetClass === 'coin_spot' ? 'CRYPTO_SPOT' : 'CRYPTO_FUTURES',
    listingStatus: 'LISTED',
    price: assetClass === 'coin_spot' ? 100_000_000 : assetClass === 'coin_futures' ? 70_000 : 75_000,
    changePercent: 1.25,
    direction: assetClass === 'coin_futures' ? 'SHORT' : 'LONG',
    signalState: 'WATCHING',
    score: 82,
    confidence: 78,
    dataCompleteness: partial ? 70 : 92,
    riskScore: 24,
    riskLevel: 'LOW',
    liquidity: 1_000_000_000,
    volume: 100_000,
    tradingValue: 7_500_000_000,
    spreadPercent: 0.05,
    volatilityPercent: 1.4,
    matched: ['추세 일치', '유동성·거래대금'],
    notMatched: [],
    unverified: partial ? ['뉴스·공시'] : [],
    evidence: [{
      key: 'trend',
      label: '추세 일치',
      status: 'matched',
      source: 'public-candles',
      observedAt: '2026-08-05T00:00:00.000Z',
      reasons: ['실제 공개 캔들로 추세를 확인했습니다.'],
    }],
    pricePlan: {
      entryZone: { from: 74_000, to: 75_000 },
      invalidation: 70_000,
      stopLoss: 70_000,
      targets: [82_000, 86_000],
      riskReward: 1.6,
    },
    dataState: partial ? 'partial' : 'complete',
    dataSources: assetClass === 'coin_spot'
      ? ['upbit-public-ticker', 'upbit-public-candles']
      : assetClass === 'coin_futures'
        ? ['bitget-public-ticker', 'bitget-public-candles']
        : ['market-quote', 'market-candles'],
    observedAt: '2026-08-05T00:00:00.000Z',
    expiresAt: '2026-08-05T03:00:00.000Z',
    strongSignalEligible: false,
    warnings: [
      ...(partial ? ['일부 데이터 미확인'] : []),
      ...(assetClass === 'coin_spot'
        ? ['현물 Scanner에는 숏·레버리지를 적용하지 않습니다.']
        : []),
    ],
  };
  return {
    ok: true,
    requestId: `request:${market}:${symbol}:${timeframe}`,
    assetClass,
    market,
    timeframe,
    cards: [card],
    alerts: [],
    failures: options.failure
      ? [{ symbol: 'FAILED', reason: 'provider_error', message: 'fixture provider error' }]
      : [],
    execution: {
      requestedCount: options.failure ? 2 : 1,
      startedCount: options.failure ? 2 : 1,
      completedCount: 1,
      excludedCount: 0,
      providerErrorCount: options.failure ? 1 : 0,
      timeoutCount: 0,
      partial,
      timedOut: false,
      cancelled: false,
      duplicate: false,
      elapsedMs: 25,
      deadlineMs: 12_000,
      itemTimeoutMs: 3_500,
      maxConcurrency: 1,
    },
    universe: {
      totalCount: options.failure ? 2 : 1,
      cursor: 0,
      nextCursor: null,
      source: assetClass === 'coin_spot'
        ? 'upbit-public'
        : assetClass === 'coin_futures'
          ? 'bitget-public'
          : market === 'US'
            ? 'finnhub-symbol-master'
            : 'krx-symbol-master',
      partial,
      stale: false,
      listingStatusCoverage: 'listed-or-unknown',
    },
    dataState: partial ? 'partial' : 'complete',
    message: partial ? '공개 공급자 일부 지연 결과입니다.' : '공개 데이터 분석을 완료했습니다.',
    generatedAt: options.generatedAt ?? '2026-08-05T00:00:00.000Z',
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

async function fulfill(route: Route, payload: unknown, delayMs = 0) {
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(payload),
  }).catch(() => undefined);
}

async function installBaseMocks(page: Page, unexpectedHttp: string[]) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/chart')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ticker: '005930',
          timeframe: '1D',
          provider: 'fixture',
          fetchedAt: '2026-08-05T00:00:00.000Z',
          candles: [],
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && ![401, 403, 409, 429, 502].includes(response.status())) {
      unexpectedHttp.push(`${response.status()} ${response.url()}`);
    }
  });
}

for (const [width, height] of [[360, 800], [390, 844], [430, 932]] as const) {
  test(`signal scanner is usable without overflow or order requests at ${width}x${height}`, async ({ page }) => {
    const forbidden: string[] = [];
    const unexpectedHttp: string[] = [];
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (forbiddenRequest.test(path)) forbidden.push(path);
    });
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await installBaseMocks(page, unexpectedHttp);
    await page.route('**/api/market/scan**', (route) => fulfill(route, scannerResponse()));

    await page.setViewportSize({ width, height });
    await page.goto('/__phase11-technical-workspace-e2e');
    await expect(page.getByRole('heading', { name: 'AI 신호검색기' })).toBeVisible();
    await expect(page.getByRole('region', { name: '검색 시장' }).getByRole('button', { name: /^국내주식/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: /^삼성전자 005930 · KR · STOCK$/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(forbidden).toEqual([]);
    expect(unexpectedHttp).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}

test('latest timeframe response wins and all four public markets remain separated', async ({ page }) => {
  const requests: string[] = [];
  const forbidden: string[] = [];
  const unexpectedHttp: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (forbiddenRequest.test(url.pathname)) forbidden.push(url.pathname);
    if (url.pathname.includes('/api/market/scan') || url.pathname.includes('/api/scanner/crypto/')) {
      requests.push(`${url.pathname}?${url.searchParams.toString()}`);
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await installBaseMocks(page, unexpectedHttp);
  await page.route('**/api/market/scan**', async (route) => {
    const url = new URL(route.request().url());
    const timeframe = url.searchParams.get('timeframe') ?? '1D';
    const market = url.searchParams.get('market') === 'US' ? 'US' : 'KR';
    const delayed = timeframe === '5m' && market === 'KR';
    await fulfill(route, scannerResponse({
      market,
      timeframe,
      symbol: delayed ? 'OLD5M' : market === 'US' ? 'AAPL' : timeframe === '3m' ? 'LATEST3M' : 'BASE1D',
      name: delayed ? '이전 5분 응답' : market === 'US' ? 'Apple' : timeframe === '3m' ? '최신 3분 응답' : '기준 일봉 응답',
    }), delayed ? 600 : 10);
  });
  await page.route('**/api/scanner/crypto/spot**', (route) => fulfill(route, scannerResponse({
    market: 'UPBIT_KRW',
    assetClass: 'coin_spot',
    symbol: 'BTC',
    name: '비트코인',
    timeframe: '3m',
  })));
  await page.route('**/api/scanner/crypto/futures**', (route) => fulfill(route, scannerResponse({
    market: 'BITGET_USDT_FUTURES',
    assetClass: 'coin_futures',
    symbol: 'BTCUSDT',
    name: 'BTCUSDT',
    timeframe: '3m',
  })));

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/__phase11-technical-workspace-e2e');
  await page.getByRole('region', { name: '검색 전략' }).getByRole('button', { name: /단타 Engine/ }).click();
  await expect(page.getByLabel('시간봉')).toHaveValue('5m');
  await page.getByLabel('시간봉').selectOption('3m');
  await expect(page.getByText('최신 3분 응답', { exact: true })).toBeVisible();
  await page.waitForTimeout(700);
  await expect(page.getByText('이전 5분 응답', { exact: true })).toHaveCount(0);

  const marketSelector = page.getByRole('region', { name: '검색 시장' });
  await marketSelector.getByRole('button', { name: /^미국주식/ }).click();
  await expect(page.getByText('Apple', { exact: true })).toBeVisible();
  await marketSelector.getByRole('button', { name: /^코인 현물/ }).click();
  await expect(page.getByText('비트코인', { exact: true })).toBeVisible();
  await expect(page.getByText(/현물 Scanner에는 숏·레버리지를 적용하지 않습니다/)).toBeVisible();
  await marketSelector.getByRole('button', { name: /^코인 선물/ }).click();
  await expect(page.getByText('BTCUSDT', { exact: true }).first()).toBeVisible();

  expect(requests.some((item) => item.includes('market=KR'))).toBe(true);
  expect(requests.some((item) => item.includes('market=US'))).toBe(true);
  expect(requests.some((item) => item.includes('/api/scanner/crypto/spot'))).toBe(true);
  expect(requests.some((item) => item.includes('/api/scanner/crypto/futures'))).toBe(true);
  for (const request of requests) {
    const url = new URL(request, 'https://scanner.test');
    expect(['scalping', 'swing']).toContain(url.searchParams.get('strategy'));
  }
  expect(requests.some((item) => item.includes('strategy=scalping') && item.includes('timeframe=3m'))).toBe(true);
  expect(forbidden).toEqual([]);
  expect(unexpectedHttp).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('partial data and provider failure are distinguished without fake success', async ({ page }) => {
  const unexpectedHttp: string[] = [];
  let mode: 'partial' | 'error' = 'partial';
  await installBaseMocks(page, unexpectedHttp);
  await page.route('**/api/market/scan**', async (route) => {
    if (mode === 'error') {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: 'SCAN_PROVIDER_ERROR',
          cards: [],
          alerts: [],
          orderSubmitted: false,
          exchangeRequestSent: false,
        }),
      });
      return;
    }
    await fulfill(route, scannerResponse({ partial: true, failure: true }));
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__phase11-technical-workspace-e2e');
  await expect(page.getByTestId('scanner-partial')).toContainText('공개 공급자 일부 지연 결과입니다.');
  await expect(page.getByRole('heading', { name: '분석하지 못한 종목 1개' })).toBeVisible();
  await expect(page.getByText('FAILED · provider_error')).toBeVisible();

  mode = 'error';
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('시장데이터 공급자 응답이 불안정합니다');
  expect(unexpectedHttp).toEqual([]);
});

test('scanner lifecycle: refresh, normalization, monotonic guard, and isolation', async ({ page }) => {
  await installBaseMocks(page, []);

  let handler: (route: Route) => Promise<void> = async (route) => {
    await fulfill(route, scannerResponse({ generatedAt: '2026-08-05T00:00:00.000Z' }));
  };
  await page.route('**/api/market/scan**', (route) => handler(route));

  await page.goto('/__phase11-technical-workspace-e2e');
  await expect(page.getByRole('button', { name: /^삼성전자 005930 · KR · STOCK$/ })).toBeVisible();

  handler = async (route) => {
    const res = scannerResponse({ generatedAt: '2026-08-05T01:00:00.000Z' });
    const card = res.cards[0];
    res.cards = [card, { ...card, signalId: 'dup' }];
    await fulfill(route, res);
  };
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect(page.getByRole('button', { name: /^삼성전자 005930 · KR · STOCK$/ })).toHaveCount(1);

  handler = async (route) => {
    await fulfill(route, scannerResponse({ generatedAt: '2026-08-05T00:30:00.000Z', symbol: 'NEW', name: '새종목' }));
  };
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  await expect(page.getByText('새종목', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^삼성전자 005930 · KR · STOCK$/ })).toHaveCount(1);
});

test('scanner automatic 30-second polling refreshes ranking, membership, dedupe, and freshness without user action', async ({ page }) => {
  test.setTimeout(125_000);
  const forbidden: string[] = [];
  const unexpectedHttp: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (forbiddenRequest.test(path)) forbidden.push(path);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await installBaseMocks(page, unexpectedHttp);

  const card = (symbol: string, name: string, score: number) => ({
    ...scannerResponse({ symbol, name }).cards[0],
    signalId: `signal:KR:${symbol}:1D`,
    symbol,
    name,
    score,
  });
  const response = (generatedAt: string, cards: ReturnType<typeof card>[]) => {
    const payload = scannerResponse({
      generatedAt,
      symbol: cards[0]?.symbol ?? 'NONE',
      name: cards[0]?.name ?? '없음',
    });
    payload.cards = cards;
    payload.execution.requestedCount = cards.length;
    payload.execution.startedCount = cards.length;
    payload.execution.completedCount = cards.length;
    payload.execution.maxConcurrency = Math.max(1, cards.length);
    payload.universe.totalCount = cards.length;
    return payload;
  };

  const snapshots = [
    response('2026-08-05T00:00:00.000Z', [
      card('AAA', '알파', 90),
      card('BBB', '베타', 80),
    ]),
    response('2026-08-05T00:00:30.000Z', [
      card('BBB', '베타', 95),
      card('CCC', '감마', 85),
      { ...card('CCC', '감마', 85), signalId: 'signal:KR:CCC:1D:duplicate' },
      card('AAA', '알파', 70),
    ]),
    response('2026-08-05T00:01:00.000Z', [
      card('BBB', '베타', 96),
    ]),
    response('2026-08-05T00:00:45.000Z', [
      card('STALE', '오래된스냅샷', 99),
    ]),
  ];
  let scanCalls = 0;
  await page.route('**/api/market/scan**', async (route) => {
    const index = Math.min(scanCalls, snapshots.length - 1);
    scanCalls += 1;
    await fulfill(route, snapshots[index]);
  });

  await page.goto('/__phase11-technical-workspace-e2e');
  const scanner = page.getByRole('heading', { name: 'AI 신호검색기' }).locator('xpath=ancestor::main[1]');
  await expect(scanner.getByText('알파', { exact: true })).toBeVisible();
  await expect(scanner.getByText('베타', { exact: true })).toBeVisible();

  const activeNames = async () => scanner.locator('article button[type="button"] > p:first-child').evaluateAll((nodes) =>
    nodes.map((node) => node.textContent?.trim() ?? '').filter(Boolean),
  );
  await expect.poll(activeNames).toEqual(['알파', '베타']);

  await expect.poll(() => scanCalls, { timeout: 35_000 }).toBeGreaterThanOrEqual(2);
  await expect(scanner.getByText('감마', { exact: true })).toHaveCount(1);
  await expect.poll(activeNames).toEqual(['베타', '감마', '알파']);

  await expect.poll(() => scanCalls, { timeout: 35_000 }).toBeGreaterThanOrEqual(3);
  await expect(scanner.getByText('베타', { exact: true })).toBeVisible();
  await expect(scanner.getByText('알파', { exact: true })).toHaveCount(0);
  await expect(scanner.getByText('감마', { exact: true })).toHaveCount(0);
  await expect.poll(activeNames).toEqual(['베타']);

  await expect.poll(() => scanCalls, { timeout: 35_000 }).toBeGreaterThanOrEqual(4);
  await expect(scanner.getByText('오래된스냅샷', { exact: true })).toHaveCount(0);
  await expect.poll(activeNames).toEqual(['베타']);
  expect(forbidden).toEqual([]);
  expect(unexpectedHttp).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('scanner requestKey resets generatedAt freshness across real market and timeframe contexts', async ({ page }) => {
  const unexpectedHttp: string[] = [];
  await installBaseMocks(page, unexpectedHttp);
  await page.route('**/api/market/scan**', async (route) => {
    const url = new URL(route.request().url());
    const market = url.searchParams.get('market') === 'US' ? 'US' : 'KR';
    const timeframe = url.searchParams.get('timeframe') ?? '1D';
    if (market === 'KR') {
      await fulfill(route, scannerResponse({ market: 'KR', timeframe, symbol: 'KRNEW', name: 'KR 최신 기준', generatedAt: '2026-08-05T10:00:00.000Z' }));
      return;
    }
    if (timeframe === '4H') {
      await fulfill(route, scannerResponse({ market: 'US', timeframe, symbol: 'US4H', name: 'US 4시간 컨텍스트', generatedAt: '2026-08-05T08:00:00.000Z' }));
      return;
    }
    await fulfill(route, scannerResponse({ market: 'US', timeframe, symbol: 'US1D', name: 'US 일봉 컨텍스트', generatedAt: '2026-08-05T09:00:00.000Z' }));
  });

  await page.goto('/__phase11-technical-workspace-e2e');
  await expect(page.getByText('KR 최신 기준', { exact: true })).toBeVisible();
  const marketSelector = page.getByRole('region', { name: '검색 시장' });
  await marketSelector.getByRole('button', { name: /^미국주식/ }).click();
  await expect(page.getByText('US 일봉 컨텍스트', { exact: true })).toBeVisible();
  await page.getByLabel('시간봉').selectOption('4H');
  await expect(page.getByText('US 4시간 컨텍스트', { exact: true })).toBeVisible();
  await expect(page.getByLabel('시간봉')).toHaveValue('4H');
  expect(unexpectedHttp).toEqual([]);
});

test('scanner market and timeframe race keeps the newest context when an older request responds late', async ({ page }) => {
  const unexpectedHttp: string[] = [];
  const requests: string[] = [];
  await installBaseMocks(page, unexpectedHttp);
  await page.route('**/api/market/scan**', async (route) => {
    const url = new URL(route.request().url());
    const market = url.searchParams.get('market') === 'US' ? 'US' : 'KR';
    const timeframe = url.searchParams.get('timeframe') ?? '1D';
    requests.push(`${market}:${timeframe}`);
    if (market === 'US' && timeframe === '1D') {
      await fulfill(route, scannerResponse({ market, timeframe, symbol: 'LATEUS1D', name: '늦은 US 일봉', generatedAt: '2026-08-05T12:00:00.000Z' }), 700);
      return;
    }
    if (market === 'US' && timeframe === '4H') {
      await fulfill(route, scannerResponse({ market, timeframe, symbol: 'CURRENTUS4H', name: '현재 US 4시간', generatedAt: '2026-08-05T11:00:00.000Z' }), 10);
      return;
    }
    await fulfill(route, scannerResponse({ market: 'KR', timeframe, symbol: 'BASEKR', name: '기준 KR', generatedAt: '2026-08-05T10:00:00.000Z' }), 10);
  });

  await page.goto('/__phase11-technical-workspace-e2e');
  await expect(page.getByText('기준 KR', { exact: true })).toBeVisible();
  const marketSelector = page.getByRole('region', { name: '검색 시장' });
  await marketSelector.getByRole('button', { name: /^미국주식/ }).click();
  await page.getByLabel('시간봉').selectOption('4H');
  await expect(page.getByText('현재 US 4시간', { exact: true })).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.getByText('늦은 US 일봉', { exact: true })).toHaveCount(0);
  await expect(marketSelector.getByRole('button', { name: /^미국주식/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('시간봉')).toHaveValue('4H');
  expect(requests).toContain('US:1D');
  expect(requests).toContain('US:4H');
  expect(unexpectedHttp).toEqual([]);
});
