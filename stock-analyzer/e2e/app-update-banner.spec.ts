import { expect, test } from '@playwright/test';
import { APP_UPDATE_AVAILABLE_EVENT } from '../src/lib/app-update';

test('new app version notification is explicit and offers user-controlled refresh', async ({ page }) => {
  await page.goto('/install');
  await expect(page.getByTestId('app-update-banner')).toHaveCount(0);

  await page.evaluate((eventName) => {
    window.dispatchEvent(new Event(eventName));
  }, APP_UPDATE_AVAILABLE_EVENT);

  const banner = page.getByTestId('app-update-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('새 버전이 준비되었습니다.');
  await expect(page.getByTestId('refresh-app-update')).toBeVisible();
});
