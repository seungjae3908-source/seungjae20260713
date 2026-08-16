import { expect, test, type Page, type Route } from '@playwright/test';

type Action = 'BUY' | 'SELL' | 'LONG' | 'SHORT' | 'NO_TRADE' | 'UNKNOWN';

const directionLabels: Record<Action, string> = {
  BUY: '↗ 매수 신호',
  SELL: '↘ 보유분 매도·청산 참고',
  LONG: '↑ 롱 신호',
  SHORT: '↓ 숏 신호',
  NO_TRADE: '— 거래 안 함 · NO_TRADE',
  UNKNOWN: '? 현물 방향 확인 필요 · UNKNOWN',
};

function card(action: Action, index: number) {
  const futures = action === 'LONG' || action === 'SHORT';
  const noDirection = action === 'NO_TRADE' || action === 'UNKNOWN';
  return {
    signalId: `direction:${action}:${index}`,
    assetClass: futures ? 'coin_futures' : 'stock',
    market: futures ? 'BITGET' : 'KR',
    exchange: futures ? 'BITGET' : 'KRX',
    symbol: futures ? `BTCUSDT${index}` : `00${5930 + index}`,
    name: `Direction ${action}`,
    currency: futures ? 'USDT' : 'KRW',
    assetType: futures ? 'CRYPTO_FUTURES' : 'STOCK',
    listingStatus: 'LISTED',
    price: 75_000 + index,
    changePercent: 1.2,
    direction: noDirection ? 'NEUTRAL' : (action === 'SELL' || action === 'SHORT' ? 'SHORT' : 'LONG'),
    action,
    signalState: action === 'NO_TRADE' ? 'REJECTED' : 'WATCHING',
    score: 82,
    confidence: 78,
    dataCompleteness: 96,
    riskScore: 20,
    riskLevel: 'LOW',
    liquidity: 1_000_000_000,
    volume: 100_000,
    tradingValue: 7_500_000_000,
    spreadPercent: 0.05,
    volatilityPercent: 1.4,
    matched: ['공개 데이터 확인'],
    notMatched: [],
    unverified: [],
    evidence: [{ key: 'direction', label: '방향 계약', status: 'matched', source: 'fixture', observedAt: '2026-08-16T00:00:00.000Z', reasons: ['canonical action fixture'] }],
    pricePlan: { entryZone: { from: 74_000, to: 75_000 }, invalidation: 70_000, stopLoss: 70_000, targets: [82_000, 86_000], riskReward: 1.6 },
    dataState: 'complete',
    dataSources: ['public-fixture'],
    observedAt: '2026-08-16T00:00:00.000Z',
    expiresAt: '2099-08-16T03:00:00.000Z',
    strongSignalEligible: false,
    warnings: [],
    signalGrade: 'B',
    dataQuality: { state: 'TRUSTED', score: 96, strongSignalAllowed: true, issues: [] },
    aiValidation: { status: 'PASS', provider: 'fixture-validator', counterEvidence: [], missingData: [], risks: [], explanation: 'fixture' },
  };
}

function response() {
  const actions: Action[] = ['BUY', 'SELL', 'LONG', 'SHORT', 'NO_TRADE', 'UNKNOWN'];
  return {
    ok: true,
    requestId: 'direction-badges',
    assetClass: 'stock',
    market: 'KR',
    timeframe: '1D',
    cards: actions.map(card),
    alerts: [],
    failures: [],
    execution: {
      requestedCount: actions.length,
      startedCount: actions.length,
      completedCount: actions.length,
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
      providerAcceptedCount: actions.length,
      dataSuccessCount: actions.length,
      insufficientDataCount: 0,
      filteredByStrategyCount: 0,
      hardFilterRejectedCount: 0,
      finalDisplayedCount: actions.length,
    },
    universe: { totalCount: actions.length, cursor: 0, nextCursor: null, source: 'fixture-public', partial: false, stale: false, listingStatusCoverage: 'listed-or-unknown' },
    dataState: 'complete',
    outcome: 'CANDIDATES_AVAILABLE',
    message: 'direction fixture complete',
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
      await fulfill(route, { ticker: '005930', timeframe: '1D', provider: 'fixture', fetchedAt: '2026-08-16T00:00:00.000Z', candles: [] });
      return;
    }
    await fulfill(route, {});
  });
  await page.route('**/api/market/scan**', (route) => fulfill(route, response()));
}

test('cash and spot show buy-entry wording while futures show long short and selected symbol exposes evidence', async ({ page }) => {
  await installMocks(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/__phase11-technical-workspace-e2e');
  await expect(page.getByRole('heading', { name: 'AI 신호검색기' })).toBeVisible();
  await expect(page.getByTestId('scanner-market-signal-guide')).toContainText('국내주식 · ↗ 매수 신호');

  const badges = page.getByTestId('scanner-card-direction');
  await expect(badges).toHaveCount(6);
  const texts = await badges.allTextContents();
  for (const label of Object.values(directionLabels)) expect(texts).toContain(label);

  const grades = await page.getByTestId('scanner-master-list').getByText('등급 WATCH', { exact: true }).count();
  expect(grades).toBe(6);
  expect(texts.every((text) => !text.includes('WATCH'))).toBe(true);

  await page.getByTestId('scanner-master-list').locator('button').first().click();
  const desktopDetail = page.getByTestId('scanner-desktop-detail');
  const detail = desktopDetail.getByTestId('scanner-direction-badge');
  await expect(detail).toBeVisible();
  await expect(detail).toHaveText(directionLabels.BUY);
  await expect(desktopDetail.getByRole('heading', { name: '왜 이 신호인가' })).toBeVisible();
  await expect(desktopDetail.getByText('공개 데이터 확인').first()).toBeVisible();
  await expect(desktopDetail.getByText('canonical action fixture').first()).toBeVisible();

  await page.getByRole('button', { name: /코인 선물/ }).click();
  await expect(page.getByTestId('scanner-market-signal-guide')).toContainText('코인 선물 · ↑ 롱 신호 / ↓ 숏 신호');
});

for (const [width, height] of [[320, 760], [360, 800], [390, 844], [412, 915], [430, 932]] as const) {
  test(`direction badge and evidence stay visible without horizontal overflow at ${width}px`, async ({ page }) => {
    await installMocks(page);
    await page.setViewportSize({ width, height });
    await page.goto('/__phase11-technical-workspace-e2e');
    await expect(page.getByRole('heading', { name: 'AI 신호검색기' })).toBeVisible();
    await expect(page.getByTestId('scanner-market-signal-guide')).toContainText('↗ 매수 신호');
    await expect(page.getByTestId('scanner-card-direction').first()).toHaveText(directionLabels.BUY);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await page.getByTestId('scanner-master-list').locator('button').first().click();
    const sheet = page.getByTestId('scanner-mobile-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('scanner-direction-badge')).toHaveText(directionLabels.BUY);
    await expect(sheet.getByTestId('scanner-evidence-grade')).toHaveText('등급 WATCH');
    await expect(sheet.getByTestId('scanner-ttl-badge')).toContainText('TTL');
    await expect(sheet.getByRole('heading', { name: '왜 이 신호인가 · 핵심 판단' })).toBeVisible();
    await expect(sheet.getByText('공개 데이터 확인').first()).toBeVisible();
    expect(await sheet.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  });
}
