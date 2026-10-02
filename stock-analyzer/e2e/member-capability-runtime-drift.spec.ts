import { test, expect, type Page } from '@playwright/test';
import { MEMBER_PERMISSION_MATRIX } from '../../packages/member-access/src/index.js';

async function openPaperFixture(page: Page, futuresEnabled: boolean) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/__phase6-paper-trading-e2e?futures=${futuresEnabled ? 'on' : 'off'}`);
  await expect(page.getByTestId('paper-trading-page')).toBeVisible();
  return errors;
}

async function futuresLoaderCalls(page: Page) {
  return page.evaluate(
    () => (window as typeof window & { __phase6PaperFuturesLoaderCalls?: number }).__phase6PaperFuturesLoaderCalls ?? -1,
  );
}

test('associate paper access does not drift into futures-only runtime reads', async ({ page }) => {
  expect(MEMBER_PERMISSION_MATRIX.associate.canAccessPaperTrading).toBe(true);
  expect(MEMBER_PERMISSION_MATRIX.associate.canAccessFutures).toBe(false);

  const errors = await openPaperFixture(page, MEMBER_PERMISSION_MATRIX.associate.canAccessFutures);
  await expect(page.getByTestId('paper-account')).toBeVisible();
  await expect(page.getByTestId('paper-journal')).toBeVisible();
  await expect(page.getByTestId('paper-futures-access-disabled')).toBeVisible();
  await expect(page.getByTestId('paper-order-form')).toHaveCount(0);
  await page.waitForTimeout(400);

  expect(await futuresLoaderCalls(page)).toBe(0);
  expect(errors).toEqual([]);
});

test('regular paper access preserves futures runtime reads when capability is present', async ({ page }) => {
  expect(MEMBER_PERMISSION_MATRIX.regular.canAccessPaperTrading).toBe(true);
  expect(MEMBER_PERMISSION_MATRIX.regular.canAccessFutures).toBe(true);

  const errors = await openPaperFixture(page, MEMBER_PERMISSION_MATRIX.regular.canAccessFutures);
  await expect(page.getByTestId('paper-order-form')).toBeVisible();
  await expect(page.getByTestId('paper-futures-access-disabled')).toHaveCount(0);
  await expect.poll(() => futuresLoaderCalls(page)).toBeGreaterThanOrEqual(2);
  expect(errors).toEqual([]);
});
