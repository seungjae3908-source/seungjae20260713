import { expect, type Page } from '@playwright/test';

type ScannerResponse = {
  ok?: boolean;
  partial?: boolean;
  elapsedMs?: number;
  dataState?: string;
  cards?: unknown[];
  message?: string;
  execution?: {
    partial?: boolean;
    timedOut?: boolean;
    timeoutCount?: number;
    elapsedMs?: number;
    deadlineMs?: number;
  };
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
    expect(Number(body.elapsedMs)).toBeLessThanOrEqual(12_000);
    expect(['complete', 'partial', 'unavailable']).toContain(body.dataState);

    if (body.dataState === 'unavailable') {
      expect(body.partial, 'unavailable scanner state must be an explicit partial result').toBe(true);
      expect(body.execution?.partial, 'unavailable scanner state must expose partial execution').toBe(true);
      expect(body.execution?.timedOut, 'unavailable scanner state must be caused by the bounded deadline').toBe(true);
      expect(Number(body.execution?.timeoutCount)).toBeGreaterThanOrEqual(1);
      expect(Number(body.execution?.deadlineMs)).toBeGreaterThan(0);
      expect(Number(body.execution?.deadlineMs)).toBeLessThan(12_000);
      expect(Number(body.execution?.elapsedMs)).toBe(Number(body.elapsedMs));
      expect(body.cards, 'deadline fallback must not fabricate scanner candidates').toEqual([]);
    }

    const responseMessage = String(body.message ?? '').trim();
    expect(
      responseMessage,
      'scanner API must provide the exact user-visible state message',
    ).not.toBe('');
    await expect(
      page.getByText(responseMessage, { exact: true }).first(),
      `scanner UI must display the API state message: ${responseMessage}`,
    ).toBeVisible();

    expect(orderCapableRequests, 'scanner route must not submit order-capable requests').toEqual([]);
  } finally {
    page.off('request', observeRequest);
  }
}
