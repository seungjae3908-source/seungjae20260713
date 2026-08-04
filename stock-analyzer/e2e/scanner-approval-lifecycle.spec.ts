import { test, expect, type Page } from '@playwright/test';

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
