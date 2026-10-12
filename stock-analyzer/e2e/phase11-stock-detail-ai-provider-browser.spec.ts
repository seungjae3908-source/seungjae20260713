import { expect, test, type Page } from '@playwright/test';

test.skip(process.env.PHASE10_STAGING_E2E === 'true',
  'Local-only phase11 fixture route is never exposed on Staging or Production.');

const routeToDetail = (market: 'KR' | 'US', ticker: string) =>
  `/__phase11-stock-detail-ai-e2e?market=${market}&ticker=${ticker}&tab=analysis`;

async function mockPublicAi(
  page: Page,
  handler: (body: any) => Record<string, unknown> | Promise<Record<string, unknown>>,
  responseStatus = 200,
) {
  const requests: any[] = [];
  const financialWrites: string[] = [];
  page.on('request', (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())
      && /\/api\/.*(?:order|trade-automation|margin|leverage|transfer|withdraw|positions)/i.test(request.url())) {
      financialWrites.push(`${request.method()} ${request.url()}`);
    }
  });
  await page.route('**/api/**', route => route.fulfill({
    status: 200, contentType: 'application/json', body: '{}',
  }));
  await page.route('**/api/ai/chat', async route => {
    const body = route.request().postDataJSON();
    requests.push(body);
    await route.fulfill({
      status: responseStatus, contentType: 'application/json', body: JSON.stringify(await handler(body)),
    }).catch(() => undefined);
  });
  return { requests, financialWrites };
}

function providerReply(body: any) {
  return {
    ok: true, kind: 'answer', answer: '확인된 공개자료에 근거한 분석입니다.',
    selection: body.context,
    provider: 'groq', model: 'test-only-provider-model', fallbackUsed: false,
    data: {
      status: 'partial', asOf: new Date().toISOString(), basis: 'server_collection_time',
      sources: ['테스트 공개자료'], missing: ['선택한 시간봉 1D OHLCV'],
    },
  };
}

test('real stock-detail AI panel calls the authenticated AI provider only after a click and preserves identity', async ({ page }) => {
  const { requests, financialWrites } = await mockPublicAi(page, providerReply);
  await page.goto(routeToDetail('US', 'AAPL'));
  const request = page.getByTestId('stock-ai-request-analysis');
  await expect(request).toBeVisible();
  expect(requests).toHaveLength(0);
  await request.click();
  await expect(page.getByTestId('stock-ai-grounded-answer'))
    .toHaveText('확인된 공개자료에 근거한 분석입니다.');
  expect(requests).toHaveLength(1);
  expect(requests[0].context).toEqual({
    market: 'US', symbol: 'AAPL', ticker: 'AAPL', timeframe: '1D', action: null,
  });
  await expect(page.getByTestId('stock-ai-evidence-result')).toContainText('Groq');
  expect(financialWrites).toEqual([]);
});

test('cross-stock reply cannot appear as successful AI analysis in the actual stock-detail page', async ({ page }) => {
  const { requests, financialWrites } = await mockPublicAi(page, body => ({
    ...providerReply(body), selection: { ...body.context, ticker: '000660', symbol: '000660' },
  }));
  await page.goto(routeToDetail('KR', '005930'));
  await page.getByTestId('stock-ai-request-analysis').click();
  await expect(page.getByRole('alert'))
    .toContainText('시장·종목·시간봉이 선택 내용과 달라');
  await expect(page.getByTestId('stock-ai-evidence-result')).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(financialWrites).toEqual([]);
});

test('future collection timestamp cannot be shown as a current grounded AI opinion', async ({ page }) => {
  const { requests, financialWrites } = await mockPublicAi(page, body => ({
    ...providerReply(body),
    data: {
      ...providerReply(body).data,
      asOf: new Date(Date.now() + 86_400_000).toISOString(),
    },
  }));
  await page.goto(routeToDetail('US', 'AAPL'));
  await page.getByTestId('stock-ai-request-analysis').click();
  await expect(page.getByRole('alert'))
    .toContainText('자료 출처·수집 시각·누락 근거');
  await expect(page.getByTestId('stock-ai-evidence-result')).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(financialWrites).toEqual([]);
});

// Provider failures must not be displayed as successful model answers.
test('AI provider 429 is explained without fabricated analysis or financial writes', async ({ page }) => {
  const { requests, financialWrites } = await mockPublicAi(page,
    () => ({ ok: false, error: 'AI_CHAT_RATE_LIMITED' }), 429);
  await page.goto(routeToDetail('US', 'AAPL'));
  await expect(page.getByTestId('stock-ai-request-analysis')).toBeVisible();
  expect(requests).toHaveLength(0);
  await page.getByTestId('stock-ai-request-analysis').click();
  await expect(page.getByRole('alert')).toContainText('AI 요청 한도에 도달했습니다');
  await expect(page.getByTestId('stock-ai-evidence-result')).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(financialWrites).toEqual([]);
});

test('cancelling an in-flight AI request prevents late provider results from repainting the stock page', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { requests, financialWrites } = await mockPublicAi(page, async (body) => {
    await gate;
    return providerReply(body);
  });
  await page.goto(routeToDetail('US', 'AAPL'));
  await page.getByTestId('stock-ai-request-analysis').click();
  await expect(page.getByRole('button', { name: 'AI 분석 요청 취소' })).toBeVisible();
  await page.getByRole('button', { name: 'AI 분석 요청 취소' }).click();
  release();
  await expect(page.getByRole('alert')).toContainText('요청을 취소했습니다');
  await expect(page.getByTestId('stock-ai-evidence-result')).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(financialWrites).toEqual([]);
});
