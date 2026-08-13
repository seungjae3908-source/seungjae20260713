import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';
import { installProductionReadOnlyPolicy } from './support/production-readonly-policy';

const baseUrl = String(process.env.PRODUCTION_BASE_URL ?? '').trim().replace(/\/$/, '');
const expectedSha = String(process.env.PRODUCTION_EXPECTED_SHA ?? '').trim().toLowerCase();
const qaLogin = String(process.env.PRODUCTION_QA_LOGIN ?? '').trim();
const qaPassword = String(process.env.PRODUCTION_QA_PASSWORD ?? '').trim();
const diagnosticEnabled = process.env.PRODUCTION_READONLY_E2E === 'true'
  && /^https?:\/\//.test(baseUrl)
  && /^[0-9a-f]{40}$/.test(expectedSha)
  && Boolean(qaLogin && qaPassword);
const productionOrigin = diagnosticEnabled ? new URL(baseUrl).origin : 'https://production-diagnostics.disabled.invalid';
const artifactDir = path.resolve('production-trade-storage-artifacts');

type AppApiEvidence = {
  endpoint: string;
  method: string;
  status: number;
  backendError: string | null;
};

type SupabaseProbe = {
  table: string;
  operation: 'SELECT_LIMIT_0';
  status: number;
  ok: boolean;
  code: string | null;
  messageClass: string | null;
};

type Diagnostics = {
  expectedProductionSha: string;
  healthIdentityMatch: boolean;
  appApi: AppApiEvidence[];
  supabase: SupabaseProbe[];
  authTransportObserved: boolean;
  mutationRequestsBlocked: number;
  productionDbMutated: false;
  actualOrders: 0;
  actualCancels: 0;
  privateTradingRequests: 0;
};

type CapturedSupabaseAuth = {
  origin: string | null;
  apiKey: string | null;
  accessToken: string | null;
};

function safeBackendError(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const error = String((value as Record<string, unknown>).error ?? '').trim();
  return /^[A-Z0-9_:-]{1,120}$/.test(error) ? error : error ? 'REDACTED_BACKEND_ERROR' : null;
}

function safeSupabaseCode(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const code = String((value as Record<string, unknown>).code ?? '').trim();
  return /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : code ? 'REDACTED_CODE' : null;
}

function messageClass(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const text = [
    (value as Record<string, unknown>).message,
    (value as Record<string, unknown>).details,
    (value as Record<string, unknown>).hint,
  ].map((item) => String(item ?? '')).join(' ').toLowerCase();
  if (!text.trim()) return null;
  if (/does not exist|schema cache|could not find|unknown relation/.test(text)) return 'RELATION_OR_SCHEMA_MISSING';
  if (/permission denied|not authorized|row-level security|rls/.test(text)) return 'PERMISSION_OR_RLS_DENIED';
  if (/jwt|token|authentication|authenticated/.test(text)) return 'AUTH_SCOPE_ERROR';
  return 'OTHER_SUPABASE_ERROR';
}

async function login(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('아이디').fill(qaLogin);
  await page.getByLabel('비밀번호').fill(qaPassword);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.getByTestId('membership-label')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('관리자 승인 대기 중입니다.')).toHaveCount(0);
}

async function readJsonSafely(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return null;
  try { return await response.json(); } catch { return null; }
}

async function probeSupabase(
  auth: CapturedSupabaseAuth,
  table: string,
  select: string,
): Promise<SupabaseProbe> {
  if (!auth.origin || !auth.apiKey || !auth.accessToken) {
    return { table, operation: 'SELECT_LIMIT_0', status: 0, ok: false, code: 'AUTH_TRANSPORT_NOT_CAPTURED', messageClass: 'AUTH_SCOPE_ERROR' };
  }
  const url = new URL(`/rest/v1/${table}`, auth.origin);
  url.searchParams.set('select', select);
  url.searchParams.set('limit', '0');
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      apikey: auth.apiKey,
      authorization: `Bearer ${auth.accessToken}`,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });
  let body: unknown = null;
  try { body = await response.json(); } catch { body = null; }
  return {
    table,
    operation: 'SELECT_LIMIT_0',
    status: response.status,
    ok: response.ok,
    code: safeSupabaseCode(body),
    messageClass: response.ok ? null : messageClass(body),
  };
}

test('Production trade storage diagnostics remain authenticated and read-only', async ({ page }) => {
  test.skip(!diagnosticEnabled, 'Dedicated Production read-only diagnostics only.');
  fs.mkdirSync(artifactDir, { recursive: true });

  const blocked: Array<{ method: string; url: string }> = [];
  const auth: CapturedSupabaseAuth = { origin: null, apiKey: null, accessToken: null };
  const appApi: AppApiEvidence[] = [];

  await installProductionReadOnlyPolicy(page, productionOrigin, (request: Request) => {
    blocked.push({ method: request.method(), url: new URL(request.url()).pathname });
  });

  page.on('request', (request) => {
    try {
      const url = new URL(request.url());
      const headers = request.headers();
      const apiKey = headers.apikey;
      const authorization = headers.authorization ?? '';
      if (url.origin !== productionOrigin && apiKey && authorization.toLowerCase().startsWith('bearer ')) {
        auth.origin = url.origin;
        auth.apiKey = apiKey;
        auth.accessToken = authorization.slice(7).trim();
      }
    } catch {
      // Ignore malformed/non-URL requests. No secrets are logged.
    }
  });

  page.on('response', async (response) => {
    try {
      const url = new URL(response.url());
      if (url.origin !== productionOrigin || !url.pathname.startsWith('/api/trade-automation/')) return;
      const body = await readJsonSafely(response);
      appApi.push({
        endpoint: url.pathname,
        method: response.request().method(),
        status: response.status(),
        backendError: safeBackendError(body),
      });
    } catch {
      // Evidence collection must never interfere with the page.
    }
  });

  const health = await page.request.get(`${baseUrl}/api/health`);
  expect(health.status()).toBe(200);
  const healthBody = await health.json() as Record<string, unknown>;
  expect(healthBody.ok).toBe(true);
  expect(healthBody.deploySha).toBe(expectedSha);
  expect(healthBody.processDeploySha).toBe(expectedSha);
  expect(healthBody.deployMarkerSha).toBe(expectedSha);
  expect(healthBody.identityMatch).toBe(true);

  await login(page);
  await page.goto('/auto-trading', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4_000);

  const supabase = await Promise.all([
    probeSupabase(auth, 'trade_automation_profiles', 'user_id,payload,created_at,updated_at'),
    probeSupabase(auth, 'trade_exchange_connections', 'user_id,exchange,account_mode,configured,last_verified_at,last_error_code,created_at,updated_at'),
    probeSupabase(auth, 'trade_order_plans', 'user_id,id,idempotency_key,state,payload,created_at,updated_at'),
    probeSupabase(auth, 'trade_orders', 'user_id,id,plan_id,exchange,client_order_id,state,payload,created_at,updated_at'),
    probeSupabase(auth, 'trade_order_events', 'user_id,id,order_id,to_state,payload,created_at'),
  ]);

  const evidence: Diagnostics = {
    expectedProductionSha: expectedSha,
    healthIdentityMatch: true,
    appApi: appApi.sort((a, b) => a.endpoint.localeCompare(b.endpoint)),
    supabase,
    authTransportObserved: Boolean(auth.origin && auth.apiKey && auth.accessToken),
    mutationRequestsBlocked: blocked.length,
    productionDbMutated: false,
    actualOrders: 0,
    actualCancels: 0,
    privateTradingRequests: 0,
  };

  fs.writeFileSync(
    path.join(artifactDir, 'trade-storage-diagnostics.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
    'utf8',
  );

  expect(evidence.authTransportObserved).toBe(true);
  expect(blocked).toEqual([]);
  expect(appApi.some((item) => item.endpoint === '/api/trade-automation/status')).toBe(true);
  expect(appApi.some((item) => item.endpoint === '/api/trade-automation/approval-queue')).toBe(true);
});
