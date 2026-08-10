import { expect, type Page, type Request } from '@playwright/test';

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

export type ScannerReadinessEvidence = {
  httpStatus: number;
  dataState: 'complete' | 'partial' | 'unavailable';
  partial: boolean | undefined;
  executionPartial: boolean | undefined;
  executionTimedOut: boolean | undefined;
  timeoutCount: number;
  deadlineMs: number;
  elapsedMs: number;
  requestElapsedMs: number;
  cards: unknown[];
  message: string;
  orderCapableRequests: string[];
};

function isOrderCapablePath(pathname: string): boolean {
  return /\/(?:orders?|positions?|execute|approve|real-trade)(?:\/|$)/i.test(pathname);
}

function isScannerRequest(request: Request): boolean {
  try {
    const url = new URL(request.url());
    return request.method() === 'GET' && url.pathname === '/api/market/scan';
  } catch {
    return false;
  }
}

export async function expectHealthyScannerRoute(page: Page): Promise<ScannerReadinessEvidence> {
  const orderCapableRequests: string[] = [];
  let scannerRequestStartedAt: number | null = null;
  const observeRequest = (request: Request) => {
    const pathname = new URL(request.url()).pathname;
    if (isOrderCapablePath(pathname)) orderCapableRequests.push(pathname);
    if (isScannerRequest(request) && scannerRequestStartedAt === null) scannerRequestStartedAt = Date.now();
  };
  page.on('request', observeRequest);

  try {
    const scanResponsePromise = page.waitForResponse((response) => isScannerRequest(response.request()), {
      timeout: 20_000,
    });

    const documentResponse = await page.goto('/scanner', { waitUntil: 'domcontentloaded' });
    if (documentResponse) {
      expect(
        documentResponse.status(),
        `/scanner returned HTTP ${documentResponse.status()}`,
      ).toBeLessThan(400);
    }
    await expect(page.getByTestId('scanner-root')).toBeVisible();

    const scanResponse = await scanResponsePromise;
    const scannerResponseAt = Date.now();
    expect(
      scanResponse.status(),
      `scanner API returned HTTP ${scanResponse.status()}`,
    ).toBeGreaterThanOrEqual(200);
    expect(
      scanResponse.status(),
      `scanner API returned HTTP ${scanResponse.status()}`,
    ).toBeLessThan(300);
    expect(scannerRequestStartedAt, 'scanner request start must be observed before its response').not.toBeNull();
    const requestElapsedMs = scannerResponseAt - Number(scannerRequestStartedAt);
    expect(
      requestElapsedMs,
      'scanner HTTP response must complete within the 12s browser contract',
    ).toBeLessThanOrEqual(12_000);

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

    return {
      httpStatus: scanResponse.status(),
      dataState: body.dataState as ScannerReadinessEvidence['dataState'],
      partial: body.partial,
      executionPartial: body.execution?.partial,
      executionTimedOut: body.execution?.timedOut,
      timeoutCount: Number(body.execution?.timeoutCount ?? 0),
      deadlineMs: Number(body.execution?.deadlineMs ?? 0),
      elapsedMs: Number(body.elapsedMs ?? 0),
      requestElapsedMs,
      cards: body.cards ?? [],
      message: responseMessage,
      orderCapableRequests,
    };
  } finally {
    page.off('request', observeRequest);
  }
}
