import { test, expect } from '@playwright/test';

const PAPER_STORAGE_KEY = 'seungjae.paper-trading.v1';

test('delayed market refresh applies to the latest paper state and survives reload', async ({ page }) => {
  await page.goto('/__phase6-paper-trading-e2e?marketDelayMs=350');
  await expect(page.getByTestId('paper-trading-page')).toBeVisible();
  await expect(page.getByTestId('paper-submit')).toBeEnabled();

  await page.getByRole('button', { name: '현재가 갱신' }).click();

  await page.getByTestId('paper-submit').click();
  const confirm = page.getByTestId('confirm-paper-order');
  await expect(confirm).toBeVisible();
  await confirm.click();

  await expect(page.getByTestId('paper-positions').getByText('BTCUSDT 롱')).toBeVisible();

  await expect.poll(async () => page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: { processedEventIds?: unknown[]; positions?: unknown[] } };
    const state = parsed.state ?? parsed;
    return {
      events: Array.isArray(state.processedEventIds) ? state.processedEventIds.length : -1,
      positions: Array.isArray(state.positions) ? state.positions.length : -1,
    };
  }, PAPER_STORAGE_KEY), { timeout: 5_000 }).toEqual({ events: 2, positions: 1 });

  await page.reload();
  await expect(page.getByTestId('paper-trading-page')).toBeVisible();
  await expect(page.getByTestId('paper-positions').getByText('BTCUSDT 롱')).toBeVisible();

  const persisted = await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: { processedEventIds?: unknown[]; positions?: unknown[] } };
    const state = parsed.state ?? parsed;
    return {
      events: Array.isArray(state.processedEventIds) ? state.processedEventIds.length : -1,
      positions: Array.isArray(state.positions) ? state.positions.length : -1,
    };
  }, PAPER_STORAGE_KEY);
  expect(persisted).toEqual({ events: 2, positions: 1 });
});
