import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';

const SUPABASE_HOST = 'auth-restored-context-e2e.supabase.co';
const USER_ID = '00000000-0000-4000-8000-000000000071';
const LOGIN_NAME = 'auth-restored';
const DISPLAY_NAME = '복원 컨텍스트 사용자';
const AI_CHART_PATH = '/ai-chart?assetType=stock&market=KR&symbol=005930'
  + '&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m';
const ORDER_ENDPOINT = /\/api\/.*(?:order|trade|approval|execute|cancel)/i;

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
    sub: USER_ID,
  }),
  Buffer.from('auth-restored-signature').toString('base64url'),
].join('.');

function userPayload() {
  const timestamp = '2026-08-05T00:00:00.000Z';
  return {
    id: USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: `${LOGIN_NAME}@example.com`,
    email_confirmed_at: timestamp,
    phone: '',
    confirmed_at: timestamp,
    last_sign_in_at: timestamp,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { display_name: DISPLAY_NAME },
    identities: [],
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function sessionPayload() {
  return {
    access_token: ACCESS_TOKEN,
    refresh_token: 'auth-restored-refresh-token',
    expires_in: 86_400,
    expires_at: 4_102_444_800,
    token_type: 'bearer',
    user: userPayload(),
  };
}

function profilePayload() {
  return {
    id: USER_ID,
    login_name: LOGIN_NAME,
    display_name: DISPLAY_NAME,
    role: 'regular',
    status: 'approved',
    membership_level: 'regular',
    is_active: true,
    permissions_updated_at: '2026-08-05T00:00:00.000Z',
    updated_at: '2026-08-05T00:00:00.000Z',
  };
}

function candles(base: number) {
  return Array.from({ length: 80 }, (_, index) => ({
    time: 1_775_000_000 + index * 300,
    open: base + index,
    high: base + index + 4,
    low: base + index - 3,
    close: base + index + 2,
    volume: 1_000 + index * 10,
    isClosed: index < 79,
  }));
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
        reject(new Error('restored-context E2E port allocation failed'));
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
      throw new Error(`restored-context E2E server exited early\n${isolatedViteOutput}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      if (response.status < 500) return;
    } catch {
      // Wait for the isolated Vite process to become reachable.
    }
    await wait(250);
  }
  throw new Error(`restored-context E2E server startup timed out\n${isolatedViteOutput}`);
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

type RouteCounters = {
  sameOriginProfile: number;
  directSupabaseProfile: number;
  orderRequests: string[];
  bootstrapRequests: string[];
};

type RouteOptions = {
  profileDelayMs?: number;
  routeModuleDelayMs?: number;
};

async function installRoutes(
  context: BrowserContext,
  counters: RouteCounters,
  options: RouteOptions = {},
) {
  await context.route(`https://${SUPABASE_HOST}/**`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{}',
  }));
  await context.route(`https://${SUPABASE_HOST}/auth/v1/token**`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(sessionPayload()),
  }));
  await context.route(`https://${SUPABASE_HOST}/auth/v1/user**`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(userPayload()),
  }));
  await context.route(`https://${SUPABASE_HOST}/rest/v1/profiles**`, (route) => {
    counters.directSupabaseProfile += 1;
    return route.fulfill({
      status: 599,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'DIRECT_PROFILE_READ_FORBIDDEN_IN_TEST' }),
    });
  });

  await context.route('**/api/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{}',
  }));
  await context.route('**/api/auth/profile', async (route) => {
    counters.sameOriginProfile += 1;
    expect(route.request().headers()['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
    if (options.profileDelayMs) await wait(options.profileDelayMs);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(profilePayload()),
    });
  });
  await context.route('**/api/stocks/*/chart**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      provider: 'restored-context-stock-fixture',
      fetchedAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
      candles: candles(80_000),
    }),
  }));
  await context.route('**/api/stocks/*/candles**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      provider: 'restored-context-stock-fixture',
      fetchedAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
      candles: candles(80_000),
    }),
  }));
  if (options.routeModuleDelayMs) {
    await context.route('**/src/pages/ai-chart.tsx*', async (route) => {
      await wait(options.routeModuleDelayMs!);
      await route.continue();
    });
  }
  context.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/auth/profile' || /\/api\/stocks\/[^/]+\/(?:candles|chart)$/.test(pathname)) {
      counters.bootstrapRequests.push(pathname);
    }
    if (request.method() !== 'GET' && ORDER_ENDPOINT.test(request.url())) {
      counters.orderRequests.push(`${request.method()} ${request.url()}`);
    }
  });
}

async function login(page: Page) {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: '계정', level: 1 })).toBeVisible();
  await page.getByLabel('아이디').fill(LOGIN_NAME);
  await page.getByLabel('비밀번호').fill('safe-password-1234');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.getByText('현재 등급에 허용된 기능을 사용할 수 있습니다.')).toBeVisible();
}

async function warmAiChartRoute(page: Page) {
  await page.evaluate((nextLocation) => {
    window.history.pushState(null, '', nextLocation);
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
  }, AI_CHART_PATH);
  await expect(page.getByRole('heading', { name: 'AI 차트 생중계', level: 1 })).toBeVisible();
  await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();
}

test.describe('restored authenticated context direct AI Chart bootstrap', () => {
  test.setTimeout(120_000);

  test.beforeAll(async () => {
    const port = await findFreePort();
    isolatedBaseURL = `http://127.0.0.1:${port}`;
    const vite = path.resolve(
      analyzerDirectory(),
      process.platform === 'win32' ? 'node_modules/.bin/vite.cmd' : 'node_modules/.bin/vite',
    );
    isolatedVite = spawn(
      vite,
      [
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
          VITE_PHASE11_E2E: 'false',
          VITE_SUPABASE_URL: `https://${SUPABASE_HOST}`,
          VITE_SUPABASE_ANON_KEY: ACCESS_TOKEN,
        },
        shell: process.platform === 'win32',
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

  test('storageState restored context reaches direct AI Chart through same-origin profile bootstrap', async ({ browser }) => {
    const loginCounters: RouteCounters = {
      sameOriginProfile: 0,
      directSupabaseProfile: 0,
      orderRequests: [],
      bootstrapRequests: [],
    };
    const loginContext = await browser.newContext({
      baseURL: isolatedBaseURL,
      viewport: { width: 1440, height: 900 },
    });
    await installRoutes(loginContext, loginCounters);
    const loginPage = await loginContext.newPage();

    await login(loginPage);
    await warmAiChartRoute(loginPage);
    expect(loginCounters.sameOriginProfile).toBeGreaterThan(0);
    expect(loginCounters.directSupabaseProfile).toBe(0);
    expect(loginCounters.orderRequests).toEqual([]);

    const storageState = await loginContext.storageState();
    await loginContext.close();

    const restoredCounters: RouteCounters = {
      sameOriginProfile: 0,
      directSupabaseProfile: 0,
      orderRequests: [],
      bootstrapRequests: [],
    };
    const restoredContext = await browser.newContext({
      baseURL: isolatedBaseURL,
      storageState,
      viewport: { width: 1440, height: 900 },
    });
    await installRoutes(restoredContext, restoredCounters, {
      profileDelayMs: 3_500,
      routeModuleDelayMs: 1_000,
    });
    const restoredPage = await restoredContext.newPage();

    const coldStartedAt = Date.now();
    const response = await restoredPage.goto(AI_CHART_PATH, { waitUntil: 'domcontentloaded' });
    if (response) expect(response.status()).toBeLessThan(400);
    await expect(
      restoredPage.getByRole('heading', { name: 'AI 차트 생중계', level: 1 }),
    ).toBeVisible({ timeout: 5_000 });
    await expect(restoredPage.getByTestId('page-fallback')).toHaveCount(0);
    await expect(restoredPage.getByTestId('capability-denied')).toHaveCount(0);
    await expect(restoredPage.getByTestId('unified-chart-canvas')).toBeVisible();
    await expect(restoredPage.getByText('restored-context-stock-fixture', { exact: false })).toBeVisible();
    expect(Date.now() - coldStartedAt).toBeLessThanOrEqual(5_000);

    expect(restoredCounters.sameOriginProfile).toBeGreaterThan(0);
    expect(restoredCounters.directSupabaseProfile).toBe(0);
    expect(restoredCounters.orderRequests).toEqual([]);
    expect(restoredCounters.bootstrapRequests[0]).toBe('/api/auth/profile');

    await restoredContext.close();
  });
});
