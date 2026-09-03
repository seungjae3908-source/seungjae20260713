import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';

const source = fs.readFileSync(path.resolve(process.cwd(), 'src/components/trade-approval-queue.tsx'), 'utf8');

async function mockApprovalQueueUnavailable(page: Page) {
  let mutationRequests = 0;

  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/trade-automation/')) return;
    if (request.method() !== 'GET') mutationRequests += 1;
  });

  await page.route(/\/api\/trade-automation\/approval-queue(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'TRADE_AUTOMATION_BACKEND_UNAVAILABLE' }),
    });
  });

  return () => mutationRequests;
}

function queueItem() {
  const updatedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  return {
    id: 'plan-stale-1',
    exchange: 'bitget',
    accountMode: 'paper',
    strategyId: 'test-strategy',
    signalId: 'signal-stale-1',
    symbol: 'BTCUSDT',
    market: 'CRYPTO_FUTURES',
    side: 'long',
    orderType: 'market',
    estimatedKrw: 100_000,
    quantity: 0.001,
    limitPrice: null,
    stopPrice: 90_000,
    targetPrices: [110_000],
    splitRatios: [100],
    leverage: 2,
    signalReasons: ['test'],
    signalWarnings: [],
    signalScore: 80,
    signalConfidence: 75,
    signalRiskReward: 2,
    signalState: 'READY_FOR_APPROVAL',
    signalInvalidationReason: null,
    state: 'APPROVAL_PENDING',
    approvalExpiresAt: expiresAt,
    updatedAt,
    approval: {
      approvalEnabled: true,
      signalState: 'READY_FOR_APPROVAL',
      planState: 'APPROVAL_PENDING',
      reasonCode: null,
      expiresAt,
      lastValidatedAt: updatedAt,
    },
    order: null,
  };
}

for (const width of [360, 390, 412, 430]) {
  test(`approval queue 503 is truthful and touch-safe at ${width}px`, async ({ page }) => {
    const getMutationRequests = await mockApprovalQueueUnavailable(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/__phase12-trade-automation-e2e?approvalQueue=live');

    const queue = page.getByTestId('trade-approval-queue');
    await expect(queue).toBeVisible();
    await expect(queue.getByTestId('approval-queue-unavailable')).toBeVisible();
    await expect(queue.getByTestId('approval-queue-empty')).toHaveCount(0);
    await expect(queue).toContainText('승인 대기 신호를 확인할 수 없습니다.');
    await expect(queue).not.toContainText('현재 승인 대기 신호가 없습니다.');

    const summary = queue.locator('[aria-label="승인 상태 요약"]');
    await expect(summary.locator('p.text-base')).toHaveText(['-', '-', '-']);

    const refresh = page.getByRole('button', { name: '승인 대기 신호 새로고침' });
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(queue.getByTestId('approval-queue-unavailable')).toBeVisible();

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(getMutationRequests()).toBe(0);
  });
}

test('last-good approval data becomes stale and locks approve and reject after refresh failure', async ({ page }) => {
  let queueReads = 0;
  let mutationRequests = 0;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/trade-automation/')) return;
    if (request.method() !== 'GET') mutationRequests += 1;
  });
  await page.route(/\/api\/trade-automation\/approval-queue(?:\?.*)?$/, async (route) => {
    queueReads += 1;
    if (queueReads === 1) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, items: [queueItem()], count: 1, updatedAt: new Date().toISOString() }),
      });
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'TRADE_AUTOMATION_BACKEND_UNAVAILABLE' }),
    });
  });

  await page.goto('/__phase12-trade-automation-e2e?approvalQueue=live');
  const queue = page.getByTestId('trade-approval-queue');
  await expect(queue.getByTestId('approval-plan-plan-stale-1')).toBeVisible();
  await page.getByRole('button', { name: '승인 대기 신호 새로고침' }).click();
  await expect(queue.getByTestId('approval-queue-unavailable')).toBeVisible();
  await expect(queue).toContainText('마지막 정상 조회 데이터');
  await expect(queue.getByRole('button', { name: '거절' })).toBeDisabled();
  await expect(queue.getByTestId('approve-plan-plan-stale-1')).toBeDisabled();
  await expect(queue.locator('[aria-label="승인 상태 요약"] p.text-base')).toHaveText(['-', '-', '-']);
  expect(mutationRequests).toBe(0);
});

test('source contract keeps uncertain queue state fail-closed for summary and every mutation path', () => {
  expect(source).toContain("const summaryReady = dataState === 'ready' && !stale;");
  expect(source).toContain("value={summaryReady ? summary.available : '-'}");
  expect(source).toContain("value={summaryReady ? summary.expiringSoon : '-'}");
  expect(source).toContain("value={summaryReady ? summary.invalid : '-'}");
  expect(source).toContain("if (mutationLockRef.current || actionId || validatingId || stale || offline || dataState !== 'ready' || !queueMutationAllowedRef.current) return;");
  expect(source).toContain("disabled={anyActionBusy || item.state !== 'APPROVAL_PENDING' || stale || offline || dataState !== 'ready'}");

  const revalidateStart = source.indexOf('const revalidateConfirmation = useCallback');
  const revalidateEnd = source.indexOf('const revalidateOpenDialog = useCallback', revalidateStart);
  const revalidateBlock = source.slice(revalidateStart, revalidateEnd);
  expect(revalidateBlock).not.toContain('setStale(false)');
  expect(revalidateBlock).not.toContain('setLastUpdatedAt(new Date().toISOString())');
});
