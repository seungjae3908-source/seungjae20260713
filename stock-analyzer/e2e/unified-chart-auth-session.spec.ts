import { expect, test, type Page, type Request } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';

const SUPABASE_HOST = 'auth-session-e2e.supabase.co';
const FIRST_USER_ID = '00000000-0000-4000-8000-000000000061';
const SECOND_USER_ID = '00000000-0000-4000-8000-000000000062';
const ORDER_ENDPOINT = /\/api\/.*(?:order|trade|approval|execute|cancel)/i;

type TestUser = {
  id: string;
  loginName: string;
  displayName: string;
  token: string;
};

type BrowserEvidence = {
  consoleErrors: string[];
  pageErrors: string[];
  unhandledRejections: string[];
  unexpectedRequestFailures: string[];
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

function accessToken(userId: string, label: string) {
  return [
    encodeJwtPart({ alg: 'HS256', typ: 'JWT' }),
    encodeJwtPart({
      aud: 'authenticated',
      exp: 4_102_444_800,
      role: 'authenticated',
      sub: userId,
    }),
    Buffer.from(`${label}-signature`).toString('base64url'),
  ].join('.');
}

const USERS: TestUser[] = [
  {
    id: FIRST_USER_ID,
    loginName: 'auth-first',
    displayName: '첫 번째 인증 사용자',
    token: accessToken(FIRST_USER_ID, 'auth-first'),
  },
  {
    id: SECOND_USER_ID,
    loginName: 'auth-second',
    displayName: '재로그인 사용자',
    token: accessToken(SECOND_USER_ID, 'auth-second'),
  },
];

function userPayload(user: TestUser) {
  const timestamp = '2026-08-05T00:00:00.000Z';
  return {
    id: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: `${user.loginName}@example.com`,
    email_confirmed_at: timestamp,
    phone: '',
    confirmed_at: timestamp,
    last_sign_in_at: timestamp,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { display_name: user.displayName },
    identities: [],
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function sessionPayload(user: TestUser) {
  return {
    access_token: user.token,
    refresh_token: `${user.loginName}-refresh-token`,
    expires_in: 86_400,
    expires_at: 4_102_444_800,
    token_type: 'bearer',
    user: userPayload(user),
  };
}

function profilePayload(user: TestUser, displayName = user.displayName) {
  return {
    id: user.id,
    login_name: user.loginName,
    display_name: displayName,
    role: 'regular',
    status: 'approved',
    membership_level: 'regular',
    is_active: true,
    permissions_updated_at: '2026-08-05T00:00:00.000Z',
    updated_at: '2026-08-05T00:00:00.000Z',
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
        reject(new Error('인증 E2E 서버 포트를 할당하지 못했습니다.'));
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
      throw new Error(`격리 인증 E2E 서버가 조기 종료됐습니다.\n${isolatedViteOutput}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      if (response.status < 500) return;
    } catch {
      // 서버가 준비될 때까지 재시도합니다.
    }
    await wait(250);
  }
  throw new Error(`격리 인증 E2E 서버 시작 시간이 초과됐습니다.\n${isolatedViteOutput}`);
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

function candles(base: number, stepSeconds = 300) {
  return Array.from({ length: 80 }, (_, index) => ({
    time: 1_775_000_000 + index * stepSeconds,
    open: base + index,
    high: base + index + 4,
    low: base + index - 3,
    close: base + index + 2,
    volume: 1_000 + index * 10,
    isClosed: index < 79,
  }));
}

function monitorBrowser(page: Page): BrowserEvidence {
  const evidence: BrowserEvidence = {
    consoleErrors: [],
    pageErrors: [],
    unhandledRejections: [],
    unexpectedRequestFailures: [],
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
    evidence.unexpectedRequestFailures.push(
      `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`,
    );
  });
  page.on('response', (response) => {
    if (
      (response.url().includes('/api/') || response.url().includes(`https://${SUPABASE_HOST}/`))
      && response.status() >= 400
    ) {
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

async function installUnhandledMonitor(page: Page) {
  await page.addInitScript(() => {
    const originalDateNow = Date.now.bind(Date);
    let offset = 0;
    Object.defineProperty(window, '__authE2eAdvanceTime', {
      configurable: true,
      value: (milliseconds: number) => {
        offset += milliseconds;
      },
    });
    Date.now = () => originalDateNow() + offset;
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
      console.error(`[e2e-unhandledrejection] ${reason}`);
    });
  });
}

async function installChartMocks(page: Page) {
  await page.route('**/api/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{}',
  }));
  await page.route('**/api/search/quotes**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      results: [
        {
          ticker: '005930',
          name: '삼성전자',
          market: 'KR',
          currency: 'KRW',
          price: 80_000,
          changePercent: 1.2,
          rating: { rating: 'BUY', confidence: 80, score: 80 },
        },
      ],
    }),
  }));
  await page.route('**/api/crypto/spot/markets**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      markets: [{
        market: 'KRW-BTC',
        symbol: 'BTC',
        koreanName: '비트코인',
        englishName: 'Bitcoin',
      }],
    }),
  }));
  await page.route('**/api/stocks/*/chart**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      provider: 'auth-stock-fixture',
      fetchedAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
      candles: candles(80_000),
    }),
  }));
  await page.route('**/api/stocks/*/candles**', (route) => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ message: 'NOT_FOUND' }),
  }));
  await page.route('**/api/crypto/spot/candles**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      provider: 'auth-upbit-fixture',
      fetchedAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
      candles: candles(180_000),
    }),
  }));
}

async function login(page: Page, loginName: string) {
  await page.getByLabel('아이디').fill(loginName);
  await page.getByLabel('비밀번호').fill('safe-password-1234');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.getByText('현재 등급에 허용된 기능을 사용할 수 있습니다.')).toBeVisible();
}

async function navigateSpa(page: Page, pathAndSearch: string) {
  await page.evaluate((nextLocation) => {
    window.history.pushState(null, '', nextLocation);
    window.dispatchEvent(
      new PopStateEvent('popstate', { state: window.history.state }),
    );
  }, pathAndSearch);
}

test.describe('production auth session and AI chart route', () => {
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
          VITE_PHASE11_E2E: 'false',
          VITE_SUPABASE_URL: `https://${SUPABASE_HOST}`,
          VITE_SUPABASE_ANON_KEY: USERS[0].token,
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

  test('blocks a late old profile during logout and re-enters the real AI chart after login', async ({ page }) => {
    const evidence = monitorBrowser(page);
    await installUnhandledMonitor(page);
    await installChartMocks(page);

    let tokenCalls = 0;
    let logoutCalls = 0;
    const profileCalls = new Map<string, number>();
    let currentUser: TestUser | null = null;
    let lateProfileStartedResolve: (() => void) | null = null;
    const lateProfileStarted = new Promise<void>((resolve) => {
      lateProfileStartedResolve = resolve;
    });
    let releaseLateProfileResolve: (() => void) | null = null;
    const releaseLateProfile = new Promise<void>((resolve) => {
      releaseLateProfileResolve = resolve;
    });

    await page.route(`https://${SUPABASE_HOST}/**`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    }));
    await page.route(`https://${SUPABASE_HOST}/auth/v1/token**`, (route) => {
      const user = USERS[Math.min(tokenCalls, USERS.length - 1)];
      tokenCalls += 1;
      currentUser = user;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(sessionPayload(user)),
      });
    });
    await page.route(`https://${SUPABASE_HOST}/auth/v1/user**`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(userPayload(currentUser ?? USERS[0])),
    }));
    await page.route(`https://${SUPABASE_HOST}/auth/v1/logout**`, async (route) => {
      logoutCalls += 1;
      currentUser = null;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{}',
      });
    });
    await page.route(`https://${SUPABASE_HOST}/rest/v1/profiles**`, async (route) => {
      const requestUrl = decodeURIComponent(route.request().url());
      const user = USERS.find((candidate) => requestUrl.includes(candidate.id))
        ?? currentUser
        ?? USERS[0];
      const count = (profileCalls.get(user.id) ?? 0) + 1;
      profileCalls.set(user.id, count);

      if (user.id === FIRST_USER_ID && count === 2) {
        lateProfileStartedResolve?.();
        await releaseLateProfile;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Content-Range': '0-0/1' },
          body: JSON.stringify(profilePayload(user, '늦은 이전 사용자')),
        }).catch(() => undefined);
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Content-Range': '0-0/1' },
        body: JSON.stringify(profilePayload(user)),
      });
    });

    await page.goto(`${isolatedBaseURL}/login`);
    await expect(page.getByRole('heading', { name: '계정', level: 1 })).toBeVisible();
    await login(page, USERS[0].loginName);
    expect(profileCalls.get(FIRST_USER_ID)).toBe(1);

    await navigateSpa(
      page,
      '/ai-chart?assetType=stock&market=KR&symbol=005930'
      + '&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m',
    );
    await expect(page).toHaveURL(/\/ai-chart/);
    await expect(page.getByTestId('capability-denied')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'AI 차트 생중계', level: 1 })).toBeVisible();
    await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();
    await expect(page.getByText('auth-stock-fixture', { exact: false })).toBeVisible();

    await navigateSpa(page, '/account');
    await expect(page.getByText(USERS[0].displayName, { exact: true })).toBeVisible();
    await page.evaluate(() => {
      const advance = (
        window as typeof window & { __authE2eAdvanceTime?: (milliseconds: number) => void }
      ).__authE2eAdvanceTime;
      advance?.(31_000);
      window.dispatchEvent(new Event('online'));
    });
    await lateProfileStarted;

    await page.evaluate(() => {
      const marker = '늦은 이전 사용자';
      const state = window as typeof window & { __lateProfileApplied?: boolean };
      state.__lateProfileApplied = document.body.textContent?.includes(marker) ?? false;
      const observer = new MutationObserver(() => {
        if (document.body.textContent?.includes(marker)) state.__lateProfileApplied = true;
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    });

    await page.getByRole('button', { name: '로그아웃', exact: true }).click();
    await page.waitForTimeout(100);
    expect(logoutCalls).toBe(0);
    releaseLateProfileResolve?.();

    await expect.poll(() => logoutCalls).toBe(1);
    await expect(page.getByLabel('아이디')).toBeVisible();
    await expect(page.getByText('늦은 이전 사용자', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => (
      window as typeof window & { __lateProfileApplied?: boolean }
    ).__lateProfileApplied ?? false)).toBe(false);
    await expect(page.getByRole('heading', { name: 'AI 차트 생중계', level: 1 })).toHaveCount(0);

    await login(page, USERS[1].loginName);
    await expect(page.getByText(USERS[1].displayName, { exact: true })).toBeVisible();
    expect(profileCalls.get(SECOND_USER_ID)).toBe(1);

    await navigateSpa(
      page,
      '/ai-chart?assetType=stock&market=KR&symbol=005930'
      + '&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m',
    );
    await expect(page.getByRole('heading', { name: 'AI 차트 생중계', level: 1 })).toBeVisible();
    await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();
    await page.getByTestId('market-UPBIT').click();
    await expect(page).toHaveURL(/market=UPBIT/);
    await expect(page.getByText('auth-upbit-fixture', { exact: false })).toBeVisible();
    await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();

    expect(tokenCalls).toBe(2);
    expect(evidence.consoleErrors, evidence.consoleErrors.join('\n')).toEqual([]);
    expect(evidence.pageErrors, evidence.pageErrors.join('\n')).toEqual([]);
    expect(evidence.unhandledRejections, evidence.unhandledRejections.join('\n')).toEqual([]);
    expect(
      evidence.unexpectedRequestFailures,
      evidence.unexpectedRequestFailures.join('\n'),
    ).toEqual([]);
    expect(evidence.unexpectedHttpErrors).toEqual([]);
    expect(evidence.orderRequests).toEqual([]);
  });
});
