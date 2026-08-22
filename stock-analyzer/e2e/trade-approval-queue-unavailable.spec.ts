import { test, expect, type Page } from '@playwright/test';

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
      body: JSON.stringify({
        ok: false,
        error: 'TRADE_AUTOMATION_BACKEND_UNAVAILABLE',
      }),
    });
  });

  return () => mutationRequests;
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

    const refresh = page.getByRole('button', { name: '승인 대기 신호 새로고침' });
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(queue.getByTestId('approval-queue-unavailable')).toBeVisible();

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(getMutationRequests()).toBe(0);
  });
}
