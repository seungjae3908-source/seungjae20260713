import { test, expect, type Page } from '@playwright/test';

const candles = Array.from({ length: 40 }, (_, index) => ({ time: new Date(Date.UTC(2026, 6, 1, 0, index * 5)).toISOString(), open: 70000 + index * 10, high: 70100 + index * 10, low: 69900 + index * 10, close: 70050 + index * 10, volume: 1000 + index * 20, isClosed: index < 39 }));

async function mockWorkspace(page: Page) {
  await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/market/scan**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, searchRunId: 'scan:test:1D:1', timeframe: '1D', supportedIndicators: ['거래량 증가', '5일선 돌파', 'AI 점수 상위'], cards: [{ ticker: '000660', name: 'SK하이닉스', market: 'KR', currency: 'KRW', price: 205000, changePercent: 1.2, score: 88, confidence: 82, matched: ['거래량 증가', '5일선 돌파', 'AI 점수 상위'], missing: [], breakoutProbability: 75, expectedPeriod: '단기', entry: ['200000'], stop: ['190000'], matchCount: 3, selectedCount: 3, riskLevel: 'LOW', riskScore: 10, liquidity: 1_000_000_000, dataState: 'ok', analyzedAt: '2026-08-03T00:00:00Z', scoreBreakdown: { trend: { score: 88, status: 'ok', reasons: ['상승 구조'] } } }] }) }));
  await page.route('**/api/stocks/*/chart**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticker: route.request().url().includes('000660') ? '000660' : '005930', timeframe: '1D', provider: 'fixture', fetchedAt: '2026-08-03T00:00:00Z', candles }) }));
  await page.route('**/api/quotes**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ quotes: [{ ticker: '^KS11', changePercent: 0.4 }] }) }));
}

for (const [width, height] of [[360, 800], [390, 844], [430, 932]] as const) {
  test(`AI search selection opens the AI chart analyzer without horizontal overflow at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await mockWorkspace(page);
    await page.goto('/__phase11-ai-workspace-e2e');
    await expect(page.getByRole('heading', { name: 'AI 검색기' })).toBeVisible();
    await page.getByRole('button', { name: '저장 검색' }).click();
    await expect(page.getByText(/저장됨/)).toBeVisible();
    await page.reload();
    await page.getByLabel('저장 검색 복원').selectOption({ index: 1 });
    await expect(page.getByText(/복원됨/)).toBeVisible();
    await page.getByRole('button', { name: '종목보기', exact: true }).click();
    await page.getByText('SK하이닉스', { exact: true }).last().click();
    await page.getByRole('button', { name: 'AI 차트 분석기에서 보기' }).click();
    await expect(page).toHaveURL(/\/ai-chart\?/);
    await expect(page.getByRole('heading', { name: 'AI 차트 분석기' })).toBeVisible();
    await expect(page.getByText('AI 점수').locator('..')).toContainText('88');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}

test('desktop technical workspace keeps AI search, chart, and analysis together', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockWorkspace(page);
  await page.goto('/__phase11-technical-workspace-e2e');
  await expect(page.getByRole('heading', { name: 'AI 검색기' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI 차트 분석기' })).toBeVisible();
  const scanner = page.locator('aside').first();
  await scanner.getByRole('button', { name: '종목보기', exact: true }).click();
  await scanner.getByText('SK하이닉스', { exact: true }).click();
  await scanner.getByRole('button', { name: 'AI 차트 분석기에서 보기' }).click();
  await expect(page).toHaveURL(/\/__phase11-technical-workspace-e2e$/);
  await expect(page.getByText('SK하이닉스', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('AI 점수').last().locator('..')).toContainText('88');
});

test('AI chat handles send, refusal response, and cancellation-safe UI', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/ai/chat', async (route) => {
    calls += 1;
    const request = route.request().postDataJSON();
    if (request.message.includes('느리게')) await new Promise((resolve) => setTimeout(resolve, 2_000));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, kind: request.message.includes('주문') ? 'refusal' : 'answer', answer: request.message.includes('주문') ? '주문 작업은 실행할 수 없습니다.' : 'RSI는 가격 변화의 상대적 강도를 보는 기술지표입니다.' }) }).catch(() => undefined);
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
