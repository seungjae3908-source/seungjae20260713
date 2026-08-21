import { expect, test, type Page, type Route } from '@playwright/test';

const forbiddenRequest = /\/(?:stocks\/auto-trade|trade-automation|paper-trading|crypto\/(?:spot\/accounts|futures\/(?:auto|account|positions))|orders?|cancel|accounts?)(?:[/?]|$)/i;

type QualityOptions = {
  signalState?: 'CONFIRMED' | 'WEAKENED';
  degraded?: boolean;
  missingQuantAndRanking?: boolean;
};

function scannerResponse(options: QualityOptions = {}) {
  const degraded = options.degraded ?? false;
  const missingQuantAndRanking = options.missingQuantAndRanking ?? false;
  const card: Record<string, unknown> = {
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
    action: 'BUY',
    signalState: options.signalState ?? 'CONFIRMED',
    signalGrade: 'A',
    score: 84,
    confidence: 81,
    dataCompleteness: degraded ? 62 : 96,
    riskScore: 28,
    riskLevel: 'LOW',
    liquidity: 1_000_000_000,
    volume: 100_000,
    tradingValue: 7_500_000_000,
    spreadPercent: 0.05,
    volatilityPercent: 1.4,
    matched: ['추세 일치', '거래량 확인'],
    notMatched: [],
    unverified: degraded ? ['뉴스·공시'] : [],
    evidence: [{
      key: 'trend',
      label: '추세 일치',
      status: 'matched',
      source: 'public-candles',
      observedAt: '2026-08-21T08:00:00.000Z',
      reasons: ['실제 공개 캔들로 추세를 확인했습니다.'],
    }],
    pricePlan: {
      entryZone: { from: 74_000, to: 75_000 },
      invalidation: 70_000,
      stopLoss: 70_000,
      targets: [82_000, 86_000],
      riskReward: 1.6,
    },
    dataState: degraded ? 'untrusted' : 'complete',
    dataSources: ['market-quote', 'market-candles'],
    observedAt: '2026-08-21T08:00:00.000Z',
    expiresAt: '2026-08-21T12:00:00.000Z',
    strongSignalEligible: !degraded,
    warnings: degraded ? ['일부 데이터 미확인'] : [],
    dataQuality: degraded
      ? {
          state: 'DATA_UNTRUSTED',
          score: 41,
          strongSignalAllowed: false,
          issues: [{ code: 'STALE_CANDLES', severity: 'blocking', message: '캔들 freshness 기준 미충족' }],
        }
      : {
          state: 'TRUSTED',
          score: 96,
          strongSignalAllowed: true,
          issues: [],
        },
    aiValidation: {
      status: degraded ? 'PARTIAL' : 'PASS',
      provider: 'fixture-validator',
      counterEvidence: [],
      missingData: degraded ? ['뉴스·공시'] : [],
      risks: degraded ? ['일부 데이터 미확인'] : [],
      explanation: '공개 데이터 근거만 검증했습니다.',
    },
  };

  if (!missingQuantAndRanking) {
    card.quantScore = {
      technical: 91,
      trend: 88,
      momentum: 83,
      volume: 79,
      liquidity: 94,
      volatility: 67,
      marketRegime: 86,
      risk: 72,
    };
    card.candidateRanking = {
      rank: 1,
      score: 89,
      relativeScore: 92,
      relative: {
        tradingValuePercentile: 96,
        momentumPercentile: 88,
        trendPercentile: 93,
        volumePercentile: 84,
        volatilityPercentile: 65,
      },
      watchCompletionPercent: 87,
      watchReasons: ['추세 상위권 유지', '거래대금 조건 충족'],
      hardFilterPassed: true,
      hardFilterReasons: ['유동성 통과', 'Risk 한도 통과'],
    };
  }

  return {
    ok: true,
    requestId: 'request:quality-panel',
    assetClass: 'stock',
    market: 'KR',
    timeframe: '1D',
    cards: [card],
    alerts: [],
    failures: [],
    execution: {
      requestedCount: 1,
      startedCount: 1,
      completedCount: 1,
      excludedCount: 0,
      providerErrorCount: 0,
      timeoutCount: 0,
      partial: degraded,
      timedOut: false,
      cancelled: false,
      duplicate: false,
      elapsedMs: 25,
      deadlineMs: 12_000,
      itemTimeoutMs: 3_500,
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
      source: 'krx-symbol-master',
      partial: degraded,
      stale: false,
      listingStatusCoverage: 'listed-or-unknown',
    },
    dataState: degraded ? 'untrusted' : 'complete',
    outcome: 'CANDIDATES_AVAILABLE',
    message: degraded ? '데이터 품질 제한 결과입니다.' : '공개 데이터 분석을 완료했습니다.',
    generatedAt: '2026-08-21T08:00:00.000Z',
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

async function fulfill(route: Route, payload: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
}

async function installMocks(page: Page, payload: unknown, forbidden: string[]) {
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (forbiddenRequest.test(url.pathname)) forbidden.push(`${request.method()} ${url.pathname}`);
  });
  await page.route('**/api/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/market/scan**', (route) => fulfill(route, payload));
}

test('desktop Signal Detail exposes server quality, quant and ranking evidence without order requests', async ({ page }) => {
  const forbidden: string[] = [];
  await page.setViewportSize({ width: 1280, height: 900 });
  await installMocks(page, scannerResponse(), forbidden);

  await page.goto('/__phase11-technical-workspace-e2e');
  const samsung = page.getByRole('button', { name: /^삼성전자 005930 · KR · STOCK$/ });
  await expect(samsung).toBeVisible();
  await samsung.click();

  const panel = page.getByTestId('scanner-signal-quality-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('scanner-signal-state')).toHaveText('상태 CONFIRMED');
  await expect(page.getByTestId('scanner-quality-data-state')).toHaveText('TRUSTED');
  await expect(page.getByTestId('scanner-quality-data-score')).toHaveText('96');
  await expect(page.getByTestId('scanner-quality-strong-allowed')).toHaveText('YES');
  await expect(page.getByTestId('scanner-quality-hard-filter')).toHaveText('PASS');
  await expect(page.getByTestId('scanner-quality-rank')).toHaveText('1위');
  await expect(panel.getByText('91', { exact: true })).toBeVisible();
  await expect(panel.getByText('92', { exact: true })).toBeVisible();
  await expect(panel.getByText('87%', { exact: true })).toBeVisible();
  await expect(panel.getByText('추세 상위권 유지', { exact: true })).toBeVisible();
  await expect(panel.getByText('유동성 통과', { exact: true })).toBeVisible();
  await expect(panel.getByText('차단·경고 이슈 없음', { exact: true })).toBeVisible();
  expect(forbidden).toEqual([]);
});

test('mobile quality panel fails closed for untrusted and missing evidence', async ({ page }) => {
  const forbidden: string[] = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await installMocks(page, scannerResponse({ signalState: 'WEAKENED', degraded: true, missingQuantAndRanking: true }), forbidden);

  await page.goto('/__phase11-technical-workspace-e2e');
  const samsung = page.getByRole('button', { name: /^삼성전자 005930 · KR · STOCK$/ });
  await expect(samsung).toBeVisible();
  await samsung.click();

  const sheet = page.getByTestId('scanner-mobile-sheet');
  await expect(sheet).toBeVisible();
  const panel = sheet.getByTestId('scanner-signal-quality-panel');
  await expect(panel).toBeVisible();
  await expect(sheet.getByTestId('scanner-signal-state')).toHaveText('상태 WEAKENED');
  await expect(panel.getByTestId('scanner-quality-data-state')).toHaveText('DATA_UNTRUSTED');
  await expect(panel.getByTestId('scanner-quality-data-score')).toHaveText('41');
  await expect(panel.getByTestId('scanner-quality-strong-allowed')).toHaveText('NO');
  await expect(panel.getByTestId('scanner-quality-hard-filter')).toHaveText('미확인');
  await expect(panel.getByTestId('scanner-quality-rank')).toHaveText('미확인');
  await expect(panel.getByText('차단 · STALE_CANDLES · 캔들 freshness 기준 미충족', { exact: true })).toBeVisible();
  expect(await panel.getByText('미확인', { exact: true }).count()).toBeGreaterThan(5);
  expect(forbidden).toEqual([]);
});
