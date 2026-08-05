import { test, expect, type Page } from '@playwright/test';

const candles = Array.from({ length: 40 }, (_, index) => ({
  time: new Date(Date.UTC(2026, 6, 1, 0, index * 5)).toISOString(),
  open: 70000 + index * 10,
  high: 70100 + index * 10,
  low: 69900 + index * 10,
  close: 70050 + index * 10,
  volume: 1000 + index * 20,
  isClosed: index < 39,
}));

const scannerCard = {
  ticker: '000660',
  symbol: '000660',
  name: 'SK하이닉스',
  assetClass: 'stock',
  market: 'KR',
  exchange: 'KRX',
  currency: 'KRW',
  assetType: 'STOCK',
  listingStatus: 'LISTED',
  price: 205000,
  changePercent: 1.2,
  score: 88,
  confidence: 82,
  dataCompleteness: 94,
  matched: ['거래량 증가', '5일선 돌파', 'AI 점수 상위'],
  notMatched: [],
  unverified: [],
  missing: [],
  breakoutProbability: 75,
  expectedPeriod: '단기',
  entry: ['200000'],
  stop: ['190000'],
  matchCount: 3,
  selectedCount: 3,
  riskLevel: 'LOW',
  riskScore: 10,
  liquidity: 1_000_000_000,
  volume: 1_000_000,
  tradingValue: 205_000_000_000,
  spreadPercent: 0.05,
  volatilityPercent: 1.2,
  dataState: 'complete',
  analyzedAt: '2026-08-03T00:00:00Z',
  observedAt: '2026-08-03T00:00:00Z',
  expiresAt: '2026-08-06T00:00:00Z',
  signalId: 'signal:phase11-sk-hynix',
  direction: 'LONG',
  signalState: 'WATCHING',
  strongSignalEligible: true,
  warnings: [],
  dataSources: ['market-quote', 'market-candles'],
  evidence: [{
    key: '거래량 증가',
    label: '거래량 증가',
    status: 'matched',
    source: 'market-candles-volume',
    observedAt: '2026-08-03T00:00:00Z',
    reasons: ['실제 거래량 증가를 확인했습니다.'],
  }],
  pricePlan: {
    entryZone: { from: 200000, to: 205000 },
    invalidation: 190000,
    stopLoss: 190000,
    targets: [220000, 230000],
    riskReward: 1.5,
  },
  scoreBreakdown: { trend: { score: 88, status: 'ok', reasons: ['상승 구조'] } },
};

const scannerPayload = {
  ok: true,
  provider: 'fixture',
  searchRunId: 'scan:test:1D:1',
  requestId: 'scan:test:1D:1',
  assetClass: 'stock',
  timeframe: '1D',
  market: 'KR',
  supportedIndicators: ['거래량 증가', '5일선 돌파', 'AI 점수 상위'],
  rows: [scannerCard],
  cards: [scannerCard],
  results: [scannerCard],
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
    elapsedMs: 10,
    deadlineMs: 12000,
    itemTimeoutMs: 3500,
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
  message: '1종목 공개 데이터 분석을 완료했습니다.',
  generatedAt: '2026-08-03T00:00:00Z',
  orderSubmitted: false,
  exchangeRequestSent: false,
};

async function mockWorkspace(page: Page) {
  await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/market/scan**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(scannerPayload),
  }));
  await page.route('**/api/stocks/*/chart**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ticker: route.request().url().includes('000660') ? '000660' : '005930',
      timeframe: '1D',
      provider: 'fixture',
      fetchedAt: '2026-08-03T00:00:00Z',
      candles,
    }),
  }));
  await page.route('**/api/quotes**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ quotes: [{ ticker: '^KS11', changePercent: 0.4 }] }),
  }));
}

for (const [width, height] of [[360, 800], [390, 844], [430, 932]] as const) {
  test(`AI search selection opens the AI chart broadcast without horizontal overflow at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await mockWorkspace(page);
    await page.goto('/__phase11-ai-workspace-e2e');
    await expect(page.getByRole('heading', { name: 'AI 검색기' })).toBeVisible();
    await page.getByRole('button', { name: '저장 검색' }).click();
    await expect(page.getByText(/저장됨/)).toBeVisible();
    await page.reload();
    await page.getByLabel('저장 검색 복원').selectOption({ index: 1 });
    await expect(page.getByText(/복원됨/)).toBeVisible();
    await page.getByRole('button', { name: /^종목보기/ }).click();
    await page.getByText('SK하이닉스', { exact: true }).last().click();
    await page.getByRole('button', { name: 'AI 차트 분석기에서 보기', exact: true }).click();
    await expect(page).toHaveURL(/\/ai-chart\?/);
    await expect(page.getByRole('heading', { name: 'AI 차트 생중계', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: '현재 차트 컨텍스트' })).toBeVisible();
    await expect(page.getByText('000660 · KR · 1D', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}

test('desktop technical workspace keeps AI signal scanner, chart broadcast, and analysis together', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockWorkspace(page);
  await page.goto('/__phase11-technical-workspace-e2e');
  await expect(page.getByRole('heading', { name: 'AI 신호검색기' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI 차트 생중계', level: 1 })).toBeVisible();
  const scanner = page.locator('aside').first();
  await expect(scanner.getByText('SK하이닉스', { exact: true })).toBeVisible();
  await scanner.getByRole('button', { name: 'AI 차트 분석기에서 보기', exact: true }).click();
  await expect(page).toHaveURL(/\/__phase11-technical-workspace-e2e$/);
  await expect(page.getByRole('heading', { name: '현재 차트 컨텍스트' })).toBeVisible();
  await expect(page.getByText('000660 · KR · 1D', { exact: true })).toBeVisible();
});

test('AI chat handles send, refusal response, and cancellation-safe UI', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/ai/chat', async (route) => {
    calls += 1;
    const request = route.request().postDataJSON();
    if (request.message.includes('느리게')) await new Promise((resolve) => setTimeout(resolve, 2_000));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        kind: request.message.includes('주문') ? 'refusal' : 'answer',
        answer: request.message.includes('주문')
          ? '주문 작업은 실행할 수 없습니다.'
          : 'RSI는 가격 변화의 상대적 강도를 보는 기술지표입니다.',
      }),
    }).catch(() => undefined);
  });
  await page.goto('/__phase11-ai-chat-e2e');
  const input = page.getByPlaceholder(/질문 입력/);
  await input.fill('RSI를 설명해줘');
  await input.press('Enter');
  await expect(page.getByText(/상대적 강도/)).toBeVisible();
  await input.fill('실제 주문 실행해줘');
  await input.press('Enter');
  await expect(page.getByText('주문 작업은 실행할 수 없습니다.')).toBeVisible();
  await input.fill('조금 느리게 설명해줘');
  await input.press('Enter');
  await page.getByRole('button', { name: '요청 취소' }).click();
  await expect(page.getByRole('alert')).toContainText('요청을 취소했습니다.');
  expect(calls).toBe(3);
});
