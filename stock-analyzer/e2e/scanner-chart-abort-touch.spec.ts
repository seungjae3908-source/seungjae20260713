import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';

const SUPABASE_HOST = 'scanner-chart-abort-e2e.supabase.co';
const SUPABASE_STORAGE_KEY = 'sb-scanner-chart-abort-e2e-auth-token';
const TEST_USER_ID = '00000000-0000-4000-8000-000000000051';
const CHART_ENDPOINT = /\/api\/stocks\/[^/]+\/(?:chart|candles)(?:\?|$)/i;
const ORDER_ENDPOINT = /\/api\/(?:stocks\/auto-trade\/(?:plan|execute|monitor|close-plan|close-execute)|crypto\/[^?]*(?:order|execute))/i;

type MockState = {
  delayOneMinute: boolean;
  failChart: boolean;
  startedChartRequests: string[];
};

type BrowserEvidence = {
  chartAborts: Array<{ url: string; errorText: string }>;
  unexpectedRequestFailures: string[];
  consoleErrors: string[];
  pageErrors: string[];
  unhandledRejections: string[];
  unexpectedHttpErrors: Array<{ status: number; url: string }>;
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
  Buffer.from('scanner-chart-abort-e2e-signature').toString('base64url'),
].join('.');

function approvedSession() {
  const timestamp = '2026-08-04T09:20:00.000Z';
  return {
    access_token: ACCESS_TOKEN,
    refresh_token: 'scanner-chart-abort-e2e-refresh-token',
    expires_in: 86_400,
    expires_at: 4_102_444_800,
    token_type: 'bearer',
    user: {
      id: TEST_USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'scanner-chart-abort-e2e@example.com',
      email_confirmed_at: timestamp,
      phone: '',
      confirmed_at: timestamp,
      last_sign_in_at: timestamp,
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: { display_name: '차트 Abort E2E' },
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
        reject(new Error('격리 Abort E2E 서버 포트를 할당하지 못했습니다.'));
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
    time: 1_700_100_000 + index * step,
    open: base + index,
    high: base + index + 3,
    low: base + index - 2,
    close: base + index + 1,
    volume: 1_000 + index * 10,
    isClosed: true,
  }));
}

function monitorBrowser(page: Page): BrowserEvidence {
  const evidence: BrowserEvidence = {
    chartAborts: [],
    unexpectedRequestFailures: [],
    consoleErrors: [],
    pageErrors: [],
    unhandledRejections: [],
    unexpectedHttpErrors: [],
    orderRequests: [],
  };

  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text.startsWith('[e2e-unhandledrejection]')) {
      evidence.unhandledRejections.push(text);
      return;
    }
    evidence.consoleErrors.push(text);
  });
  page.on('pageerror', (error) => evidence.pageErrors.push(error.message));
  page.on('requestfailed', (request: Request) => {
    const errorText = request.failure()?.errorText ?? '';
    if (CHART_ENDPOINT.test(request.url()) && /ERR_ABORTED|NS_BINDING_ABORTED/i.test(errorText)) {
      evidence.chartAborts.push({ url: request.url(), errorText });
      return;
    }
    evidence.unexpectedRequestFailures.push(`${request.method()} ${request.url()} ${errorText}`);
  });
  page.on('request', (request) => {
    if (request.method() !== 'GET' && ORDER_ENDPOINT.test(request.url())) {
      evidence.orderRequests.push(`${request.method()} ${request.url()}`);
    }
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) {
      evidence.unexpectedHttpErrors.push({ status: response.status(), url: response.url() });
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
        login_name: 'chart-abort-e2e',
        display_name: '차트 Abort E2E',
        role: 'regular',
        status: 'approved',
        membership_level: 'regular',
        is_active: true,
        permissions_updated_at: '2026-08-04T09:20:00.000Z',
        updated_at: '2026-08-04T09:20:00.000Z',
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
        searchRunId: 'legacy-chart-abort:e2e',
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
  await page.route(CHART_ENDPOINT, async (route) => {
    const requestUrl = new URL(route.request().url());
    const segments = requestUrl.pathname.split('/');
    const ticker = decodeURIComponent(segments.at(-2) ?? '005930').toUpperCase();
    const timeframe = requestUrl.searchParams.get('tf') ?? '5m';
    state.startedChartRequests.push(requestUrl.toString());

    if (state.failChart) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'ABORT_TOUCH_FAILURE' }),
      });
      return;
    }
    if (state.delayOneMinute && timeframe === '1m') await wait(2_000);

    const frameBase = timeframe === '1m' ? 1_000 : timeframe === '15m' ? 2_000 : 100;
    const base = ticker === 'AAPL' ? 3_000 : frameBase;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ticker,
        timeframe,
        provider: 'legacy-chart-abort-fixture',
        fetchedAt: '2026-08-04T09:20:00.000Z',
        updatedAt: '2026-08-04T09:20:00.000Z',
        candles: validCandles(base, timeframe),
      }),
    }).catch(() => undefined);
  });
}

async function openScanner(page: Page, state: MockState) {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApprovedUser(page);
  await installApplicationMocks(page, state);
  await page.goto(`${isolatedBaseURL}/scanner`);
  await expect(page).toHaveURL(/\/scanner$/);
  await expect(page.getByRole('heading', { name: 'AI 검색기', level: 1 })).toBeVisible();
  await expect(page.getByTestId('capability-denied')).toHaveCount(0);
}

async function expectTouchTarget(locator: Locator, label: string) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator, `${label}가 화면에 보여야 합니다.`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label}의 bounding box가 있어야 합니다.`).not.toBeNull();
  expect(box!.height, `${label} 높이`).toBeGreaterThanOrEqual(44);
  expect(box!.width, `${label} 너비`).toBeGreaterThanOrEqual(44);
  return box!;
}

function rectanglesOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
) {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
}

test.describe('legacy scanner chart abort and touch geometry', () => {
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

  test('aborts obsolete timeframe and market requests without error UI or orders', async ({ page }) => {
    const state: MockState = {
      delayOneMinute: false,
      failChart: false,
      startedChartRequests: [],
    };
    const evidence = monitorBrowser(page);
    await openScanner(page, state);

    await page.getByRole('button', { name: 'AI 차트 분석기', exact: true }).click();
    const currentPrice = page.getByText('현재가', { exact: true }).locator('xpath=../..');
    await expect(currentPrice).toContainText('140원');
    await page.getByRole('button', { name: '자동 갱신 중', exact: true }).click();

    state.delayOneMinute = true;
    await page.getByRole('button', { name: '1분', exact: true }).click();
    await expect.poll(() => state.startedChartRequests.filter((url) => url.includes('tf=1m')).length).toBe(1);
    await page.getByRole('button', { name: '15분', exact: true }).click();
    await expect(currentPrice).toContainText('2,040원');
    await expect.poll(() => evidence.chartAborts.filter(({ url }) => url.includes('tf=1m')).length).toBe(1);
    await expect(page.getByText('차트 데이터를 불러오지 못했습니다.', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: '1분', exact: true }).click();
    await expect.poll(() => state.startedChartRequests.filter((url) => url.includes('tf=1m')).length).toBe(2);
    await page.getByRole('button', { name: '해외', exact: true }).click();
    await expect(page.getByRole('heading', { name: '애플', exact: true })).toBeVisible();
    await expect(currentPrice).toContainText('$3,040.00');
    await expect.poll(() => evidence.chartAborts.filter(({ url }) => url.includes('tf=1m')).length).toBe(2);
    await expect(page.getByText('차트 데이터를 불러오지 못했습니다.', { exact: true })).toHaveCount(0);

    expect(evidence.chartAborts).toHaveLength(2);
    expect(evidence.unexpectedRequestFailures).toEqual([]);
    expect(evidence.consoleErrors).toEqual([]);
    expect(evidence.pageErrors).toEqual([]);
    expect(evidence.unhandledRejections).toEqual([]);
    expect(evidence.unexpectedHttpErrors).toEqual([]);
    expect(evidence.orderRequests).toEqual([]);
  });

  test('keeps primary mobile controls at least 44px without overlap or overflow', async ({ page }) => {
    const state: MockState = {
      delayOneMinute: false,
      failChart: false,
      startedChartRequests: [],
    };
    const evidence = monitorBrowser(page);
    await openScanner(page, state);

    const chartTab = page.getByRole('button', { name: 'AI 차트 분석기', exact: true });
    const autoTab = page.getByRole('button', { name: '자동매매', exact: true });
    const domestic = page.getByRole('button', { name: '국내', exact: true });
    const overseas = page.getByRole('button', { name: '해외', exact: true });
    const chartTabBox = await expectTouchTarget(chartTab, 'AI 차트 분석기 전환 버튼');
    const autoTabBox = await expectTouchTarget(autoTab, '자동매매 전환 버튼');
    const domesticBox = await expectTouchTarget(domestic, '국내 시장 버튼');
    const overseasBox = await expectTouchTarget(overseas, '해외 시장 버튼');
    expect(rectanglesOverlap(chartTabBox, autoTabBox), '차트·자동매매 버튼 터치 영역 겹침').toBe(false);
    expect(rectanglesOverlap(domesticBox, overseasBox), '국내·해외 버튼 터치 영역 겹침').toBe(false);

    await chartTab.click();
    await expect(page.getByText('현재가', { exact: true }).locator('xpath=../..')).toContainText('140원');
    await page.getByRole('button', { name: '자동 갱신 중', exact: true }).click();
    await expectTouchTarget(page.getByRole('button', { name: '자동 갱신 중', exact: true }), '자동 갱신 버튼');
    await expectTouchTarget(page.getByTitle('차트 새로고침'), '차트 새로고침 버튼');
    await expectTouchTarget(page.getByRole('button', { name: '1분', exact: true }), '1분 시간봉 버튼');
    await expectTouchTarget(page.getByRole('button', { name: '15분', exact: true }), '15분 시간봉 버튼');

    state.failChart = true;
    await page.getByTitle('차트 새로고침').click();
    await expect(page.getByText('ABORT_TOUCH_FAILURE', { exact: true })).toBeVisible();
    await expectTouchTarget(page.getByRole('button', { name: '다시 시도', exact: true }), '차트 재시도 버튼');
    state.failChart = false;
    await page.getByRole('button', { name: '다시 시도', exact: true }).click();
    await expect(page.getByText('현재가', { exact: true }).locator('xpath=../..')).toContainText('140원');

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 844, height: 390 });
    await expectTouchTarget(page.getByRole('button', { name: '15분', exact: true }), '가로 화면 15분 시간봉 버튼');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    expect(evidence.unexpectedRequestFailures).toEqual([]);
    expect(evidence.consoleErrors.filter((text) => !/Failed to load resource.*503/i.test(text))).toEqual([]);
    expect(evidence.pageErrors).toEqual([]);
    expect(evidence.unhandledRejections).toEqual([]);
    expect(evidence.unexpectedHttpErrors.filter(({ status }) => status !== 503)).toEqual([]);
    expect(evidence.orderRequests).toEqual([]);
  });
});
