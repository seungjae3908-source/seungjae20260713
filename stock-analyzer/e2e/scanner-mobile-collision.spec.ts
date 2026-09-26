import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

type Box = { x: number; y: number; width: number; height: number };

function scannerCard(action: 'SELL' | 'SHORT', index: number) {
  const futures = action === 'SHORT';
  return {
    signalId: `mobile-collision:${action}:${index}`,
    assetClass: futures ? 'coin_futures' : 'stock',
    market: futures ? 'BITGET' : 'KR',
    exchange: futures ? 'BITGET' : 'KRX',
    symbol: futures ? 'THISISANINTENTIONALLYLONGFUTURESSYMBOLUSDT' : '005930-VERY-LONG-DISPLAY-CODE',
    name: futures
      ? '매우 긴 코인 선물 종목명으로 모바일 카드 폭 충돌을 검증하는 테스트 자산'
      : '매우 긴 국내주식 종목명으로 모바일 카드 가격과 방향 배지 충돌을 검증하는 테스트 종목',
    currency: futures ? 'USDT' : 'KRW',
    assetType: futures ? 'CRYPTO_FUTURES' : 'STOCK',
    listingStatus: 'LISTED',
    price: futures ? 123_456_789.123456 : 987_654_321,
    changePercent: 1.2,
    direction: 'SHORT',
    action,
    signalState: 'WATCHING',
    score: 99,
    confidence: 87,
    dataCompleteness: 96,
    riskScore: 99,
    riskLevel: 'VERY_HIGH_RISK_LABEL_FOR_STRESS',
    liquidity: 1_000_000_000,
    volume: 100_000,
    tradingValue: 7_500_000_000,
    spreadPercent: 0.05,
    volatilityPercent: 1.4,
    matched: [
      '아주 긴 공개 데이터 근거 문자열도 카드 너비를 벗어나면 안 됩니다',
      '두 번째 긴 근거 문자열',
      '세 번째 긴 근거 문자열',
    ],
    notMatched: [],
    unverified: ['추가 검증 필요'],
    evidence: [{
      key: 'direction',
      label: '방향 계약',
      status: 'matched',
      source: 'mobile-collision-public-fixture-with-a-long-provider-name',
      observedAt: '2026-08-16T00:00:00.000Z',
      reasons: ['canonical mobile collision fixture with long evidence copy'],
    }],
    pricePlan: {
      entryZone: { from: 123_456_700.123456, to: 123_456_789.123456 },
      invalidation: 120_000_000,
      stopLoss: 120_000_000,
      targets: [130_000_000.123456, 140_000_000.123456],
      riskReward: 1.6789,
    },
    dataState: 'complete',
    dataSources: ['public-fixture-provider-with-intentionally-long-provenance-name'],
    observedAt: '2026-08-16T00:00:00.000Z',
    expiresAt: '2099-08-16T03:00:00.000Z',
    strongSignalEligible: false,
    warnings: ['긴 위험 경고 문구 역시 모바일 상세 영역을 벗어나거나 다른 버튼과 겹치면 안 됩니다'],
    signalGrade: 'B',
    dataQuality: { state: 'TRUSTED', score: 96, strongSignalAllowed: true, issues: [] },
    aiValidation: {
      status: 'PASS',
      provider: 'fixture-validator',
      counterEvidence: [],
      missingData: [],
      risks: [],
      explanation: 'fixture',
    },
  };
}

function response() {
  const cards = [scannerCard('SELL', 0), scannerCard('SHORT', 1)];
  return {
    ok: true,
    requestId: 'mobile-collision',
    assetClass: 'stock',
    market: 'KR',
    timeframe: '1D',
    cards,
    alerts: [{
      idempotencyKey: 'mobile-collision-alert',
      signalId: cards[1].signalId,
      assetClass: 'coin_futures',
      market: 'BITGET',
      symbol: cards[1].symbol,
      direction: 'SHORT',
      action: 'SHORT',
      state: 'APPROVAL_PENDING',
      entryZone: { from: 123_456_700, to: 123_456_789 },
      stopLoss: 130_000_000,
      targets: [110_000_000],
      expiresAt: '2099-08-16T03:00:00.000Z',
      evidence: ['public fixture'],
      orderSubmitted: false,
      exchangeRequestSent: false,
    }],
    failures: [],
    execution: {
      requestedCount: cards.length,
      startedCount: cards.length,
      completedCount: cards.length,
      excludedCount: 0,
      providerErrorCount: 0,
      timeoutCount: 0,
      partial: false,
      timedOut: false,
      cancelled: false,
      duplicate: false,
      elapsedMs: 20,
      deadlineMs: 12_000,
      itemTimeoutMs: 3_500,
      maxConcurrency: 2,
      providerAcceptedCount: cards.length,
      dataSuccessCount: cards.length,
      insufficientDataCount: 0,
      filteredByStrategyCount: 0,
      hardFilterRejectedCount: 0,
      finalDisplayedCount: cards.length,
    },
    universe: {
      totalCount: cards.length,
      cursor: 0,
      nextCursor: null,
      source: 'fixture-public',
      partial: false,
      stale: false,
      listingStatusCoverage: 'listed-or-unknown',
    },
    dataState: 'complete',
    outcome: 'CANDIDATES_AVAILABLE',
    message: 'mobile collision fixture complete',
    generatedAt: '2026-08-16T00:00:00.000Z',
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

async function fulfill(route: Route, payload: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
}

async function installMocks(page: Page) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/chart')) {
      await fulfill(route, {
        ticker: '005930',
        timeframe: '1D',
        provider: 'fixture',
        fetchedAt: '2026-08-16T00:00:00.000Z',
        candles: [],
      });
      return;
    }
    await fulfill(route, {});
  });
  await page.route('**/api/market/scan**', (route) => fulfill(route, response()));
}

function overlaps(a: Box, b: Box, tolerance = 0.5) {
  return a.x < b.x + b.width - tolerance
    && a.x + a.width > b.x + tolerance
    && a.y < b.y + b.height - tolerance
    && a.y + a.height > b.y + tolerance;
}

async function box(locator: Locator): Promise<Box> {
  const value = await locator.boundingBox();
  expect(value).not.toBeNull();
  return value as Box;
}

function expectInside(inner: Box, outer: Box, tolerance = 1) {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - tolerance);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y - tolerance);
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + tolerance);
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height + tolerance);
}

for (const [width, height] of [[320, 760], [360, 800], [390, 844], [412, 915], [430, 932]] as const) {
  test(`scanner controls and detail do not collide at ${width}px`, async ({ page }) => {
    await installMocks(page);
    await page.setViewportSize({ width, height });
    await page.goto('/__phase11-technical-workspace-e2e');
    await expect(page.getByRole('heading', { name: 'AI 검색기', level: 1 })).toBeVisible();

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    const list = page.getByTestId('scanner-master-list');
    const article = list.locator('article').first();
    const header = article.locator(':scope > div').first();
    const signalButton = header.locator(':scope > button').first();
    const priceRail = header.locator(':scope > div').last();
    const direction = article.getByTestId('scanner-card-direction');

    const articleBox = await box(article);
    const signalBox = await box(signalButton);
    const priceBox = await box(priceRail);
    const directionBox = await box(direction);

    expectInside(signalBox, articleBox);
    expectInside(priceBox, articleBox);
    expectInside(directionBox, articleBox);
    expect(overlaps(signalBox, priceBox)).toBe(false);
    expect(priceBox.y).toBeGreaterThanOrEqual(signalBox.y + signalBox.height - 1);

    const cardActions = article.locator(':scope > div.grid.grid-cols-2.gap-2 > button');
    await expect(cardActions).toHaveCount(2);
    const firstAction = await box(cardActions.nth(0));
    const secondAction = await box(cardActions.nth(1));
    expect(overlaps(firstAction, secondAction)).toBe(false);
    expectInside(firstAction, articleBox);
    expectInside(secondAction, articleBox);

    await signalButton.click();
    const sheet = page.getByTestId('scanner-mobile-sheet');
    await expect(sheet).toBeVisible();
    const sheetBox = await box(sheet);
    expect(await sheet.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);

    const detailDirection = sheet.getByTestId('scanner-direction-badge');
    expectInside(await box(detailDirection), sheetBox);

    const tabs = sheet.getByTestId('scanner-mobile-detail-tabs');
    expect(await tabs.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    const tabButtons = tabs.getByRole('tab');
    await expect(tabButtons).toHaveCount(5);
    const tabBoxes: Box[] = [];
    for (let index = 0; index < 5; index += 1) {
      const tabBox = await box(tabButtons.nth(index));
      expectInside(tabBox, await box(tabs));
      tabBoxes.push(tabBox);
    }
    for (let index = 0; index < tabBoxes.length - 1; index += 1) {
      expect(overlaps(tabBoxes[index], tabBoxes[index + 1])).toBe(false);
    }

    await tabButtons.filter({ hasText: '위험' }).click();
    const riskPanel = sheet.getByTestId('scanner-mobile-risk');
    await expect(riskPanel).toBeVisible();
    expect(await riskPanel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);

    const nav = page.locator("nav[aria-label='주요 메뉴']");
    if (await nav.count()) {
      const [sheetZ, navZ] = await page.evaluate(() => {
        const sheetElement = document.querySelector('[data-testid="scanner-mobile-sheet"]');
        const navElement = document.querySelector("nav[aria-label='주요 메뉴']");
        return [
          Number.parseInt(sheetElement ? getComputedStyle(sheetElement).zIndex || '0' : '0', 10),
          Number.parseInt(navElement ? getComputedStyle(navElement).zIndex || '0' : '0', 10),
        ];
      });
      expect(sheetZ).toBeGreaterThan(navZ);
    }
  });
}
