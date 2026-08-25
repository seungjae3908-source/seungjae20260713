import { expect, test, type Page, type Route } from '@playwright/test';

const forbiddenRequest = /\/(?:stocks\/auto-trade|trade-automation|paper-trading|crypto\/(?:spot\/accounts|futures\/(?:auto|account|positions))|orders?|cancel|accounts?)(?:[/?]|$)/i;

function execution(count: number) {
  return {
    requestedCount: count,
    startedCount: count,
    completedCount: count,
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
    maxConcurrency: Math.max(1, count),
    providerAcceptedCount: count,
    dataSuccessCount: count,
    insufficientDataCount: 0,
    filteredByStrategyCount: 0,
    hardFilterRejectedCount: 0,
    finalDisplayedCount: count,
  };
}

function emptyStockResponse() {
  return {
    ok: true,
    requestId: 'request:stock-empty',
    assetClass: 'stock',
    market: 'KR',
    timeframe: '1D',
    cards: [],
    alerts: [],
    failures: [],
    execution: execution(0),
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
    outcome: 'VALID_ZERO_SIGNAL',
    message: '현재 조건에 맞는 신호가 없습니다.',
    generatedAt: '2026-08-25T18:30:00.000Z',
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

function futuresCard({ symbol, action, rank, score, price }: { symbol: string; action: 'LONG' | 'SHORT'; rank: number; score: number; price: number }) {
  const long = action === 'LONG';
  return {
    signalId: `signal:BITGET:${symbol}:5m`,
    assetClass: 'coin_futures',
    market: 'BITGET',
    exchange: 'BITGET',
    symbol,
    name: symbol,
    currency: 'USDT',
    assetType: 'CRYPTO_FUTURES',
    listingStatus: 'LISTED',
    price,
    changePercent: 1.25,
    direction: action,
    action,
    signalState: 'CONFIRMED',
    signalGrade: 'B',
    score,
    confidence: 77,
    dataCompleteness: 100,
    riskScore: 0,
    riskLevel: 'LOW',
    liquidity: 1_000_000,
    volume: 100_000,
    tradingValue: 5_000_000,
    spreadPercent: 0.05,
    volatilityPercent: 1.4,
    matched: ['유동성·거래대금', '스프레드'],
    notMatched: [],
    unverified: [],
    evidence: [{
      key: 'trend',
      label: '추세',
      status: 'matched',
      source: 'bitget-public-candles',
      observedAt: '2026-08-25T18:30:00.000Z',
      reasons: ['공개 캔들 근거를 확인했습니다.'],
    }],
    pricePlan: {
      entryZone: { from: price - 0.2, to: price + 0.2 },
      invalidation: long ? price - 1 : price + 1,
      stopLoss: long ? price - 1 : price + 1,
      targets: [long ? price + 2 : price - 2, long ? price + 3 : price - 3],
      riskReward: 2,
    },
    dataState: 'complete',
    dataSources: ['bitget-public-ticker', 'bitget-public-candles'],
    observedAt: '2026-08-25T18:30:00.000Z',
    expiresAt: '2099-08-25T18:45:00.000Z',
    strongSignalEligible: true,
    warnings: [],
    dataQuality: {
      state: 'TRUSTED',
      score: 96,
      strongSignalAllowed: true,
      issues: [],
    },
    quantScore: {
      technical: 80,
      trend: 80,
      momentum: 80,
      volume: 80,
      liquidity: 80,
      volatility: 80,
      marketRegime: 80,
      risk: 80,
    },
    candidateRanking: {
      rank,
      score: 90 - rank,
      relativeScore: 90 - rank,
      relative: {
        tradingValuePercentile: 90,
        momentumPercentile: 90,
        trendPercentile: 90,
        volumePercentile: 90,
        volatilityPercentile: 50,
      },
      watchCompletionPercent: 85,
      watchReasons: [],
      hardFilterPassed: true,
      hardFilterReasons: [],
    },
    aiValidation: {
      status: 'PASS',
      provider: 'fixture-validator',
      counterEvidence: [],
      missingData: [],
      risks: [],
      explanation: '공개 데이터 근거만 사용했습니다.',
    },
  };
}

function futuresResponse() {
  const cards = [
    futuresCard({ symbol: 'KORUUSDT', action: 'SHORT', rank: 2, score: 74.08342555373085, price: 20.491 }),
    futuresCard({ symbol: 'HYPEUSDT', action: 'LONG', rank: 1, score: 61.84552563294669, price: 82.448 }),
  ];
  return {
    ok: true,
    requestId: 'request:futures-mobile-ux',
    assetClass: 'coin_futures',
    market: 'BITGET',
    timeframe: '5m',
    cards,
    alerts: [],
    failures: [],
    execution: execution(cards.length),
    universe: {
      totalCount: cards.length,
      cursor: 0,
      nextCursor: null,
      source: 'bitget-public-contracts',
      partial: false,
      stale: false,
      listingStatusCoverage: 'listed-or-unknown',
    },
    dataState: 'complete',
    outcome: 'CANDIDATES_AVAILABLE',
    message: '검증 후보를 표시했습니다.',
    generatedAt: '2026-08-25T18:30:00.000Z',
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

async function fulfill(route: Route, payload: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
}

async function installMocks(page: Page, forbidden: string[]) {
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (forbiddenRequest.test(url.pathname)) forbidden.push(`${request.method()} ${url.pathname}`);
  });
  await page.route('**/api/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/market/scan**', (route) => fulfill(route, emptyStockResponse()));
  await page.route('**/api/scanner/crypto/futures**', (route) => fulfill(route, futuresResponse()));
}

test('mobile futures scanner sorts canonical ranks, filters long/short, rounds score and deduplicates symbol title', async ({ page }) => {
  const forbidden: string[] = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await installMocks(page, forbidden);

  await page.goto('/__phase11-technical-workspace-e2e');
  await page.getByRole('button', { name: '코인 선물', exact: true }).click();

  const filter = page.getByTestId('scanner-futures-direction-filter');
  await expect(filter).toBeVisible();
  await expect(filter.getByRole('tab', { name: '전체 2', exact: true })).toBeVisible();
  await expect(filter.getByRole('tab', { name: '롱 1', exact: true })).toBeVisible();
  await expect(filter.getByRole('tab', { name: '숏 1', exact: true })).toBeVisible();

  const cards = page.getByTestId('scanner-signal-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText('1위 · HYPEUSDT');
  await expect(cards.nth(0)).toContainText('점수 61.8 · 위험 0');
  await expect(cards.nth(0).getByTestId('scanner-card-direction')).toHaveText('롱');
  await expect(cards.nth(1)).toContainText('2위 · KORUUSDT');
  await expect(cards.nth(1)).toContainText('점수 74.1 · 위험 0');
  await expect(cards.nth(1).getByTestId('scanner-card-direction')).toHaveText('숏');

  await filter.getByRole('tab', { name: '롱 1', exact: true }).click();
  await expect(page.getByTestId('scanner-signal-card')).toHaveCount(1);
  await expect(page.getByTestId('scanner-signal-card')).toContainText('HYPEUSDT');
  await filter.getByRole('tab', { name: '숏 1', exact: true }).click();
  await expect(page.getByTestId('scanner-signal-card')).toHaveCount(1);
  await expect(page.getByTestId('scanner-signal-card')).toContainText('KORUUSDT');
  await filter.getByRole('tab', { name: '전체 2', exact: true }).click();

  await cards.nth(0).getByRole('button', { name: /HYPEUSDT · 코인 선물 · BITGET/ }).click();
  const sheet = page.getByTestId('scanner-mobile-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('heading', { name: 'HYPEUSDT', exact: true })).toBeVisible();
  await expect(sheet.getByText('HYPEUSDT · HYPEUSDT', { exact: true })).toHaveCount(0);
  await expect(sheet.getByText('신호 점수')).toBeVisible();
  await expect(sheet.getByText('61.8점', { exact: true })).toBeVisible();
  await expect(sheet.getByTestId('scanner-direction-badge')).toHaveText('롱');
  await expect(sheet).toHaveClass(/bg-card/);

  expect(forbidden).toEqual([]);
});