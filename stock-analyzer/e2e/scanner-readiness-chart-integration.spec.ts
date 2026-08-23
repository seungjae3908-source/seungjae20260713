import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';

const SUPABASE_HOST = 'scanner-readiness-chart-e2e.supabase.co';
const SUPABASE_STORAGE_KEY = 'sb-scanner-readiness-chart-e2e-auth-token';
const TEST_USER_ID = '00000000-0000-4000-8000-000000000071';
const SCAN_ENDPOINT = /\/api\/market\/scan(?:\?|$)/i;
const CHART_ENDPOINT = /\/api\/stocks\/[^/]+\/(?:chart|candles)(?:\?|$)/i;
const ORDER_ENDPOINT = /\/api\/.*(?:order|trade|approval|execute|cancel)/i;

type MockState = {
  delayInitialScan: boolean;
  delayOneMinuteChart: boolean;
  scanRequests: string[];
  chartRequests: string[];
};

type Evidence = {
  scanAborts: Array<{ url: string; errorText: string }>;
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
  Buffer.from('scanner-readiness-chart-signature').toString('base64url'),
].join('.');

function approvedSession() {
  const timestamp = '2026-08-05T00:00:00.000Z';
  return {
    access_token: ACCESS_TOKEN,
    refresh_token: 'scanner-readiness-chart-refresh-token',
    expires_in: 86_400,
    expires_at: 4_102_444_800,
    token_type: 'bearer',
    user: {
      id: TEST_USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'scanner-readiness-chart@example.com',
      email_confirmed_at: timestamp,
      phone: '',
      confirmed_at: timestamp,
      last_sign_in_at: timestamp,
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: { display_name: 'Scanner Readiness E2E' },
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
        reject(new Error('scanner readiness E2E 서버 포트를 할당하지 못했습니다.'));
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
      throw new Error(`격리 scanner E2E 서버가 조기 종료됐습니다.\n${isolatedViteOutput}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      if (response.status < 500) return;
    } catch {
      // 서버가 준비될 때까지 재시도합니다.
    }
    await wait(250);
  }
  throw new Error(`격리 scanner E2E 서버 시작 시간이 초과됐습니다.\n${isolatedViteOutput}`);
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

function candles(base: number, timeframe: string) {
  const step = timeframe === '1m' ? 60 : timeframe === '15m' ? 900 : 300;
  return Array.from({ length: 40 }, (_, index) => ({
    time: 1_775_100_000 + index * step,
    open: base + index,
    high: base + index + 3,
    low: base + index - 2,
    close: base + index + 1,
    volume: 1_000 + index * 10,
    isClosed: true,
  }));
}

function monitor(page: Page): Evidence {
  const evidence: Evidence = {
    scanAborts: [],
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
    if (SCAN_ENDPOINT.test(request.url()) && /ERR_ABORTED|NS_BINDING_ABORTED/i.test(errorText)) {
      evidence.scanAborts.push({ url: request.url(), errorText });
      return;
    }
    if (CHART_ENDPOINT.test(request.url()) && /ERR_ABORTED|NS_BINDING_ABORTED/i.test(errorText)) {
      evidence.chartAborts.push({ url: request.url(), errorText });
      return;
    }
    evidence.unexpectedRequestFailures.push(`${request.method()} ${request.url()} ${errorText}`);
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) {
      evidence.unexpectedHttpErrors.push({ status: response.status(), url: response.url() });
    }
  });
  page.on('request', (request) => {
    if (request.method() !== 'GET' && ORDER_ENDPOINT.test(request.url())) {
      evidence.orderRequests.push(`${request.method()} ${request.url()}`);
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

  await page.route(`https://${SUPABASE_HOST}/**`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{}',
  }));
  await page.route(`https://${SUPABASE_HOST}/rest/v1/profiles**`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'Content-Range': '0-0/1' },
    body: JSON.stringify({
      id: TEST_USER_ID,
      login_name: 'scanner-readiness-chart',
      display_name: 'Scanner Readiness E2E',
      role: 'regular',
      status: 'approved',
      membership_level: 'regular',
      is_active: true,
      permissions_updated_at: '2026-08-05T00:00:00.000Z',
      updated_at: '2026-08-05T00:00:00.000Z',
    }),
  }));
}

async function installApplicationMocks(page: Page, state: MockState) {
  await page.route('**/api/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{}',
  }));
  await page.route('**/api/market/scan**', async (route) => {
    const call = state.scanRequests.length + 1;
    state.scanRequests.push(route.request().url());
    if (state.delayInitialScan && call === 1) await wait(2_000);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        searchRunId: `scanner-readiness:e2e:${call}`,
        timeframe: '1D',
        supportedIndicators: [],
        cards: [],
        partial: false,
        completedCount: 0,
        requestedCount: 0,
        providerErrorCount: 0,
        timeoutCount: 0,
        elapsedMs: 10,
      }),
    }).catch(() => undefined);
  });
  await page.route('**/api/quotes**', (route) => route.fulfill({
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
  }));
  await page.route('**/api/stocks/auto-trade/status**', (route) => route.fulfill({
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
  }));
  await page.route(CHART_ENDPOINT, async (route) => {
    const url = new URL(route.request().url());
    const ticker = decodeURIComponent(url.pathname.split('/').at(-2) ?? '005930').toUpperCase();
    const timeframe = url.searchParams.get('tf') ?? '5m';
    state.chartRequests.push(url.toString());
    if (state.delayOneMinuteChart && timeframe === '1m') await wait(2_000);
    const base = timeframe === '1m'
      ? 1_000
      : timeframe === '15m'
        ? 2_000
        : ticker === 'AAPL'
          ? 3_000
          : 1_000;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ticker,
        timeframe,
        provider: 'scanner-readiness-chart-fixture',
        fetchedAt: '2026-08-05T00:00:00.000Z',
        updatedAt: '2026-08-05T00:00:00.000Z',
        candles: candles(base, timeframe),
      }),
    }).catch(() => undefined);
  });
}

async function expectTouchTarget(locator: Locator, label: string) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator, `${label}가 화면에 보여야 합니다.`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label}의 bounding box가 있어야 합니다.`).not.toBeNull();
  expect(box!.width, `${label} 너비`).toBeGreaterThanOrEqual(44);
  expect(box!.height, `${label} 높이`).toBeGreaterThanOrEqual(44);
  return box!;
}

function overlaps(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
) {
  return !(
    left.x + left.width <= right.x
    || right.x + right.width <= left.x
    || left.y + left.height <= right.y
    || right.y + right.height <= left.y
  );
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  )).toBe(true);
}

async function expectVisiblePanelsInsideViewport(page: Page) {
  const escaped = await page.locator(
    '[role="dialog"]:visible, [data-testid="scanner-readiness-status"]:visible',
  ).evaluateAll((elements) => elements
    .map((element) => {
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        width: window.innerWidth,
        height: window.innerHeight,
      };
    })
    .filter((box) => (
      box.left < 0
      || box.top < 0
      || box.right > box.width
      || box.bottom > box.height
    )));
  expect(escaped).toEqual([]);
}

test.describe('scanner readiness and legacy chart integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

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

  test('separates scan and chart aborts and keeps mobile controls usable', async ({ page }) => {
    const state: MockState = {
      delayInitialScan: true,
      delayOneMinuteChart: false,
      scanRequests: [],
      chartRequests: [],
    };
    const evidence = monitor(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await installApprovedUser(page);
    await installApplicationMocks(page, state);

    await page.goto(`${isolatedBaseURL}/__phase11-ai-workspace-e2e`);
    await expect(page).toHaveURL(/\/__phase11-ai-workspace-e2e$/);
    await expect(page.getByRole('heading', { name: 'AI 검색기', level: 1 })).toBeVisible();
    await expect.poll(() => state.scanRequests.length).toBe(1);

    await page.getByRole('button', { name: '해외', exact: true }).click();
    await expect.poll(() => state.scanRequests.length).toBeGreaterThanOrEqual(2);
    await expect.poll(() => evidence.scanAborts.length).toBe(1);
    await page.waitForTimeout(2_100);

    await page.getByRole('button', { name: 'AI 차트 분석기', exact: true }).click();
    const currentPrice = page.getByText('현재가', { exact: true }).locator('xpath=../..');
    await expect(currentPrice).toContainText('$3,040.00');
    await page.getByRole('button', { name: '자동 갱신 중', exact: true }).click();

    state.delayOneMinuteChart = true;
    await page.getByRole('button', { name: '1분', exact: true }).click();
    await expect.poll(() => state.chartRequests.filter((url) => url.includes('tf=1m')).length).toBe(1);
    await page.getByRole('button', { name: '15분', exact: true }).click();
    await expect(currentPrice).toContainText('$2,040.00');
    await expect.poll(() => evidence.chartAborts.length).toBe(1);
    await page.waitForTimeout(2_100);
    await expect(currentPrice).toContainText('$2,040.00');

    for (const viewport of [
      { width: 360, height: 800 },
      { width: 390, height: 844 },
      { width: 430, height: 932 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport);
      const readiness = page.getByTestId('scanner-readiness-status');
      const chartTab = page.getByRole('button', { name: 'AI 차트 분석기', exact: true });
      const marketButton = page.getByRole('button', { name: '해외', exact: true });
      const timeframe = page.getByRole('button', { name: '15분', exact: true });
      const readinessBox = await readiness.boundingBox();
      const chartTabBox = await expectTouchTarget(chartTab, `${viewport.width}px 차트 탭`);
      const marketBox = await expectTouchTarget(marketButton, `${viewport.width}px 시장 버튼`);
      const timeframeBox = await expectTouchTarget(timeframe, `${viewport.width}px 시간봉 버튼`);
      expect(readinessBox).not.toBeNull();
      expect(overlaps(readinessBox!, chartTabBox)).toBe(false);
      expect(overlaps(readinessBox!, marketBox)).toBe(false);
      expect(overlaps(readinessBox!, timeframeBox)).toBe(false);
      await timeframe.tap();
      await expectNoHorizontalOverflow(page);
      await expectVisiblePanelsInsideViewport(page);
      expect(await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('*')).some(
        (element) => {
          const style = getComputedStyle(element);
          return element.scrollHeight > element.clientHeight
            && (style.overflowY === 'auto' || style.overflowY === 'scroll');
        },
      ))).toBe(true);
    }

    expect(evidence.scanAborts).toHaveLength(1);
    expect(evidence.chartAborts).toHaveLength(1);
    expect(evidence.unexpectedRequestFailures, evidence.unexpectedRequestFailures.join('\n')).toEqual([]);
    expect(evidence.consoleErrors, evidence.consoleErrors.join('\n')).toEqual([]);
    expect(evidence.pageErrors, evidence.pageErrors.join('\n')).toEqual([]);
    expect(evidence.unhandledRejections, evidence.unhandledRejections.join('\n')).toEqual([]);
    expect(evidence.unexpectedHttpErrors).toEqual([]);
    expect(evidence.orderRequests).toEqual([]);
  });
});
