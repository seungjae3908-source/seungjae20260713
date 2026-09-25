import { test, expect } from '@playwright/test';

test('paper actions reject same-tick reentrancy and release the guard after completion', async ({ page }) => {
  await page.addInitScript(() => {
    const originalSetTimeout = window.setTimeout.bind(window);
    const instrumented = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 120) {
        const target = window as typeof window & { __paperAction120msCalls?: number };
        target.__paperAction120msCalls = (target.__paperAction120msCalls ?? 0) + 1;
      }
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout;
    window.setTimeout = instrumented;
    (window as typeof window & { __paperAction120msCalls?: number }).__paperAction120msCalls = 0;
  });

  await page.goto('/__phase6-paper-trading-e2e');
  await expect(page.getByTestId('paper-trading-page')).toBeVisible();
  await page.getByTestId('paper-submit').click();
  const confirm = page.getByTestId('confirm-paper-order');
  await expect(confirm).toBeVisible();

  const before = await page.evaluate(
    () => (window as typeof window & { __paperAction120msCalls?: number }).__paperAction120msCalls ?? 0,
  );
  await confirm.evaluate((node) => {
    const button = node as HTMLButtonElement;
    button.click();
    button.click();
  });

  await expect(page.getByTestId('paper-positions').getByText('BTCUSDT 롱')).toBeVisible();
  await expect.poll(() => page.evaluate(
    () => (window as typeof window & { __paperAction120msCalls?: number }).__paperAction120msCalls ?? 0,
  )).toBe(before + 1);

  await page.getByTestId('paper-positions').getByRole('button', { name: '25%' }).click();
  await expect(page.getByTestId('paper-positions').getByText('partially_closed')).toBeVisible();
  await expect.poll(() => page.evaluate(
    () => (window as typeof window & { __paperAction120msCalls?: number }).__paperAction120msCalls ?? 0,
  )).toBe(before + 2);
});
