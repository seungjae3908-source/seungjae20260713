import { expect, test, type Page, type Request } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';

const SUPABASE_HOST = 'scanner-chart-e2e.supabase.co';
const SUPABASE_STORAGE_KEY = 'sb-scanner-chart-e2e-auth-token';
const TEST_USER_ID = '00000000-0000-4000-8000-000000000050';
const ORDER_ENDPOINT = /\/api\/(?:stocks\/auto-trade\/(?:plan|execute|monitor|close-plan|close-execute)|crypto\/[^?]*(?:order|execute))/i;

type ChartScenario =
  | 'mixed'
  | 'invalid-only'
  | 'empty'
  | 'rate-limited'
  | 'server-error'
  | 'normal'
  | 'timeframe-race';

type MockState = {
  scenario: ChartScenario;
};

type BrowserEvidence = {
  consoleErrors: string[];
  expectedConsoleDiagnostics: string[];
  pageErrors: string[];
  unhandledRejections: string[];
  unexpectedRequestFailures: string[];
  apiHttpErrors: Array<{ status: number; url: string }>;
  orderRequests: string[];
};

let isolatedVite: ChildProcess | null = null;
let isolatedViteOutput = '';
let isolatedBaseURL = '';

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function encodeJwtPart(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

const ACCESS_TOKEN = [
  encodeJwtPart({ alg: 'HS256', typ: 'JWT' }),
  encodeJwtPart({
    aud: 'authenticated',
    exp: 4_102_444_800,
    role: 'authenticated',
    sub: TEST_USER_ID,
  }),
  Buffer.from('scanner-chart-e2e-signature').toString('base64url'),
].join('.');

function approvedSession() {
  const timestamp = '2026-08-04T08:00:00.000Z';
  return {
    access_token: ACCESS_TOKEN,
    refresh_token: 'scanner-chart-e2e-refresh-token',
    expires_in: 86_400,
    expires_at: 4_102_444_800,
    token_type: 'bearer',
    user: {
      id: TEST_USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'scanner-chart-e2e@example.com',
      email_confirmed_at: timestamp,
      phone: '',
      confirmed_at: timestamp,
      last_sign_in_at: timestamp,
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: { display_name: '차트 E2E' },
      identities: [],
      created_at: timestamp,
      updated_at: timestamp,
    },
  };
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('격리 E2E 서버 포트를 할당하지 못했습니다.'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function analyzerDirectory() {
  return path.basename(process.cwd()) === 'stock-analyzer'
    ? process.cwd()
    : path.resolve(process.cwd(), 'stock-analyzer');
}

async function waitForIsolatedVite(url: string, child: ChildProcess) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`격리 Vite 서버가 조기 종료됐습니다.\n${isolatedViteOutput}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      if (response.status < 500) return;
    } catch {
      // 서버가 준비될 때까지 재시도합니다.
    }
    await wait(250);
  }
  throw new Error(`격리 Vite 서버 시작 시간이 초과됐습니다.\n${isolatedViteOutput}`);
}

async function stopIsolatedVite() {
  const child = isolatedVite;
  isolatedVite = null;
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    wait(5_000),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

function timeframeSeconds(timeframe: string) {
  const values: Record<string, number> = {
    '1m': 60,
    '3m': 180,
    '5m': 300,
    '15m': 900,
    '30m': 1_800,
    '1H': 3_600,
    '4H': 14_400,
    '1D': 86_400,
  };
  return values[timeframe] ?? 300;
}

function validCandles(base: number, timeframe: string) {
  const step = timeframeSeconds(timeframe);
  return Array.from({ length: 40 }, (_, index) => ({
    time: 1_700_000_000 + index * step,
    open: base + index,
    high: base + index + 3,
    low: base + index - 2,
    close: base + index + 1,
    volume: 1_000 + index * 10,
    isClosed: true,
  }));
}

function mixedCandles(base: number, timeframe: string) {
  const rows = validCandles(base, timeframe);
  const step = timeframeSeconds(timeframe);
  return [
    ...rows,
    { time: '', open: 9_998, high: 10_001, low: 9_997, close: 9_999, volume: 10 },
    { time: 'not-a-time', open: 8_887, high: 8_890, low: 8_886, close: 8_888, volume: 10 },
    {
      time: 1_700_000_000 + rows.length * step,
      open: 7_000,
      high: 6_990,
      low: 6_980,
      close: 7_010,
      volume: 10,
    },
  ];
}

function invalidOnlyCandles() {
  return [
    { time: '', open: 100, high: 103, low: 99, close: 101, volume: 100 },
    { time: 'missing-time', open: 101, high: 104, low: 100, close: 102, volume: 110 },
    { time: Number.NaN, open: 102, high: 105, low: 101, close: 103, volume: 120 },
  ];
}

function monitorBrowser(page: Page): BrowserEvidence {
  const evidence: BrowserEvidence = {
    consoleErrors: [],
    expectedConsoleDiagnostics: [],
    pageErrors: [],
    unhandledRejections: [],
    unexpectedRequestFailures: [],
    apiHttpErrors: [],
    orderRequests: [],
  };

  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text.startsWith('[e2e-unhandledrejection]')) {
      evidence.unhandledRejections.push(text);
      return;
    }
    if (/Failed to load resource.*(?:429|500|502|503)/i.test(text)) {
      evidence.expectedConsoleDiagnostics.push(text);
      return;
    }
    evidence.consoleErrors.push(text);
  });
  page.on('pageerror', (error) => evidence.pageErrors.push(error.message));
  page.on('requestfailed', (request: Request) => {
    const errorText = request.failure()?.errorText ?? '';
    if (!/ERR_ABORTED|NS_BINDING_ABORTED/i.test(errorText)) {
      evidence.unexpectedRequestFailures.push(`${request.method()} ${request.url()} ${errorText}`);
    }
  });
  page.on('request', (request) => {
    if (request.method() !== 'GET' && ORDER_ENDPOINT.test(request.url())) {
      evidence.orderRequests.push(`${request.method()} ${request.url()}`);
    }
  });
  page.on('response', (response) => {
    if (!response.url().includes('/api/')) return;
    if (response.status() >= 400) {
      evidence.apiHttpErrors.push({ status: response.status(), url: response.url() });
    }
  });

  return evidence;
}

async function installApprovedUser(page: Page) {
  await page.addInitScript(
    ({ key, session }) => {
      try {
        window.localStorage.setItem(key, session);
      } catch {
        // about:blank에서는 저장소 접근이 제한될 수 있습니다.
      }
      window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
        console.error(`[e2e-unhandledrejection] ${reason}`);
      });
    },
    { key: SUPABASE_STORAGE_KEY, session: JSON.stringify(approvedSession()) },
  );

  await page.route(`https://${SUPABASE_HOST}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  await page.route(`https://${SUPABASE_HOST}/rest/v1/profiles**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Content-Range': '0-0/1' },
      body: JSON.stringify({
        id: TEST_USER_ID,
        login_name: 'chart-e2e',
        display_name: '차트 E2E',
        role: 'regular',
        status: 'approved',
        membership_level: 'regular',
        is_active: true,
        permissions_updated_at: '2026-08-04T08:00:00.000Z',
        updated_at: '2026-08-04T08:00:00.000Z',
      }),
    }),
  );
}

async function installApplicationMocks(page: Page, state: MockState) {
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );

  await page.route('**/api/market/scan**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        searchRunId: 'legacy-chart-broadcast:e2e',
        timeframe: '1D',
        supportedIndicators: [],
        cards: [],
      }),
    }),
  );

  await page.route('**/api/quotes**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        quotes: [
          { ticker: '^KS11', changePercent: 0.2 },
          { ticker: '^KQ11', changePercent: -0.1 },
          { ticker: '^GSPC', changePercent: 0.3 },
          { ticker: '^IXIC', changePercent: 0.4 },
        ],
      }),
    }),
  );

  await page.route('**/api/stocks/auto-trade/status**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'mock',
        enabled: false,
        domesticSupported: true,
        usSupported: false,
        realKeyConfigured: false,
        executionKeyConfigured: false,
      }),
    }),
  );

  await page.route(/\/api\/stocks\/[^/]+\/(?:chart|candles)(?:\?|$)/, async (route) => {
    const requestUrl = new URL(route.request().url());
    const segments = requestUrl.pathname.split('/');
    const ticker = decodeURIComponent(segments.at(-2) ?? '005930').toUpperCase();
    const timeframe = requestUrl.searchParams.get('tf') ?? '5m';

    if (state.scenario === 'rate-limited') {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'RATE_LIMITED' }),
      });
      return;
    }
    if (state.scenario === 'server-error') {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'SERVER_FAILURE' }),
      });
      return;
    }

    if (state.scenario === 'timeframe-race') {
      await wait(timeframe === '1m' ? 900 : 40);
    } else if (state.scenario === 'mixed') {
      await wait(350);
    }

    const frameBase = timeframe === '1m' ? 1_000 : timeframe === '15m' ? 2_000 : 100;
    const base = ticker === 'AAPL' ? 3_000 : frameBase;
    const candles = state.scenario === 'invalid-only'
      ? invalidOnlyCandles()
      : state.scenario === 'empty'
        ? []
        : state.scenario === 'mixed'
          ? mixedCandles(base, timeframe)
          : validCandles(base, timeframe);

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ticker,
        timeframe,
        provider: 'legacy-chart-broadcast-fixture',
        fetchedAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        candles,
      }),
    }).catch(() => undefined);
  });
}

async function openScanner(page: Page, state: MockState) {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApprovedUser(page);
  await installApplicationMocks(page, state);
  await page.goto(`${isolatedBaseURL}/__phase11-ai-workspace-e2e`);
  await expect(page).toHaveURL(/\/__phase11-ai-workspace-e2e$/);
  await expect(page.getByRole('heading', { name: 'AI 검색기', level: 1 })).toBeVisible();
  await expect(page.getByTestId('capability-denied')).toHaveCount(0);
}

test.describe('mobile scanner legacy ChartBroadcastPanel contract', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    const port = await findFreePort();
    isolatedBaseURL = `http://127.0.0.1:${port}`;
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    isolatedVite = spawn(
      pnpm,
      [
        'exec',
        'vite',
        '--config',
        'vite.config.ts',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--strictPort',
      ],
      {
        cwd: analyzerDirectory(),
        env: {
          ...process.env,
          VITE_PHASE4_E2E: 'true',
          VITE_PHASE11_E2E: 'true',
          VITE_SUPABASE_URL: `https://${SUPABASE_HOST}`,
          VITE_SUPABASE_ANON_KEY: ACCESS_TOKEN,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    for (const stream of [isolatedVite.stdout, isolatedVite.stderr]) {
      stream?.on('data', (chunk) => {
        isolatedViteOutput = `${isolatedViteOutput}${String(chunk)}`.slice(-12_000);
      });
    }
    await waitForIsolatedVite(isolatedBaseURL, isolatedVite);
  });

  test.afterAll(async () => {
    await stopIsolatedVite();
  });

  test('opens the real /scanner panel, drops invalid timestamps, handles failures, and recovers', async ({ page }) => {
    const state: MockState = { scenario: 'mixed' };
    const evidence = monitorBrowser(page);
    await openScanner(page, state);

    await page.getByRole('button', { name: 'AI 차트 분석기', exact: true }).click();
    await expect(page.getByText('차트 불러오는 중...', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '차트 불러오기', level: 2 })).toBeVisible();
    await expect(page).toHaveURL(/\/__phase11-ai-workspace-e2e$/);
    await expect(page.getByRole('heading', { name: 'AI 차트 생중계', level: 1 })).toHaveCount(0);

    const currentPrice = page.getByText('현재가', { exact: true }).locator('xpath=../..');
    await expect(currentPrice).toContainText('140원');
    await expect(page.getByText('9,999원', { exact: true })).toHaveCount(0);
    await expect(page.getByText('8,888원', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/상태 stale/)).toBeVisible();
    await page.getByRole('button', { name: '자동 갱신 중', exact: true }).click();

    state.scenario = 'invalid-only';
    await page.getByTitle('차트 새로고침').click();
    await expect(page.getByText('표시할 실제 봉 데이터가 없습니다.', { exact: true })).toBeVisible();
    await expect(page.getByText('AI 차트 분석 타임라인', { exact: true })).toHaveCount(0);

    state.scenario = 'empty';
    await page.getByTitle('차트 새로고침').click();
    await expect(page.getByText('표시할 실제 봉 데이터가 없습니다.', { exact: true })).toBeVisible();

    state.scenario = 'rate-limited';
    await page.getByTitle('차트 새로고침').click();
    await expect(page.getByText('차트 데이터를 불러오지 못했습니다.', { exact: true })).toBeVisible();
    await expect(page.getByText('RATE_LIMITED', { exact: true })).toBeVisible();

    state.scenario = 'server-error';
    await page.getByRole('button', { name: '다시 시도', exact: true }).click();
    await expect(page.getByText('SERVER_FAILURE', { exact: true })).toBeVisible();

    state.scenario = 'normal';
    await page.getByRole('button', { name: '다시 시도', exact: true }).click();
    await expect(currentPrice).toContainText('140원');

    state.scenario = 'timeframe-race';
    await page.getByRole('button', { name: '1분', exact: true }).click();
    await page.getByRole('button', { name: '15분', exact: true }).click();
    await expect(currentPrice).toContainText('2,040원');
    await page.waitForTimeout(1_100);
    await expect(currentPrice).toContainText('2,040원');

    await page.getByRole('button', { name: '해외', exact: true }).click();
    await expect(page.getByRole('heading', { name: '애플', exact: true })).toBeVisible();
    await expect(currentPrice).toContainText('$3,040.00');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    const unexpectedHttpErrors = evidence.apiHttpErrors.filter(
      ({ status }) => status !== 429 && status !== 503,
    );
    expect(evidence.apiHttpErrors.some(({ status }) => status === 429)).toBe(true);
    expect(evidence.apiHttpErrors.some(({ status }) => status === 503)).toBe(true);
    expect(unexpectedHttpErrors).toEqual([]);
    expect(evidence.consoleErrors).toEqual([]);
    expect(evidence.pageErrors).toEqual([]);
    expect(evidence.unhandledRejections).toEqual([]);
    expect(evidence.unexpectedRequestFailures).toEqual([]);
    expect(evidence.orderRequests).toEqual([]);
  });

  test('scanner auto view mounts the same legacy panel without sending an order request', async ({ page }) => {
    const state: MockState = { scenario: 'normal' };
    const evidence = monitorBrowser(page);
    await openScanner(page, state);

    await page.getByRole('button', { name: '자동매매', exact: true }).click();
    await expect(page.getByRole('heading', { name: '차트 불러오기', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: '자동매매 후보 종목', level: 2 })).toBeVisible();
    await expect(page).toHaveURL(/\/__phase11-ai-workspace-e2e$/);
    await page.waitForTimeout(750);

    expect(evidence.orderRequests).toEqual([]);
    expect(evidence.consoleErrors).toEqual([]);
    expect(evidence.pageErrors).toEqual([]);
    expect(evidence.unhandledRejections).toEqual([]);
    expect(evidence.unexpectedRequestFailures).toEqual([]);
    expect(evidence.apiHttpErrors).toEqual([]);
  });
});
