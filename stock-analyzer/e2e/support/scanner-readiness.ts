import { expect, type Page, type Request } from '@playwright/test';

type ScannerResponse = {
  ok?: boolean;
  partial?: boolean;
  elapsedMs?: number;
  dataState?: string;
  cards?: unknown[];
  message?: string;
  error?: unknown;
  outcome?: unknown;
  providerHealth?: unknown;
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

type ScannerOpenOptions = {
  open?: () => Promise<void>;
};

function safeDiagnosticText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim();
  return normalized ? normalized.slice(0, maximumLength) : null;
}

export function scannerFailureDiagnostic(status: number, value: unknown): string {
  const body = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const providerRows = Array.isArray(body?.providerHealth) ? body.providerHealth : [];
  const providerHealth = providerRows.slice(0, 8).flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const candidate = row as Record<string, unknown>;
    return [{
      provider: safeDiagnosticText(candidate.provider, 80),
      state: safeDiagnosticText(candidate.state, 40),
      latencyMs: typeof candidate.latencyMs === 'number' && Number.isFinite(candidate.latencyMs)
        ? Math.max(0, Math.round(candidate.latencyMs))
        : null,
      retryCount: typeof candidate.retryCount === 'number' && Number.isFinite(candidate.retryCount)
        ? Math.max(0, Math.round(candidate.retryCount))
        : null,
      timeout: candidate.timeout === true,
      freshness: safeDiagnosticText(candidate.freshness, 40),
      failureReason: safeDiagnosticText(candidate.failureReason, 240),
    }];
  });

  return JSON.stringify({
    httpStatus: status,
    error: safeDiagnosticText(body?.error, 80),
    outcome: safeDiagnosticText(body?.outcome, 80),
    dataState: safeDiagnosticText(body?.dataState, 40),
    providerHealth,
  });
}

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

export async function expectHealthyScannerRoute(
  page: Page,
  options: ScannerOpenOptions = {},
): Promise<ScannerReadinessEvidence> {
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

    if (options.open) {
      await options.open();
    } else {
      const documentResponse = await page.goto('/scanner', { waitUntil: 'domcontentloaded' });
      if (documentResponse) {
        expect(
          documentResponse.status(),
          `/scanner returned HTTP ${documentResponse.status()}`,
        ).toBeLessThan(400);
      }
    }
    await expect(page.getByTestId('scanner-root')).toBeVisible();

    const scanResponse = await scanResponsePromise;
    const scannerResponseAt = Date.now();
    const parsedBody = await scanResponse.json().catch(() => null) as ScannerResponse | null;
    const diagnostic = scannerFailureDiagnostic(scanResponse.status(), parsedBody);
    expect(
      scanResponse.status(),
      `scanner API returned HTTP ${scanResponse.status()}; diagnostic=${diagnostic}`,
    ).toBeGreaterThanOrEqual(200);
    expect(
      scanResponse.status(),
      `scanner API returned HTTP ${scanResponse.status()}; diagnostic=${diagnostic}`,
    ).toBeLessThan(300);
    expect(
      parsedBody,
      `scanner API returned a non-JSON response; diagnostic=${diagnostic}`,
    ).not.toBeNull();
    expect(scannerRequestStartedAt, 'scanner request start must be observed before its response').not.toBeNull();
    const requestElapsedMs = scannerResponseAt - Number(scannerRequestStartedAt);
    expect(
      requestElapsedMs,
      'scanner HTTP response must complete within the 12s browser contract',
    ).toBeLessThanOrEqual(12_000);

    const body = parsedBody as ScannerResponse;
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
