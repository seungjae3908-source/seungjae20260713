import { expect, type Page } from '@playwright/test';

type ScannerResponse = {
  ok?: boolean;
  partial?: boolean;
  elapsedMs?: number;
  dataState?: string;
  cards?: unknown[];
};

function isOrderCapablePath(pathname: string): boolean {
  return /\/(?:orders?|positions?|execute|approve|real-trade)(?:\/|$)/i.test(pathname);
}

export async function expectHealthyScannerRoute(page: Page): Promise<void> {
  const orderCapableRequests: string[] = [];
  const observeRequest = (request: { url(): string }) => {
    const pathname = new URL(request.url()).pathname;
    if (isOrderCapablePath(pathname)) orderCapableRequests.push(pathname);
  };
  page.on('request', observeRequest);

  try {
    const scanResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.pathname === '/api/market/scan';
    }, { timeout: 20_000 });

    const documentResponse = await page.goto('/scanner', { waitUntil: 'domcontentloaded' });
    if (documentResponse) {
      expect(
        documentResponse.status(),
        `/scanner returned HTTP ${documentResponse.status()}`,
      ).toBeLessThan(400);
    }
    await expect(page.getByTestId('scanner-root')).toBeVisible();

    const scanResponse = await scanResponsePromise;
    expect(
      scanResponse.status(),
      `scanner API returned HTTP ${scanResponse.status()}`,
    ).toBeLessThan(500);
    expect(scanResponse.ok(), 'scanner API must return a bounded 2xx response').toBeTruthy();

    const body = await scanResponse.json() as ScannerResponse;
    expect(body.ok).toBe(true);
    expect(Number(body.elapsedMs)).toBeLessThanOrEqual(15_000);
    expect(['complete', 'partial']).toContain(body.dataState);

    if (body.partial) {
      await expect(page.getByTestId('scanner-partial')).toBeVisible();
    } else if (Array.isArray(body.cards) && body.cards.length === 0) {
      await expect(page.getByTestId('scanner-empty')).toBeVisible();
    } else {
      await expect(page.getByTestId('scanner-success')).toBeVisible();
    }

    expect(orderCapableRequests, 'scanner route must not submit order-capable requests').toEqual([]);
  } finally {
    page.off('request', observeRequest);
  }
}
