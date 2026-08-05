import { test, expect, type Page, type Route } from '@playwright/test';

function captureFailures(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const unexpectedHttpErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) {
      unexpectedHttpErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  return { consoleErrors, pageErrors, unexpectedHttpErrors };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function isOrderLikeMutation(method: string, pathname: string) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false;
  return /\/api\/(?:trade-automation\/(?:scanner\/plans|plans\/[^/]+\/(?:approve|approve-paper)|orders|emergency-stop)|stocks\/auto-trade|crypto\/[^/]+\/(?:orders?|auto))/.test(pathname);
}

test('approval lifecycle UI entry and reload create zero order-like mutations', async ({ page }) => {
  const failures = captureFailures(page);
  const orderLikeMutations: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (isOrderLikeMutation(request.method(), url.pathname)) {
      orderLikeMutations.push(`${request.method()} ${url.pathname}`);
    }
  });

  await page.goto('/__phase12-trade-automation-e2e');
  await expect(page.getByRole('heading', { name: '승인형 주문', exact: true })).toBeVisible();
  await expect(page.getByTestId('approval-plan-ready-plan')).toHaveCount(1);
  await expect(page.getByTestId('approval-plan-invalid-plan')).toHaveCount(1);
  await expect(page.getByTestId('approve-plan-ready-plan')).toBeEnabled();
  await expect(page.getByTestId('approve-plan-invalid-plan')).toBeDisabled();
  expect(orderLikeMutations).toEqual([]);

  await page.reload();
  await expect(page.getByRole('heading', { name: '승인형 주문', exact: true })).toBeVisible();
  await expect(page.getByTestId('approval-plan-ready-plan')).toHaveCount(1);
  await expect(page.getByTestId('approval-plan-invalid-plan')).toHaveCount(1);
  expect(orderLikeMutations).toEqual([]);
  expect(failures.consoleErrors).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
  expect(failures.unexpectedHttpErrors).toEqual([]);
});

test('signal alerts do not present unknown server freshness as current', async ({ page }) => {
  const failures = captureFailures(page);
  await page.route('**/api/trade-automation/approval-alerts?limit=50', async (route) => {
    await fulfillJson(route, {
      ok: true,
      alerts: [{
        id: 'freshness-unknown-alert',
        planId: 'ready-plan',
        signalId: 'signal-ready',
        symbol: 'BTC',
        market: 'KRW',
        exchange: 'upbit',
        kind: 'CONDITION_MAINTAINED',
        cycle: 1,
        title: 'BTC 조건 유지 확인',
        message: '현재 조건 유지 중',
        eventState: 'READY_FOR_APPROVAL',
        currentSignalState: 'READY_FOR_APPROVAL',
        approvalEnabled: true,
        approvalReasonCode: null,
        approvalExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        score: 82,
        confidence: 78,
        reasonCode: 'SIGNAL_READY',
        createdAt: new Date().toISOString(),
      }],
    });
  });

  await page.goto('/__phase12-trade-automation-e2e?fixture=network-alerts');
  await expect(page.getByText('서버 갱신 시각을 확인할 수 없어 최신 정보로 표시하지 않습니다.')).toBeVisible();
  await expect(page.getByText('마지막 확인 후 갱신 실패')).toBeVisible();
  await expect(page.getByText('마지막 갱신 -')).toBeVisible();
  await expect(page.getByText(/자동 갱신 중/)).toHaveCount(0);
  expect(failures.consoleErrors).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
  expect(failures.unexpectedHttpErrors).toEqual([]);
});

test('changing scanner selection discards the previous approval response', async ({ page }) => {
  const failures = captureFailures(page);
  let requestCount = 0;
  await page.route('**/api/trade-automation/scanner/plans', async (route) => {
    requestCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fulfillJson(route, {
      ok: true,
      duplicate: false,
      serverVerified: true,
      liveOrderEnabled: false,
      plan: {
        id: 'stale-plan',
        symbol: '005930',
        estimatedKrw: 100_000,
        quantity: 1,
        stopPrice: 65_000,
        targetPrices: [75_000],
        splitRatios: [40, 30, 30],
        signalScore: 85,
        signalConfidence: 80,
        signalRiskReward: 2,
        signalExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        state: 'APPROVAL_PENDING',
        signalState: 'READY_FOR_APPROVAL',
      },
    });
  });

  await page.goto('/__phase12-trade-automation-e2e?fixture=composer-race');
  await expect(page.getByText('삼성전자 · 005930')).toBeVisible();
  await page.getByRole('button', { name: '승인 대기 등록', exact: true }).click();
  await expect(page.getByRole('button', { name: '서버 재검증 중...', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '다음 종목 선택', exact: true }).click();
  await expect(page.getByText('SK하이닉스 · 000660')).toBeVisible();
  await expect(page.getByRole('button', { name: '승인 대기 등록', exact: true })).toBeEnabled();
  await page.waitForTimeout(500);

  await expect(page.getByText('서버 검증이 끝났습니다. 승인형 주문 화면에서 최종 승인할 수 있습니다.')).toHaveCount(0);
  await expect(page.getByText('85점', { exact: true })).toHaveCount(0);
  expect(requestCount).toBe(1);
  expect(failures.consoleErrors).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
  expect(failures.unexpectedHttpErrors).toEqual([]);
});
