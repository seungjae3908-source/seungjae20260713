import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('automatic trading page does not render the legacy approval queue', async ({ page }) => {
  const approvalRequests: string[] = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.includes('/api/trade-automation/approval-queue')
      || /\/api\/trade-automation\/plans\/[^/]+\/(approve|approval-status)/u.test(pathname)) {
      approvalRequests.push(`${request.method()} ${pathname}`);
    }
  });

  await page.goto('/__phase12-trade-automation-e2e?approvalQueue=live');
  await expect(page.getByTestId('trade-approval-queue')).toHaveCount(0);
  await expect(page.getByTestId('auto-trading-safety-summary')).toContainText('주문별 승인');
  await expect(page.getByTestId('auto-trading-safety-summary')).toContainText('불필요');
  expect(approvalRequests).toEqual([]);
});

test('auto trading source has no approval queue dependency', async () => {
  const source = await readFile('src/pages/auto-trading.tsx', 'utf8');
  expect(source).not.toContain('TradeApprovalQueue');
  expect(source).not.toContain('approvalFixture');
  expect(source).toContain('4시장 개별 ON/OFF');
  expect(source).toContain('주문마다 승인을 요청하지 않습니다.');
});
