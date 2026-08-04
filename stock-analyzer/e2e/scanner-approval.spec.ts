import { test, expect, type Page } from '@playwright/test';

const card = {
  ticker: '005930', name: '삼성전자', market: 'KR', currency: 'KRW', price: 70000,
  changePercent: 1.2, score: 78, confidence: 74, matched: ['거래량 증가', '5일선 돌파', 'AI 점수 상위'],
  missing: [], breakoutProbability: 70, expectedPeriod: '단기', entry: ['70000', '68950', '67900'],
  stop: ['67200'], matchCount: 3, selectedCount: 3, riskLevel: 'LOW', riskScore: 30,
  dataState: 'ok', analyzedAt: new Date().toISOString(), scoreBreakdown: {},
};

function signal(state = 'APPROVAL_SENT') {
  return {
    id: 'scanner-KR-005930-20260804060000', market: 'KR', symbol: '005930', displayName: '삼성전자',
    timeframe: '1D', score: state === 'INVALIDATED' ? 42 : 78, confidence: state === 'INVALIDATED' ? 40 : 74,
    riskLevel: state === 'INVALIDATED' ? 'BLOCKED' : 'LOW', matchedSignals: state === 'INVALIDATED' ? [] : card.matched,
    selectedConditions: card.matched, reasons: ['거래량 증가', '단기 추세 회복'], warnings: [], currentPrice: 70000,
    entryPlan: { legs: [
      { sequence: 1, price: 70000, allocationRate: 40, status: state === 'APPROVED' ? 'FILLED' : 'PLANNED' },
      { sequence: 2, price: 68950, allocationRate: 35, status: state === 'INVALIDATED' ? 'CANCELLED' : 'PLANNED' },
      { sequence: 3, price: 67900, allocationRate: 25, status: state === 'INVALIDATED' ? 'CANCELLED' : 'PLANNED' },
    ] },
    targets: [{ price: 74200, exitRate: 50 }, { price: 77000, exitRate: 50 }], stopLoss: 67200,
    expectedRiskReward: 1.5, estimatedMaxLoss: 4000, state,
    generatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(), dataTimestamp: new Date().toISOString(),
  };
}

async function mock(page: Page) {
  let invalidateNext = false;
  await page.route('**/api/market/scan?*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ cards: [card], selected: card.matched, fetchedAt: new Date().toISOString() }),
  }));
  await page.route('**/api/trade-automation/scanner/signals', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
      ok: true, signal: signal(), guard: { enabled: true, reasons: [], checkedAt: new Date().toISOString() },
      plan: { id: 'plan-1', state: 'APPROVAL_PENDING', approvalExpiresAt: new Date(Date.now() + 600000).toISOString() }, approvalToken: 'approval-token-1',
      paperOnly: true, liveOrderEnabled: false, exchangeRequestSent: false,
    }) });
  });
  await page.route('**/api/trade-automation/scanner/signals/plan-1/revalidate', (route) => {
    const current = invalidateNext ? signal('INVALIDATED') : signal();
    const response = {
      ok: true, signal: current,
      guard: invalidateNext
        ? { enabled: false, reasons: ['SIGNAL_STATE_INVALIDATED', 'SELECTED_CONDITION_MISSING'], checkedAt: new Date().toISOString() }
        : { enabled: true, reasons: [], checkedAt: new Date().toISOString() },
      approvalRevoked: invalidateNext, followUpEntriesCancelled: invalidateNext,
      paperOnly: true, liveOrderEnabled: false, exchangeRequestSent: false,
    };
    invalidateNext = false;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });
  await page.route('**/api/trade-automation/scanner/signals/plan-1/approve', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      ok: true, signal: signal('APPROVED'), guard: { enabled: false, reasons: ['ALREADY_APPROVED'], checkedAt: new Date().toISOString() },
      plan: { id: 'plan-1', state: 'SUBMITTED' }, order: { id: 'order-1', state: 'FILLED' }, paperOrderCreated: true,
      liveOrderEnabled: false, exchangeRequestSent: false,
    }),
  }));
  return { invalidate: () => { invalidateNext = true; } };
}

for (const width of [320, 360, 390]) {
  test(`${width}px creates and approves a paper-only scanner plan`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await mock(page);
    const errors: string[] = [];
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto('/__scanner-approval-e2e');
    await expect(page.getByTestId('candidate-list')).toContainText('삼성전자');
    await page.getByRole('button', { name: '승인 요청 만들기' }).click();
    await expect(page.getByTestId('approve-button')).toBeEnabled();
    await page.getByTestId('approve-button').click();
    await expect(page.getByTestId('paper-order-result')).toContainText('FILLED');
    await expect(page.getByTestId('scanner-approval-page')).toContainText('실제 거래소 요청은 전송하지 않았습니다');
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}

test('an open approval button is disabled immediately after signal invalidation', async ({ page }) => {
  const controls = await mock(page);
  await page.goto('/__scanner-approval-e2e');
  await page.getByRole('button', { name: '승인 요청 만들기' }).click();
  await expect(page.getByTestId('approve-button')).toBeEnabled();
  controls.invalidate();
  await page.getByTestId('revalidate-button').click();
  await expect(page.getByTestId('approve-button')).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('SIGNAL_STATE_INVALIDATED');
  await expect(page.getByTestId('signal-state')).toContainText('신호 무효');
});
