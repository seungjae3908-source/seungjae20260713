import { expect, test, type Page } from '@playwright/test';

const generatedAt = '2026-08-15T06:30:00.000Z';

function response(assetClass: 'stock' | 'coin_spot' | 'coin_futures', market: string, cards: any[]) {
  return {
    ok: true,
    requestId: `ui-cleanup:${assetClass}`,
    assetClass,
    market,
    timeframe: assetClass === 'stock' ? '1D' : '5m',
    cards,
    alerts: [],
    failures: [],
    execution: {
      requestedCount: cards.length || 1,
      startedCount: cards.length || 1,
      completedCount: cards.length || 1,
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
      providerAcceptedCount: cards.length || 1,
      dataSuccessCount: cards.length || 1,
      insufficientDataCount: 0,
      filteredByStrategyCount: cards.length ? 0 : 1,
      finalDisplayedCount: cards.length,
    },
    universe: {
      totalCount: cards.length || 1,
      cursor: 0,
      nextCursor: null,
      source: assetClass === 'coin_spot' ? 'upbit-public-market' : 'fixture',
      partial: false,
      stale: false,
      listingStatusCoverage: 'listed-or-unknown',
    },
    dataState: 'complete',
    outcome: cards.length ? 'CANDIDATES_AVAILABLE' : 'VALID_ZERO_SIGNAL',
    message: cards.length ? '공개 데이터 후보를 확인했습니다.' : '현재 조건의 후보가 없습니다.',
    generatedAt,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

const spotCard = {
  signalId: 'spot:KRW-BTC:scalping:5m',
  assetClass: 'coin_spot',
  market: 'UPBIT',
  exchange: 'UPBIT',
  symbol: 'KRW-BTC',
  name: '비트코인',
  currency: 'KRW',
  assetType: 'SPOT',
  listingStatus: 'LISTED',
  price: 156_200_000,
  changePercent: 1.2,
  direction: 'LONG',
  action: 'BUY',
  signalState: 'WATCHING',
  score: 82,
  confidence: 74,
  dataCompleteness: 100,
  riskScore: 20,
  riskLevel: 'LOW',
  liquidity: 1_000_000_000,
  volume: 100,
  tradingValue: 15_620_000_000,
  spreadPercent: 0.03,
  volatilityPercent: 1.4,
  matched: ['Upbit 현물 공개 데이터'],
  notMatched: [],
  unverified: [],
  evidence: [{
    key: 'upbit-public-spot',
    label: 'Upbit 현물 공개 데이터',
    status: 'matched',
    source: 'upbit-public-market',
    observedAt: generatedAt,
    reasons: ['Upbit 현물 시장의 공개 가격과 거래량을 확인했습니다.'],
  }],
  pricePlan: {
    entryZone: { from: 155_000_000, to: 156_200_000 },
    invalidation: 153_000_000,
    stopLoss: 153_000_000,
    targets: [160_000_000],
    riskReward: 1.5,
  },
  dataState: 'complete',
  dataSources: ['upbit-public-market'],
  observedAt: generatedAt,
  expiresAt: '2026-08-15T06:40:00.000Z',
  strongSignalEligible: true,
  warnings: [],
  strategyMode: 'scalping',
  signalGrade: 'A',
};

async function mockScanner(page: Page, requests: string[]) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    if (url.pathname === '/api/scanner/crypto/spot') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response('coin_spot', 'UPBIT', [spotCard])) });
      return;
    }
    if (url.pathname === '/api/scanner/crypto/futures') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response('coin_futures', 'BITGET', [])) });
      return;
    }
    if (url.pathname === '/api/market/scan') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response('stock', url.searchParams.get('market') ?? 'KR', [])) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test('mobile coin spot selection calls the Upbit spot scanner and renders its result', async ({ page }) => {
  const requests: string[] = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await mockScanner(page, requests);
  await page.goto('/__phase11-technical-workspace-e2e');

  const spotButton = page.getByRole('button', { name: '코인 현물', exact: true });
  await expect(spotButton).toBeVisible();
  await spotButton.click();

  await expect.poll(() => requests.filter((path) => path === '/api/scanner/crypto/spot').length).toBeGreaterThan(0);
  await expect(spotButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('비트코인', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/KRW-BTC · UPBIT/).first()).toBeVisible();
  expect(requests.filter((path) => path === '/api/scanner/crypto/futures')).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
});
