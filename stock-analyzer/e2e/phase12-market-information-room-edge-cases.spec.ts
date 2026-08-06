import { expect, test, type Page, type Route } from '@playwright/test';

const NOW = '2026-08-06T00:00:00.000Z';
const E2E_USER_ID = '22222222-2222-4222-8222-222222222222';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';

type Diagnostics = {
  assertClean: () => Promise<void>;
};

type ErrorCase = {
  status: number;
  code: string;
  title: string;
  retryable: boolean;
};

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });
}

async function installApprovedSession(page: Page): Promise<void> {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'e2e-refresh-token',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'e2e-information-edge@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '정보방 오류상태 검증' },
        identities: [],
        created_at: now,
      },
    }));
  }, { storageKey: E2E_AUTH_STORAGE_KEY, userId: E2E_USER_ID, now: NOW });
}

function emptyRoomResponse() {
  const meta = {
    provider: 'KRX',
    source: 'KRX 공개 데이터',
    market: 'KR',
    assetType: 'stock',
    currency: 'KRW',
    providerUpdatedAt: NOW,
    observedAt: NOW,
    fetchedAt: NOW,
    marketTimeZone: 'Asia/Seoul',
    marketStatus: 'CLOSED',
    isDelayed: false,
    isStale: false,
    partial: false,
    unavailableFields: [],
    errorCode: null,
    retryable: false,
  } as const;
  const empty = (message: string) => ({ status: 'empty', data: [], meta, message });
  return {
    ok: true,
    room: 'stocks-kr',
    market: 'KR',
    assetType: 'stock',
    currency: 'KRW',
    fetchedAt: NOW,
    partial: false,
    sections: {
      indices: empty('현재 표시할 시장 지수가 없습니다.'),
      rankings: empty('현재 표시할 시장 종목이 없습니다.'),
      sectors: empty('현재 표시할 업종 데이터가 없습니다.'),
      news: empty('현재 표시할 뉴스가 없습니다.'),
      disclosures: empty('현재 표시할 공시가 없습니다.'),
      derivatives: {
        status: 'unsupported',
        data: {
          referenceSymbol: 'BTCUSDT',
          longRatio: null,
          shortRatio: null,
          longShortRatio: null,
          ratioObservedAt: null,
          liquidations: [],
        },
        meta: {
          ...meta,
          provider: null,
          source: null,
          unavailableFields: ['derivatives'],
          errorCode: 'PROVIDER_UNSUPPORTED',
        },
        message: '주식 정보방에는 선물 파생지표를 표시하지 않습니다.',
      },
    },
    requestPolicy: {
      publicMarketDataOnly: true,
      privateExchangeRequests: 0,
      accountRequests: 0,
      balanceRequests: 0,
      positionRequests: 0,
      orderRequests: 0,
      cancelRequests: 0,
      aiRequests: 0,
    },
  };
}

async function mockEnvironment(page: Page, options: { error?: ErrorCase } = {}): Promise<Diagnostics> {
  await installApprovedSession(page);
  await page.addInitScript(() => {
    const target = window as Window & { __informationUnhandledRejections?: string[] };
    target.__informationUnhandledRejections = [];
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
      target.__informationUnhandledRejections?.push(reason);
    });
  });

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const unexpectedHttp: string[] = [];
  const forbiddenRequests: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    const reason = request.failure()?.errorText ?? '';
    if (!reason.includes('ERR_ABORTED')) requestFailures.push(`${request.method()} ${request.url()} ${reason}`);
  });
  page.on('response', (response) => {
    if (!response.url().includes('/api/')) return;
    if (response.status() >= 400 && response.status() !== options.error?.status) {
      unexpectedHttp.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: E2E_USER_ID,
        login_name: 'e2e-information-edge',
        display_name: '정보방 오류상태 검증',
        role: 'admin',
        status: 'approved',
        membership_level: 'admin',
        is_active: true,
        permissions_updated_at: NOW,
        updated_at: NOW,
      });
    }
    if (pathname.endsWith('/auth/v1/user')) {
      return fulfill(route, {
        id: E2E_USER_ID,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'e2e-information-edge@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '정보방 오류상태 검증' },
        identities: [],
        created_at: NOW,
      });
    }
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (/\/(accounts?|balances?|positions?|orders?|cancel|trade-automation)(\/|$)|\/crypto\/futures\/auto/i.test(path)) {
      forbiddenRequests.push(`${request.method()} ${path}`);
      return fulfill(route, { ok: false, error: 'FORBIDDEN_TEST_REQUEST' }, 500);
    }
    if (path === '/api/market-information/stocks-kr') {
      if (request.method() !== 'GET') forbiddenRequests.push(`${request.method()} ${path}`);
      if (options.error) {
        return fulfill(route, {
          ok: false,
          errorCode: options.error.code,
          retryable: options.error.retryable,
          message: options.error.code === 'UPSTREAM_TIMEOUT'
            ? '시장정보 제공기관 응답 시간이 초과되었습니다.'
            : '접근할 수 없는 정보방입니다.',
          requestPolicy: {
            publicMarketDataOnly: true,
            privateExchangeRequests: 0,
            accountRequests: 0,
            balanceRequests: 0,
            positionRequests: 0,
            orderRequests: 0,
            cancelRequests: 0,
            aiRequests: 0,
          },
        }, options.error.status);
      }
      return fulfill(route, emptyRoomResponse());
    }
    if (path === '/api/notifications/price-alerts') return fulfill(route, { alerts: [] });
    if (path === '/api/watchlist/sync') return fulfill(route, { ok: true, items: [] });
    return fulfill(route, { ok: true });
  });

  return {
    assertClean: async () => {
      const unhandledRejections = await page.evaluate(() => {
        const target = window as Window & { __informationUnhandledRejections?: string[] };
        return target.__informationUnhandledRejections ?? [];
      });
      expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
      expect(pageErrors, pageErrors.join('\n')).toEqual([]);
      expect(unhandledRejections, unhandledRejections.join('\n')).toEqual([]);
      expect(requestFailures, requestFailures.join('\n')).toEqual([]);
      expect(unexpectedHttp, unexpectedHttp.join('\n')).toEqual([]);
      expect(forbiddenRequests, forbiddenRequests.join('\n')).toEqual([]);
    },
  };
}

test('empty market sections stay explicit without console, page, rejection, HTTP, or order errors', async ({ page }) => {
  const diagnostics = await mockEnvironment(page);
  await page.goto('/stocks/kr');
  await expect(page.getByRole('heading', { name: '국내주식 정보' })).toBeVisible();
  await expect(page.getByText('현재 표시할 시장 종목이 없습니다.')).toBeVisible();
  await diagnostics.assertClean();
});

test('authentication expiry, permission denial, and timeout render distinct retry-safe states', async ({ browser }) => {
  const cases: ErrorCase[] = [
    { status: 401, code: 'AUTHENTICATION_REQUIRED', title: '인증이 만료되었습니다', retryable: false },
    { status: 403, code: 'CAPABILITY_REQUIRED', title: '권한이 부족합니다', retryable: false },
    { status: 504, code: 'UPSTREAM_TIMEOUT', title: '제공기관 응답이 지연되고 있습니다', retryable: true },
  ];

  for (const item of cases) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const diagnostics = await mockEnvironment(page, { error: item });
    await page.goto('/stocks/kr');
    await expect(page.getByRole('heading', { name: item.title })).toBeVisible();
    await expect(page.getByRole('button', { name: '다시 시도' })).toBeVisible();
    await diagnostics.assertClean();
    await context.close();
  }
});
