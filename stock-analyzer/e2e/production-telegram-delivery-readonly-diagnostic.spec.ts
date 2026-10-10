import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  loginProductionReadOnly,
  productionReadOnlyAccessToken,
} from './support/production-readonly-login';

const expectedDeploySha = String(process.env.EXPECTED_DEPLOY_SHA ?? '').trim().toLowerCase();
const failedProductionRunId = Number(process.env.FAILED_PRODUCTION_RUN_ID ?? 0);
const windowStart = String(process.env.DIAGNOSTIC_WINDOW_START ?? '').trim();
const windowEnd = String(process.env.DIAGNOSTIC_WINDOW_END ?? '').trim();
const qaLogin = String(process.env.PRODUCTION_QA_LOGIN ?? '').trim();
const qaPassword = String(process.env.PRODUCTION_QA_PASSWORD ?? '').trim();
const artifactDir = path.resolve(
  process.cwd(),
  process.env.PRODUCTION_TELEGRAM_DELIVERY_DIAGNOSTIC_DIR
    ?? 'production-telegram-delivery-diagnostic-artifacts',
);

if (!/^[0-9a-f]{40}$/.test(expectedDeploySha)) throw new Error('EXPECTED_DEPLOY_SHA_INVALID');
if (!Number.isSafeInteger(failedProductionRunId) || failedProductionRunId <= 0) {
  throw new Error('FAILED_PRODUCTION_RUN_ID_INVALID');
}
if (!Number.isFinite(Date.parse(windowStart)) || !Number.isFinite(Date.parse(windowEnd))) {
  throw new Error('DIAGNOSTIC_WINDOW_INVALID');
}
if (!qaLogin || !qaPassword) throw new Error('PRODUCTION_QA_CREDENTIAL_REQUIRED');

type ApiResult<T> = { ok: boolean; status: number; body: T | null };

async function appGet<T>(page: Page, route: string): Promise<ApiResult<T>> {
  const token = await productionReadOnlyAccessToken(page);
  if (!token) throw new Error('PRODUCTION_TELEGRAM_DIAGNOSTIC_AUTH_TOKEN_MISSING');
  const response = await page.request.get(route, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    failOnStatusCode: false,
    timeout: 15_000,
  });
  return {
    ok: response.ok(),
    status: response.status(),
    body: await response.json().catch(() => null) as T | null,
  };
}

function safeCode(value: unknown) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z0-9_:-]{1,120}$/.test(code) ? code : null;
}

function safeIso(value: unknown) {
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function deliveryRef(value: unknown) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16);
}

function classify(deliveries: Array<Record<string, unknown>>, endMs: number) {
  if (deliveries.length === 0) return 'NO_MATCHING_DELIVERY';
  const errors = [...new Set(deliveries.map((item) => safeCode(item.lastErrorCode)).filter(Boolean))];
  if (errors.length > 0) return errors.join(',');
  if (deliveries.some((item) => item.state === 'DEAD_LETTER')) return 'DEAD_LETTER_WITHOUT_ERROR_CODE';
  if (deliveries.some((item) => item.state === 'RETRY_SCHEDULED' || item.state === 'FAILED')) {
    return 'RETRY_WITHOUT_ERROR_CODE';
  }
  if (deliveries.some((item) => item.state === 'SENDING')) return 'WORKER_STALLED_OR_IN_FLIGHT';
  if (deliveries.some((item) => item.state === 'PENDING')) return 'WORKER_QUEUE_STARVATION_OR_NOT_TICKING';
  if (deliveries.some((item) => item.state === 'SENT'
    && Date.parse(String(item.updatedAt ?? '')) > endMs)) return 'DELIVERY_RECOVERED_AFTER_QA_DEADLINE';
  if (deliveries.some((item) => item.state === 'SENT')) return 'SENT_WITHIN_QA_WINDOW_NOT_OBSERVED';
  return 'UNKNOWN_DELIVERY_STATE';
}

test('read exact failed-window Telegram delivery state without messages or financial mutation', async ({ page }) => {
  await loginProductionReadOnly(page, { login: qaLogin, password: qaPassword });
  const response = await appGet<any>(page, '/api/user-integrations');
  expect(response.ok, `USER_INTEGRATIONS_HTTP_${response.status}`).toBe(true);
  expect(response.body?.ok).toBe(true);
  expect(response.body?.telegramStorageAvailable).toBe(true);
  expect(Array.isArray(response.body?.deliveries)).toBe(true);

  const startMs = Date.parse(windowStart);
  const endMs = Date.parse(windowEnd);
  const deliveries = (response.body.deliveries as Array<Record<string, unknown>>)
    .filter((item) => {
      const createdMs = Date.parse(String(item.createdAt ?? ''));
      return (item.kind ?? 'EXECUTION_EVENT') === 'EXECUTION_EVENT'
        && Number.isFinite(createdMs)
        && createdMs >= startMs
        && createdMs <= endMs;
    });
  const sanitized = deliveries.map((item) => ({
    deliveryRef: deliveryRef(item.id),
    state: safeCode(item.state) ?? 'INVALID_STATE',
    attempts: Number.isSafeInteger(item.attempts) && Number(item.attempts) >= 0
      ? Number(item.attempts)
      : null,
    lastErrorCode: safeCode(item.lastErrorCode),
    kind: item.kind === 'EXECUTION_EVENT' ? 'EXECUTION_EVENT' : 'OTHER',
    createdAt: safeIso(item.createdAt),
    updatedAt: safeIso(item.updatedAt),
    nextRetryAt: safeIso(item.nextRetryAt),
  }));
  const states = Object.fromEntries(
    [...new Set(sanitized.map((item) => item.state))]
      .sort()
      .map((state) => [state, sanitized.filter((item) => item.state === state).length]),
  );
  const rootCauseClassification = classify(deliveries, endMs);

  mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(artifactDir, 'production-telegram-delivery-readonly-diagnostic.json'), `${JSON.stringify({
    schemaVersion: 'production-telegram-delivery-readonly-diagnostic-v1',
    generatedAt: new Date().toISOString(),
    targetSha: expectedDeploySha,
    failedProductionRunId,
    diagnosticWindow: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
    rootCauseClassification,
    matchingDeliveryCount: sanitized.length,
    states,
    deliveries: sanitized,
    telegramConnected: response.body?.telegram?.connected === true,
    telegramRuntime: {
      deliveryReady: response.body?.telegramRuntime?.deliveryReady === true,
      backgroundWorkersEnabled: response.body?.telegramRuntime?.backgroundWorkersEnabled === true,
      personalWorkerEnabled: response.body?.telegramRuntime?.personalWorkerEnabled === true,
      personalWorkerStarted: response.body?.telegramRuntime?.personalWorkerStarted === true,
      workerActivationApproved: response.body?.telegramRuntime?.workerActivationApproved === true,
    },
    readOnly: true,
    telegramMessagesSent: 0,
    orders: 0,
    cancels: 0,
    amends: 0,
    transfers: 0,
    withdrawals: 0,
    liveTradingAuthorityGranted: false,
    autoTradingAuthorityGranted: false,
    secretValuesRecorded: false,
    accountValuesRecorded: false,
  }, null, 2)}\n`, { mode: 0o600 });

  expect(sanitized.length, 'NO_MATCHING_DELIVERY_IN_EXACT_FAILED_STEP_WINDOW').toBeGreaterThanOrEqual(1);
});
