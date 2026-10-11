import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { installProductionReadOnlyPolicy } from './support/production-readonly-policy';
import {
  loginProductionReadOnly,
  productionReadOnlyAccessToken,
} from './support/production-readonly-login';

const baseUrl = String(process.env.PRODUCTION_BASE_URL ?? '').trim().replace(/\/$/, '');
const qaLogin = String(process.env.PRODUCTION_QA_LOGIN ?? '').trim();
const qaPassword = String(process.env.PRODUCTION_QA_PASSWORD ?? '');
const enabled = Boolean(
  baseUrl
  && qaLogin
  && qaPassword
  && process.env.PRODUCTION_READONLY_E2E === 'true',
);
const productionOrigin = baseUrl ? new URL(baseUrl).origin : 'http://production-qa-disabled.invalid';
const artifactDir = path.resolve('production-comprehensive-artifacts');

type ScannerBody = {
  ok?: boolean;
  error?: string;
  assetClass?: string;
  market?: string;
  cards?: unknown[];
  failures?: unknown[];
  dataState?: string;
  outcome?: string;
  orderSubmitted?: boolean;
  exchangeRequestSent?: boolean;
  execution?: {
    requestedCount?: number;
    completedCount?: number;
    providerErrorCount?: number;
    timeoutCount?: number;
    dataSuccessCount?: number;
    timedOut?: boolean;
  };
  universe?: { totalCount?: number; source?: string; stale?: boolean };
};

const strictReadOnlyFilters = 'strategy=scalping&timeframe=5m&cursor=0&batchSize=10&minimumScore=100&maximumRiskScore=0';
const cases = [
  { lane: 'KR_STOCK', assetClass: 'stock', url: `/api/market/scan?market=KR&${strictReadOnlyFilters}` },
  { lane: 'US_STOCK', assetClass: 'stock', url: `/api/market/scan?market=US&${strictReadOnlyFilters}` },
  { lane: 'CRYPTO_SPOT', assetClass: 'coin_spot', url: `/api/scanner/crypto/spot?condition=trend&${strictReadOnlyFilters}` },
  { lane: 'CRYPTO_FUTURES', assetClass: 'coin_futures', url: `/api/scanner/crypto/futures?condition=trend&${strictReadOnlyFilters}` },
] as const;

test.describe('Production four-market Signal Scanner read-only QA', () => {
  test.skip(!enabled, 'Dedicated Production QA credentials and read-only flag are required');

  test('all four real provider lanes return a valid zero-signal or candidate response', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'prod-desktop-1440', 'One exact Production sample prevents duplicate provider load');
    test.setTimeout(120_000);

    const blocked: string[] = [];
    await installProductionReadOnlyPolicy(page, productionOrigin, (request, reason) => {
      blocked.push(`${reason}:${request.method()}:${new URL(request.url()).pathname}`);
    });
    await loginProductionReadOnly(page, { login: qaLogin, password: qaPassword });
    const token = await productionReadOnlyAccessToken(page);
    expect(token, 'Authenticated Production scanner QA token is required').toBeTruthy();

    const evidence = [];
    for (const scannerCase of cases) {
      const startedAt = Date.now();
      const response = await page.request.get(`${baseUrl}${scannerCase.url}`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        timeout: 25_000,
        failOnStatusCode: false,
      });
      const body = await response.json().catch(() => ({})) as ScannerBody;
      expect(response.status(), `${scannerCase.lane} scanner HTTP status; error=${body.error ?? 'none'}`).toBe(200);
      expect(body.ok, `${scannerCase.lane} scanner contract`).toBe(true);
      expect(body.assetClass, `${scannerCase.lane} asset class`).toBe(scannerCase.assetClass);
      expect(Array.isArray(body.cards), `${scannerCase.lane} cards`).toBe(true);
      expect(Array.isArray(body.failures), `${scannerCase.lane} failures`).toBe(true);
      expect(body.orderSubmitted, `${scannerCase.lane} order authority`).toBe(false);
      expect(body.exchangeRequestSent, `${scannerCase.lane} exchange authority`).toBe(false);

      const outcome = String(body.outcome ?? '');
      expect(outcome === 'PROVIDER_FAILURE', `${scannerCase.lane} provider failure`).toBe(false);
      expect(outcome === 'REQUEST_TIMEOUT', `${scannerCase.lane} request timeout`).toBe(false);
      expect(body.execution?.timedOut, `${scannerCase.lane} execution timeout`).toBe(false);
      expect(Number(body.execution?.timeoutCount ?? 0), `${scannerCase.lane} timeout count`).toBe(0);
      expect(String(body.dataState ?? ''), `${scannerCase.lane} data state`).not.toBe('unavailable');
      expect(String(body.dataState ?? ''), `${scannerCase.lane} trust state`).not.toBe('untrusted');
      expect(Number(body.universe?.totalCount ?? 0), `${scannerCase.lane} real universe`).toBeGreaterThan(0);
      expect(String(body.universe?.source ?? ''), `${scannerCase.lane} universe source`).not.toBe('unavailable');

      evidence.push({
        lane: scannerCase.lane,
        status: response.status(),
        durationMs: Date.now() - startedAt,
        outcome,
        dataState: body.dataState ?? null,
        universeSource: body.universe?.source ?? null,
        universeCount: Number(body.universe?.totalCount ?? 0),
        requestedCount: Number(body.execution?.requestedCount ?? 0),
        completedCount: Number(body.execution?.completedCount ?? 0),
        dataSuccessCount: Number(body.execution?.dataSuccessCount ?? 0),
        providerErrorCount: Number(body.execution?.providerErrorCount ?? 0),
        timeoutCount: Number(body.execution?.timeoutCount ?? 0),
        candidateCount: Array.isArray(body.cards) ? body.cards.length : 0,
        orderSubmitted: body.orderSubmitted,
        exchangeRequestSent: body.exchangeRequestSent,
      });
    }

    expect(blocked, 'Signal Scanner QA attempted a client mutation').toEqual([]);
    fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(artifactDir, 'production-four-market-signal-scanner.json'),
      `${JSON.stringify({
        schemaVersion: 'production-four-market-signal-scanner-v1',
        generatedAt: new Date().toISOString(),
        complete: true,
        validZeroSignalAccepted: true,
        lanes: evidence,
        blockedMutationRequests: blocked.length,
        actualOrders: 0,
        executionAuthority: 'NONE',
        secretValuesRecorded: false,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
  });
});
