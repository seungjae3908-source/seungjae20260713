import { expect, test } from '@playwright/test';

test('old-document authorized GET aborts on pagehide instead of leaking into the next route', async ({ page }) => {
  await page.route('**/api/pagehide-read-e2e', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ ok: true }),
    }).catch(() => undefined);
  });

  await page.goto('/login');

  const result = await page.evaluate(async () => {
    const { authorizedFetch } = await import('/src/lib/auth-fetch.ts');
    const request = authorizedFetch('/api/pagehide-read-e2e', {}, { timeoutMs: null })
      .then(() => ({ state: 'fulfilled', name: '' }))
      .catch((error: unknown) => ({
        state: 'rejected',
        name: error instanceof Error ? error.name : String(error),
      }));

    await new Promise((resolve) => window.setTimeout(resolve, 50));
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    return await request;
  });

  expect(result).toEqual({ state: 'rejected', name: 'AbortError' });
});

test('pagehide cancellation is read-only and does not abort an authorized POST transport', async ({ page }) => {
  await page.route('**/api/pagehide-write-e2e', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.goto('/login');

  const result = await page.evaluate(async () => {
    const { authorizedFetch } = await import('/src/lib/auth-fetch.ts');
    const request = authorizedFetch('/api/pagehide-write-e2e', { method: 'POST' }, { timeoutMs: null })
      .then((response) => ({ state: 'fulfilled', status: response.status }))
      .catch((error: unknown) => ({
        state: 'rejected',
        status: error instanceof Error ? error.name : String(error),
      }));

    await new Promise((resolve) => window.setTimeout(resolve, 25));
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    return await request;
  });

  expect(result).toEqual({ state: 'fulfilled', status: 200 });
});
