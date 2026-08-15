import { expect, test, type Page, type Route } from '@playwright/test';

function scannerPayload() {
  return {
    ok: true,
    requestId: 'mobile-detail-tabs:KR',
    assetClass: 'stock',
    market: 'KR',
    timeframe: '1D',
    cards: [
      {
        signalId: 'sig-005930-swing',
        assetClass: 'stock',
        market: 'KR',
        exchange: 'KRX',
        symbol: '005930',
        name: '삼성전자',
        currency: 'KRW',
        assetType: 'STOCK',
        listingStatus: 'LISTED',
        price: 82000,
        changePercent: 1.2,
        direction: 'LONG',
        action: 'BUY',
        signalState: 'CANDIDATE',
        score: 82,
        confidence: 68,
        dataCompleteness: 98,
        riskScore: 31,
        riskLevel: 'LOW',
        liquidity: 90,
        volume: 1000000,
        tradingValue: 82000000000,
        spreadPercent: 0.05,
        volatilityPercent: 1.8,
        matched: ['추세 정렬', '거래량 확인'],
        notMatched: ['과열 없음'],
        unverified: ['뉴스 이벤트'],
        evidence: [
          { key: 'trend', label: '추세', status: 'matched', source: 'public-market', observedAt: '2026-08-15T00:00:00.000Z', reasons: ['중기 추세가 상승 방향으로 정렬됨'] },
          { key: 'volume', label: '거래량', status: 'matched', source: 'public-market', observedAt: '2026-08-15T00:00:00.000Z', reasons: ['거래량 확인'] },
        ],
        pricePlan: {
          entryZone: { from: 81500, to: 82300 },
          invalidation: 79000,
          stopLoss: 79000,
          targets: [85000, 87000],
          riskReward: 2.1,
        },
        dataState: 'complete',
        dataSources: ['public-market'],
        observedAt: '2026-08-15T00:00:00.000Z',
        expiresAt: '2026-08-16T00:00:00.000Z',
        strongSignalEligible: true,
        warnings: ['실적 발표 일정 확인 필요'],
        strategyMode: 'swing',
        signalGrade: 'A',
        backtestQuality: {
          status: 'verified',
          oosWinRate: 61.2,
          walkForwardWinRate: 58.7,
          expectancyPercent: 0.9,
          profitFactor: 1.42,
          maxDrawdownPercent: 8.3,
          tradeCount: 184,
          costsIncluded: true,
          slippageIncluded: true,
          regime: 'Bull',
        },
      },
    ],
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
      elapsedMs: 12,
      deadlineMs: 12000,
      itemTimeoutMs: 3500,
      maxConcurrency: 1,
      providerAcceptedCount: 1,
      dataSuccessCount: 1,
      insufficientDataCount: 0,
      filteredByStrategyCount: 0,
      hardFilterRejectedCount: 0,
      finalDisplayedCount: 1,
    },
    universe: {
      totalCount: 1,
      cursor: 0,
      nextCursor: null,
      source: 'fixture-stock',
      partial: false,
      stale: false,
      listingStatusCoverage: 'listed-or-unknown',
    },
    dataState: 'complete',
    outcome: 'CANDIDATES_AVAILABLE',
    message: '공개 데이터 분석 완료',
    generatedAt: '2026-08-15T00:00:00.000Z',
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

async function fulfill(route: Route, payload: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
}

async function installMocks(page: Page) {
  await page.route('**/api/**', (route) => fulfill(route, {}));
  await page.route('**/api/market/scan**', (route) => fulfill(route, scannerPayload()));
}

for (const viewport of [
  { width: 320, height: 720 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
] as const) {
  test(`mobile signal detail uses compact tabs at ${viewport.width}px`, async ({ page }) => {
    await installMocks(page);
    await page.setViewportSize(viewport);
    await page.goto('/__phase11-technical-workspace-e2e');

    await expect(page.getByRole('button', { name: /삼성전자 005930/ })).toBeVisible();
    await page.getByRole('button', { name: /삼성전자 005930/ }).click();

    const sheet = page.getByTestId('scanner-mobile-sheet');
    await expect(sheet).toBeVisible();
    const tabs = sheet.getByTestId('scanner-mobile-detail-tabs');
    await expect(tabs).toBeVisible();
    await expect(tabs.getByRole('tab')).toHaveCount(5);
    await expect(tabs.getByRole('tab', { name: '요약' })).toHaveAttribute('aria-selected', 'true');
    await expect(sheet.getByTestId('scanner-mobile-summary')).toBeVisible();
    await expect(sheet.getByTestId('scanner-mobile-performance')).toHaveCount(0);

    await tabs.getByRole('tab', { name: '성과' }).click();
    await expect(tabs.getByRole('tab', { name: '성과' })).toHaveAttribute('aria-selected', 'true');
    await expect(sheet.getByTestId('scanner-mobile-performance')).toContainText('61.2%');
    await expect(sheet.getByTestId('scanner-mobile-performance')).toContainText('184');
    await expect(sheet.getByTestId('scanner-mobile-summary')).toHaveCount(0);

    await tabs.getByRole('tab', { name: '근거' }).click();
    await expect(sheet.getByTestId('scanner-mobile-evidence')).toContainText('중기 추세가 상승 방향으로 정렬됨');

    await tabs.getByRole('tab', { name: '차트' }).click();
    await expect(sheet.getByTestId('scanner-mobile-chart').getByRole('button', { name: 'AI 차트 분석기에서 보기' })).toBeVisible();

    await tabs.getByRole('tab', { name: '위험' }).click();
    await expect(sheet.getByTestId('scanner-mobile-risk')).toContainText('실적 발표 일정 확인 필요');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });
}
